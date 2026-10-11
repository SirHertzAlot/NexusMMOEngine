/**
 * Dungeons tab (ROADMAP E8, DUNGEONS-AND-LOOT.md §3.5) — the baked pool,
 * one dungeon in 3D, and edits saved as a patch over the bake.
 *
 * - Pool: every baked dungeon with its map thumbnail (the bake's --png),
 *   rooms, rank, boss and edit count; "bake more" adds to the pool with
 *   the same CLI as `npm run dungeon:bake`.
 * - 3D view (dungeon-scene.ts): orbit with the mouse; click a room's floor,
 *   a spawn or a prop to select it; drag a prop to move it.
 * - Details: a room's role and archetype; a spawn's pin and rank; a prop's
 *   position, remove, or add one where you click with "place prop".
 *
 * Edits go into the patch (inspectors/dungeon-view.ts) with undo; Save
 * writes `<id>.patch.json` after the host validates it. Presentation only.
 */

import * as React from "react";
import { callEnvelope } from "../api.js";
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
import { getTool } from "./tool-store.js";
import { canDragDungeonProp } from "./viewport-tools.js";
import { useDocActions } from "./doc-actions.js";
import { DocBar } from "./doc-bar.js";
import { useDocument } from "./use-document.js";
import { pushBake } from "../dock-feed.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, SectionTitle, Select, Field, CheckField } from "./components.js";
import { editorSelection } from "./editor-selection.js";

