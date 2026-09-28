/**
 * chunk-baker.ts — canonical server-side navmesh tile baking (Phase 2).
 *
 * Bakes one navmesh tile per terrain chunk at chunk-gen/load time — NEVER
 * per tick. The server owns baking: it builds the triangle mesh from the
 * same ChunkDataSource heightmap the world streams, so navmesh and
 * rendered/collided terrain can never disagree.
 *
 * Geometry contract: triangles use counter-clockwise winding viewed from
 * above (+Y), matching what the native bake pipeline requires.
 */

import { createHash } from "node:crypto";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import {
  type NavigationBackend,
  type BakeTileConfig,
  type BakeTileStats,
} from "./backend.js";

/** Sensible Recast defaults for MMO terrain chunks (tuned, not magic). */
export const DEFAULT_BAKE_CONFIG: Omit<BakeTileConfig, "tileX" | "tileZ"> = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2.0,
  agentRadius: 0.6,
  agentMaxClimb: 0.9,
  walkableSlopeAngle: 45,
  regionMinSize: 8,
  regionMergeSize: 20,
  edgeMaxLen: 12,
  edgeMaxError: 1.3,
  vertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

export interface ChunkBakeOptions {
  backend: NavigationBackend;
  source: ChunkDataSource;
  seed: bigint;
  /** World units per chunk edge. Default 16. */
  chunkWorldSize?: number;
  lod?: number;
  /** Overrides merged over DEFAULT_BAKE_CONFIG. */
  bakeConfig?: Partial<Omit<BakeTileConfig, "tileX" | "tileZ">>;
}

export interface ChunkBakeResult {
  chunkX: number;
  chunkZ: number;
  blob: Uint8Array;
  stats: BakeTileStats;
  /** sha256 of the canonical bake-config JSON — registry key material. */
  bakeConfigHash: string;
  config: BakeTileConfig;
}

/**
 * Canonical JSON of a bake config: fixed key order, so the hash is
 * stable across processes. Changing any bake parameter changes the
 * hash, which invalidates cached tiles (versioned build artifacts).
 */
export function canonicalBakeConfig(config: BakeTileConfig): string {
  const keys = [
    "tileX", "tileZ", "cellSize", "cellHeight", "agentHeight",
    "agentRadius", "agentMaxClimb", "walkableSlopeAngle", "regionMinSize",
    "regionMergeSize", "edgeMaxLen", "edgeMaxError", "vertsPerPoly",
    "detailSampleDist", "detailSampleMaxError",
  ] as const;
  const ordered: Record<string, number> = {};
  for (const k of keys) ordered[k] = config[k];
  return JSON.stringify(ordered);
}

export function bakeConfigHash(config: BakeTileConfig): string {
  return createHash("sha256").update(canonicalBakeConfig(config)).digest("hex");
}

/**
 * Build a triangle mesh for chunk (cx, cz) from the heightmap source.
 * Exported for tests: winding must be CCW viewed from above.
 */
export function buildChunkMesh(
  source: ChunkDataSource,
  seed: bigint,
  cx: number,
  cz: number,
  lod: number,
  chunkWorldSize: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const n = source.chunkSamples;
  const side = Math.sqrt(n);
  if (!Number.isInteger(side) || side < 2) {
    throw new Error(`chunk-baker: chunkSamples must be a square >= 4, got ${n}`);
  }
  const heights = new Float32Array(n);
  source.generateChunk(seed, cx, cz, lod, heights);

  const verts = new Float32Array(n * 3);
  const step = chunkWorldSize / (side - 1);
  const baseX = cx * chunkWorldSize;
  const baseZ = cz * chunkWorldSize;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = (j * side + i) * 3;
      verts[v] = baseX + i * step;
      verts[v + 1] = heights[j * side + i];
      verts[v + 2] = baseZ + j * step;
    }
  }

  // Two triangles per cell, CCW viewed from above (+Y):
  // (v00, v11, v10) and (v00, v01, v11).
  const cells = side - 1;
  const indices = new Uint32Array(cells * cells * 6);
  let t = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const v00 = j * side + i;
      const v10 = v00 + 1;
      const v01 = v00 + side;
      const v11 = v01 + 1;
      indices[t++] = v00; indices[t++] = v11; indices[t++] = v10;
      indices[t++] = v00; indices[t++] = v01; indices[t++] = v11;
    }
  }
  return { vertices: verts, indices };
}

/**
 * Bake one navmesh tile for chunk (chunkX, chunkZ). Synchronous and
 * expensive (seconds-scale for large tiles) — call at chunk-gen/load,
 * on a worker thread, or ahead of time. Never per tick.
 *
 * Configuration contract: the backend's NavService must be created with
 * originX=0, originZ=0 and tileWorldSize=chunkWorldSize, so that tile
 * (tileX, tileZ) bounds line up exactly with the mesh world coords
 * produced by buildChunkMesh.
 */
export function bakeChunkTile(
  options: ChunkBakeOptions,
  chunkX: number,
  chunkZ: number,
): ChunkBakeResult {
  const chunkWorldSize = options.chunkWorldSize ?? 16;
  const lod = options.lod ?? 0;
  const { vertices, indices } = buildChunkMesh(
    options.source,
    options.seed,
    chunkX,
    chunkZ,
    lod,
    chunkWorldSize,
  );
  const config: BakeTileConfig = {
    ...DEFAULT_BAKE_CONFIG,
    ...options.bakeConfig,
    tileX: chunkX,
    tileZ: chunkZ,
  };
  const { blob, stats } = options.backend.bakeTile(config, vertices, indices);
  return {
    chunkX,
    chunkZ,
    blob,
    stats,
    bakeConfigHash: bakeConfigHash(config),
    config,
  };
}

/**
 * True when a bake failed because the tile has no walkable surface (a
 * cliff steeper than the agent's slope limit): Recast reports 0 spans,
 * contours, or polys. The chunk simply has no navmesh tile.
 */
export function isNothingWalkable(err: unknown): boolean {
  return /0 spans|0 contours|0 polys/.test((err as Error)?.message ?? "");
}
