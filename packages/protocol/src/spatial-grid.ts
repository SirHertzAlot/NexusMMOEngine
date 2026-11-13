/**
 * Spatial containers (roadmap CF6): a grid W x H holding items with a real footprint, which may be turned a quarter.
 * Pure and shared: the server uses it to validate every placement (the client only ever proposes), the client to
 * show where a dragged item would land and whether that is allowed.
 *
 * A grid is addressed by cell index `y * columns + x`. A placement is an anchor (the item's top-left cell once turned)
 * and a rotation. `occupancy` holds one item id per cell, 0 where nothing is.
 */

export interface GridSize {
  columns: number;
  rows: number;
}

/** An item's size in cells as authored: width across, height down. */
export type Footprint = readonly [number, number];

export interface Placement {
  x: number;
  y: number;
  /** Turned a quarter: width and height swap. */
  rot: boolean;
}

/** The size an item covers once turned (or not). */
export function sizeOf(f: Footprint, rot: boolean): [number, number] {
  return rot ? [f[1], f[0]] : [f[0], f[1]];
}

/** Only an item that is not square can be turned to anything new. */
export function canRotate(f: Footprint): boolean {
  return f[0] !== f[1];
}

/** The cell index of (x, y). */
export const cellOf = (g: GridSize, x: number, y: number): number => y * g.columns + x;

/** Whether the placement lies wholly inside the grid. */
export function inside(g: GridSize, f: Footprint, p: Placement): boolean {
  const [w, h] = sizeOf(f, p.rot);
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x + w <= g.columns && p.y + h <= g.rows;
}

/** Why a placement is refused: outside the grid, turned when it cannot be, or over another item. Null: allowed. */
export type PlaceRefusal = "outside" | "cannot-turn" | "occupied";

/**
 * Check a placement. `occupancy` is the grid's cells (one id per cell, 0: empty); `self` is the item being moved, whose
 * own cells do not count against it.
 */
export function checkPlace(g: GridSize, occupancy: ArrayLike<number>, f: Footprint, p: Placement, self = 0): PlaceRefusal | null {
  if (p.rot && !canRotate(f)) return "cannot-turn";
  if (!inside(g, f, p)) return "outside";
  const [w, h] = sizeOf(f, p.rot);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const at = occupancy[cellOf(g, p.x + i, p.y + j)]!;
      if (at !== 0 && at !== self) return "occupied";
    }
  }
  return null;
}

/** Mark the placement's cells with `id` (0 clears them). The caller has checked it. */
export function stamp(g: GridSize, occupancy: { [i: number]: number }, f: Footprint, p: Placement, id: number): void {
  const [w, h] = sizeOf(f, p.rot);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) occupancy[cellOf(g, p.x + i, p.y + j)] = id;
}

/**
 * The first place the item fits, scanning rows from the top left; turned only when it does not fit upright.
 * Null when it fits nowhere.
 */
export function firstFit(g: GridSize, occupancy: ArrayLike<number>, f: Footprint, self = 0): Placement | null {
  for (const rot of canRotate(f) ? [false, true] : [false]) {
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.columns; x++) if (checkPlace(g, occupancy, f, { x, y, rot }, self) === null) return { x, y, rot };
  }
  return null;
}

/** The grid a bag of `slots` cells makes with `columns` across (the last row may be short: those cells do not exist). */
export function gridFor(slots: number, columns: number): GridSize {
  const c = Math.max(1, Math.min(columns, slots));
  return { columns: c, rows: Math.ceil(slots / c) };
}

/** Cells that do not exist when the cell count is not a whole number of rows: marked taken so nothing is placed there. */
export const NOT_A_CELL = 0xffffffff;

/** Encode a placement for storage in one integer (the ledger's slot): the anchor cell and the turn. */
export function packPlacement(g: GridSize, p: Placement): number {
  return cellOf(g, p.x, p.y) | (p.rot ? 0x8000 : 0);
}

/** Decode `packPlacement`; the anchor must be inside the grid's cells. */
export function unpackPlacement(g: GridSize, packed: number): Placement {
  const rot = (packed & 0x8000) !== 0;
  const cell = packed & 0x7fff;
  return { x: cell % g.columns, y: Math.floor(cell / g.columns), rot };
}
