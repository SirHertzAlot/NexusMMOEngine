/**
 * Dungeon view (ROADMAP E8, DUNGEONS-AND-LOOT.md §3.5) — the model and
 * view-model for one baked dungeon and the edits made over it, in pure TS
 * (no React, no DOM, no Node), like inspectors/ecs.ts.
 *
 * A baked dungeon (`<id>.dungeon.json`, packages/dungeon format.ts) is
 * never rewritten. Edits are a **patch** beside it (`<id>.patch.json`),
 * bound to the layout's content hash:
 *
 *   { format: "mmo-dungeon-patch/1", dungeon, hash,
 *     rooms:  { "<room id>": { type?, archetype? } },
 *     spawns: { "<spawn index>": { pinned?, rank?, species? } },
 *     props:  { "p<i>" | "d<i>": { x, y, rot? } | { removed: true } },
 *     added:  [ { kind, x, y, rot } ] }
 *
 * `p<i>` is the layout's prop i (decor, on whole cells: a prop at (x, y)
 * stands in that cell), `d<i>` the dressing's prop i (continuous: cell
 * (i, j) spans [i, i+1)). Each edit is in its source's units; the view
 * puts both in continuous units.
 * Because a bake never re-bakes a layout already in the pool (same hash),
 * a re-bake keeps the patch valid; a patch whose hash no longer matches
 * is reported stale rather than applied to the wrong layout. Turning the
 * patch into WFC pins for the dressing and population passes is the
 * dungeon package's next step.
 */

