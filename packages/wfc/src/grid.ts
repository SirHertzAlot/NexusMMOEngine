/**
 * Grids: cells of a 2D or 3D grid are the slots, each cell linked to its
 * +x, +y and +z neighbours under the rules "x", "y" and "z". Which tiles
 * may touch comes from **sockets** (a tile's +x socket must equal its
 * right neighbour's -x socket) or from an `allow` function, or both.
 *
 * Used for settlement and ruin layouts, room interiors, tile sets.
 */

import type { WfcOption, WfcProblem, WfcRule } from "./solver.js";

export type Axis = "x" | "y" | "z";

export interface GridTile extends WfcOption {
  /** Socket per face: px/nx (+x/-x), py/ny, pz/nz. A missing face matches anything. */
  sockets?: Partial<Record<"px" | "nx" | "py" | "ny" | "pz" | "nz", string>>;
}

export interface GridSpec {
  width: number;
  height: number;
  /** Layers (default 1: a 2D grid). */
  depth?: number;
  tiles: readonly GridTile[];
  /** May `a` sit on the negative side of `b` along `axis`? (With sockets, both must agree.) */
  allow?: (a: GridTile, b: GridTile, axis: Axis) => boolean;
}

export interface GridProblem extends WfcProblem {
  /** Slot index of cell (x, y, z). */
  index(x: number, y: number, z?: number): number;
  width: number;
  height: number;
  depth: number;
}

const FACES: Record<Axis, ["px" | "py" | "pz", "nx" | "ny" | "nz"]> = { x: ["px", "nx"], y: ["py", "ny"], z: ["pz", "nz"] };

export function gridProblem(spec: GridSpec): GridProblem {
  const { width: W, height: H } = spec;
  const D = spec.depth ?? 1;
  const index = (x: number, y: number, z = 0): number => (z * H + y) * W + x;
  const edges: { a: number; b: number; rule: string }[] = [];
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const s = index(x, y, z);
        if (x + 1 < W) edges.push({ a: s, b: index(x + 1, y, z), rule: "x" });
        if (y + 1 < H) edges.push({ a: s, b: index(x, y + 1, z), rule: "y" });
        if (z + 1 < D) edges.push({ a: s, b: index(x, y, z + 1), rule: "z" });
      }
  const rule = (axis: Axis): WfcRule => (a, b) => {
    const ta = a as GridTile, tb = b as GridTile;
    const [pos, neg] = FACES[axis];
    const sa = ta.sockets?.[pos], sb = tb.sockets?.[neg];
    if (sa !== undefined && sb !== undefined && sa !== sb) return false;
    return spec.allow ? spec.allow(ta, tb, axis) : true;
  };
  return {
    options: spec.tiles,
    slots: W * H * D,
    edges,
    rules: { x: rule("x"), y: rule("y"), z: rule("z") },
    index,
    width: W,
    height: H,
    depth: D,
  };
}
