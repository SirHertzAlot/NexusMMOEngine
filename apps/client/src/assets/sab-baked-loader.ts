/**
 * SabBakedLoader — Baked Asset Store B3 client loader (`BAKED-ASSET-STORE-SPEC.md §5 B3`).
 *
 * When `crossOriginIsolated && SharedArrayBuffer && Worker` (`probeSabSupport().usable`)
 * and a `WorkerRequester` are available:
 *   1. Sends the baked `.chunk` bytes + asset slice descriptors to the worker's
 *      `"bakedPlace"` handler to decode and place SoA columns into a `SabArena`.
 *   2. Wraps zero-copy `Float32Array`/`Uint32Array` typed-array views over `arena.sab`
 *      directly into `BakedGeometryRecord` / `THREE.BufferGeometry` / `THREE.Mesh`.
 *
 * Otherwise falls back seamlessly to main-thread `decodeBakedGeometryRecord`, producing
 * identical `BakedGeometryRecord` and `THREE.Mesh` objects.
 */

import * as THREE from "three";
import {
  BakedAssetProvider,
  BakedChunkManifestSchema,
  buildGeometryFromBakedRecord,
  buildObjectFromBakedRecord,
  decodeBakedGeometryRecord,
  type BakedChunkManifest,
  type BakedGeometryRecord,
} from "@mmo-engine/art/browser";
import { SAB_ARENA_HEADER_BYTES, SabArena, SabArenaState } from "./sab-arena.js";
import { probeSabSupport, type SabSupport } from "./sab-support.js";
import type { WorkerRequester } from "../workers/pool.js";
import { estimateBakedChunkSabBytes } from "../workers/handlers/baked-place.js";
import type { BakedPlaceResultPayload, BakedPlacedAsset } from "../workers/types.js";

export type PlacedBakedSuccess = Exclude<BakedPlaceResultPayload, { overflow: true }>;

export interface PlacedBakedChunkResult {
  chunkId: string;
  records: Map<string, BakedGeometryRecord>;
  meshes: Map<string, THREE.Mesh>;
  geometries: Map<string, THREE.BufferGeometry>;
  via: "sab-worker" | "main-thread";
  sabBytes: number | null;
  sab: SharedArrayBuffer | null;
}

export interface SabBakedLoaderOptions {
  workers?: WorkerRequester;
  support?: SabSupport;
  maxSabBytes?: number;
}

/**
 * Construct zero-copy `BakedGeometryRecord` views over a populated `SharedArrayBuffer`.
 * Every `positions`/`normals`/`uvs`/`indices` attribute backs directly onto `sab`.
 */
export function sabBakedRecords(
  sab: SharedArrayBuffer,
  placed: PlacedBakedSuccess,
): Map<string, BakedGeometryRecord> {
  const bySlice = new Map<string, BakedGeometryRecord>();
  const out = new Map<string, BakedGeometryRecord>();

  for (const item of placed.assets) {
    const key = `${item.positions.byteOffset}:${item.indices.byteOffset}`;
    let record = bySlice.get(key);
    if (!record) {
      record = {
        positions: new Float32Array(sab, item.positions.byteOffset, item.positions.length),
        normals: new Float32Array(sab, item.normals.byteOffset, item.normals.length),
        uvs: new Float32Array(sab, item.uvs.byteOffset, item.uvs.length),
        indices: new Uint32Array(sab, item.indices.byteOffset, item.indices.length),
        groups: item.groups.map((g) => ({ ...g })),
        boundingSphere: { ...item.boundingSphere },
      };
      bySlice.set(key, record);
    }
    out.set(item.id, record);
  }
  return out;
}

/** Build `THREE.BufferGeometry` & `THREE.Mesh` instances directly over SAB SoA views. */
export function sabBakedMeshes(
  sab: SharedArrayBuffer,
  placed: PlacedBakedSuccess,
  sharedMaterials?: Map<string, THREE.MeshStandardMaterial>,
): { records: Map<string, BakedGeometryRecord>; meshes: Map<string, THREE.Mesh>; geometries: Map<string, THREE.BufferGeometry> } {
  const records = sabBakedRecords(sab, placed);
  const { meshes, geometries } = buildMeshesFromRecords(placed.assets, records, sharedMaterials);
  return { records, meshes, geometries };
}

function buildMeshesFromRecords(
  assets: ReadonlyArray<Pick<BakedPlacedAsset, "id" | "canonicalId">>,
  records: ReadonlyMap<string, BakedGeometryRecord>,
  sharedMaterials?: Map<string, THREE.MeshStandardMaterial>,
): { meshes: Map<string, THREE.Mesh>; geometries: Map<string, THREE.BufferGeometry> } {
  const mats = sharedMaterials ?? new Map<string, THREE.MeshStandardMaterial>();
  const templateBySlice = new Map<BakedGeometryRecord, THREE.Mesh>();
  const meshes = new Map<string, THREE.Mesh>();
  const geometries = new Map<string, THREE.BufferGeometry>();

  for (const entry of assets) {
    const rec = records.get(entry.id);
    if (!rec) continue;
    let template = templateBySlice.get(rec);
    if (!template) {
      template = buildObjectFromBakedRecord(rec, mats);
      template.name = entry.canonicalId;
      templateBySlice.set(rec, template);
    }
    meshes.set(entry.id, template.clone(false));
    geometries.set(entry.id, template.geometry ?? buildGeometryFromBakedRecord(rec));
  }
  return { meshes, geometries };
}

