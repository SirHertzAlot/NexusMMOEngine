/**
 * Water surface lookups for the running server, from a baked world's
 * survey maps: `water_level` (the surface height of the sea and each lake,
 * NaN on land). Worlds baked before it was stored fall back to the
 * `water` map (sea cells at sea level; their lakes aren't known).
 *
 * A point takes the highest surface among the four survey cells around it
 * (8 m cells), so the water reaches right up to the shore; whether you're
 * actually in it is the surface against the ground under you.
 */

import type { WaterSurface } from "../systems.js";
import type { WorldMap } from "../persist/terrain-tiles.js";
import { SEA } from "./hydrology.js";

export function waterSurfaceFromMaps(
  maps: { level: WorldMap | null; water: WorldMap | null },
  seaLevel: number,
): WaterSurface | null {
  let grid: WorldMap | null = maps.level;
  let level: Float32Array;
  if (grid && grid.data instanceof Float32Array) {
    level = grid.data;
  } else if (maps.water) {
    grid = maps.water;
    level = new Float32Array(grid.data.length);
    for (let i = 0; i < level.length; i++) level[i] = grid.data[i] === SEA ? seaLevel : Number.NaN;
  } else {
    return null;
  }
  const { width: W, depth: D, cell, originX, originZ } = grid;
  return (x, z) => {
    const fu = (x - originX) / cell;
    const fv = (z - originZ) / cell;
    const u0 = Math.floor(fu);
    const v0 = Math.floor(fv);
    let best: number | null = null;
    for (let dv = 0; dv <= 1; dv++) {
      for (let du = 0; du <= 1; du++) {
        const u = u0 + du;
        const v = v0 + dv;
        if (u < 0 || v < 0 || u >= W || v >= D) continue;
        const s = level[v * W + u];
        if (!Number.isNaN(s) && (best === null || s > best)) best = s;
      }
    }
    return best;
  };
}
