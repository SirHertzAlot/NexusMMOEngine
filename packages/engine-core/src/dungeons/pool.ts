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
}

export interface LayoutSpawn {
  x: number;
  z: number;
  tier: number;
  room: number;
  /** The species the bake put here ("" or absent: unpopulated). */
  species: string;
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
  dressing?: { rank: number };
  population?: { spawns: { x: number; y: number; species: string }[] };
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
    return readLayout(JSON.parse(readFileSync(join(this.dir, e.file), "utf8")));
  }
}
