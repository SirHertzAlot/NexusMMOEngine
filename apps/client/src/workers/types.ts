import type { SabDecodeResult } from "../assets/glb-meshopt.js";

/**
 * Worker task types and payloads — shared between main thread and worker.
 */
import type { TerrainTile } from '@mmo-engine/protocol';

export interface WorkerTask<T = unknown> {
  id: number;
  type: string;
  payload: T;
}

export interface WorkerResult<R = unknown> {
  id: number;
  type: string;
  payload: R;
  error?: string;
}

/** Map of task type -> payload type for compile-time safety. */
export interface TaskPayloadMap {
  terrain: TerrainTaskPayload;
  pcg: PcgTaskPayload;
  bvh: BvhTaskPayload;
  terrainBlock: TerrainBlockTaskPayload;
  chunkDecompose: ChunkDecomposePayload;
  /** SAB Phase 6: decode a GLB into a SharedArrayBuffer arena. */
  assetDecode: AssetDecodeTaskPayload;
  // Extend this interface to add new task types
}

export interface TerrainTaskPayload {
  heights: Float32Array;
  chunkWorldSize: number;
}

export interface PcgTaskPayload {
  bytes: ArrayBuffer;
}

export interface BvhTaskPayload {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** One LOD block of chunks (see terrain-lod.ts buildBlockBuffers). */
export interface TerrainBlockTaskPayload {
  chunks: Array<{ cx: number; cz: number; heights: Float32Array; normals: Float32Array; stride: number }>;
  chunkWorldSize: number;
  originX: number;
  originZ: number;
}

/** Decompose a larger heightmap region into protocol tiles. */
export interface ChunkDecomposePayload {
  /** Row-major heights, X inner: heights[z * width + x]. */
  heights: Float32Array;
  width: number;
  depth: number;
  /** Grid coordinate of heights[0]. */
  originGX: number;
  originGZ: number;
}

export type TaskPayload = TaskPayloadMap[keyof TaskPayloadMap];

export interface TerrainResultPayload {
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array;
  bbox: Float32Array; // [minX, minY, minZ, maxX, maxY, maxZ]
}

export interface PcgResultPayload {
  position: Float32Array;
  index: Uint32Array;
  normal?: Float32Array;
  uv?: Float32Array;
  color?: Float32Array;
  bbox: Float32Array;
}

/** Same shape as three-mesh-bvh's SerializedBVH, so it feeds MeshBVH.deserialize directly. */
export interface BvhResultPayload {
  version: number;
  roots: ArrayBuffer[];
  index: Int32Array | Uint32Array | Uint16Array | null;
  indirectBuffer: Uint32Array | Uint16Array | null;
}

export interface TerrainBlockResultPayload {
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array | Uint32Array;
}

export type ResultPayload = TerrainResultPayload | PcgResultPayload | BvhResultPayload | TerrainBlockResultPayload | AssetDecodeResultPayload;

/** SAB Phase 6: GLB bytes (transferred to the worker) + the arena it decodes into. */
export interface AssetDecodeTaskPayload {
  glb: ArrayBuffer;
  sab: SharedArrayBuffer;
}

/** Worker decode result, or an overflow report (retry with a bigger arena). */
export type AssetDecodeResultPayload = SabDecodeResult | { overflow: true; neededBytes: number };

export interface WorkerRequest<T extends keyof TaskPayloadMap = keyof TaskPayloadMap> {
  id: number;
  type: T;
  payload: TaskPayloadMap[T];
}

export interface WorkerResponse<T extends keyof TaskPayloadMap = keyof TaskPayloadMap> {
  id: number;
  type: T;
  payload: T extends 'terrain' ? TerrainResultPayload :
    T extends 'pcg' ? PcgResultPayload :
    T extends 'bvh' ? BvhResultPayload :
    T extends 'terrainBlock' ? TerrainBlockResultPayload :
    T extends 'chunkDecompose' ? TerrainTile[] :
    T extends 'assetDecode' ? AssetDecodeResultPayload :
    never;
  error?: string;
}

export type WorkerMessage = WorkerRequest | WorkerResponse;

export interface WorkerTaskHandler<T extends keyof TaskPayloadMap> {
  type: T;
  handle(payload: TaskPayloadMap[T]): Promise<WorkerResponse<T>['payload']>;
}
