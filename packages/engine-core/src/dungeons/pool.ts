/**
 * The dungeon pool as an instance reads it (roadmap D4): the layouts
 * `npm run dungeon:bake` wrote to `<data>/dungeons` (index.json plus one
 * `<id>.dungeon.json` each, format "mmo-dungeon/1", see
 * @mmo-engine/dungeon format.ts). Starting an instance reads files and
 * generates nothing.
 *
 * Only what a run needs is decoded: the walkable cells, the rooms (entrance
 * and boss), and the spawn points with the species the bake populated them
 * with. Cells are DUNGEON_CELL (2 m) square; cell (x, y) is world
 * ((x + 0.5) * 2, (y + 0.5) * 2) in the instance's own space.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Metres per layout cell (@mmo-engine/dungeon DUNGEON_CELL). */
export const CELL_M = 2;
/** Layout cell values (@mmo-engine/dungeon CELL). */
const FLOOR = 1;
const POOL = 3;

export interface PoolEntry {
  id: string;
  file: string;
  name: string;
  theme: string;
  rank?: number;
  rooms: number;
  width: number;
  height: number;
  /** The prebaked shell (`dungeon:bake` without --no-shell): a PCGM mesh file beside the layout. */
  shell?: { file: string };
}

/** A baked prop to stand in the run (props.json says which kinds spawn). Metres, in the instance's space. */
export interface LayoutProp {
  /** The kind (pillar, brazier, barrel, torch…): a props.json key. */
  kind: string;
  x: number;
  z: number;
  /** Turn about the vertical axis, radians (a wall-mounted kind faces out of its wall). */
  yaw: number;
  scale: number;
  /** Footprint radius the bake gave a dressing prop; 0: the table's own. */
  radius: number;
}

export interface LayoutSpawn {
  x: number;
  z: number;
  tier: number;
  room: number;
  /** The species the bake put here ("" or absent: unpopulated). */
  species: string;
}

/** One part of a room's interior: a model the grammar placed (content/synthesis). */
export interface LayoutPlacement {
  /** The model the part draws (its catalog asset id). */
  assetRef: string;
  /** Offset from the room's origin, metres. */
  pos: [number, number, number];
  /** Rotation quaternion, x y z w. */
  rot: [number, number, number, number];
  /** Scale per axis, metres. */
  scale: [number, number, number];
}

/** A room's interior: its parts stand about the origin, a point in the instance's space (metres). */
export interface LayoutInterior {
  room: number;
  origin: [number, number];
  placements: LayoutPlacement[];
}

export interface InstanceLayout {
  id: string;
  name: string;
  theme: string;
  rank: number | null;
  width: number;
  height: number;
  /** 1 where a body may stand (floor and shallow pools). */
  walkable: Uint8Array;
  /** World position of the entrance room's centre. */
  entrance: { x: number; z: number };
  /** The entrance room's id (chests and traps never spawn there). */
  entranceRoom: number;
  bossRoom: number;
  /** Room centres in world coordinates, for chest placement. */
  rooms: { id: number; x: number; z: number }[];
  spawns: LayoutSpawn[];
  /** Round props that block bodies, flat [x, z, radius] in metres (baked `colliders`, grid cells). */
  colliders: Float64Array;
  /** Absolute path of the baked shell mesh (absent: the dungeon was baked without one). */
  shell?: string;
  /** Everything baked to stand in the rooms: layout props, the dressing's furniture, torches. */
  props: LayoutProp[];
  /** The room interiors the bake laid (the interior grammar's walls and floors); absent: none laid. */
  interiors?: LayoutInterior[];
}

interface DungeonFileLike {
  format: string;
  id: string;
  name: string;
  params: { theme: string };
  width: number;
  height: number;
  rooms: { id: number; cx: number; cy: number }[];
  entrance: number;
  boss: number;
  spawns: { x: number; y: number; tier: number; room: number }[];
  grids: { grid: string };
  dressing?: { rank: number; props?: { kind: string; x: number; y: number; rot?: number; radius?: number }[] };
  props?: { kind: string; x: number; y: number; rot?: number; scale?: number; dx?: number; dy?: number }[];
  torches?: { x: number; y: number; dx: number; dy: number }[];
  colliders?: { x: number; y: number; r: number }[];
  population?: { spawns: { x: number; y: number; species: string }[] };
  interiors?: { room: number; origin: [number, number]; placements: { assetRef: string; transform: { pos: [number, number, number]; rot: [number, number, number, number]; scale: [number, number, number] } }[] }[];
}

export const cellCentre = (c: number): number => (c + 0.5) * CELL_M;