export const PATCH_FORMAT = "mmo-dungeon-patch/1";
export const ROOM_TYPES = ["entrance", "combat", "elite", "treasure", "shrine", "boss"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
/** Grid cell values (packages/dungeon CELL). */
export const CELL = { void: 0, floor: 1, wall: 2, pool: 3 } as const;
/** The highest rank a spawn can be set to (the rank ladder's default length, packages/compose). */
export const MAX_RANK = 5;

/** The parts of a baked dungeon file the view reads. */
export interface DungeonFileView {
  format: string;
  id: string;
  hash: string;
  name: string;
  width: number;
  height: number;
  params: { theme: string };
  rooms: Array<{ id: number; cx: number; cy: number; w: number; h: number; type: RoomType; depth: number; difficulty: number; size: string; shape: string }>;
  corridors: Array<{ a: number; b: number; loop: boolean; critical: boolean }>;
  props: Array<{ kind: string; x: number; y: number; rot: number; scale?: number; room?: number }>;
  spawns: Array<{ x: number; y: number; tier: number; room: number }>;
  torches: Array<{ x: number; y: number; dx: number; dy: number }>;
  entrance: number;
  boss: number;
  grids: { grid: string; roomId: string; [k: string]: string };
  dressing?: { rank: number; archetypes: string[]; props: Array<{ kind: string; x: number; y: number; rot: number; room: number; mount: boolean }>; resources?: unknown[] };
  population?: { rooms: string[]; spawns: Array<{ x: number; y: number; tier: number; room: number; species: string }> };
}

export interface PropEdit {
  x?: number;
  y?: number;
  rot?: number;
  removed?: boolean;
}

export interface DungeonPatch {
  format: typeof PATCH_FORMAT;
  dungeon: string;
  hash: string;
  rooms: Record<string, { type?: RoomType; archetype?: string }>;
  spawns: Record<string, { pinned?: boolean; rank?: number; species?: string }>;
  props: Record<string, PropEdit>;
  added: Array<{ kind: string; x: number; y: number; rot: number }>;
}

export function emptyPatch(d: Pick<DungeonFileView, "id" | "hash">): DungeonPatch {
  return { format: PATCH_FORMAT, dungeon: d.id, hash: d.hash, rooms: {}, spawns: {}, props: {}, added: [] };
}

/** Base64 to bytes, in the browser (atob) and in Node (Buffer). */
export function base64Bytes(s: string): Uint8Array {
  const g = globalThis as unknown as { Buffer?: { from(s: string, e: string): Uint8Array }; atob?: (s: string) => string };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(s, "base64"));
  const bin = g.atob!(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PatchIssue {
  path: string;
  message: string;
}

/** Everything wrong with `patch` for dungeon `d` (empty: it applies cleanly). */
export function validatePatch(d: DungeonFileView, patch: unknown, archetypes?: readonly string[]): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const p = patch as Partial<DungeonPatch> | null;
  if (!p || typeof p !== "object") return [{ path: "", message: "patch must be an object" }];
  if (p.format !== PATCH_FORMAT) issues.push({ path: "format", message: `format must be ${PATCH_FORMAT}` });
  if (p.dungeon !== d.id) issues.push({ path: "dungeon", message: `patch is for ${String(p.dungeon)}, not ${d.id}` });
  if (p.hash !== d.hash) issues.push({ path: "hash", message: "stale: the layout's hash doesn't match (re-baked or replaced)" });
  const grid = base64Bytes(d.grids.grid);
  const floorAt = (x: number, y: number): boolean => {
    const i = Math.floor(y) * d.width + Math.floor(x);
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < d.width && y < d.height && (grid[i] === CELL.floor || grid[i] === CELL.pool);
  };
  for (const [id, edit] of Object.entries(p.rooms ?? {})) {
    const where = `rooms.${id}`;
    if (!d.rooms.some((r) => String(r.id) === id)) issues.push({ path: where, message: `no room ${id}` });
    if (edit.type !== undefined && !ROOM_TYPES.includes(edit.type)) issues.push({ path: `${where}.type`, message: `unknown room type ${String(edit.type)}` });
    if (edit.archetype !== undefined && edit.archetype !== "" && archetypes && !archetypes.includes(edit.archetype)) {
      issues.push({ path: `${where}.archetype`, message: `unknown archetype ${edit.archetype}` });
    }
  }
  const types = d.rooms.map((r) => p.rooms?.[String(r.id)]?.type ?? r.type);
  for (const must of ["entrance", "boss"] as const) {
    const n = types.filter((t) => t === must).length;
    if (n !== 1) issues.push({ path: "rooms", message: `a dungeon needs exactly one ${must} room (the patch makes ${n})` });
  }
  for (const [i, edit] of Object.entries(p.spawns ?? {})) {
    const where = `spawns.${i}`;
    if (!/^\d+$/.test(i) || Number(i) >= d.spawns.length) issues.push({ path: where, message: `no spawn ${i}` });
    if (edit.rank !== undefined && (!Number.isInteger(edit.rank) || edit.rank < 1 || edit.rank > MAX_RANK)) {
      issues.push({ path: `${where}.rank`, message: `rank must be a whole number 1–${MAX_RANK}` });
    }
  }
  const layoutProps = d.props.length;
  const dressProps = d.dressing?.props.length ?? 0;
  for (const [key, edit] of Object.entries(p.props ?? {})) {
    const where = `props.${key}`;
    const m = /^([pd])(\d+)$/.exec(key);
    if (!m || Number(m[2]) >= (m[1] === "p" ? layoutProps : dressProps)) {
      issues.push({ path: where, message: `no prop ${key}` });
      continue;
    }
    if (!edit.removed && (edit.x !== undefined || edit.y !== undefined)) {
      const base = m[1] === "p" ? d.props[Number(m[2])] : d.dressing!.props[Number(m[2])];
      const half = m[1] === "p" ? 0.5 : 0;
      if (!floorAt((edit.x ?? base.x) + half, (edit.y ?? base.y) + half)) issues.push({ path: where, message: "a prop must stand on a floor cell" });
    }
  }
  (p.added ?? []).forEach((a, i) => {
    if (typeof a?.kind !== "string" || !a.kind) issues.push({ path: `added.${i}`, message: "an added prop needs a kind" });
    else if (!floorAt(a.x, a.y)) issues.push({ path: `added.${i}`, message: "a prop must stand on a floor cell" });
  });
  return issues;
}

// ---- view-model -------------------------------------------------------------

export interface RoomView {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  type: RoomType;
  baked: RoomType;
  archetype: string;
  species: string;
  depth: number;
  difficulty: number;
  edited: boolean;
}

export interface SpawnView {
  index: number;
  x: number;
  y: number;
  tier: number;
  room: number;
  species: string;
  rank: number;
  pinned: boolean;
  edited: boolean;
}

export interface PropView {
  /** `p<i>` (layout), `d<i>` (dressing) or `a<i>` (added by the patch). */
  key: string;
  kind: string;
  x: number;
  y: number;
  rot: number;
  room: number;
  edited: boolean;
}

export interface DungeonView {
  id: string;
  name: string;
  theme: string;
  width: number;
  height: number;
  /** CELL per cell, row-major. */
  grid: Uint8Array;
  /** Room id per cell (-1: none), row-major. */
  roomId: Int16Array;
  rooms: RoomView[];
  spawns: SpawnView[];
  props: PropView[];
  torches: DungeonFileView["torches"];
  corridors: DungeonFileView["corridors"];
  rank: number | null;
  edits: number;
}

function int16(bytes: Uint8Array): Int16Array {
  const copy = new Uint8Array(bytes);
  return new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
}

/** The dungeon as it plays with the patch applied. */
export function dungeonView(d: DungeonFileView, patch: DungeonPatch): DungeonView {
  const rankAll = d.dressing?.rank ?? 1;
  const rooms = d.rooms.map((r): RoomView => {
    const e = patch.rooms[String(r.id)] ?? {};
    return {
      id: r.id,
      cx: r.cx,
      cy: r.cy,
      w: r.w,
      h: r.h,
      type: e.type ?? r.type,
      baked: r.type,
      archetype: e.archetype ?? d.dressing?.archetypes[r.id] ?? "",
      species: d.population?.rooms[r.id] ?? "",
      depth: r.depth,
      difficulty: r.difficulty,
      edited: e.type !== undefined || e.archetype !== undefined,
    };
  });
  const spawns = d.spawns.map((s, index): SpawnView => {
    const e = patch.spawns[String(index)] ?? {};
    return {
      index,
      x: s.x,
      y: s.y,
      tier: s.tier,
      room: s.room,
      species: e.species ?? d.population?.spawns[index]?.species ?? "",
      rank: e.rank ?? rankAll,
      pinned: e.pinned === true,
      edited: Object.keys(e).length > 0,
    };
  });
  const props: PropView[] = [];
  const addProp = (key: string, base: { kind: string; x: number; y: number; rot: number; room?: number }, half: number): void => {
    const e = patch.props[key];
    if (e?.removed) return;
    props.push({ key, kind: base.kind, x: (e?.x ?? base.x) + half, y: (e?.y ?? base.y) + half, rot: e?.rot ?? base.rot, room: base.room ?? -1, edited: e !== undefined });
  };
  d.props.forEach((p, i) => addProp(`p${i}`, p, 0.5));
  (d.dressing?.props ?? []).forEach((p, i) => addProp(`d${i}`, p, 0));
  patch.added.forEach((a, i) => props.push({ key: `a${i}`, kind: a.kind, x: a.x, y: a.y, rot: a.rot, room: -1, edited: true }));
  return {
    id: d.id,
    name: d.name,
    theme: d.params.theme,
    width: d.width,
    height: d.height,
    grid: base64Bytes(d.grids.grid),
    roomId: int16(base64Bytes(d.grids.roomId)),
    rooms,
    spawns,
    props,
    torches: d.torches,
    corridors: d.corridors,
    rank: d.dressing?.rank ?? null,
    edits: countEdits(patch),
  };
}

export function countEdits(p: DungeonPatch): number {
  return Object.keys(p.rooms).length + Object.keys(p.spawns).length + Object.keys(p.props).length + p.added.length;
}

// ---- edits ------------------------------------------------------------------

export type DungeonEdit =
  | { kind: "roomType"; room: number; type: RoomType }
  | { kind: "roomArchetype"; room: number; archetype: string }
  | { kind: "spawn"; index: number; pinned?: boolean; rank?: number }
  /** x, y in the view's continuous units. */
  | { kind: "moveProp"; key: string; x: number; y: number }
  | { kind: "removeProp"; key: string }
  | { kind: "addProp"; prop: { kind: string; x: number; y: number; rot: number } }
  | { kind: "resetRoom"; room: number }
  | { kind: "resetSpawn"; index: number };

function cleaned<T extends object>(o: T): T | undefined {
  return Object.values(o).some((v) => v !== undefined) ? o : undefined;
}

/** `patch` with one edit made (a new object; the old one is unchanged, for undo). */
export function editPatch(d: DungeonFileView, patch: DungeonPatch, e: DungeonEdit): DungeonPatch {
  const next: DungeonPatch = JSON.parse(JSON.stringify(patch)) as DungeonPatch;
  const setRoom = (id: number, change: { type?: RoomType; archetype?: string }): void => {
    const base = d.rooms.find((r) => r.id === id);
    if (!base) throw new Error(`no room ${id}`);
    const cur = { ...(next.rooms[String(id)] ?? {}), ...change };
    // Back to the baked value: drop the edit.
    if (cur.type === base.type) delete cur.type;
    if (cur.archetype !== undefined && cur.archetype === (d.dressing?.archetypes[id] ?? "")) delete cur.archetype;
    const kept = cleaned(cur);
    if (kept) next.rooms[String(id)] = kept;
    else delete next.rooms[String(id)];
  };
  switch (e.kind) {
    case "roomType":
      setRoom(e.room, { type: e.type });
      break;
    case "roomArchetype":
      setRoom(e.room, { archetype: e.archetype });
      break;
    case "resetRoom":
      delete next.rooms[String(e.room)];
      break;
    case "spawn": {
      const cur = { ...(next.spawns[String(e.index)] ?? {}) };
      if (e.pinned !== undefined) cur.pinned = e.pinned || undefined;
      if (e.rank !== undefined) cur.rank = e.rank === (d.dressing?.rank ?? 1) ? undefined : e.rank;
      const kept = cleaned(cur);
      if (kept) next.spawns[String(e.index)] = JSON.parse(JSON.stringify(kept)) as typeof kept;
      else delete next.spawns[String(e.index)];
      break;
    }
    case "resetSpawn":
      delete next.spawns[String(e.index)];
      break;
    case "moveProp": {
      const x = Math.round(e.x * 100) / 100;
      const y = Math.round(e.y * 100) / 100;
      if (e.key.startsWith("a")) {
        const a = next.added[Number(e.key.slice(1))];
        if (!a) throw new Error(`no prop ${e.key}`);
        a.x = x;
        a.y = y;
      } else {
        // A layout prop's units are whole cells (the view's x − ½).
        const half = e.key.startsWith("p") ? 0.5 : 0;
        next.props[e.key] = { ...(next.props[e.key] ?? {}), x: Math.round((x - half) * 100) / 100, y: Math.round((y - half) * 100) / 100 };
      }
      break;
    }
    case "removeProp":
      if (e.key.startsWith("a")) next.added.splice(Number(e.key.slice(1)), 1);
      else next.props[e.key] = { removed: true };
      break;
    case "addProp":
      next.added.push({ ...e.prop, x: Math.round(e.prop.x * 100) / 100, y: Math.round(e.prop.y * 100) / 100 });
      break;
  }
  return next;
}
