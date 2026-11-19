/**
 * Grid bag helpers (CF6): what covers each cell, and whether a dragged item may land. The server decides; this only
 * predicts it with the same shared checks, so the highlight never disagrees with the answer.
 */

import { NOT_A_CELL, canStackViews, checkPlace, occupantAt, stamp, type Footprint, type GridSize, type PlaceRefusal, type Placement } from "@mmo-engine/protocol";
import type { ItemView } from "@mmo-engine/protocol";

/** One id per covered cell (0: free), with the cells past the last slot closed. */
export function occupancyOf(items: readonly ItemView[], grid: GridSize & { slots: number }): Uint32Array {
  const cells = new Uint32Array(grid.columns * grid.rows);
  for (let i = grid.slots; i < cells.length; i++) cells[i] = NOT_A_CELL;
  for (const it of items) {
    if (!it.at) continue;
    const upright: Footprint = it.at.rot ? [it.at.h, it.at.w] : [it.at.w, it.at.h];
    stamp(grid, cells, upright, { x: it.at.x, y: it.at.y, rot: it.at.rot }, it.id);
  }
  return cells;
}

/**
 * null: the server would take it. `footprint` is the item as authored (upright); `p.rot` is the turn asked for.
 */
export function dropVerdict(grid: GridSize, cells: ArrayLike<number>, footprint: Footprint, p: Placement, self: number): PlaceRefusal | null {
  return checkPlace(grid, cells, footprint, p, self);
}

/**
 * If dropping `dragged` at `p` covers exactly one other stackable item of the same definition that still
 * has headroom (`count < maxStack`), return that target item's id; otherwise null.
 */
export function dropCombineTarget(
  grid: GridSize,
  cells: ArrayLike<number>,
  items: readonly ItemView[],
  dragged: ItemView,
  footprint: Footprint,
  p: Placement,
): number | null {
  const targetId = occupantAt(grid, cells, footprint, p, dragged.id);
  if (!targetId || targetId <= 0) return null;
  const target = items.find((i) => i.id === targetId);
  return target && canStackViews(dragged, target) ? targetId : null;
}