/** Decode a baked dungeon file into what an instance runs on. */
export function readLayout(json: unknown): InstanceLayout {
  const f = json as DungeonFileLike;
  if (!f || f.format !== "mmo-dungeon/1") throw new Error(`not an mmo-dungeon/1 file (format: ${String(f?.format)})`);
  const grid = Buffer.from(f.grids.grid, "base64");
  if (grid.length !== f.width * f.height) throw new Error(`${f.id}: grid has ${grid.length} cells, expected ${f.width * f.height}`);
  const walkable = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) walkable[i] = grid[i] === FLOOR || grid[i] === POOL ? 1 : 0;
  const entrance = f.rooms.find((r) => r.id === f.entrance) ?? f.rooms[0];
  const species = new Map<string, string>();
  for (const s of f.population?.spawns ?? []) species.set(`${s.x},${s.y}`, s.species);
  const colliders = new Float64Array((f.colliders?.length ?? 0) * 3);
  f.colliders?.forEach((c, i) => colliders.set([c.x * CELL_M, c.y * CELL_M, c.r * CELL_M], i * 3));
  // Grid cells are continuous (cell (i, j) spans [i, i+1)), so a prop at (x, y) stands at x * CELL_M: the colliders' convention.
  // A kind with a wall to face (dx, dy) turns to face out of it; the rest keep the bake's own turn.
  const facing = (p: { rot?: number; dx?: number; dy?: number }): number => (p.dx !== undefined && p.dy !== undefined ? Math.atan2(p.dx, p.dy) : (p.rot ?? 0));
  const props: LayoutProp[] = [
    ...(f.props ?? []).map((p) => ({ kind: p.kind, x: p.x * CELL_M, z: p.y * CELL_M, yaw: facing(p), scale: p.scale ?? 1, radius: 0 })),
    ...(f.dressing?.props ?? []).map((p) => ({ kind: p.kind, x: p.x * CELL_M, z: p.y * CELL_M, yaw: p.rot ?? 0, scale: 1, radius: (p.radius ?? 0) * CELL_M })),
    ...(f.torches ?? []).map((t) => ({ kind: "torch", x: t.x * CELL_M, z: t.y * CELL_M, yaw: facing(t), scale: 1, radius: 0 })),
  ];
  return {
    id: f.id,
    name: f.name,
    theme: f.params.theme,
    rank: f.dressing?.rank ?? null,
    width: f.width,
    height: f.height,
    walkable,
    entrance: { x: cellCentre(Math.round(entrance.cx)), z: cellCentre(Math.round(entrance.cy)) },
    entranceRoom: f.entrance,
    bossRoom: f.boss,
    rooms: f.rooms.map((r) => ({ id: r.id, x: cellCentre(Math.round(r.cx)), z: cellCentre(Math.round(r.cy)) })),
    spawns: f.spawns.map((s) => ({ x: cellCentre(s.x), z: cellCentre(s.y), tier: s.tier, room: s.room, species: species.get(`${s.x},${s.y}`) ?? "" })),
    colliders,
    props,
    interiors: (f.interiors ?? []).map((r) => ({
      room: r.room,
      origin: r.origin,
      placements: r.placements.map((p) => ({ assetRef: p.assetRef, pos: p.transform.pos, rot: p.transform.rot, scale: p.transform.scale })),
    })),
  };
}

/** Is world (x, z) on a walkable cell of the layout? */
export function walkableAt(l: InstanceLayout, x: number, z: number): boolean {
  const cx = Math.floor(x / CELL_M);
  const cy = Math.floor(z / CELL_M);
  return cx >= 0 && cy >= 0 && cx < l.width && cy < l.height && l.walkable[cy * l.width + cx] === 1;
}

export class DungeonPool {
  readonly entries: PoolEntry[];

  constructor(private readonly dir: string) {
    const index = join(dir, "index.json");
    if (!existsSync(index)) {
      this.entries = [];
      return;
    }
    const parsed = JSON.parse(readFileSync(index, "utf8")) as { format?: string; dungeons?: PoolEntry[] };
    if (parsed.format !== "mmo-dungeon-index/1" || !Array.isArray(parsed.dungeons)) throw new Error(`${index}: not a dungeon pool index`);
    this.entries = parsed.dungeons;
  }

  /** Entries an entrance may draw from: its rank (null: any) and themes (empty: any). */
  matching(rank: number | null, themes: readonly string[]): PoolEntry[] {
    return this.entries.filter((e) => (rank === null || e.rank === rank) && (themes.length === 0 || themes.includes(e.theme)));
  }

  /** One matching layout, chosen by `seed` (null: nothing matches). */
  pick(rank: number | null, themes: readonly string[], seed: number): InstanceLayout | null {
    const list = this.matching(rank, themes);
    if (list.length === 0) return null;
    const e = list[(seed >>> 0) % list.length];
    const layout = readLayout(JSON.parse(readFileSync(join(this.dir, e.file), "utf8")));
    return e.shell ? { ...layout, shell: join(this.dir, e.shell.file) } : layout;
  }
}
