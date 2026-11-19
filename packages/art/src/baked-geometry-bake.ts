/**
 * Node-only Baked Asset Store B1 Geometry Baker (`BAKED-ASSET-STORE-SPEC.md §5 B1`):
 * - Extracts glTF 2.0 binary (`.glb`) scene graphs in Node (no DOM/WebGL),
 *   applies node hierarchy world transforms (`THREE.Matrix4`), converts to
 *   canonical SoA vertex/index streams (`encodeBakedGeometryRecord`),
 * - Enforces licence-lane validation fail-closed via `./baked-store.js`,
 * - Records corrupt/unsupported non-licence GLB failures in `rejected[]` so
 *   `BakedAssetProvider` retains placeholder fallback per rejected asset,
 * - Deduplicates identical SoA geometry blobs via SHA-256 and writes deterministic,
 *   content-addressed `.chunk` binary payloads, `.baked.json` runtime manifest,
 *   and SQLite `store.sqlite` index.
 *
 * Node-only module: do NOT re-export from `browser.ts`.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as THREE from "three";
import {
  bakedAssetHash32,
  computeBakedBoundingSphere,
  encodeBakedGeometryRecord,
  packColorRgba,
  type BakedChunkAssetEntry,
  type BakedChunkManifest,
  type BakedChunkRejectedEntry,
  type BakedGeometryRecord,
  type BakedMaterialGroup,
} from "./baked-geometry.js";
import {
  BakedStoreIndexManifestSchema,
  chunkIdToKind,
  chunkManifestFilename,
  type BakedStoreChunkEntry,
  type BakedStoreIndexManifest,
} from "./baked-chunk-streaming.js";
import {
  commitBakedStoreDatabase,
  compareCodepoint,
  prepareBakedStoreInputs,
  resolveContainedFile,
  sha256Hex,
  validateBakeLicences,
  validateChunkId,
  writeFileAtomic,
  type BakedAssetStore,
  type BuildBakedAssetIndexOptions,
  type ChunkKind,
  type ChunkToInsert,
  type DedupeReport,
  type HashedAssetRecord,
  type LicenceCoverageReport,
  type ResolvedBlobSlot,
} from "./baked-store.js";
import { nodeLocalMatrix, parseGlbChunks, readAccessorValues } from "./glb-parse.js";
import { errMessage } from "./util.js";

/**
 * Extract merged world-space SoA geometry streams from a glTF 2.0 `.glb` file.
 * Runs purely in Node without DOM or WebGL dependencies.
 */
