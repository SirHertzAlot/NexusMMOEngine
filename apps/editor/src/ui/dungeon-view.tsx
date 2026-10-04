/**
 * Dungeons tab (ROADMAP E8, DUNGEONS-AND-LOOT.md §3.5) — the baked pool,
 * one dungeon in 3D, and edits saved as a patch over the bake.
 *
 * - Pool: every baked dungeon with its map thumbnail (the bake's --png),
 *   rooms, rank, boss and edit count; "bake more" adds to the pool with
 *   the same CLI as `npm run dungeon:bake`.
 * - 3D view (dungeon-scene.ts): orbit with the mouse; click a room's floor,
 *   a spawn or a prop to select it; drag a selected prop to move it.
 * - Details: a room's role and archetype; a spawn's pin and rank; a prop's
 *   position, remove, or add one where you click with "place prop".
 *
 * Edits go into the patch (inspectors/dungeon-view.ts) with undo; Save
 * writes `<id>.patch.json` after the host validates it. Presentation only.
 */

import * as React from "react";
import {
  dungeonView,
  editPatch,
  emptyPatch,
  ROOM_TYPES,
  type DungeonEdit,
  type DungeonFileView,
  type DungeonPatch,
  type PatchIssue,
  type RoomType,
} from "../inspectors/dungeon-view.js";
import type { PoolEntry } from "../dungeon-host.js";
import { DungeonScene, type Pick } from "./dungeon-scene.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, SectionTitle } from "./components.js";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body });
  return body;
}

