/**
 * Stacked layout masks: several floor levels, each its own footprint, joined
 * by stairs. The shell carries one floor height per cell, so a level is a
 * footprint and a column belongs to one level only. Two cells on different
 * levels may touch only at a stair, which is what keeps the walking distances
 * (the adapter's BFS) right.
 *
 * Each level is a rows mask like LayoutMask's ('#' rock, '.' floor, 'p' pool),
 * all the same size. A stair names a floor cell on its `from` level and the
 * neighbouring floor cell on its `to` level.
 */
import { z } from "zod";
import type { Dungeon } from "./generate.js";
import { dungeonFromLayout, parseLayoutMask, type LayoutMask } from "./mask-layout.js";

export const StackLevel = z.strictObject({
  level: z.number().int().min(-8).max(8),
  rows: z.array(z.string()).min(3),
});

export const StackStair = z.strictObject({
  id: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  from: z.number().int().min(-8).max(8),
  to: z.number().int().min(-8).max(8),
});
export type StackStair = z.infer<typeof StackStair>;

export const LayoutStack = z.strictObject({
  version: z.literal(1),
  levels: z.array(StackLevel).min(1),
  entrance: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0) }),
  stairs: z.array(StackStair).default([]),
});
export type LayoutStack = z.infer<typeof LayoutStack>;

const SOLID = "#";
const FLOOR = ".";
const POOL = "p";

export interface StackedDungeon {
  /** The Dungeon the shell takes (the footprints merged; the adapter's walking distances). */
  dungeon: Dungeon;
  /** Floor level per cell, row-major: what dungeonShell's `levels` takes. */
  levels: Int8Array;
  /** Each stair's cells: the `from` cell and the `to` cell it opens onto. */
  stairs: Array<{ id: string; from: { x: number; y: number; level: number }; to: { x: number; y: number; level: number } }>;
}

/** Parse and check a stack, then merge it into one Dungeon with a level per cell. Throws with the reason on any error. */
export function stackedDungeon(value: unknown, name = "stacked-layout"): StackedDungeon {
  const s = LayoutStack.parse(value);
  const H = s.levels[0].rows.length;
  const W = s.levels[0].rows[0].length;
  const levelsSeen = new Set<number>();
  for (const l of s.levels) {
    if (levelsSeen.has(l.level)) throw new Error(`stack: level ${l.level} repeats`);
    levelsSeen.add(l.level);
    if (l.rows.length !== H || l.rows.some((r) => r.length !== W)) throw new Error(`stack: level ${l.level} must be ${W} × ${H}`);
    for (const r of l.rows) for (const ch of r) if (ch !== SOLID && ch !== FLOOR && ch !== POOL) throw new Error(`stack: level ${l.level} has unknown cell '${ch}'`);
  }

  // Merge: a column belongs to one level; its cell is floor or pool there.
  const n = W * H;
  const rows: string[] = [];
  const levels = new Int8Array(n);
  const owner = new Int16Array(n).fill(-1);
  const cellChar = new Array<string>(n).fill(SOLID);
  for (const l of s.levels) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = l.rows[y][x];
        if (ch === SOLID) continue;
        const i = y * W + x;
        if (owner[i] >= 0) throw new Error(`stack: cell ${x},${y} is on levels ${s.levels[owner[i]].level} and ${l.level}`);
        owner[i] = s.levels.indexOf(l);
        cellChar[i] = ch;
        levels[i] = l.level;
      }
    }
  }
  for (let y = 0; y < H; y++) rows.push(cellChar.slice(y * W, y * W + W).join(""));

  const floorOn = (x: number, y: number, level: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] >= 0 && levels[y * W + x] === level && cellChar[y * W + x] !== SOLID;

  // Stairs: a floor cell on `from` next to a floor cell on `to`.
  const stairPairs = new Set<string>();
  const stairs: StackedDungeon["stairs"] = [];
  const stairIds = new Set<string>();
  for (const st of s.stairs) {
    if (stairIds.has(st.id)) throw new Error(`stack: stair id ${st.id} repeats`);
    stairIds.add(st.id);
    if (st.from === st.to) throw new Error(`stack: stair ${st.id} must join two levels`);
    if (!floorOn(st.x, st.y, st.from)) throw new Error(`stack: stair ${st.id} must sit on floor of level ${st.from}`);
    const next = [[st.x + 1, st.y], [st.x - 1, st.y], [st.x, st.y + 1], [st.x, st.y - 1]].find(([nx, ny]) => floorOn(nx, ny, st.to));
    if (!next) throw new Error(`stack: stair ${st.id} needs floor of level ${st.to} beside it`);
    const a = st.y * W + st.x, b = next[1] * W + next[0];
    stairPairs.add(`${a}|${b}`);
    stairPairs.add(`${b}|${a}`);
    stairs.push({ id: st.id, from: { x: st.x, y: st.y, level: st.from }, to: { x: next[0], y: next[1], level: st.to } });
  }

  // Two walkable cells on different levels may touch only at a stair.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (owner[i] < 0) continue;
      for (const [nx, ny] of [[x + 1, y], [x, y + 1]] as const) {
        if (nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (owner[j] < 0 || levels[j] === levels[i]) continue;
        if (!stairPairs.has(`${i}|${j}`)) throw new Error(`stack: cells ${x},${y} (level ${levels[i]}) and ${nx},${ny} (level ${levels[j]}) touch with no stair between them`);
      }
    }
  }

  const merged: LayoutMask = { version: 1, rows, entrance: s.entrance, portals: [] };
  parseLayoutMask(merged); // the entrance must be floor, and the rows well-formed
  if (levels[s.entrance.y * W + s.entrance.x] !== 0) throw new Error("stack: the entrance must be on level 0");
  return { dungeon: dungeonFromLayout(merged, name), levels, stairs };
}