export function extractGlbGeometry(glbBytes: Uint8Array): BakedGeometryRecord {
  const { gltf, buffers } = parseGlbChunks(glbBytes);
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const sceneIdx = gltf.scene ?? 0;
  const rootNodes = gltf.scenes?.[sceneIdx]?.nodes ?? (nodes.length > 0 ? [0] : []);

  const meshPlacements: Array<{ meshIndex: number; matrix: THREE.Matrix4 }> = [];
  if (rootNodes.length > 0 && nodes.length > 0) {
    const visit = (nodeIdx: number, parentMat: THREE.Matrix4): void => {
      const node = nodes[nodeIdx];
      if (!node) return;
      const world = new THREE.Matrix4().multiplyMatrices(parentMat, nodeLocalMatrix(node));
      if (node.mesh !== undefined) {
        meshPlacements.push({ meshIndex: node.mesh, matrix: world });
      }
      for (const childIdx of node.children ?? []) {
        visit(childIdx, world);
      }
    };
    const identity = new THREE.Matrix4();
    for (const rootIdx of rootNodes) visit(rootIdx, identity);
  } else {
    for (let i = 0; i < meshes.length; i++) {
      meshPlacements.push({ meshIndex: i, matrix: new THREE.Matrix4() });
    }
  }

  const posOut: number[] = [];
  const normOut: number[] = [];
  const uvOut: number[] = [];
  const idxOut: number[] = [];
  const groups: BakedMaterialGroup[] = [];

  const vec = new THREE.Vector3();
  const normVec = new THREE.Vector3();
  const normalMat = new THREE.Matrix3();

  for (const placement of meshPlacements) {
    const mesh = meshes[placement.meshIndex];
    if (!mesh) continue;
    normalMat.getNormalMatrix(placement.matrix);
    const flipWinding = placement.matrix.determinant() < 0;

    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode !== 4) {
        throw new Error(`unsupported primitive mode ${mode} (expected TRIANGLES=4)`);
      }
      if (prim.attributes.POSITION === undefined) {
        throw new Error("primitive missing POSITION attribute");
      }

      const rawPos = readAccessorValues(gltf, buffers, prim.attributes.POSITION, "VEC3").values;
      const vertCount = rawPos.length / 3;
      const rawNorm =
        prim.attributes.NORMAL !== undefined
          ? readAccessorValues(gltf, buffers, prim.attributes.NORMAL, "VEC3").values
          : null;
      const rawUv =
        prim.attributes.TEXCOORD_0 !== undefined
          ? readAccessorValues(gltf, buffers, prim.attributes.TEXCOORD_0, "VEC2").values
          : null;
      const rawIdx =
        prim.indices !== undefined
          ? readAccessorValues(gltf, buffers, prim.indices, "SCALAR").values
          : Array.from({ length: vertCount }, (_, k) => k);

      if (rawIdx.length % 3 !== 0) {
        throw new Error(`triangle index count ${rawIdx.length} is not divisible by 3`);
      }

      const vertBase = posOut.length / 3;
      for (let v = 0; v < vertCount; v++) {
        vec.set(rawPos[v * 3], rawPos[v * 3 + 1], rawPos[v * 3 + 2]).applyMatrix4(placement.matrix);
        posOut.push(vec.x, vec.y, vec.z);

        if (rawNorm) {
          normVec.set(rawNorm[v * 3], rawNorm[v * 3 + 1], rawNorm[v * 3 + 2]).applyMatrix3(normalMat);
          if (normVec.lengthSq() > 0) normVec.normalize();
          else normVec.set(0, 1, 0);
          normOut.push(normVec.x, normVec.y, normVec.z);
        } else {
          normOut.push(0, 1, 0);
        }

        if (rawUv) {
          uvOut.push(rawUv[v * 2], rawUv[v * 2 + 1]);
        } else {
          uvOut.push(0, 0);
        }
      }

      const startIdx = idxOut.length;
      for (let t = 0; t < rawIdx.length; t += 3) {
        const i0 = rawIdx[t];
        const i1 = flipWinding ? rawIdx[t + 2] : rawIdx[t + 1];
        const i2 = flipWinding ? rawIdx[t + 1] : rawIdx[t + 2];
        if (i0 < 0 || i0 >= vertCount || i1 < 0 || i1 >= vertCount || i2 < 0 || i2 >= vertCount) {
          throw new Error(`index out of vertex range [0, ${vertCount})`);
        }
        idxOut.push(vertBase + i0, vertBase + i1, vertBase + i2);
      }

      // Compute flat face normals if the source GLB omitted NORMAL.
      if (!rawNorm) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const ab = new THREE.Vector3();
        const ac = new THREE.Vector3();
        for (let t = startIdx; t < idxOut.length; t += 3) {
          const i0 = idxOut[t] * 3;
          const i1 = idxOut[t + 1] * 3;
          const i2 = idxOut[t + 2] * 3;
          a.set(posOut[i0], posOut[i0 + 1], posOut[i0 + 2]);
          b.set(posOut[i1], posOut[i1 + 1], posOut[i1 + 2]);
          c.set(posOut[i2], posOut[i2 + 1], posOut[i2 + 2]);
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          ab.cross(ac);
          if (ab.lengthSq() > 0) ab.normalize();
          else ab.set(0, 1, 0);
          for (const k of [i0, i1, i2]) {
            normOut[k] = ab.x;
            normOut[k + 1] = ab.y;
            normOut[k + 2] = ab.z;
          }
        }
      }

      const mat = prim.material !== undefined ? gltf.materials?.[prim.material] : undefined;
      const pbr = mat?.pbrMetallicRoughness;
      const cf = pbr?.baseColorFactor ?? [1, 1, 1, 1];
      groups.push({
        start: startIdx,
        count: idxOut.length - startIdx,
        colorRgba: packColorRgba(cf[0], cf[1], cf[2], cf[3]),
        roughness: pbr?.roughnessFactor ?? 0.9,
        metalness: pbr?.metallicFactor ?? 0,
      });
    }
  }

  if (posOut.length === 0 || idxOut.length === 0) {
    throw new Error("GLB contains no triangle geometry");
  }

  const positions = new Float32Array(posOut);
  const normals = new Float32Array(normOut);
  const uvs = new Float32Array(uvOut);
  const indices = new Uint32Array(idxOut);
  return {
    positions,
    normals,
    uvs,
    indices,
    groups,
    boundingSphere: computeBakedBoundingSphere(positions),
  };
}