export function DungeonPanel(): React.JSX.Element {
  const [pool, setPool] = React.useState<PoolEntry[]>([]);
  const [archetypes, setArchetypes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [dungeon, setDungeon] = React.useState<DungeonFileView | null>(null);
  const doc = useDocument<DungeonPatch>();
  const patch = doc.value;
  const [selected, setSelected] = React.useState<Pick>(null);
  const pick = (p: Pick): void => {
    setSelected(p);
    if (!p) {
      const cur = editorSelection.get();
      if (cur && (cur.kind === "dungeon-room" || cur.kind === "dungeon-spawn" || cur.kind === "dungeon-prop")) editorSelection.clear();
      return;
    }
    if (p.kind === "room") {
      editorSelection.select({ source: "outliner", kind: "dungeon-room", id: String(p.id), label: `Room ${p.id}`, components: [{ name: "Dungeon room", fields: [{ key: "id", value: String(p.id) }] }] });
    } else if (p.kind === "spawn") {
      editorSelection.select({ source: "outliner", kind: "dungeon-spawn", id: String(p.index), label: `Spawn ${p.index}`, components: [{ name: "Dungeon spawn", fields: [{ key: "index", value: String(p.index) }] }] });
    } else {
      editorSelection.select({ source: "outliner", kind: "dungeon-prop", id: p.key, label: `Prop ${p.key}`, components: [{ name: "Dungeon prop", fields: [{ key: "key", value: p.key }] }] });
    }
  };
  const [placing, setPlacing] = React.useState(false);  const [issues, setIssues] = React.useState<PatchIssue[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [bake, setBake] = React.useState({ count: 3, seed: "random", rank: "" });
  const [baking, setBaking] = React.useState(false);

  const refreshPool = React.useCallback(async () => {
    try {
      const r = await callEnvelope<{ dungeons: PoolEntry[]; archetypes: string[] }>("/api/editor/dungeons", "GET");
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
      const r = await callEnvelope<{ dungeon: DungeonFileView; patch: DungeonPatch | null }>(`/api/editor/dungeons/${id}`, "GET");
      const p = r.patch && r.patch.hash === r.dungeon.hash ? r.patch : emptyPatch(r.dungeon);
      if (r.patch && r.patch.hash !== r.dungeon.hash) setNotice("Its saved patch is stale (made for another layout) and was not loaded.");
      setDungeon(r.dungeon);
      doc.load(p);
      pick(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** `merge`: part of the drag the last edit started (one undo step per drag). */
  const edit = (e: DungeonEdit, merge = false): void => {
    if (!dungeon || !patch) return;
    try {
      const next = editPatch(dungeon, patch, e);
      doc.edit(next, { merge });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async (): Promise<void> => {
    if (!dungeon || !patch) return;
    setIssues([]);
    try {
      const r = await callEnvelope<{ edits: number }>(`/api/editor/dungeons/${dungeon.id}/patch`, "PUT", { patch });
      doc.markSaved(patch);
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
      const r = await callEnvelope<{ log: string }>("/api/editor/dungeons/bake", "POST", body);
      const last = r.log.split("\n").pop() ?? "baked";
      setNotice(last);
      pushBake("dungeons", last || "baked");
      await refreshPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      pushBake("dungeons", `bake failed: ${e instanceof Error ? e.message : String(e)}`, false);
    } finally {
      setBaking(false);
    }
  };

  const view = React.useMemo(() => (dungeon && patch ? dungeonView(dungeon, patch) : null), [dungeon, patch]);
  const dirty = doc.dirty;

  // Toolbar Save/Undo/Redo target while a dungeon is open.
  useDocActions(() => {
    if (!dungeon || !patch) return null;
    return {
      label: `dungeon "${dungeon.id}"`,
      canSave: dirty,
      ...doc.history,
      save: () => void save(),
      canRevert: dirty,
      revert: () => void open(dungeon.id),
      exportDoc: () => ({ name: `${dungeon.id}.patch`, data: patch }),
      importDoc: (incoming: unknown) => {
        const p = incoming as typeof patch;
        if (p.hash !== dungeon.hash) throw new Error(`this patch was made for another layout of ${dungeon.id}`);
        doc.edit(p);
      },
    };
  });

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
              <Field label="count">
                <Input value={String(bake.count)} onChange={(e) => setBake({ ...bake, count: Number(e.target.value) || 1 })} />
              </Field>
              <Field label="seed">
                <Input value={bake.seed} onChange={(e) => setBake({ ...bake, seed: e.target.value })} />
              </Field>
              <Field label="rank">
                <Input value={bake.rank} placeholder="1-5" onChange={(e) => setBake({ ...bake, rank: e.target.value })} />
              </Field>
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
                <DocBar dirty={dirty} history={doc.history} saveLabel="Save patch" onSave={() => void save()} />
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
              onPick={pick}
              onMove={(key, x, y, first) => edit({ kind: "moveProp", key, x, y }, !first)}
              onPlace={(x, y) => {
                setPlacing(false);
                edit({ kind: "addProp", prop: { kind: "crate", x, y, rot: 0 } });
                pick({ kind: "prop", key: `a${patch!.added.length}` });
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
              edited or added). Move tool: drag the selected prop to move it. Select: drag to orbit, wheel to zoom, right-drag to pan.
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
          {view && <Details view={view} selected={selected} archetypes={archetypes} edit={edit} onSelect={pick} />}
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
        <Field label={`role (baked: ${r.baked})`}>
          <Select size="xs" className="mt-0.5 w-full"
            value={r.type}
            onChange={(e) => edit({ kind: "roomType", room: r.id, type: e.target.value as RoomType })}
          >
            {ROOM_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="archetype">
          <Select size="xs" className="mt-0.5 w-full"
            value={r.archetype}
            onChange={(e) => edit({ kind: "roomArchetype", room: r.id, archetype: e.target.value })}
          >
            <option value="">(none)</option>
            {archetypes.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </Select>
        </Field>
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
        <CheckField checked={s.pinned} onChange={(pinned) => edit({ kind: "spawn", index: s.index, pinned })} label="Pinned (a re-dress keeps who stands here)" />
        <Field label="rank">
          <Select size="xs" className="mt-0.5 w-full"
            value={s.rank}
            onChange={(e) => edit({ kind: "spawn", index: s.index, rank: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
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
        // Dragging any prop with the move tool: the camera holds still for
        // this gesture. Otherwise the gesture orbits (select stays the
        // camera/pick default). A press without a move still just selects.
        if (hit?.kind === "prop" && canDragDungeonProp(getTool())) {
          s.setOrbit(false);
          drag.current = { key: hit.key, moved: false };
          onPick(hit);
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
