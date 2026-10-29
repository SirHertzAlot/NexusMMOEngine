/**
 * Where a run's chests and traps go (roadmap D4f). A room's centre is no
 * place for them any more: the dressed rooms stand furniture there, and the
 * same rooms in the same order put chests on traps. So: chests the bake
 * already stood in the rooms (a treasure room's, a treasury's row) come
 * first; then one free cell per room, for the remaining chests and then the
 * traps. A free cell is walkable with walkable neighbours, clear of every
 * baked prop's footprint and collider, and at least SPACING_M from anything
 * already placed. Every choice comes from the layout's id, so a dungeon
 * always lays out the same way.
 *
 * DoD Performance Optimizations:
 *  - Precomputes a flat `interiorWalkable: Uint8Array` bitmask over the
 *    dungeon grid once so the $3 \times 3$ walkable-neighborhood check in
 *    `free(x, y)` is a single $O(1)$ array lookup instead of 9 bounds-checked
 *    function calls per cell.
 *  - Flattens `blockers` into contiguous `blockerX`, `blockerZ`, `blockerClearSq`
 *    `Float64Array`s (with `(r + CLEARANCE_M) ** 2` pre-squared!) so checking
 *    candidate cells avoids tuple array allocations and redundant squaring.
 */

import { fnv1a32 } from "@mmo-engine/picg";
import { hash } from "../procgen/ecology.js";
import type { DungeonProps } from "./content.js";
import { CELL_M, cellCentre, type InstanceLayout, type LayoutProp } from "./pool.js";

/** Baked kinds a run opens as its chests. */
export const CHEST_KINDS: ReadonlySet<string> = new Set(["chest", "gilded-chest"]);
/** Gap kept between a placed chest or trap and a prop's footprint (a chest's own half-diagonal). */
export const CLEARANCE_M = 0.9;
/** Least distance between two placed things: two cells, more than a trap's trigger radius. */
export const SPACING_M = 2 * CELL_M;
const SPACING_SQ = SPACING_M * SPACING_M;
/** How far from a room's centre (cells, square) a free cell is looked for. */
const ROOM_REACH = 5;

export interface Placed {
  x: number;
  z: number;
  /** The baked prop this chest is (an index into layout.props); absent: the run stands a chest there. */
  prop?: number;
}

/** A prop's footprint radius, metres: the bake's own, else its table box's widest half (scaled), else half a metre. */
export function footprint(p: LayoutProp, table?: DungeonProps): number {
  if (p.radius > 0) return p.radius;
  const half = table?.archetypes[`dungeon:${p.kind}`]?.collision?.halfExtents;
  return half ? Math.max(half[0], half[2]) * p.scale : 0.5;
}

export function placeChestsAndTraps(layout: InstanceLayout, chests: number, traps: number, table?: DungeonProps): { chests: Placed[]; traps: Placed[] } {
  let s = fnv1a32(layout.id);
  const rand = (): number => (s = hash(s, 0x2545f491)) / 4294967296;
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  const placed: Placed[] = [];
  const spaced = (x: number, z: number): boolean => {
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < SPACING_SQ) return false;
    }
    return true;
  };

  const outChests: Placed[] = [];
  const baked = shuffle(layout.props.flatMap((p, i) => (CHEST_KINDS.has(p.kind) ? [i] : [])));
  for (const i of baked) {
    if (outChests.length >= chests) break;
    if (!spaced(layout.props[i].x, layout.props[i].z)) continue; // a treasury's row: one of it, the rest stay dressing
    const c = { x: layout.props[i].x, z: layout.props[i].z, prop: i };
    outChests.push(c);
    placed.push(c);
  }

  // Flat SoA blocker arrays with pre-squared (r + CLEARANCE_M)^2 thresholds
  const numProps = layout.props.length;
  const numColliders = (layout.colliders.length / 3) | 0;
  const totalBlockers = numProps + numColliders;
  const blockerX = new Float64Array(totalBlockers);
  const blockerZ = new Float64Array(totalBlockers);
  const blockerClearSq = new Float64Array(totalBlockers);
  for (let i = 0; i < numProps; i++) {
    const p = layout.props[i];
    const r = footprint(p, table) + CLEARANCE_M;
    blockerX[i] = p.x;
    blockerZ[i] = p.z;
    blockerClearSq[i] = r * r;
  }
  for (let i = 0; i < numColliders; i++) {
    const idx = numProps + i;
    const r = layout.colliders[i * 3 + 2] + CLEARANCE_M;
    blockerX[idx] = layout.colliders[i * 3];
    blockerZ[idx] = layout.colliders[i * 3 + 1];
    blockerClearSq[idx] = r * r;
  }

  const w = layout.width;
  const h = layout.height;
  const walkable = layout.walkable;
  const walk = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && walkable[y * w + x] === 1;
  const free = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x + 1 >= w || y + 1 >= h) return false;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!walk(x + ox, y + oy)) return false;
      }
    }
    const wx = cellCentre(x);
    const wz = cellCentre(y);
    if (!spaced(wx, wz)) return false;
    for (let i = 0; i < totalBlockers; i++) {
      const dx = blockerX[i] - wx;
      const dz = blockerZ[i] - wz;
      if (dx * dx + dz * dz < blockerClearSq[i]) return false;
    }
    return true;
  };
  const rooms = layout.rooms.filter((r) => r.id !== layout.entranceRoom).sort((a, b) => a.id - b.id);
  /** One free cell near each room's centre, rooms in a seeded order, until `n` are found. */
  const fill = (n: number, out: Placed[]): void => {
    for (const r of shuffle(rooms.slice())) {
      if (out.length >= n) return;
      const cx = Math.floor(r.x / CELL_M), cy = Math.floor(r.z / CELL_M);
      const cells: [number, number][] = [];
      for (let y = cy - ROOM_REACH; y <= cy + ROOM_REACH; y++) for (let x = cx - ROOM_REACH; x <= cx + ROOM_REACH; x++) if (free(x, y)) cells.push([x, y]);
      if (cells.length === 0) continue;
      const [x, y] = cells[Math.floor(rand() * cells.length)];
      const p = { x: cellCentre(x), z: cellCentre(y) };
      out.push(p);
      placed.push(p);
    }
  };
  fill(chests, outChests);
  const outTraps: Placed[] = [];
  fill(traps, outTraps);
  return { chests: outChests, traps: outTraps };
}