export interface BakeKitGeometryOptions extends Omit<BuildBakedAssetIndexOptions, "dbPath"> {
  /** Directory where `chunks/<hash>.chunk`, `<kit>.baked.json`, and `store.sqlite` are written. */
  outDir: string;
  /** Kit identifier (e.g. `"fantasy-props"` or `"fantasy-kingdom"`). */
  kit: string;
  /** Optional explicit SQLite path (defaults to `<outDir>/store.sqlite`). */
  dbPath?: string;
  /** Optional asset id allow-list (otherwise all models in `kit` are baked). */
  assetIds?: ReadonlySet<string> | readonly string[];
  /** Override chunk id (defaults to `"kit:<kit>"`). */
  chunkId?: ChunkKind;
}

export interface BakeKitGeometryResult {
  store: BakedAssetStore;
  chunkPath: string;
  manifestPath: string;
  manifest: BakedChunkManifest;
  bakedCount: number;
  uniqueBlobCount: number;
  rejectedCount: number;
  dedupeReport: DedupeReport;
  licenceCoverageReport: LicenceCoverageReport;
}

/**
 * Bake one kit's models from `manifest.json`/`catalog.json` + GLB files into:
 * - `<outDir>/chunks/<chunkHash>.chunk`: concatenated 4-byte-aligned SoA geometry records
 * - `<outDir>/<kit>.baked.json`: browser-safe manifest consumed by `BakedAssetProvider`
 * - `<outDir>/store.sqlite`: B0 SQLite index recording baked chunk hashes, offsets, & licences.
 */
interface PreparedModelBlobs {
  prepared: ReturnType<typeof prepareBakedStoreInputs>;
  shapeById: Map<string, string>;
  blobBytesByHash: Map<string, Uint8Array>;
  bakedItems: Array<{
    asset: ReturnType<typeof prepareBakedStoreInputs>["resolvedAssets"][number];
    blobHash: string;
    bytes: Uint8Array;
  }>;
  rejected: BakedChunkRejectedEntry[];
}

function prepareGeometryModelBlobs(
  options: Omit<BuildBakedAssetIndexOptions, "dbPath"> & {
    dbPath: string;
    kit?: string;
    assetIds?: ReadonlySet<string> | readonly string[];
  },
): PreparedModelBlobs {
  const filterSet = options.assetIds ? new Set(options.assetIds) : null;
  const prepared = prepareBakedStoreInputs(options);
  const selectedModels = prepared.resolvedAssets
    .filter((a) => {
      if (a.kind !== "model") return false;
      if (filterSet) return filterSet.has(a.id);
      if (options.kit !== undefined) {
        return a.pack === options.kit || a.id.startsWith(`${options.kit}/`) || prepared.manifest.models.every((m) => !m.id.includes("/"));
      }
      return true;
    })
    .sort((a, b) => compareCodepoint(a.id, b.id));

  // Fail closed on any licence-lane violation before writing files.
  validateBakeLicences(
    selectedModels.map((a) => ({ id: a.id, kind: a.kind, classification: a.classification })),
    prepared.target,
  );

  const shapeById = new Map<string, string>();
  for (const m of prepared.manifest.models) {
    if (m.forShape !== undefined) shapeById.set(m.id, m.forShape);
  }

  const blobBytesByHash = new Map<string, Uint8Array>();
  const bakedItems: PreparedModelBlobs["bakedItems"] = [];
  const rejected: BakedChunkRejectedEntry[] = [];

  for (const asset of selectedModels) {
    try {
      const fullPath = resolveContainedFile(prepared.assetsRoot, asset.file, `model "${asset.id}"`);
      const glbBytes = readFileSync(fullPath);
      const record = extractGlbGeometry(glbBytes);
      const bakedBytes = encodeBakedGeometryRecord(record);
      const blobHash = sha256Hex(bakedBytes);
      if (!blobBytesByHash.has(blobHash)) blobBytesByHash.set(blobHash, bakedBytes);
      bakedItems.push({ asset, blobHash, bytes: bakedBytes });
    } catch (err) {
      rejected.push({ id: asset.id, reason: errMessage(err) });
    }
  }

  return { prepared, shapeById, blobBytesByHash, bakedItems, rejected };
}

