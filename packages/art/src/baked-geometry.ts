/**
 * Browser-safe Baked Asset Store B1 geometry SoA codec & manifest schema.
 *
 * Binary layout (little-endian, 4-byte aligned):
 * - Header (40 bytes):
 *     [0..4)   magic = 0x4D4D4F42 ("MMOB")
 *     [4..8)   version = 1
 *     [8..12)  vertexCount (u32)
 *     [12..16) indexCount (u32)
 *     [16..20) groupCount (u32)
 *     [20..24) boundingSphere.cx (f32)
 *     [24..28) boundingSphere.cy (f32)
 *     [28..32) boundingSphere.cz (f32)
 *     [32..36) boundingSphere.radius (f32)
 *     [36..40) reserved (u32 = 0)
 * - Groups (groupCount * 20 bytes):
 *     [+0..4)  start (u32 index offset)
 *     [+4..8)  count (u32 index count)
 *     [+8..12) colorRgba (u32 packed R<<24 | G<<16 | B<<8 | A)
 *     [+12..16) roughness (f32)
 *     [+16..20) metalness (f32)
 * - SoA column streams:
 *     positions: Float32Array(vertexCount * 3)
 *     normals:   Float32Array(vertexCount * 3)
 *     uvs:       Float32Array(vertexCount * 2)
 *     indices:   Uint32Array(indexCount)
 */

import * as THREE from "three";
import { z } from "zod";
import { canonF32 } from "./util.js";

export const BAKED_GEOMETRY_MAGIC = 0x4d4d4f42; // "MMOB"
export const BAKED_GEOMETRY_VERSION = 1;
const HEADER_BYTES = 40;
const GROUP_STRIDE_BYTES = 20;

export interface BakedMaterialGroup {
  start: number;
  count: number;
  /** Packed RGBA bytes `[r << 24 | g << 16 | b << 8 | a] >>> 0`. */
  colorRgba: number;
  roughness: number;
  metalness: number;
}

export interface BakedBoundingSphere {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface BakedGeometryRecord {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: BakedMaterialGroup[];
  boundingSphere: BakedBoundingSphere;
}

/** Browser-safe runtime manifest describing one baked kit chunk file (`chunks/<hash>.chunk`). */
export const BakedChunkAssetEntrySchema = z.object({
  id: z.string().min(1),
  assetHash: z.number().int().nonnegative(),
  canonicalId: z.string().min(1),
  byteOffset: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  blobHash: z.string().regex(/^[0-9a-f]{64}$/),
  licenceLane: z.string().min(1),
  forShape: z.string().min(1).optional(),
  credit: z.string().nullable().optional(),
});

export const BakedChunkRejectedEntrySchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});

export const BakedChunkManifestSchema = z.object({
  version: z.literal(1),
  kit: z.string().min(1),
  target: z.enum(["own-game", "shipped-prototype-pack"]),
  chunkId: z.string().min(1),
  chunkFile: z.string().min(1),
  chunkHash: z.string().regex(/^[0-9a-f]{64}$/),
  chunkBytes: z.number().int().nonnegative(),
  assets: z.array(BakedChunkAssetEntrySchema),
  rejected: z.array(BakedChunkRejectedEntrySchema).default([]),
});

export type BakedChunkAssetEntry = z.infer<typeof BakedChunkAssetEntrySchema>;
export type BakedChunkRejectedEntry = z.infer<typeof BakedChunkRejectedEntrySchema>;
export type BakedChunkManifest = z.infer<typeof BakedChunkManifestSchema>;