export class SabBakedLoader {
  private readonly workers?: WorkerRequester;
  private readonly support: SabSupport;
  private readonly maxSabBytes: number;

  constructor(options: SabBakedLoaderOptions = {}) {
    this.workers = options.workers;
    this.support = options.support ?? probeSabSupport();
    this.maxSabBytes = options.maxSabBytes ?? 256 * 1024 * 1024;
  }

  /**
   * Place one baked chunk into GPU-ready `BufferGeometry` + `Mesh` objects via
   * the SAB worker path when usable, falling back transparently to main thread.
   */
  async placeChunkBytes(
    rawManifest: BakedChunkManifest,
    chunkBytes: Uint8Array,
    sharedMaterials?: Map<string, THREE.MeshStandardMaterial>,
  ): Promise<PlacedBakedChunkResult> {
    const manifest = BakedChunkManifestSchema.parse(rawManifest);
    if (chunkBytes.byteLength !== manifest.chunkBytes) {
      throw new Error(
        `chunk "${manifest.chunkId}" byte length ${chunkBytes.byteLength} != expected ${manifest.chunkBytes}`,
      );
    }

    if (this.support.usable && this.workers) {
      const viaSab = await this.trySabPlace(manifest, chunkBytes, sharedMaterials);
      if (viaSab) return viaSab;
    }

    const records = new Map<string, BakedGeometryRecord>();
    const sliceCache = new Map<string, BakedGeometryRecord>();
    for (const entry of manifest.assets) {
      const sliceKey = `${entry.byteOffset}:${entry.byteLength}`;
      let rec = sliceCache.get(sliceKey);
      if (!rec) {
        rec = decodeBakedGeometryRecord(chunkBytes, entry.byteOffset, entry.byteLength);
        sliceCache.set(sliceKey, rec);
      }
      records.set(entry.id, rec);
    }

    const { meshes, geometries } = buildMeshesFromRecords(manifest.assets, records, sharedMaterials);
    return {
      chunkId: manifest.chunkId,
      records,
      meshes,
      geometries,
      via: "main-thread",
      sabBytes: null,
      sab: null,
    };
  }

  /**
   * Decode/place a baked chunk via SAB worker (or fallback) and bind the resulting
   * zero-copy records directly into a `BakedAssetProvider`.
   */
  async mountIntoProvider(
    provider: BakedAssetProvider,
    manifest: BakedChunkManifest,
    chunkBytes: Uint8Array,
  ): Promise<PlacedBakedChunkResult> {
    const placed = await this.placeChunkBytes(manifest, chunkBytes);
    provider.registerBakedRecords(manifest, placed.records);
    return placed;
  }

  private async trySabPlace(
    manifest: BakedChunkManifest,
    chunkBytes: Uint8Array,
    sharedMaterials?: Map<string, THREE.MeshStandardMaterial>,
  ): Promise<PlacedBakedChunkResult | null> {
    try {
      const slices = manifest.assets.map((a) => ({
        id: a.id,
        canonicalId: a.canonicalId,
        assetHash: a.assetHash,
        byteOffset: a.byteOffset,
        byteLength: a.byteLength,
        ...(a.forShape !== undefined ? { forShape: a.forShape } : {}),
      }));

      let needed = estimateBakedChunkSabBytes(slices);
      if (needed + SAB_ARENA_HEADER_BYTES > this.maxSabBytes) return null;

      for (let attempt = 0; attempt < 2; attempt++) {
        const arena = SabArena.create(needed + SAB_ARENA_HEADER_BYTES + 1024);
        // Copy because worker postMessage detaches transferred ArrayBuffers.
        const chunkCopy = chunkBytes.slice().buffer as ArrayBuffer;
        const result = await this.workers!.request("bakedPlace", {
          chunkId: manifest.chunkId,
          chunk: chunkCopy,
          assets: slices,
          sab: arena.sab,
        });
        if ("overflow" in result) {
          needed = result.neededBytes;
          if (needed + SAB_ARENA_HEADER_BYTES > this.maxSabBytes) return null;
          continue;
        }
        if (arena.state !== SabArenaState.Ready) return null;
        const { records, meshes, geometries } = sabBakedMeshes(arena.sab, result, sharedMaterials);
        arena.markConsumed();
        return {
          chunkId: manifest.chunkId,
          records,
          meshes,
          geometries,
          via: "sab-worker",
          sabBytes: arena.usedBytes,
          sab: arena.sab,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