interface EmittedChunkResult {
  chunkPath: string;
  manifestPath: string;
  manifest: BakedChunkManifest;
  chunkRow: ChunkToInsert;
  assetsWithHashes: HashedAssetRecord[];
  slotByHash: Map<string, ResolvedBlobSlot>;
  uniqueBlobCount: number;
}

function emitGeometryChunkPartition(params: {
  outDir: string;
  manifestRelFile: string;
  chunkId: ChunkKind;
  kit: string;
  target: "own-game" | "shipped-prototype-pack";
  items: ReadonlyArray<PreparedModelBlobs["bakedItems"][number]>;
  blobBytesByHash: ReadonlyMap<string, Uint8Array>;
  shapeById: ReadonlyMap<string, string>;
  selectedIds: ReadonlySet<string>;
  rejected: ReadonlyArray<BakedChunkRejectedEntry>;
}): EmittedChunkResult {
  const {
    outDir,
    manifestRelFile,
    chunkId,
    kit,
    target,
    items,
    blobBytesByHash,
    shapeById,
    selectedIds,
    rejected,
  } = params;

  const byHash = new Map<string, Array<(typeof items)[number]>>();
  for (const item of items) {
    const list = byHash.get(item.blobHash) ?? [];
    list.push(item);
    byHash.set(item.blobHash, list);
  }

  const slotByHash = new Map<string, ResolvedBlobSlot>();
  const orderedHashes = [...byHash.keys()].sort(compareCodepoint);
  let totalChunkBytes = 0;
  for (const h of orderedHashes) {
    const blob = blobBytesByHash.get(h)!;
    const aligned = (blob.byteLength + 3) & ~3;
    const canonical = [...byHash.get(h)!].sort((a, b) => compareCodepoint(a.asset.id, b.asset.id))[0].asset;
    slotByHash.set(h, {
      hash: h,
      byteLength: blob.byteLength,
      chunkId,
      byteOffset: totalChunkBytes,
      canonicalAssetId: canonical.id,
    });
    totalChunkBytes += aligned;
  }

  const chunkBuffer = new Uint8Array(totalChunkBytes);
  for (const h of orderedHashes) {
    const slot = slotByHash.get(h)!;
    chunkBuffer.set(blobBytesByHash.get(h)!, slot.byteOffset);
  }
  const chunkHash = sha256Hex(chunkBuffer);
  const chunkRelFile = `chunks/${chunkHash}.chunk`;

  mkdirSync(join(outDir, "chunks"), { recursive: true });
  const chunkPath = join(outDir, chunkRelFile);
  writeFileAtomic(chunkPath, chunkBuffer);

  const assetsWithHashes: HashedAssetRecord[] = items.map((item) => ({
    ...item.asset,
    chunkId,
    variantOf: item.asset.variantOf && selectedIds.has(item.asset.variantOf) ? item.asset.variantOf : undefined,
    hash: item.blobHash,
    byteLength: item.bytes.byteLength,
  }));

  const manifestEntries: BakedChunkAssetEntry[] = assetsWithHashes.map((a) => {
    const slot = slotByHash.get(a.hash)!;
    const forShape = shapeById.get(a.id);
    return {
      id: a.id,
      assetHash: bakedAssetHash32(a.id),
      canonicalId: slot.canonicalAssetId,
      byteOffset: slot.byteOffset,
      byteLength: slot.byteLength,
      blobHash: a.hash,
      licenceLane: a.classification.licenceLane,
      ...(forShape !== undefined ? { forShape } : {}),
      ...(a.classification.credit ? { credit: a.classification.credit } : {}),
    };
  });

  const manifest: BakedChunkManifest = {
    version: 1,
    kit,
    target,
    chunkId,
    chunkFile: chunkRelFile,
    chunkHash,
    chunkBytes: chunkBuffer.byteLength,
    assets: manifestEntries,
    rejected: [...rejected].sort((a, b) => compareCodepoint(a.id, b.id)),
  };

  const manifestPath = join(outDir, manifestRelFile);
  if (manifestRelFile.includes("/")) {
    mkdirSync(join(outDir, manifestRelFile.split("/").slice(0, -1).join("/")), { recursive: true });
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    chunkPath,
    manifestPath,
    manifest,
    chunkRow: { id: chunkId, kind: chunkId, bytes: chunkBuffer.byteLength, hash: chunkHash },
    assetsWithHashes,
    slotByHash,
    uniqueBlobCount: orderedHashes.length,
  };
}

