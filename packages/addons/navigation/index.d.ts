// Type definitions for @mmo-engine/addon-navigation.

export declare const PathStatus: Readonly<{
  Ok: 0;
  NoStartPoly: 1;
  NoEndPoly: 2;
  NoPath: 3;
  UnknownProfile: 4;
}>;

export declare const CrowdAddStatus: Readonly<{ Added: 0; Updated: 1; Full: 2 }>;
export declare const CrowdTargetStatus: Readonly<{ Ok: 0; UnknownAgent: 1; NoPoly: 2; Cleared: 3 }>;
export declare const CrowdAgentState: Readonly<{ Invalid: 0; Idle: 1; Moving: 2; Arrived: 3; NoPath: 4 }>;

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
  /** The crowd's capacity. Default { maxAgents: 1024, maxAgentRadius: 1 }. */
  crowd?: { maxAgents?: number; maxAgentRadius?: number };
  /** Build tiles from layers plus obstacles (see bakeTileLayers). */
  tileCache?: TileCacheConfig;
}

export interface TileCacheConfig {
  /** Must divide tileWorldSize into 8-200 cells. */
  cellSize: number;
  cellHeight: number;
  agentHeight: number;
  agentRadius: number;
  agentMaxClimb: number;
  edgeMaxError?: number;
  /** Default 8192 (at most 65535). */
  maxObstacles?: number;
  /** Layers per tile (1 for a heightmap). Default 2. */
  maxLayers?: number;
}

/** Obstacles to add, SoA: kind 0 an upright cylinder standing on pos, 1 a box centred on pos turned by yaw. */
export interface ObstacleBatch {
  count: number;
  kind: Uint8Array;
  pos: Float32Array;
  radius: Float32Array;
  height: Float32Array;
  halfExtents: Float32Array;
  yaw: Float32Array;
}

/** Agents to add (or update, when already in the crowd), SoA. */
export interface CrowdAddBatch {
  count: number;
  entityIds: BigUint64Array;
  /** Where each agent is, 3 * count. */
  pos: Float32Array;
  radius: Float32Array;
  height: Float32Array;
  /** Top speed, m/s. */
  maxSpeed: Float32Array;
  /** m/s². */
  maxAcceleration: Float32Array;
}

/** New targets, SoA. A NaN x clears an agent's target. */
export interface CrowdTargetBatch {
  count: number;
  entityIds: BigUint64Array;
  target: Float32Array;
}

/** Where the simulation has each listed agent this tick. */
export interface CrowdSync {
  count: number;
  entityIds: BigUint64Array;
  pos: Float32Array;
}

/** crowdStep's results for the synced agents, caller-allocated. */
export interface CrowdStepOut {
  /** The move the crowd made this tick over dt (steering plus separation), 3 * count: the velocity to act on. */
  vel: Float32Array;
  /** Each agent's position on the navmesh, 3 * count. */
  pos: Float32Array;
  /** CrowdAgentState per agent. */
  state: Uint8Array;
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
  /** Add agents (or update ones already in the crowd): a CrowdAddStatus each. */
  crowdAdd(batch: CrowdAddBatch): Int32Array;
  /** Remove agents; unknown ids are ignored. */
  crowdRemove(entityIds: BigUint64Array): void;
  /** Set (or with NaN, clear) targets: a CrowdTargetStatus each. */
  crowdTarget(batch: CrowdTargetBatch): Int32Array;
  /** Snap agents to the simulation, update the crowd, read the steering back. */
  crowdStep(dt: number, sync: CrowdSync, out: CrowdStepOut): void;
  /** Agents in the crowd. */
  crowdCount(): number;
  /** A tile's heightfield layers (tile cache). Throws "0 layers" where nothing is walkable. */
  bakeTileLayers(config: BakeConfig, vertices: Float32Array, indices: Uint32Array): Buffer;
  /** Add a tile's layers to the cache and build its navmesh tiles: the cache refs. */
  loadLayers(tileX: number, tileZ: number, blob: Uint8Array): BigUint64Array;
  unloadLayers(refs: BigUint64Array): void;
  /** Obstacle refs (0: failed). They apply as updateObstacles rebuilds the tiles they touch. */
  addObstacles(batch: ObstacleBatch): Uint32Array;
  removeObstacles(refs: Uint32Array): void;
  /** Rebuild up to maxTiles touched tiles; true when every change is in. */
  updateObstacles(maxTiles: number): boolean;
  obstacleCount(): number;
  destroy(): void;
}

export declare function createService(config: NavServiceConfig): NavService;
