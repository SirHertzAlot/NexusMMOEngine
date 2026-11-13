/**
 * The dungeon bake panel: a top-down grid to paint the layout (rock, floor,
 * pool, erase), a portal tool that places a portal on a clicked wall cell,
 * the theme, each layer's density and budget, and a re-bake that shows the
 * view (triangles, parts, floor area, portals, layer placements) and the
 * bake's provenance.
 *
 * Every edit goes through the host (POST /api/editor/bake-doc/op) so the
 * same checks run in one place; the bake goes through .../bake. The panel
 * holds no edit logic of its own. It imports only browser-safe modules.
 */
import * as React from "react";
import { callEnvelope } from "../api.js";
import { BAKE_LAYERS, BAKE_THEMES, emptyDoc, type DocOp, type DungeonBakeDoc, type PaintCell } from "../inspectors/dungeon-bake-types.js";
import { PORTAL_KINDS, type PortalKind } from "../inspectors/portal-kind.js";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "./components.js";

type Tool = "rock" | "floor" | "pool" | "portal";

interface BakeReply {
  view: {
    triangles: number;
    partCounts: Record<string, number>;
    floorArea: number;
    portals: Array<{ id: string; kind: PortalKind; x: number; y: number }>;
    layers: Array<{ layer: string; placed: number }>;
  };
  provenance: { who: string; what: string; when: string; where: string; why: string; how: { theme: string; layers: string[] } };
}

const CELL_CLASS: Record<string, string> = {
  "#": "bg-zinc-800",
  ".": "bg-amber-200/70",
  p: "bg-sky-500",
};
const TOOL_CELL: Record<Exclude<Tool, "portal">, PaintCell> = { rock: "#", floor: ".", pool: "p" };

export function DungeonBakePanel(): React.JSX.Element {
  const [doc, setDoc] = React.useState<DungeonBakeDoc>(() => emptyDoc("crypt"));
  const [tool, setTool] = React.useState<Tool>("floor");
  const [portalKind, setPortalKind] = React.useState<PortalKind>("door");
  const [reply, setReply] = React.useState<BakeReply | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const send = React.useCallback(async (op: DocOp): Promise<void> => {
    setError(null);
    try {
      const next = await callEnvelope<{ doc: DungeonBakeDoc }>("/api/editor/bake-doc/op", "POST", { doc, op });
      setDoc(next.doc);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [doc]);

  const onCell = (x: number, y: number): void => {
    if (tool === "portal") {
      const id = `${portalKind}-${x}-${y}`;
      void send({ op: "placePortal", portal: { id, x, y, side: "x", kind: portalKind } });
      return;
    }
    void send({ op: "paint", x, y, cell: TOOL_CELL[tool] });
  };

  const bake = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setReply(await callEnvelope<BakeReply>("/api/editor/bake-doc/bake", "POST", { doc, why: "panel bake" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const portalAt = (x: number, y: number): string | undefined => doc.portals.find((p) => p.x === x && p.y === y)?.id;
  const layers = BAKE_LAYERS[doc.theme] ?? [];

  return (
    <div className="grid h-full content-start gap-4 overflow-y-auto md:grid-cols-[auto_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Layout</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Paint tool">
            {(["floor", "rock", "pool", "portal"] as const).map((t) => (
              <Button key={t} variant={tool === t ? "default" : "outline"} onClick={() => setTool(t)} aria-pressed={tool === t}>
                {t}
              </Button>
            ))}
          </div>
          {tool === "portal" ? (
            <Select aria-label="Portal kind" value={portalKind} onChange={(e) => setPortalKind(e.target.value as PortalKind)}>
              {PORTAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          ) : null}
          <div
            role="grid"
            aria-label="Layout grid"
            className="inline-grid w-fit gap-px bg-zinc-600 p-px"
            style={{ gridTemplateColumns: `repeat(${doc.rows[0].length}, 1.5rem)` }}
          >
            {doc.rows.flatMap((row, y) =>
              [...row].map((ch, x) => {
                const portal = portalAt(x, y);
                const entrance = doc.entrance.x === x && doc.entrance.y === y;
                return (
                  <button
                    key={`${x},${y}`}
                    type="button"
                    role="gridcell"
                    aria-label={`${x},${y} ${ch === "#" ? "rock" : ch === "p" ? "pool" : "floor"}${portal ? ` portal ${portal}` : ""}${entrance ? " entrance" : ""}`}
                    onClick={() => onCell(x, y)}
                    className={`h-6 w-6 text-[10px] ${CELL_CLASS[ch] ?? "bg-zinc-800"} ${portal ? "ring-2 ring-fuchsia-400" : ""}`}
                  >
                    {entrance ? "E" : portal ? "P" : ""}
                  </button>
                );
              }),
            )}
          </div>
          <p className="text-xs text-zinc-400">Top-down: x across, y down. Portals sit on a rock cell beside floor.</p>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Theme and layers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Select
              aria-label="Theme"
              value={doc.theme}
              onChange={(e) => void send({ op: "setTheme", theme: e.target.value })}
            >
              {BAKE_THEMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            {layers.map((layer) => (
              <div key={layer} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2">
                <span className="text-sm">{layer}</span>
                <label className="text-xs">
                  density
                  <Input
                    aria-label={`${layer} density`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={doc.layerEdits[layer]?.density ?? ""}
                    placeholder="theme"
                    onBlur={(e) => e.target.value !== "" && void send({ op: "editLayer", layer, field: "density", value: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs">
                  budget
                  <Input
                    aria-label={`${layer} budget`}
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={doc.layerEdits[layer]?.budget ?? ""}
                    placeholder="theme"
                    onBlur={(e) => e.target.value !== "" && void send({ op: "editLayer", layer, field: "budget", value: Number(e.target.value) })}
                  />
                </label>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bake</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-center gap-2">
              <Button onClick={() => void bake()} disabled={busy}>
                {busy ? "Baking…" : "Re-bake and view"}
              </Button>
              {error ? (
                <span role="alert" className="text-sm text-red-400">
                  {error}
                </span>
              ) : null}
            </div>
            {reply ? (
              <div className="grid gap-1 text-sm" aria-label="Bake view">
                <div>Triangles: {reply.view.triangles}</div>
                <div>Floor area: {reply.view.floorArea.toFixed(1)} m²</div>
                <div>
                  Parts: {Object.entries(reply.view.partCounts).map(([p, n]) => `${p} ${n}`).join(", ")}
                </div>
                <div>
                  Portals:{" "}
                  {reply.view.portals.length === 0 ? "none" : reply.view.portals.map((p) => `${p.id} (${p.kind})`).join(", ")}
                </div>
                <div>Layers: {reply.view.layers.map((l) => `${l.layer} ${l.placed}`).join(", ")}</div>
                <div className="text-xs text-zinc-400">
                  Provenance: {reply.provenance.who} · {reply.provenance.what} · {reply.provenance.when} · {reply.provenance.where} ·
                  why {reply.provenance.why} · {reply.provenance.how.theme}
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">Paint the layout, then re-bake to see the view.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
