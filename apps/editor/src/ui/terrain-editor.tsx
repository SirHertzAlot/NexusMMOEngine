/**
 * Terrain panel — sculpt the world heightmap the game server runs on.
 *
 * Loads one area of the editor's world (the same world.db as
 * `npm run server`) - a baked world is far too big to load whole - edits
 * it as ONE HeightGrid (so seams can't open), and saves only the chunks
 * that changed. The area's outer border is pinned when the world continues
 * past it, so edits always meet the unloaded neighbours exactly. Saving
 * re-seats trees/rocks onto the new ground and stops play mode first (a
 * running server would overwrite the edit); the server serves the new
 * terrain on next start.
 */

import * as React from "react";
import {
  applyBrush,
  chunkKey,
  HeightGrid,
  sampleNearest,
  type BrushTool,
} from "@mmo-engine/protocol";
import { TerrainView } from "../terrain/terrain-view.js";
import {
  generateTerrain,
  loadTerrain,
  saveTerrain,
  type TerrainArea,
  type WorldTerrain,
} from "../terrain/terrain-api.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SectionTitle,
} from "./components.js";

const TOOLS: Array<{ id: BrushTool; label: string; hint: string }> = [
  { id: "raise", label: "Raise", hint: "units/s" },
  { id: "lower", label: "Lower", hint: "units/s" },
  { id: "smooth", label: "Smooth", hint: "rate" },
  { id: "flatten", label: "Flatten", hint: "rate" },
];

