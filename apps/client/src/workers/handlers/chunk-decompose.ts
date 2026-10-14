import type { WorkerTaskHandler } from '../types.js';
import { TILE_SAMPLES, TILE_CELLS, type TerrainTile } from '@mmo-engine/protocol';

/**
 * Decompose a larger heightmap region into 16×16 protocol tiles.
 *
 * Takes a rectangular heightmap (row-major Float32Array, X inner) positioned
 * at integer grid coordinates and cuts it into TerrainTiles following the
 * protocol's shared-border convention: chunk (cx, cz) covers
 * gx = cx*15 .. cx*15+15, so neighbouring chunks share their border row/column.
 *
 * Samples outside the input region are NaN (matching HeightGrid convention).
 */
export interface ChunkDecomposePayload {
  /** Row-major heights, X inner: heights[z * width + x]. */
  heights: Float32Array;
  width: number;
  depth: number;
  /** Grid coordinate of heights[0]. */
  originGX: number;
  originGZ: number;
}

export function decomposeToTiles(payload: ChunkDecomposePayload): TerrainTile[] {
  const { heights, width, depth, originGX, originGZ } = payload;
  if (width <= 0 || depth <= 0) throw new Error('decompose: width and depth must be positive');
  if (heights.length !== width * depth) throw new Error('decompose: heights length mismatch');

  // Chunk index range covering the region (inclusive).
  const minCX = Math.floor(originGX / TILE_CELLS);
  const maxCX = Math.floor((originGX + width - 1) / TILE_CELLS);
  const minCZ = Math.floor(originGZ / TILE_CELLS);
  const maxCZ = Math.floor((originGZ + depth - 1) / TILE_CELLS);

  const tiles: TerrainTile[] = [];
  for (let cz = minCZ; cz <= maxCZ; cz++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      const tile = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
      for (let j = 0; j < TILE_SAMPLES; j++) {
        for (let i = 0; i < TILE_SAMPLES; i++) {
          const gx = cx * TILE_CELLS + i;
          const gz = cz * TILE_CELLS + j;
          const lx = gx - originGX;
          const lz = gz - originGZ;
          tile[j * TILE_SAMPLES + i] =
            lx >= 0 && lx < width && lz >= 0 && lz < depth
              ? heights[lz * width + lx]
              : Number.NaN;
        }
      }
      tiles.push({ cx, cz, heights: tile });
    }
  }
  return tiles;
}

export const chunkDecomposeHandler: WorkerTaskHandler<'chunkDecompose'> = {
  type: 'chunkDecompose',
  async handle(payload) {
    return decomposeToTiles(payload);
  },
};
