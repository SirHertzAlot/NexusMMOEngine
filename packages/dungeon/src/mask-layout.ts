/**
 * The layout mask: a dungeon's floor plan as data, and the one adapter that
 * turns it into the `Dungeon` the existing shell, collision and dressing
 * already take. The adapter is the only seam, so the rest of the pipeline is
 * unchanged, and a different layout source can replace it.
 *
 * Rows are y (north to south), characters x: '#' solid rock, '.' floor,
 * 'p' pool. A portal names a solid wall cell beside floor: the adapter cuts
 * it open (it becomes floor) and lists it as the portal entity. The shell and
 * the portal entity read the same cell, so they cannot drift.
 */
import { z } from "zod";
import { CELL, type Dungeon, type DungeonParams } from "./generate.js";
import { DUNGEON_CELL } from "./shell.js";

export const LayoutPortal = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  /** The axis the opening runs along: 'x' (east–west) or 'y' (north–south). */
  side: z.enum(["x", "y"]),
});
export type LayoutPortal = z.infer<typeof LayoutPortal>;

export const LayoutMask = z.strictObject({
  version: z.literal(1),
  /** One string per row (y), one character per column (x). */
  rows: z.array(z.string()).min(3),
  entrance: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0) }),
  portals: z.array(LayoutPortal).default([]),
});
export type LayoutMask = z.infer<typeof LayoutMask>;

const SOLID = "#";
const FLOOR = ".";
const POOL = "p";

/** Parse a mask and check the things the schema can't: a rectangle, a floor entrance, portals on wall cells beside floor. */
export function parseLayoutMask(value: unknown): LayoutMask {
  const m = LayoutMask.parse(value);
  const w = m.rows[0].length;
  if (m.rows.some((r) => r.length !== w)) throw new Error("layout: every row must be the same width");
  for (const r of m.rows) for (const ch of r) if (ch !== SOLID && ch !== FLOOR && ch !== POOL) throw new Error(`layout: unknown cell '${ch}'`);
  const at = (x: number, y: number): string | undefined => (y >= 0 && y < m.rows.length && x >= 0 && x < w ? m.rows[y][x] : undefined);
  if (at(m.entrance.x, m.entrance.y) !== FLOOR) throw new Error("layout: the entrance must be on floor");
  const ids = new Set<string>();
  for (const p of m.portals) {
    if (ids.has(p.id)) throw new Error(`layout: portal id ${p.id} repeats`);
    ids.add(p.id);
    if (at(p.x, p.y) !== SOLID) throw new Error(`layout: portal ${p.id} must sit on a solid wall cell`);
    const [a, b] = p.side === "x" ? [at(p.x - 1, p.y), at(p.x + 1, p.y)] : [at(p.x, p.y - 1), at(p.x, p.y + 1)];
    if (a !== FLOOR && b !== FLOOR) throw new Error(`layout: portal ${p.id} must have floor on one side`);
  }
  return m;
}

const PARAMS: DungeonParams = { seed: 0, rooms: 3, loopChance: 0, decorDensity: 0, theme: "" };

/**
 * Build the Dungeon the shell takes from a checked mask. Portals are cut open
 * here. Distances are walking distances from the entrance, and the boss is the
 * farthest floor cell.
 */
export function dungeonFromLayout(layout: LayoutMask, name = "layout"): Dungeon {
  const m = parseLayoutMask(layout);
  const W = m.rows[0].length;
  const H = m.rows.length;
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = m.rows[y][x];
      grid[y * W + x] = ch === FLOOR ? CELL.floor : ch === POOL ? CELL.pool : CELL.wall;
    }
  }
  for (const p of m.portals) grid[p.y * W + p.x] = CELL.floor; // the shell cut

  const walk = (i: number): boolean => grid[i] === CELL.floor || grid[i] === CELL.pool;
  const distance = new Int16Array(W * H).fill(-1);
  const entrance = m.entrance.y * W + m.entrance.x;
  distance[entrance] = 0;
  const queue = [entrance];
  let boss = entrance;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (distance[j] !== -1 || !walk(j)) continue;
      distance[j] = distance[i] + 1;
      queue.push(j);
      if (distance[j] > distance[boss]) boss = j;
    }
  }
  const maxDistance = distance[boss];
  const floorCells = queue.length;
  return {
    params: PARAMS,
    seed: 0,
    attempts: 1,
    valid: floorCells === [...grid].filter((_, i) => walk(i)).length,
    name,
    width: W,
    height: H,
    grid,
    roomId: new Int16Array(W * H).fill(-1),
    corridor: new Uint8Array(W * H),
    doorway: new Uint8Array(W * H),
    lake: new Uint8Array(W * H),
    distance,
    maxDistance,
    rooms: [],
    corridors: [],
    entrance,
    boss,
    maxDepth: maxDistance,
    props: [],
    spawns: [],
    torches: [],
    pools: [],
    arches: [],
    stats: { rooms: 0, corridors: 0, loops: 0, criticalPath: maxDistance, floorTiles: floorCells },
  } as Dungeon;
}

/** The portal entities for a mask: the same cells the adapter cut open. */
export function layoutPortals(layout: LayoutMask): Array<{ id: string; x: number; y: number; side: "x" | "y" }> {
  return parseLayoutMask(layout).portals.map((p) => ({ id: p.id, x: p.x, y: p.y, side: p.side }));
}

export { DUNGEON_CELL };
