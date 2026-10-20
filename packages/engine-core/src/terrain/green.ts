/**
 * Green land: the survey's buildable ground (the green of the biome preview) and the squares of it that settlements may
 * stand in. Read from the survey grid, the data the preview draws, not from the picture.
 */

import type { CoarseGrid } from "./survey.js";

/** The biomes that count as green: the buildable land of the preview. */
export const GREEN_BIOMES: readonly string[] = ["plains", "forest", "rainforest"];

/** The smallest square worth a settlement, cells. */
export const GREEN_MIN_CELLS = 24;

/** The survey fields green land is read from. */
export interface GreenFields {
  grid: CoarseGrid;
  height: Float32Array;
  biome: Uint8Array;
  water: Uint8Array;
  river: Uint8Array;
  ice?: Uint8Array;
  seaLevel?: number;
}

/** An all-green square: grid cells (`cx`, `cz` its low corner, `cells` its side) and world metres. */
export interface GreenSquare {
  cx: number;
  cz: number;
  cells: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  areaM2: number;
}

/** 1 on every green cell: a green biome, no water, river or ice, and `floorM` or more above the sea. */
export function greenMask(f: GreenFields, biomeIds: readonly string[], green: readonly string[], floorM: number): Uint8Array {
  const ok = biomeIds.map((id) => green.includes(id));
  const sea = f.seaLevel ?? 0;
  const mask = new Uint8Array(f.height.length);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = ok[f.biome[i]!] && !f.water[i] && !f.river[i] && !f.ice?.[i] && f.height[i]! >= sea + floorM ? 1 : 0;
  }
  return mask;
}

/**
 * The all-green squares, largest first, never overlapping, none under `minCells` a side. Each pass takes the biggest square
 * left (the classic largest-square table) and clears it; ties go to the lowest z, then x, so the result is deterministic.
 */
export function greenSquares(mask: Uint8Array, grid: CoarseGrid, minCells: number): GreenSquare[] {
  const { width: W, depth: D, cell, originX, originZ } = grid;
  const m = Uint8Array.from(mask);
  const side = new Int32Array(W * D);
  const out: GreenSquare[] = [];
  for (;;) {
    let best = 0;
    let at = -1;
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        side[i] = !m[i] ? 0 : x === 0 || z === 0 ? 1 : Math.min(side[i - 1]!, side[i - W]!, side[i - W - 1]!) + 1;
        if (side[i]! > best) {
          best = side[i]!;
          at = i;
        }
      }
    }
    if (best < Math.max(1, minCells)) return out;
    // `at` is the square's high corner.
    const cx = (at % W) - best + 1;
    const cz = Math.floor(at / W) - best + 1;
    for (let z = cz; z < cz + best; z++) m.fill(0, z * W + cx, z * W + cx + best);
    const x0 = originX + cx * cell;
    const z0 = originZ + cz * cell;
    out.push({ cx, cz, cells: best, x0, z0, x1: x0 + best * cell, z1: z0 + best * cell, areaM2: best * cell * best * cell });
  }
}
