import type { SabDecodeResult } from "../assets/glb-meshopt.js";

/**
 * Worker task types and payloads — shared between main thread and worker.
 */
import type { TerrainTile } from '@mmo-engine/protocol';
import type { WeatherFieldParams } from '../render/weather/field.js';

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
  /** WX1: advance the coarse weather field simulation by a batch of steps. */
  weather: WeatherTaskPayload;
  /** Baked Asset Store B3: decode baked SoA chunk records directly into a SharedArrayBuffer arena. */
  bakedPlace: BakedPlaceTaskPayload;
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
  /** Material slot names (a dungeon shell: floor, wall, ceiling, basin) and each triangle's slot. */
  materials?: string[];
  triangleMaterial?: Uint32Array;
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

export interface BakedPlaceAssetSlice {
  id: string;
  canonicalId: string;
  assetHash: number;
  byteOffset: number;
  byteLength: number;
  forShape?: string;
}

export interface BakedPlaceTaskPayload {
  chunkId: string;
  /** Encoded `.chunk` binary payload (transferred to worker). */
  chunk: ArrayBuffer;
  /** Records within `chunk` to decode & place as SoA columns in `sab`. */
  assets: BakedPlaceAssetSlice[];
  /** Destination SharedArrayBuffer formatted as `SabArena`. */
  sab: SharedArrayBuffer;
}

export interface BakedPlaceColumnSlice {
  byteOffset: number;
  length: number;
}

export interface BakedPlaceMaterialGroup {
  start: number;
  count: number;
  colorRgba: number;
  roughness: number;
  metalness: number;
}

export interface BakedPlaceBoundingSphere {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface BakedPlacedAsset {
  id: string;
  canonicalId: string;
  assetHash: number;
  forShape?: string;
  positions: BakedPlaceColumnSlice;
  normals: BakedPlaceColumnSlice;
  uvs: BakedPlaceColumnSlice;
  indices: BakedPlaceColumnSlice;
  groups: BakedPlaceMaterialGroup[];
  boundingSphere: BakedPlaceBoundingSphere;
}

export type BakedPlaceResultPayload =
  | {
      chunkId: string;
      assets: BakedPlacedAsset[];
      totalBytes: number;
    }
  | {
      overflow: true;
      neededBytes: number;
    };

export type ResultPayload = TerrainResultPayload | PcgResultPayload | BvhResultPayload | TerrainBlockResultPayload | AssetDecodeResultPayload | WeatherResultPayload | BakedPlaceResultPayload;

/** WX1: the updated field arrays. `moisture`/`temperature` hold the state
 *  after `steps` steps; the climatology arrays are returned unchanged so the
 *  main thread gets re-attached copies (they were transferred in the payload). */
export interface WeatherResultPayload {
  moisture: Float32Array;
  temperature: Float32Array;
  climatologyTemp: Float32Array;
  climatologyMoisture: Float32Array;
}

/** SAB Phase 6: GLB bytes (transferred to the worker) + the arena it decodes into. */
export interface AssetDecodeTaskPayload {
  glb: ArrayBuffer;
  sab: SharedArrayBuffer;
}

/** WX1: the field arrays the main thread owns, plus everything needed to
 *  advance them `steps` steps of `dt` seconds. All arrays are transferred. */
export interface WeatherTaskPayload {
  moisture: Float32Array;
  temperature: Float32Array;
  params: WeatherFieldParams;
  seed: number;
  steps: number;
  dt: number;
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
    T extends 'weather' ? WeatherResultPayload :
    T extends 'bakedPlace' ? BakedPlaceResultPayload :
    never;
  error?: string;
}

export type WorkerMessage = WorkerRequest | WorkerResponse;

export interface WorkerTaskHandler<T extends keyof TaskPayloadMap> {
  type: T;
  handle(payload: TaskPayloadMap[T]): Promise<WorkerResponse<T>['payload']>;
}