/** Canonical FNV-1a 32-bit hash matching `@mmo-engine/scatter` `AssetRef.assetHash`. */
export function bakedAssetHash32(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Compute centroid + bounding radius over `positions` (`xyz` triples). */
export function computeBakedBoundingSphere(positions: Float32Array): BakedBoundingSphere {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) return { cx: 0, cy: 0, cz: 0, radius: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = canonF32((minX + maxX) * 0.5);
  const cy = canonF32((minY + maxY) * 0.5);
  const cz = canonF32((minZ + maxZ) * 0.5);
  let r2 = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { cx, cy, cz, radius: canonF32(Math.sqrt(r2)) };
}

/** Pack `[r, g, b, a]` floats in `0..1` to a deterministic uint32 `0xRRGGBBAA`. */
export function packColorRgba(r = 1, g = 1, b = 1, a = 1): number {
  const clampByte = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  return (
    ((clampByte(r) << 24) |
      (clampByte(g) << 16) |
      (clampByte(b) << 8) |
      clampByte(a)) >>>
    0
  );
}

/** Encode SoA geometry streams into a canonical, 4-byte-aligned binary blob. */
export function encodeBakedGeometryRecord(input: {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups?: readonly BakedMaterialGroup[];
  boundingSphere?: BakedBoundingSphere;
}): Uint8Array {
  if (input.positions.length % 3 !== 0) {
    throw new Error(`positions length ${input.positions.length} must be a multiple of 3`);
  }
  const vertexCount = input.positions.length / 3;
  if (input.normals.length !== vertexCount * 3) {
    throw new Error(`normals length ${input.normals.length} does not match vertexCount * 3 (${vertexCount * 3})`);
  }
  if (input.uvs.length !== vertexCount * 2) {
    throw new Error(`uvs length ${input.uvs.length} does not match vertexCount * 2 (${vertexCount * 2})`);
  }
  const indexCount = input.indices.length;
  const groups: readonly BakedMaterialGroup[] =
    input.groups && input.groups.length > 0
      ? input.groups
      : [{ start: 0, count: indexCount, colorRgba: 0xffffffff, roughness: 0.9, metalness: 0 }];

  const sphere = input.boundingSphere ?? computeBakedBoundingSphere(input.positions);
  const posBytes = vertexCount * 3 * 4;
  const normBytes = vertexCount * 3 * 4;
  const uvBytes = vertexCount * 2 * 4;
  const idxBytes = indexCount * 4;
  const groupBytes = groups.length * GROUP_STRIDE_BYTES;
  const totalBytes = HEADER_BYTES + groupBytes + posBytes + normBytes + uvBytes + idxBytes;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, BAKED_GEOMETRY_MAGIC, true);
  view.setUint32(4, BAKED_GEOMETRY_VERSION, true);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indexCount, true);
  view.setUint32(16, groups.length, true);
  view.setFloat32(20, canonF32(sphere.cx), true);
  view.setFloat32(24, canonF32(sphere.cy), true);
  view.setFloat32(28, canonF32(sphere.cz), true);
  view.setFloat32(32, canonF32(sphere.radius), true);
  view.setUint32(36, 0, true);

  let off = HEADER_BYTES;
  for (const grp of groups) {
    if (grp.start < 0 || grp.count < 0 || grp.start + grp.count > indexCount) {
      throw new Error(`material group [${grp.start}, +${grp.count}) exceeds indexCount ${indexCount}`);
    }
    view.setUint32(off, grp.start >>> 0, true);
    view.setUint32(off + 4, grp.count >>> 0, true);
    view.setUint32(off + 8, grp.colorRgba >>> 0, true);
    view.setFloat32(off + 12, canonF32(grp.roughness), true);
    view.setFloat32(off + 16, canonF32(grp.metalness), true);
    off += GROUP_STRIDE_BYTES;
  }

  const writeF32Column = (src: Float32Array): void => {
    for (let i = 0; i < src.length; i++) {
      view.setFloat32(off, canonF32(src[i]), true);
      off += 4;
    }
  };
  writeF32Column(input.positions);
  writeF32Column(input.normals);
  writeF32Column(input.uvs);
  for (let i = 0; i < input.indices.length; i++) {
    view.setUint32(off, input.indices[i] >>> 0, true);
    off += 4;
  }
  return out;
}

