/**
 * Baked Asset Store B3 worker handler: decodes baked `.chunk` SoA records
 * off the main thread and writes vertex/index columns directly into a
 * `SabArena` (`SharedArrayBuffer`).
 */

import { decodeBakedGeometryRecord } from "@mmo-engine/art/browser";
import { SabArena, SabOverflowError } from "../../assets/sab-arena.js";
import type {
  BakedPlaceAssetSlice,
  BakedPlacedAsset,
  BakedPlaceResultPayload,
  WorkerTaskHandler,
} from "../types.js";

/** Upper-bound estimate (in bytes) of the SAB arena payload for a list of baked slices. */
export function estimateBakedChunkSabBytes(
  assets: ReadonlyArray<Pick<BakedPlaceAssetSlice, "byteOffset" | "byteLength">>,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const a of assets) {
    const key = `${a.byteOffset}:${a.byteLength}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Encoded MMOB header is 40 bytes; columns <= byteLength - 40 plus up to 32B alignment padding.
    total += Math.max(0, a.byteLength - 40) + 32;
  }
  return Math.max(64, total);
}

/**
 * Decode every `assets` entry inside `chunkBytes` and write its SoA columns
 * (`positions`, `normals`, `uvs`, `indices`) into `arena`, deduplicating entries
 * that share identical `(byteOffset, byteLength)` chunk slices.
 */
export function placeBakedChunkIntoSab(
  chunkId: string,
  chunkBytes: Uint8Array,
  assets: ReadonlyArray<BakedPlaceAssetSlice>,
  arena: SabArena,
): BakedPlaceResultPayload {
  arena.beginWrite();
  try {
    const placedBySlice = new Map<
      string,
      Omit<BakedPlacedAsset, "id" | "canonicalId" | "assetHash" | "forShape">
    >();
    const placed: BakedPlacedAsset[] = [];

    for (const asset of assets) {
      const sliceKey = `${asset.byteOffset}:${asset.byteLength}`;
      let shared = placedBySlice.get(sliceKey);
      if (!shared) {
        const record = decodeBakedGeometryRecord(chunkBytes, asset.byteOffset, asset.byteLength);

        const posOffset = arena.alloc(record.positions.byteLength, 4);
        arena.typed(Float32Array, posOffset, record.positions.length).set(record.positions);

        const nrmOffset = arena.alloc(record.normals.byteLength, 4);
        arena.typed(Float32Array, nrmOffset, record.normals.length).set(record.normals);

        const uvOffset = arena.alloc(record.uvs.byteLength, 4);
        arena.typed(Float32Array, uvOffset, record.uvs.length).set(record.uvs);

        const idxOffset = arena.alloc(record.indices.byteLength, 4);
        arena.typed(Uint32Array, idxOffset, record.indices.length).set(record.indices);

        shared = {
          positions: { byteOffset: posOffset, length: record.positions.length },
          normals: { byteOffset: nrmOffset, length: record.normals.length },
          uvs: { byteOffset: uvOffset, length: record.uvs.length },
          indices: { byteOffset: idxOffset, length: record.indices.length },
          groups: record.groups.map((g) => ({ ...g })),
          boundingSphere: { ...record.boundingSphere },
        };
        placedBySlice.set(sliceKey, shared);
      }

      placed.push({
        id: asset.id,
        canonicalId: asset.canonicalId,
        assetHash: asset.assetHash,
        ...(asset.forShape !== undefined ? { forShape: asset.forShape } : {}),
        ...shared,
      });
    }

    arena.publish();
    return {
      chunkId,
      assets: placed,
      totalBytes: arena.usedBytes,
    };
  } catch (err) {
    if (err instanceof SabOverflowError) {
      const neededBytes = Math.max(arena.usedBytes + err.neededBytes, estimateBakedChunkSabBytes(assets));
      arena.markError(neededBytes);
      return { overflow: true, neededBytes };
    }
    throw err;
  }
}

export const bakedPlaceHandler: WorkerTaskHandler<"bakedPlace"> = {
  type: "bakedPlace",
  async handle(payload) {
    const arena = SabArena.wrap(payload.sab);
    const chunkBytes = new Uint8Array(payload.chunk);
    return placeBakedChunkIntoSab(payload.chunkId, chunkBytes, payload.assets, arena);
  },
};
