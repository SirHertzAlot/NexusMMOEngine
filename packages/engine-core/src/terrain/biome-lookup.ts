/**
 * The biome at a point of a baked world, from its survey map (`biome`,
 * one id per survey cell) and the biome names the ids index (recorded at
 * bake time as meta `world_biomes`). Null outside the map.
 */

import type { TerrainTileStore, WorldMap } from "../persist/terrain-tiles.js";
import type { WorldInfoMeta } from "./world-info.js";

export function biomeAtFromMap(map: WorldMap, names: readonly string[]): (x: number, z: number) => string | null {
  const { width, depth, cell, originX, originZ, data } = map;
  return (x, z) => {
    const u = Math.floor((x - originX) / cell);
    const v = Math.floor((z - originZ) / cell);
    if (u < 0 || v < 0 || u >= width || v >= depth) return null;
    return names[data[v * width + u]] ?? null;
  };
}

/** A running world's biome lookup, or null for a legacy world (no survey maps). */
export function biomeLookup(meta: WorldInfoMeta, tiles: TerrainTileStore): ((x: number, z: number) => string | null) | null {
  const map = tiles.getMap("biome");
  const names = meta.getMeta("world_biomes");
  if (!map || !names) return null;
  return biomeAtFromMap(map, JSON.parse(names) as string[]);
}