/** Decode a baked SoA geometry record from a slice of a chunk byte buffer. */
export function decodeBakedGeometryRecord(
  bytes: Uint8Array,
  byteOffset = 0,
  byteLength?: number,
): BakedGeometryRecord {
  const len = byteLength ?? bytes.byteLength - byteOffset;
  if (byteOffset < 0 || len < HEADER_BYTES || byteOffset + len > bytes.byteLength) {
    throw new Error(`invalid baked geometry slice [${byteOffset}..${byteOffset + len}) of ${bytes.byteLength}`);
  }
  const absStart = bytes.byteOffset + byteOffset;
  const view = new DataView(bytes.buffer, absStart, len);
  const magic = view.getUint32(0, true);
  if (magic !== BAKED_GEOMETRY_MAGIC) {
    throw new Error(`bad baked geometry magic 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== BAKED_GEOMETRY_VERSION) {
    throw new Error(`unsupported baked geometry version ${version}`);
  }
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const groupCount = view.getUint32(16, true);
  const boundingSphere: BakedBoundingSphere = {
    cx: view.getFloat32(20, true),
    cy: view.getFloat32(24, true),
    cz: view.getFloat32(28, true),
    radius: view.getFloat32(32, true),
  };

  const expectedBytes =
    HEADER_BYTES +
    groupCount * GROUP_STRIDE_BYTES +
    vertexCount * 8 * 4 +
    indexCount * 4;
  if (expectedBytes !== len) {
    throw new Error(`baked geometry byteLength mismatch: header expects ${expectedBytes}, got ${len}`);
  }

  const groups: BakedMaterialGroup[] = [];
  let off = HEADER_BYTES;
  for (let i = 0; i < groupCount; i++) {
    const start = view.getUint32(off, true);
    const count = view.getUint32(off + 4, true);
    const colorRgba = view.getUint32(off + 8, true);
    const roughness = view.getFloat32(off + 12, true);
    const metalness = view.getFloat32(off + 16, true);
    if (start + count > indexCount) {
      throw new Error(`baked geometry group ${i} [${start}, +${count}) exceeds indexCount ${indexCount}`);
    }
    groups.push({ start, count, colorRgba, roughness, metalness });
    off += GROUP_STRIDE_BYTES;
  }

  const sliceF32 = (bytePos: number, count: number): Float32Array => {
    const total = bytes.byteOffset + byteOffset + bytePos;
    if (total % 4 === 0) {
      return new Float32Array(bytes.buffer, total, count);
    }
    const copy = bytes.slice(byteOffset + bytePos, byteOffset + bytePos + count * 4);
    return new Float32Array(copy.buffer);
  };
  const sliceU32 = (bytePos: number, count: number): Uint32Array => {
    const total = bytes.byteOffset + byteOffset + bytePos;
    if (total % 4 === 0) {
      return new Uint32Array(bytes.buffer, total, count);
    }
    const copy = bytes.slice(byteOffset + bytePos, byteOffset + bytePos + count * 4);
    return new Uint32Array(copy.buffer);
  };

  const posCount = vertexCount * 3;
  const normCount = vertexCount * 3;
  const uvCount = vertexCount * 2;
  const positions = sliceF32(off, posCount);
  off += posCount * 4;
  const normals = sliceF32(off, normCount);
  off += normCount * 4;
  const uvs = sliceF32(off, uvCount);
  off += uvCount * 4;
  const indices = sliceU32(off, indexCount);

  return { positions, normals, uvs, indices, groups, boundingSphere };
}

/** Build a Three.js `BufferGeometry` directly from SoA columns (no GLB parse). */
export function buildGeometryFromBakedRecord(record: BakedGeometryRecord): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(record.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(record.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(record.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(record.indices, 1));
  if (record.groups.length > 1) {
    for (let i = 0; i < record.groups.length; i++) {
      geometry.addGroup(record.groups[i].start, record.groups[i].count, i);
    }
  }
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(record.boundingSphere.cx, record.boundingSphere.cy, record.boundingSphere.cz),
    record.boundingSphere.radius,
  );
  return geometry;
}

/** Build a Three.js `Mesh` + shared standard materials from a baked geometry record. */
export function buildObjectFromBakedRecord(
  record: BakedGeometryRecord,
  sharedMaterials?: Map<string, THREE.MeshStandardMaterial>,
): THREE.Mesh {
  const geometry = buildGeometryFromBakedRecord(record);
  const matForGroup = (grp: BakedMaterialGroup): THREE.MeshStandardMaterial => {
    const key = `${grp.colorRgba.toString(16)}:${grp.roughness.toFixed(3)}:${grp.metalness.toFixed(3)}`;
    const cached = sharedMaterials?.get(key);
    if (cached) return cached;
    const r = ((grp.colorRgba >>> 24) & 0xff) / 255;
    const g = ((grp.colorRgba >>> 16) & 0xff) / 255;
    const b = ((grp.colorRgba >>> 8) & 0xff) / 255;
    const a = (grp.colorRgba & 0xff) / 255;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      roughness: grp.roughness,
      metalness: grp.metalness,
      transparent: a < 0.999,
      opacity: a,
    });
    sharedMaterials?.set(key, mat);
    return mat;
  };
  const materials = record.groups.map(matForGroup);
  return new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
}
