// Type definitions for @mmo-engine/addon-navigation.

export declare const PathStatus: Readonly<{
  Ok: 0;
  NoStartPoly: 1;
  NoEndPoly: 2;
  NoPath: 3;
  UnknownProfile: 4;
}>;

export interface AgentProfileConfig {
  /** Profile id referenced by findPaths requests (0-255). */
  id: number;
  agentHeight: number;
  agentRadius: number;
  agentMaxClimb: number;
}

export interface NavServiceConfig {
  /** World coords of the corner of tile (0, 0). */
  originX: number;
  originZ: number;
  /** World units per square tile. */
  tileWorldSize: number;
  maxTiles?: number;
  maxPolys?: number;
  profiles: AgentProfileConfig[];
}

/** Bake configuration for bakeTile (world units + degrees). */
export interface BakeConfig {
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

export interface BakeStats {
  spanCount: number;
  contourCount: number;
  polyCount: number;
  detailTriCount: number;
  blobBytes: number;
}

export interface BakeResult {
  blob: Buffer;
  stats: BakeStats;
}

/** Bulk path-request batch (SoA). */
export interface FindPathsBatch {
  count: number;
  /** u64 entity ids, length count. */
  entityIds: BigUint64Array;
  /** Path start positions, length 3 * count. */
  start: Float32Array;
  /** Path end positions, length 3 * count. */
  end: Float32Array;
  /** Agent profile id per request, length count. */
  profile: Uint8Array;
  /** Max straight-path waypoints written per request. */
  maxWaypoints: number;
}

/** Caller-allocated output arena for findPaths. */
export interface FindPathsArena {
  /** Per-request PathStatus, length count. */
  status: Int32Array;
  /** Per-request waypoint count, length count. */
  waypointCount: Uint32Array;
  /** Per-request corridor poly count, length count. */
  polyCount: Uint32Array;
  /** Waypoints, length 3 * maxWaypoints * count. */
  waypoints: Float32Array;
}

export declare class NavService {
  loadTiles(blobs: Buffer[]): BigUint64Array;
  unloadTiles(refs: BigUint64Array): void;
  findPaths(batch: FindPathsBatch, arena: FindPathsArena): void;
  bakeTile(
    config: BakeConfig,
    vertices: Float32Array,
    indices: Uint32Array,
  ): BakeResult;
  tileCount(): number;
  destroy(): void;
}

export declare function createService(config: NavServiceConfig): NavService;