export function TerrainEditorPanel(): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewRef = React.useRef<TerrainView | null>(null);
  const gridRef = React.useRef<HeightGrid | null>(null);
  const dirtyRef = React.useRef(new Set<string>());
  const flattenTarget = React.useRef(0);
  const chunkSize = React.useRef(16);
  const brush = React.useRef({ tool: "raise" as BrushTool, radius: 4, strength: 2 });

  const [world, setWorld] = React.useState<WorldTerrain | null>(null);
  const [tool, setTool] = React.useState<BrushTool>("raise");
  const [radius, setRadius] = React.useState(4);
  const [strength, setStrength] = React.useState(2);
  const [wireframe, setWireframe] = React.useState(false);
  const [dirtyCount, setDirtyCount] = React.useState(0);
  const [busy, setBusy] = React.useState<null | "loading" | "saving" | "generating">("loading");
  const [message, setMessage] = React.useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [amplitude, setAmplitude] = React.useState("2");
  const [frequency, setFrequency] = React.useState("0.02");
  // The area loaded (what Revert/Save reload) and the one being typed.
  const areaRef = React.useRef<TerrainArea | undefined>(undefined);
  const [areaInput, setAreaInput] = React.useState({ cx: "0", cz: "0", radius: "8" });

  React.useEffect(() => {
    brush.current = { tool, radius, strength };
    viewRef.current?.setBrushRadius(radius);
  }, [tool, radius, strength]);

  const markDirty = React.useCallback((keys: Iterable<string>) => {
    for (const k of keys) dirtyRef.current.add(k);
    setDirtyCount(dirtyRef.current.size);
  }, []);

  // Viewport lifetime = panel lifetime (disposed on tab switch/unmount).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const view = new TerrainView(canvas, {
      onDab(x, z, dt, first) {
        const grid = gridRef.current;
        if (!grid) return;
        const { tool: t, radius: r, strength: s } = brush.current;
        if (first && t === "flatten") flattenTarget.current = sampleNearest(grid, x, z, chunkSize.current);
        const touched = applyBrush(grid, {
          tool: t,
          x,
          z,
          radius: r,
          // raise/lower: s units per second; smooth/flatten: blend rate.
          strength: t === "raise" || t === "lower" ? s * dt : 1 - Math.exp(-s * dt),
          target: flattenTarget.current,
          chunkWorldSize: chunkSize.current,
        });
        if (touched.size > 0) {
          view.updateChunks(touched);
          markDirty(touched);
        }
      },
    });
    view.setBrushRadius(brush.current.radius);
    viewRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [markDirty]);

  const showWorld = React.useCallback((w: WorldTerrain) => {
    const grid = HeightGrid.fromTiles(w.tiles);
    if (w.partial) grid.pinBorders();
    gridRef.current = grid;
    areaRef.current = w.area;
    setAreaInput({ cx: String(w.area.cx), cz: String(w.area.cz), radius: String(w.area.radius) });
    chunkSize.current = w.chunkWorldSize;
    dirtyRef.current.clear();
    setDirtyCount(0);
    setWorld(w);
    setAmplitude(String(w.amplitude));
    setFrequency(String(w.frequency));
    viewRef.current?.setWorld(grid, w.props, w.chunkWorldSize);
  }, []);

  const reload = React.useCallback(async (area?: TerrainArea) => {
    setBusy("loading");
    try {
      showWorld(await loadTerrain(area ?? areaRef.current));
    } catch (err) {
      setMessage({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(null);
    }
  }, [showWorld]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    viewRef.current?.setWireframe(wireframe);
  }, [wireframe]);

  async function save(): Promise<void> {
    const grid = gridRef.current;
    if (!grid || dirtyRef.current.size === 0) return;
    setBusy("saving");
    setMessage(null);
    try {
      const tiles = [...dirtyRef.current].map((k) => {
        const [cx, cz] = k.split(",").map(Number);
        return grid.tile(cx, cz);
      });
      const r = await saveTerrain(tiles);
      setMessage({
        tone: "ok",
        text:
          `Saved ${r.saved} chunk(s); ${r.reseatedProps} prop(s) moved onto the new ground.` +
          (r.stoppedPlayMode ? " Play mode was stopped — start it again to see the change." : ""),
      });
      showWorld(await loadTerrain(areaRef.current));
    } catch (err) {
      setMessage({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  function loadArea(): void {
    const area = { cx: Number(areaInput.cx), cz: Number(areaInput.cz), radius: Number(areaInput.radius) };
    if (![area.cx, area.cz, area.radius].every(Number.isInteger)) {
      setMessage({ tone: "bad", text: "Area centre and radius are whole chunk numbers." });
      return;
    }
    if (dirtyRef.current.size > 0 && !window.confirm("Loading another area discards your unsaved sculpting. Continue?")) return;
    setMessage(null);
    void reload(area);
  }

  async function regenerate(): Promise<void> {
    const grid = gridRef.current;
    if (!grid || !world) return;
    if (dirtyRef.current.size > 0 && !window.confirm("Regenerating replaces your unsaved sculpting. Continue?")) return;
    setBusy("generating");
    setMessage(null);
    try {
      const tiles = await generateTerrain({
        amplitude: Number(amplitude),
        frequency: Number(frequency),
        chunks: grid.chunkCoords(),
      });
      const next = HeightGrid.fromTiles(tiles);
      gridRef.current = next;
      viewRef.current?.setWorld(next, world.props, world.chunkWorldSize);
      markDirty(next.chunkCoords().map(([cx, cz]) => chunkKey(cx, cz)));
      setMessage({ tone: "ok", text: "Preview generated — Save to keep it." });
    } catch (err) {
      setMessage({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  const toolHint = TOOLS.find((t) => t.id === tool)?.hint ?? "";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Terrain</CardTitle>
            <div className="flex items-center gap-2">
              {world && (world.stored
                ? <Badge tone="ok">stored</Badge>
                : <Badge tone="warn">generated — save to store</Badge>)}
              <Badge tone={dirtyCount > 0 ? "info" : "default"}>{dirtyCount} unsaved chunk(s)</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <canvas ref={canvasRef} className="block h-[560px] w-full rounded-md" />
          <p className="mt-2 text-xs text-muted-foreground">
            Left-drag sculpt · right-drag orbit · middle-drag pan · wheel zoom
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Brush</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {TOOLS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={tool === t.id ? "default" : "outline"}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="terrain-radius">Radius: {radius.toFixed(1)} units</Label>
            <input id="terrain-radius" type="range" min={1} max={12} step={0.5}
              value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="terrain-strength">Strength: {strength.toFixed(1)} {toolHint}</Label>
            <input id="terrain-strength" type="range" min={0.5} max={10} step={0.5}
              value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
            Wireframe
          </label>

          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy !== null || dirtyCount === 0}>
              {busy === "saving" ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={() => void reload()} disabled={busy !== null}>
              Revert
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <SectionTitle>Area</SectionTitle>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="terrain-area-cx">Chunk X</Label>
                <Input id="terrain-area-cx" value={areaInput.cx}
                  onChange={(e) => setAreaInput({ ...areaInput, cx: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="terrain-area-cz">Chunk Z</Label>
                <Input id="terrain-area-cz" value={areaInput.cz}
                  onChange={(e) => setAreaInput({ ...areaInput, cz: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="terrain-area-r">Radius</Label>
                <Input id="terrain-area-r" value={areaInput.radius}
                  onChange={(e) => setAreaInput({ ...areaInput, radius: e.target.value })} />
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={loadArea} disabled={busy !== null}>
              {busy === "loading" ? "Loading…" : "Load area"}
            </Button>
            {world?.world && (
              <p className="text-xs text-muted-foreground">
                World "{world.world.name}": chunks {world.world.minChunk}..{world.world.maxChunk} on each axis
                ({((world.world.maxChunk - world.world.minChunk + 1) * world.chunkWorldSize / 1000).toFixed(1)} km).
                {world.partial && " The area's outer edge is pinned to its neighbours."}
              </p>
            )}
          </div>

          {world && !world.world && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <SectionTitle>Regenerate from noise</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="terrain-amp">Amplitude</Label>
                <Input id="terrain-amp" value={amplitude} onChange={(e) => setAmplitude(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="terrain-freq">Frequency</Label>
                <Input id="terrain-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)} />
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void regenerate()} disabled={busy !== null}>
              {busy === "generating" ? "Generating…" : "Preview regenerate"}
            </Button>
          </div>
          )}

          {message && (
            <p className={`text-xs ${message.tone === "ok" ? "text-green-400" : "text-red-400"}`}>{message.text}</p>
          )}
          {world && (
            <p className="text-xs text-muted-foreground">
              {world.tiles.length} of {world.totalTiles || world.tiles.length} chunk(s) · seed {world.seed} ·{" "}
              <span className="font-mono break-all">{world.dataDir}</span>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
