/**
 * backend.ts — narrow swappable navigation backend (Phase 2, slice 2.1).
 *
 * SOLID: the simulation depends only on `NavigationBackend`; the real
 * adapter below binds it to @mmo-engine/addon-navigation, and tests swap
 * in a mock. The JS side never sees native dtPolyRefs — tile identity is
 * the u64 tile ref, entity identity is the engine wire id.
 */

import { createRequire } from "node:module";

/** Native path status codes (mirrors the addon's PathStatus). */
export const NAV_PATH_STATUS = {
  Ok: 0,
  NoStartPoly: 1,
  NoEndPoly: 2,
  NoPath: 3,
  UnknownProfile: 4,
} as const;

export interface NavAgentProfile {
  id: number;
  agentHeight: number;
  agentRadius: number;
  agentMaxClimb: number;
}

export interface NavServiceOptions {
  originX: number;
  originZ: number;
  tileWorldSize: number;
  maxTiles?: number;
  maxPolys?: number;
  profiles: NavAgentProfile[];
}

/** Bake parameters — one tile. See the addon README for semantics. */
export interface BakeTileConfig {
  tileX: number;
  tileZ: number;
  cellSize: number;
  cellHeight: number;
  agentHeight: number;
  agentRadius: number;
  agentMaxClimb: number;
  walkableSlopeAngle: number;
  regionMinSize: number;
  regionMergeSize: number;
  edgeMaxLen: number;
  edgeMaxError: number;
  vertsPerPoly: number;
  detailSampleDist: number;
  detailSampleMaxError: number;
}

export interface BakeTileStats {
  spanCount: number;
  contourCount: number;
  polyCount: number;
  detailTriCount: number;
  blobBytes: number;
}

export interface BakeTileResult {
  blob: Uint8Array;
  stats: BakeTileStats;
}

/** Structure-of-arrays path query batch (caller-owned arenas). */
export interface FindPathsInput {
  count: number;
  entityIds: BigUint64Array;
  start: Float32Array;
  end: Float32Array;
  profile: Uint8Array;
  maxWaypoints: number;
}

export interface FindPathsOutput {
  status: Int32Array;
  waypointCount: Uint32Array;
  polyCount: Uint32Array;
  waypoints: Float32Array;
}

/**
 * Narrow navigation backend. Bulk in, bulk out, no per-entity calls on
 * the hot path (DOD/EDA: the sim emits one batch per tick).
 */
export interface NavigationBackend {
  bakeTile(
    config: BakeTileConfig,
    vertices: Float32Array,
    indices: Uint32Array,
  ): BakeTileResult;
  loadTiles(blobs: Uint8Array[]): BigUint64Array;
  unloadTiles(tileRefs: BigUint64Array): void;
  tileCount(): number;
  findPaths(input: FindPathsInput, output: FindPathsOutput): void;
  destroy(): void;
}

interface NativeNavService {
  bakeTile(
    config: BakeTileConfig,
    vertices: Float32Array,
    indices: Uint32Array,
  ): { blob: Uint8Array; stats: BakeTileStats };
  loadTiles(blobs: Uint8Array[]): BigUint64Array;
  unloadTiles(tileRefs: BigUint64Array): void;
  tileCount(): number;
  findPaths(input: FindPathsInput, output: FindPathsOutput): void;
  destroy(): void;
}

/**
 * Real adapter: binds NavigationBackend to @mmo-engine/addon-navigation.
 * Throws a helpful error when the native binding is not built (run
 * `npm install` at the repo root first).
 */
export function createNavigationBackend(
  options: NavServiceOptions,
): NavigationBackend {
  const require = createRequire(import.meta.url);
  let addon: { createService: (o: NavServiceOptions) => NativeNavService };
  try {
    // The addon is a CJS native binding; require keeps ESM/CJS interop simple.
    addon = require("@mmo-engine/addon-navigation");
  } catch (err) {
    throw new Error(
      "navigation/backend: @mmo-engine/addon-navigation is not built. " +
        "Run `npm install` at the repo root to build the native addon. " +
        `Underlying error: ${(err as Error).message}`,
    );
  }
  const svc = addon.createService(options);
  return {
    bakeTile: (config, vertices, indices) =>
      svc.bakeTile(config, vertices, indices),
    loadTiles: (blobs) => svc.loadTiles(blobs),
    unloadTiles: (tileRefs) => svc.unloadTiles(tileRefs),
    tileCount: () => svc.tileCount(),
    findPaths: (input, output) => svc.findPaths(input, output),
    destroy: () => svc.destroy(),
  };
}
