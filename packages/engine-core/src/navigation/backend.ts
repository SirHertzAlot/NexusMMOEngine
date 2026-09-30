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
  /** The crowd's capacity (default 1024 agents up to 1 m radius). */
  crowd?: { maxAgents?: number; maxAgentRadius?: number };
  /** Build tiles from layers plus obstacles (DetourTileCache). */
  tileCache?: TileCacheOptions;
}

export interface TileCacheOptions {
  cellSize: number;
  cellHeight: number;
  agentHeight: number;
  agentRadius: number;
  agentMaxClimb: number;
  edgeMaxError?: number;
  maxObstacles?: number;
  maxLayers?: number;
}

/** Obstacles, SoA: kind 0 an upright cylinder standing on pos, 1 a box centred on pos turned by yaw. */
export interface ObstacleInput {
  count: number;
  kind: Uint8Array;
  pos: Float32Array;
  radius: Float32Array;
  height: Float32Array;
  halfExtents: Float32Array;
  yaw: Float32Array;
}

/** Tile cache (DetourTileCache): layer tiles and obstacles. */
export interface TileCacheBackend {
  bakeTileLayers(config: BakeTileConfig, vertices: Float32Array, indices: Uint32Array): Uint8Array;
  loadLayers(tileX: number, tileZ: number, blob: Uint8Array): BigUint64Array;
  unloadLayers(refs: BigUint64Array): void;
  addObstacles(input: ObstacleInput): Uint32Array;
  removeObstacles(refs: Uint32Array): void;
  /** Rebuild up to maxTiles touched tiles; true when every change is in. */
  update(maxTiles: number): boolean;
  count(): number;
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

/** Agents to add or update, SoA (see the addon's crowdAdd). */
export interface CrowdAddInput {
  count: number;
  entityIds: BigUint64Array;
  pos: Float32Array;
  radius: Float32Array;
  height: Float32Array;
  maxSpeed: Float32Array;
  maxAcceleration: Float32Array;
}

/** Crowd steering (DetourCrowd): agents keyed by wire id, bulk calls only. */
export interface CrowdBackend {
  add(input: CrowdAddInput): Int32Array;
  remove(entityIds: BigUint64Array): void;
  /** A NaN target x clears the agent's target. */
  target(input: { count: number; entityIds: BigUint64Array; target: Float32Array }): Int32Array;
  /** Snap agents to `sync.pos`, update the crowd, write steering into `out`. */
  step(
    dt: number,
    sync: { count: number; entityIds: BigUint64Array; pos: Float32Array },
    out: { vel: Float32Array; pos: Float32Array; state: Uint8Array },
  ): void;
  count(): number;
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
  /** Crowd steering, when the backend has it. */
  crowd?: CrowdBackend;
  /** The tile cache, when the service was made with one. */
  tileCache?: TileCacheBackend;
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
  crowdAdd(input: CrowdAddInput): Int32Array;
  crowdRemove(entityIds: BigUint64Array): void;
  crowdTarget(input: { count: number; entityIds: BigUint64Array; target: Float32Array }): Int32Array;
  crowdStep(
    dt: number,
    sync: { count: number; entityIds: BigUint64Array; pos: Float32Array },
    out: { vel: Float32Array; pos: Float32Array; state: Uint8Array },
  ): void;
  crowdCount(): number;
  bakeTileLayers(config: BakeTileConfig, vertices: Float32Array, indices: Uint32Array): Uint8Array;
  loadLayers(tileX: number, tileZ: number, blob: Uint8Array): BigUint64Array;
  unloadLayers(refs: BigUint64Array): void;
  addObstacles(input: ObstacleInput): Uint32Array;
  removeObstacles(refs: Uint32Array): void;
  updateObstacles(maxTiles: number): boolean;
  obstacleCount(): number;
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
    crowd: {
      add: (input) => svc.crowdAdd(input),
      remove: (ids) => svc.crowdRemove(ids),
      target: (input) => svc.crowdTarget(input),
      step: (dt, sync, out) => svc.crowdStep(dt, sync, out),
      count: () => svc.crowdCount(),
    },
    tileCache: options.tileCache
      ? {
          bakeTileLayers: (config, vertices, indices) => svc.bakeTileLayers(config, vertices, indices),
          loadLayers: (tileX, tileZ, blob) => svc.loadLayers(tileX, tileZ, blob),
          unloadLayers: (refs) => svc.unloadLayers(refs),
          addObstacles: (input) => svc.addObstacles(input),
          removeObstacles: (refs) => svc.removeObstacles(refs),
          update: (maxTiles) => svc.updateObstacles(maxTiles),
          count: () => svc.obstacleCount(),
        }
      : undefined,
    destroy: () => svc.destroy(),
  };
}
