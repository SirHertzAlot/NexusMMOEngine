/**
 * Mesh and polygon Booleans: manifold (solids) and Clipper2 (polygons).
 *
 * Engine frame: y is up. Polygons lie in the x-z plane as (x, z) pairs;
 * outer rings run counter-clockwise seen from above, holes clockwise.
 */

/** Rings of (x, z) points: `rings[i]` points each, packed in order in `points`. */
export interface Polygons {
  points: Float64Array;
  rings: Uint32Array;
}

export interface PolygonResult extends Polygons {
  /** Filled area, m². */
  area: number;
}

export type BooleanOp = "union" | "difference" | "intersection";
export type Join = "miter" | "round" | "square" | "bevel";

export interface CellOptions {
  /** Cell size in metres (default 1): cell (x, y) covers x..x+1, y..y+1 times this, y on the z axis. */
  cell?: number;
  /** Only cells with this mask value (default: any non-zero). */
  value?: number;
  /** Drop points closer than this to the line through their neighbours (default cell / 1000). */
  simplify?: number;
  /** Grow (positive) or shrink (negative) the outline by this many metres. */
  offset?: number;
  join?: Join;
}

export interface OffsetOptions {
  join?: Join;
  miterLimit?: number;
  /** Segments per full circle for round joins (0: manifold's default). */
  segments?: number;
  simplify?: number;
}

/** A CSG tree for `solid`. A leaf's `tag` follows its faces through every Boolean. */
export type SolidNode =
  | { op: "box"; min: [number, number, number]; max: [number, number, number]; tag?: number }
  | { op: "extrude"; polygons: Polygons; y0?: number; height: number; tag?: number }
  | { op: "translate"; by: [number, number, number]; of: SolidNode; tag?: number }
  | { op: BooleanOp; of: SolidNode[]; tag?: number };

export interface SolidResult {
  positions: Float32Array;
  indices: Uint32Array;
  /** The tag of the leaf each triangle came from (0: untagged). */
  tags: Uint16Array;
  volume: number;
  area: number;
  /** Topological genus: 0 for a closed shell with no handles. */
  genus: number;
}

export function version(): string;
/** The merged outline of the cells (every row's runs unioned in one batch). */
export function cellsToPolygons(mask: Uint8Array, width: number, height: number, opts?: CellOptions): PolygonResult;
export function polygonBoolean(op: BooleanOp, a: Polygons, b: Polygons): PolygonResult;
export function polygonOffset(polygons: Polygons, delta: number, opts?: OffsetOptions): PolygonResult;
/** Evaluate a CSG tree into one closed (manifold) triangle mesh. */
export function solid(tree: SolidNode): SolidResult;
