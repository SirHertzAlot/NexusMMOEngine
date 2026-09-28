/**
 * Ground colours from the world map: one colour per map cell from its
 * biome, river cells blended toward wet mud. Uploaded as a small texture
 * the terrain shader samples by world position; linear filtering blends
 * biome borders over a cell or two, like the terrain itself blends.
 *
 * Slope and height (rock faces, snow) are the shader's job; this is only
 * what flat ground looks like in each biome.
 */

import type { WorldMap } from "@mmo-engine/protocol";

/** sRGB ground colour per biome id; unknown biomes get DEFAULT_GROUND. */
export const BIOME_GROUND: Record<string, readonly [number, number, number]> = {
  plains: [104, 138, 68],
  forest: [56, 90, 46],
  rainforest: [38, 78, 40],
  desert: [201, 172, 118],
  swamp: [76, 82, 56],
  mountains: [112, 104, 94],
  snow: [232, 236, 240],
  glacier: [190, 218, 236],
  tundra: [128, 132, 104],
  volcanic: [62, 52, 50],
  beach: [214, 196, 150],
  // Under water: the sea floor and lake beds (the water surface is drawn over them).
  sea: [150, 138, 104],
  lake: [92, 86, 64],
};
export const DEFAULT_GROUND: readonly [number, number, number] = [96, 128, 66];
const RIVER_MUD: readonly [number, number, number] = [82, 72, 56];
const RIVER_BLEND = 0.75;

/** RGBA8 (sRGB) ground colour per map cell, row-major like the map. */
export function groundColors(map: WorldMap): Uint8Array<ArrayBuffer> {
  const n = map.width * map.depth;
  const out = new Uint8Array(n * 4);
  const palette = map.biomes.map((id) => BIOME_GROUND[id] ?? DEFAULT_GROUND);
  for (let i = 0; i < n; i++) {
    const c = palette[map.biome[i]] ?? DEFAULT_GROUND;
    const t = map.river[i] ? RIVER_BLEND : 0;
    out[4 * i] = Math.round(c[0] + (RIVER_MUD[0] - c[0]) * t);
    out[4 * i + 1] = Math.round(c[1] + (RIVER_MUD[1] - c[1]) * t);
    out[4 * i + 2] = Math.round(c[2] + (RIVER_MUD[2] - c[2]) * t);
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * Snow line for a world, metres: well up the tallest peaks, or none
 * (Infinity) when nothing is high enough to hold snow.
 */
export function snowLine(maxHeight: number): number {
  return maxHeight > 150 ? maxHeight * 0.72 : Infinity;
}