/**
 * Bake one kit's models from `manifest.json`/`catalog.json` + GLB files into:
 * - `<outDir>/chunks/<chunkHash>.chunk`: concatenated 4-byte-aligned SoA geometry records
 * - `<outDir>/<kit>.baked.json`: browser-safe manifest consumed by `BakedAssetProvider`
 * - `<outDir>/store.sqlite`: B0 SQLite index recording baked chunk hashes, offsets, & licences.
 */
export function bakeKitGeometry(options: BakeKitGeometryOptions): BakeKitGeometryResult {
  const outDir = resolve(options.outDir);
  const dbPath = options.dbPath ?? join(outDir, "store.sqlite");
  const chunkId: ChunkKind = options.chunkId ? validateChunkId(options.chunkId) : (`kit:${options.kit}` as ChunkKind);

  const prep = prepareGeometryModelBlobs({ ...options, dbPath });
  const selectedIds = new Set(prep.bakedItems.map((i) => i.asset.id));

  const emitted = emitGeometryChunkPartition({
    outDir,
    manifestRelFile: `${options.kit}.baked.json`,
    chunkId,
    kit: options.kit,
    target: prep.prepared.target,
    items: prep.bakedItems,
    blobBytesByHash: prep.blobBytesByHash,
    shapeById: prep.shapeById,
    selectedIds,
    rejected: prep.rejected,
  });

  const knobsToInsert = prep.prepared.knobsToInsert.filter((k) => selectedIds.has(k.assetId));
  const dbRes = commitBakedStoreDatabase({
    dbPath,
    target: prep.prepared.target,
    manifest: prep.prepared.manifest,
    converterVersion: prep.prepared.converterVersion,
    chunksToInsert: [emitted.chunkRow],
    assetsWithHashes: emitted.assetsWithHashes,
    slotByHash: emitted.slotByHash,
    resolvedClips: [],
    knobsToInsert,
    explicitVariants: (options.variants ?? []).filter((v) => selectedIds.has(v.meshAssetId)),
  });

  return {
    store: dbRes.store,
    chunkPath: emitted.chunkPath,
    manifestPath: emitted.manifestPath,
    manifest: emitted.manifest,
    bakedCount: emitted.manifest.assets.length,
    uniqueBlobCount: emitted.uniqueBlobCount,
    rejectedCount: prep.rejected.length,
    dedupeReport: dbRes.dedupeReport,
    licenceCoverageReport: dbRes.licenceCoverageReport,
  };
}

export interface BakeMultiChunkBundleOptions extends Omit<BuildBakedAssetIndexOptions, "dbPath"> {
  outDir: string;
  dbPath?: string;
  kit?: string;
  assetIds?: ReadonlySet<string> | readonly string[];
  baseChunkId?: ChunkKind;
  /** Assign each baked asset to `"base"`, `"kit:<id>"`, or `"region:<rx>_<rz>"` (defaults to `"kit:<pack>"` or `"base"`). */
  assignChunk?: (asset: { id: string; pack: string }) => ChunkKind;
}

export interface BakeMultiChunkBundleResult {
  store: BakedAssetStore;
  indexPath: string;
  index: BakedStoreIndexManifest;
  chunks: EmittedChunkResult[];
  bakedCount: number;
  rejectedCount: number;
  dedupeReport: DedupeReport;
  licenceCoverageReport: LicenceCoverageReport;
}

/**
 * Bake assets into a multi-chunk B4 bundle:
 * - `<outDir>/index.baked.json`: browser-safe `BakedStoreIndexManifest`
 * - `<outDir>/manifests/<chunk>.baked.json`: per-chunk manifest
 * - `<outDir>/chunks/<chunkHash>.chunk`: per-chunk binary SoA payload
 * - `<outDir>/store.sqlite`: B0 SQLite store recording all chunks & assets.
 */