export function DungeonPanel(): React.JSX.Element {
  const [pool, setPool] = React.useState<PoolEntry[]>([]);
  const [archetypes, setArchetypes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [dungeon, setDungeon] = React.useState<DungeonFileView | null>(null);
  const [patch, setPatch] = React.useState<DungeonPatch | null>(null);
  const [saved, setSaved] = React.useState<string>("");
  const [undo, setUndo] = React.useState<DungeonPatch[]>([]);
  const [redo, setRedo] = React.useState<DungeonPatch[]>([]);
  const [selected, setSelected] = React.useState<Pick>(null);
  const [placing, setPlacing] = React.useState(false);
  const [issues, setIssues] = React.useState<PatchIssue[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [bake, setBake] = React.useState({ count: 3, seed: "random", rank: "" });
  const [baking, setBaking] = React.useState(false);

  const refreshPool = React.useCallback(async () => {
    try {
      const r = await getJson<{ dungeons: PoolEntry[]; archetypes: string[] }>("/api/editor/dungeons");
      setPool(r.dungeons);
      setArchetypes(r.archetypes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => void refreshPool(), [refreshPool]);

  const open = async (id: string): Promise<void> => {
    setError(null);
    setIssues([]);
    setNotice(null);
    try {
      const r = await getJson<{ dungeon: DungeonFileView; patch: DungeonPatch | null }>(`/api/editor/dungeons/${id}`);
      const p = r.patch && r.patch.hash === r.dungeon.hash ? r.patch : emptyPatch(r.dungeon);
      if (r.patch && r.patch.hash !== r.dungeon.hash) setNotice("Its saved patch is stale (made for another layout) and was not loaded.");
      setDungeon(r.dungeon);
      setPatch(p);
      setSaved(JSON.stringify(p));
      setUndo([]);
      setRedo([]);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** `merge`: part of the drag the last edit started (one undo step per drag). */
  const edit = (e: DungeonEdit, merge = false): void => {
    if (!dungeon || !patch) return;
    try {
      const next = editPatch(dungeon, patch, e);
      if (!merge) setUndo((u) => [...u.slice(-199), patch]);
      setRedo([]);
      setPatch(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async (): Promise<void> => {
    if (!dungeon || !patch) return;
    setIssues([]);
    try {
      const r = await getJson<{ edits: number }>(`/api/editor/dungeons/${dungeon.id}/patch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      setSaved(JSON.stringify(patch));
      setNotice(r.edits ? `Saved ${r.edits} edit${r.edits === 1 ? "" : "s"} to ${dungeon.id}.patch.json.` : "No edits: the patch file was removed.");
      void refreshPool();
    } catch (e) {
      setIssues((e as { body?: { issues?: PatchIssue[] } }).body?.issues ?? [{ path: "", message: e instanceof Error ? e.message : String(e) }]);
    }
  };

  const runBake = async (): Promise<void> => {
    setBaking(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { count: Number(bake.count) };
      if (bake.seed.trim()) body.seed = bake.seed.trim() === "random" ? "random" : Number(bake.seed);
      if (bake.rank.trim()) body.rank = Number(bake.rank);
      const r = await getJson<{ log: string }>("/api/editor/dungeons/bake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setNotice(r.log.split("\n").pop() ?? "baked");
      await refreshPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBaking(false);
    }
  };

  const view = React.useMemo(() => (dungeon && patch ? dungeonView(dungeon, patch) : null), [dungeon, patch]);
  const dirty = patch !== null && JSON.stringify(patch) !== saved;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr_300px]" data-testid="dungeon-panel">
      <Card>
        <CardHeader>
          <CardTitle>Dungeon pool</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-xs">
          <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto" data-testid="dungeon-pool">
            {pool.map((d) => (
              <li key={d.id}>
                <button
                  className={"flex w-full gap-2 rounded p-1.5 text-left hover:bg-accent " + (dungeon?.id === d.id ? "bg-accent" : "")}
                  onClick={() => void open(d.id)}
                >
                  {d.map ? (
                    <img src={`/api/editor/dungeons/${d.id}/map.png`} alt="" className="h-14 w-14 shrink-0 rounded object-cover [image-rendering:pixelated]" />
                  ) : (
                    <span className="h-14 w-14 shrink-0 rounded bg-secondary" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{d.name}</span>
                    <span className="block text-muted-foreground">
                      {d.theme} · {d.rooms} rooms{d.rank ? ` · rank ${d.rank}` : ""}
                    </span>
                    <span className="block text-muted-foreground">
                      {d.boss ? `boss ${d.boss}` : ""}
                      {d.edits > 0 && <span className="ml-1 text-amber-300">● {d.edits} edits</span>}
                      {d.stale && <span className="ml-1 text-red-400">stale patch</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {pool.length === 0 && <li className="text-muted-foreground">The pool is empty: bake some below.</li>}
          </ul>
          <div className="border-t border-border pt-2">
            <SectionTitle>Bake more</SectionTitle>
            <div className="mt-1 grid grid-cols-[1fr_1.6fr_1fr] gap-1.5">
              <label>
                <Label>count</Label>
                <Input value={String(bake.count)} onChange={(e) => setBake({ ...bake, count: Number(e.target.value) || 1 })} />
              </label>
              <label>
                <Label>seed</Label>
                <Input value={bake.seed} onChange={(e) => setBake({ ...bake, seed: e.target.value })} />
              </label>
              <label>
                <Label>rank</Label>
                <Input value={bake.rank} placeholder="1-5" onChange={(e) => setBake({ ...bake, rank: e.target.value })} />
              </label>
            </div>
            <Button size="sm" className="mt-2 w-full" onClick={() => void runBake()} disabled={baking}>
              {baking ? "Baking…" : "Bake into the pool"}
            </Button>
          </div>
          {error && <p className="text-red-400">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{dungeon ? dungeon.name : "Dungeon"}</CardTitle>
            {dungeon && (
              <div className="flex items-center gap-1.5">
                {dirty && <Badge tone="warn">unsaved</Badge>}
                {view && view.edits > 0 && <Badge tone="info">{view.edits} edits</Badge>}
                <Button size="sm" variant={placing ? "default" : "outline"} onClick={() => setPlacing((p) => !p)}>
                  {placing ? "Click the floor…" : "Place prop"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={undo.length === 0}
                  onClick={() => {
                    setRedo((r) => [...r, patch!]);
                    setPatch(undo[undo.length - 1]);
                    setUndo((u) => u.slice(0, -1));
                  }}
                >
                  Undo
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={redo.length === 0}
                  onClick={() => {
                    setUndo((u) => [...u, patch!]);
                    setPatch(redo[redo.length - 1]);
                    setRedo((r) => r.slice(0, -1));
                  }}
                >
                  Redo
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={!dirty}>
                  Save patch
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {view ? (
            <DungeonCanvas
              view={view}
              selected={selected}
              placing={placing}
              onPick={setSelected}
              onMove={(key, x, y, first) => edit({ kind: "moveProp", key, x, y }, !first)}
              onPlace={(x, y) => {
                setPlacing(false);
                edit({ kind: "addProp", prop: { kind: "crate", x, y, rot: 0 } });
                setSelected({ kind: "prop", key: `a${patch!.added.length}` });
              }}
            />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">Pick a dungeon from the pool.</p>
          )}
          {view && (
            <p className="mt-2 text-xs text-muted-foreground">
              Floor tints: <span className="text-emerald-400">entrance</span> · <span className="text-slate-400">combat</span> ·{" "}
              <span className="text-amber-400">elite</span> · <span className="text-yellow-300">treasure</span> · <span className="text-violet-400">shrine</span> ·{" "}
              <span className="text-red-400">boss</span>. Spheres: spawns by tier (green 1, amber 2, red 3). Blocks: props (grey layout, lilac dressing, cyan
              edited or added). Drag to orbit, wheel to zoom, right-drag to pan.
            </p>
          )}
          {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
          {issues.length > 0 && (
            <div className="mt-2 rounded-md border border-red-900 bg-red-950/40 p-2 text-xs text-red-200" data-testid="patch-issues">
              <p className="font-semibold">Patch not saved:</p>
              <ul className="mt-1 font-mono">
                {issues.map((i, n) => (
                  <li key={n}>
                    {i.path}: {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="text-xs" data-testid="dungeon-details">
          {view && <Details view={view} selected={selected} archetypes={archetypes} edit={edit} onSelect={setSelected} />}
          {!view && <p className="text-muted-foreground">No dungeon open.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Details({
  view,
  selected,
  archetypes,
  edit,
  onSelect,
}: {
  view: ReturnType<typeof dungeonView>;
  selected: Pick;
  archetypes: string[];
  edit: (e: DungeonEdit) => void;
  onSelect: (p: Pick) => void;
}): React.JSX.Element {
  if (!selected) {
    return (
      <div className="text-muted-foreground">
        <p>
          {view.rooms.length} rooms · {view.spawns.length} spawns · {view.props.length} props · {view.width}×{view.height} cells
          {view.rank !== null ? ` · rank ${view.rank}` : ""}
        </p>
        <p className="mt-2">Click a room's floor, a spawn or a prop in the view.</p>
      </div>
    );
  }
  if (selected.kind === "room") {
    const r = view.rooms.find((x) => x.id === selected.id);
    if (!r) return <p>Room gone.</p>;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-foreground">
          Room {r.id} {r.edited && <span className="text-amber-300">●</span>}
        </p>
        <p className="text-muted-foreground">
          {r.w}×{r.h} · depth {r.depth} · difficulty {r.difficulty.toFixed(2)}
          {r.species ? ` · ${r.species}` : ""}
        </p>
        <label>
          <Label>role (baked: {r.baked})</Label>
          <select
            className="mt-0.5 w-full rounded border border-input bg-background px-1.5 py-1"
            value={r.type}
            onChange={(e) => edit({ kind: "roomType", room: r.id, type: e.target.value as RoomType })}
          >
            {ROOM_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <Label>archetype</Label>
          <select
            className="mt-0.5 w-full rounded border border-input bg-background px-1.5 py-1"
            value={r.archetype}
            onChange={(e) => edit({ kind: "roomArchetype", room: r.id, archetype: e.target.value })}
          >
            <option value="">(none)</option>
            {archetypes.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        {r.edited && (
          <Button size="sm" variant="outline" onClick={() => edit({ kind: "resetRoom", room: r.id })}>
            Back to the bake
          </Button>
        )}
      </div>
    );
  }
  if (selected.kind === "spawn") {
    const s = view.spawns[selected.index];
    if (!s) return <p>Spawn gone.</p>;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-foreground">
          Spawn {s.index} {s.edited && <span className="text-amber-300">●</span>}
        </p>
        <p className="text-muted-foreground">
          tier {s.tier} · room {s.room} · ({s.x}, {s.y}){s.species ? ` · ${s.species}` : ""}
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.pinned} onChange={(e) => edit({ kind: "spawn", index: s.index, pinned: e.target.checked })} />
          <span>Pinned (a re-dress keeps who stands here)</span>
        </label>
        <label>
          <Label>rank</Label>
          <select
            className="mt-0.5 w-full rounded border border-input bg-background px-1.5 py-1"
            value={s.rank}
            onChange={(e) => edit({ kind: "spawn", index: s.index, rank: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "room", id: s.room })}>
          Its room
        </Button>
        {s.edited && (
          <Button size="sm" variant="outline" onClick={() => edit({ kind: "resetSpawn", index: s.index })}>
            Back to the bake
          </Button>
        )}
      </div>
    );
  }
  const p = view.props.find((x) => x.key === selected.key);
  if (!p) return <p className="text-muted-foreground">Prop removed.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-foreground">
        {p.kind} {p.edited && <span className="text-amber-300">●</span>}
      </p>
      <p className="text-muted-foreground">
        {p.key.startsWith("p") ? "layout prop" : p.key.startsWith("d") ? "dressing prop" : "added"} · ({p.x.toFixed(1)}, {p.y.toFixed(1)})
        {p.room >= 0 ? ` · room ${p.room}` : ""}
      </p>
      <p className="text-muted-foreground">Drag it in the view to move it.</p>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          edit({ kind: "removeProp", key: p.key });
          onSelect(null);
        }}
      >
        Remove
      </Button>
    </div>
  );
}

function DungeonCanvas({
  view,
  selected,
  placing,
  onPick,
  onMove,
  onPlace,
}: {
  view: ReturnType<typeof dungeonView>;
  selected: Pick;
  placing: boolean;
  onPick: (p: Pick) => void;
  onMove: (key: string, x: number, y: number, first: boolean) => void;
  onPlace: (x: number, y: number) => void;
}): React.JSX.Element {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const scene = React.useRef<DungeonScene | null>(null);
  const lastId = React.useRef<string | null>(null);
  const drag = React.useRef<{ key: string; moved: boolean } | null>(null);

  React.useEffect(() => {
    const s = new DungeonScene(canvas.current!);
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
      lastId.current = null;
    };
  }, []);
  React.useEffect(() => {
    scene.current?.show(view, selected, lastId.current !== view.id);
    lastId.current = view.id;
  }, [view, selected]);

  return (
    <canvas
      ref={canvas}
      className={"h-[60vh] min-h-[420px] w-full rounded-md border border-border " + (placing ? "cursor-crosshair" : "")}
      data-testid="dungeon-canvas"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const s = scene.current;
        if (!s) return;
        if (placing) {
          const g = s.groundAt(e.clientX, e.clientY);
          if (g) onPlace(g.x, g.y);
          return;
        }
        const hit = s.pick(e.clientX, e.clientY);
        if (hit?.kind === "prop" && selected?.kind === "prop" && selected.key === hit.key) {
          // Dragging the selected prop: the camera holds still.
          s.setOrbit(false);
          drag.current = { key: hit.key, moved: false };
          (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
        }
        (e.currentTarget as HTMLCanvasElement).dataset.downX = String(e.clientX);
        (e.currentTarget as HTMLCanvasElement).dataset.downY = String(e.clientY);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const s = scene.current;
        if (!d || !s) return;
        const g = s.groundAt(e.clientX, e.clientY);
        if (!g) return;
        // The prop follows the pointer; the whole drag is one undo step.
        onMove(d.key, g.x, g.y, !d.moved);
        d.moved = true;
      }}
      onPointerUp={(e) => {
        const s = scene.current;
        const d = drag.current;
        drag.current = null;
        s?.setOrbit(true);
        if (d?.moved || !s || placing) return;
        // A click (not an orbit drag) selects.
        const el = e.currentTarget as HTMLCanvasElement;
        const moved = Math.hypot(e.clientX - Number(el.dataset.downX ?? 0), e.clientY - Number(el.dataset.downY ?? 0));
        if (moved < 5) onPick(s.pick(e.clientX, e.clientY));
      }}
    />
  );
}