export function bakeMultiChunkBundle(options: BakeMultiChunkBundleOptions): BakeMultiChunkBundleResult {
  const outDir = resolve(options.outDir);
  const dbPath = options.dbPath ?? join(outDir, "store.sqlite");
  const baseChunkId: ChunkKind = options.baseChunkId ? validateChunkId(options.baseChunkId) : "base";

  const prep = prepareGeometryModelBlobs({ ...options, dbPath });
  const selectedIds = new Set(prep.bakedItems.map((i) => i.asset.id));

  const grouped = new Map<ChunkKind, PreparedModelBlobs["bakedItems"]>();
  grouped.set(baseChunkId, []);
  for (const item of prep.bakedItems) {
    const inferredKit = item.asset.pack ?? (item.asset.id.includes("/") ? item.asset.id.split("/")[0] : undefined);
    const rawCid = options.assignChunk
      ? options.assignChunk({ id: item.asset.id, pack: inferredKit ?? "default" })
      : inferredKit
        ? (`kit:${inferredKit}` as ChunkKind)
        : baseChunkId;
    const cid = validateChunkId(rawCid);
    const list = grouped.get(cid) ?? [];
    list.push(item);
    grouped.set(cid, list);
  }

  const orderedChunkIds = [...grouped.keys()].sort((a, b) => {
    if (a === baseChunkId) return -1;
    if (b === baseChunkId) return 1;
    return compareCodepoint(a, b);
  });

  const chunks: EmittedChunkResult[] = [];
  const indexChunks: BakedStoreChunkEntry[] = [];
  const assetToChunk: Record<string, string> = {};
  const allAssetsWithHashes: HashedAssetRecord[] = [];
  const allSlotsByHash = new Map<string, ResolvedBlobSlot>();

  for (const cid of orderedChunkIds) {
    const items = grouped.get(cid) ?? [];
    const manifestRelFile = chunkManifestFilename(cid);
    const emitted = emitGeometryChunkPartition({
      outDir,
      manifestRelFile,
      chunkId: cid,
      kit: cid,
      target: prep.prepared.target,
      items,
      blobBytesByHash: prep.blobBytesByHash,
      shapeById: prep.shapeById,
      selectedIds,
      rejected: cid === baseChunkId ? prep.rejected : [],
    });
    chunks.push(emitted);
    indexChunks.push({
      chunkId: cid,
      kind: chunkIdToKind(cid),
      chunkFile: emitted.manifest.chunkFile,
      manifestFile: manifestRelFile,
      chunkHash: emitted.manifest.chunkHash,
      chunkBytes: emitted.manifest.chunkBytes,
      assetCount: emitted.manifest.assets.length,
      assetIds: emitted.manifest.assets.map((a) => a.id),
    });
    for (const a of emitted.manifest.assets) {
      assetToChunk[a.id] = cid;
    }
    allAssetsWithHashes.push(...emitted.assetsWithHashes);
    for (const [h, slot] of emitted.slotByHash) {
      if (!allSlotsByHash.has(h)) allSlotsByHash.set(h, slot);
    }
  }

  const index = BakedStoreIndexManifestSchema.parse({
    version: 1,
    target: prep.prepared.target,
    baseChunkId,
    chunks: indexChunks,
    assetToChunk,
  });
  const indexPath = join(outDir, "index.baked.json");
  writeFileAtomic(indexPath, JSON.stringify(index, null, 2));

  const knobsToInsert = prep.prepared.knobsToInsert.filter((k) => selectedIds.has(k.assetId));
  const dbRes = commitBakedStoreDatabase({
    dbPath,
    target: prep.prepared.target,
    manifest: prep.prepared.manifest,
    converterVersion: prep.prepared.converterVersion,
    chunksToInsert: chunks.map((c) => c.chunkRow),
    assetsWithHashes: allAssetsWithHashes,
    slotByHash: allSlotsByHash,
    resolvedClips: [],
    knobsToInsert,
    explicitVariants: (options.variants ?? []).filter((v) => selectedIds.has(v.meshAssetId)),
  });

  return {
    store: dbRes.store,
    indexPath,
    index,
    chunks,
    bakedCount: allAssetsWithHashes.length,
    rejectedCount: prep.rejected.length,
    dedupeReport: dbRes.dedupeReport,
    licenceCoverageReport: dbRes.licenceCoverageReport,
  };
}


