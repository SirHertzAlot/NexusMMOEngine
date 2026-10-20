/**
 * GLB + EXT_meshopt_compression geometry decode (SAB Phase 6).
 *
 * Pure, environment-independent core shared by both decode paths:
 * - Worker path: `decodeGlbIntoSab()` writes packed attribute bytes into a
 *   SAB arena; the main thread builds BufferGeometry views over the SAB.
 * - Fallback path: `decodeGlb()` returns the same packed bytes as plain
 *   arrays; the main thread decodes on its own thread.
 * Same bytes in -> same bytes out on either path (tested).
 *
 * Scope: geometry only (mesh primitives: attributes + index + material
 * index). Materials, textures, skins, animations, and cameras stay on the
 * GLTFLoader path (`render/gltf-loader.ts`) — those are THREE object graphs
 * that cannot live in a SAB. Sparse accessors, MAT* attributes, and
 * multi-buffer GLBs throw GlbDecodeError so the caller can fall back.
 *
 * Asset type: meshopt-compressed GLB (gltfpack `-cc`), the format the bake
 * pipeline produces and the client already reads via MeshoptDecoder.
 * Uncompressed GLBs decode through the same code (meshopt extension
 * absent -> plain bufferView read).
 */

import { MeshoptDecoder } from "meshoptimizer/decoder";
import { SabArena } from "./sab-arena.js";

export class GlbDecodeError extends Error {
  constructor(message: string) {
    super(`GLB decode: ${message}`);
    this.name = "GlbDecodeError";
  }
}

/** glTF componentType -> [TypedArray ctor, byte size]. */
const COMPONENTS = {
  5120: [Int8Array, 1],
  5121: [Uint8Array, 1],
  5122: [Int16Array, 2],
  5123: [Uint16Array, 2],
  5125: [Uint32Array, 4],
  5126: [Float32Array, 4],
} as const;

type ComponentType = keyof typeof COMPONENTS;

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export interface DecodedAttribute {
  name: string;
  componentType: ComponentType;
  /** Components per vertex (1 SCALAR .. 4 VEC4). */
  itemSize: number;
  count: number;
  normalized: boolean;
  /** Tightly-packed little-endian bytes (count * itemSize * componentSize). */
  bytes: Uint8Array;
}

export interface DecodedIndex {
  componentType: 5123 | 5125;
  count: number;
  bytes: Uint8Array;
}

export interface DecodedPrimitive {
  attributes: DecodedAttribute[];
  index: DecodedIndex | null;
  material: number | undefined;
}

export interface DecodedGlb {
  primitives: DecodedPrimitive[];
}

/** One attribute's SAB placement, returned by the worker (plain JSON). */
export interface SabAttributeDesc {
  name: string;
  componentType: ComponentType;
  itemSize: number;
  count: number;
  normalized: boolean;
  /** Absolute byte offset of the packed bytes inside the SAB. */
  byteOffset: number;
}

export interface SabIndexDesc {
  componentType: 5123 | 5125;
  count: number;
  byteOffset: number;
}

export interface SabPrimitiveDesc {
  attributes: SabAttributeDesc[];
  index: SabIndexDesc | null;
  material: number | undefined;
}

export interface SabDecodeResult {
  primitives: SabPrimitiveDesc[];
  /** Payload bytes written (excludes the arena header). */
  totalBytes: number;
}

interface GlbContainer {
  json: any;
  /** BIN chunk bytes (empty when the GLB has no BIN chunk). */
  bin: Uint8Array;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export function parseGlbContainer(bytes: Uint8Array): GlbContainer {
  if (bytes.byteLength < 12) throw new GlbDecodeError(`too short: ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new GlbDecodeError("bad magic — not a GLB");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbDecodeError(`unsupported version ${version} (want 2)`);
  const declaredLength = view.getUint32(8, true);
  if (declaredLength > bytes.byteLength) {
    throw new GlbDecodeError(`truncated: header declares ${declaredLength} bytes, got ${bytes.byteLength}`);
  }
  let offset = 12;
  let json: any = null;
  let bin = new Uint8Array(0);
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > declaredLength) throw new GlbDecodeError("truncated chunk");
    if (chunkType === CHUNK_JSON) {
      // JSON chunk padding is spaces per spec; tolerate NUL padding too.
      const text = new TextDecoder().decode(bytes.subarray(start, end)).replace(/[\0\s]+$/, "");
      json = JSON.parse(text);
    } else if (chunkType === CHUNK_BIN) {
      bin = bytes.slice(start, end);
    }
    offset = end;
  }
  if (json === null) throw new GlbDecodeError("missing JSON chunk");
  return { json, bin };
}

function componentSize(componentType: number): number {
  const entry = (COMPONENTS as Record<number, readonly [unknown, number] | undefined>)[componentType];
  if (!entry) throw new GlbDecodeError(`unsupported componentType ${componentType}`);
  return entry[1];
}

/** Effective (decoded) bytes of a bufferView: meshopt-decoded, or the raw BIN slice. */
async function bufferViewBytes(
  json: any,
  bin: Uint8Array,
  bufferViewIndex: number,
  cache: Map<number, Uint8Array>,
): Promise<Uint8Array> {
  const cached = cache.get(bufferViewIndex);
  if (cached) return cached;
  const bv = json.bufferViews?.[bufferViewIndex];
  if (!bv) throw new GlbDecodeError(`missing bufferView ${bufferViewIndex}`);
  if (bv.buffer !== undefined && bv.buffer !== 0) {
    throw new GlbDecodeError(`bufferView ${bufferViewIndex} references buffer ${bv.buffer} — GLB-only pipeline (buffer 0)`);
  }
  let out: Uint8Array;
  const ext = bv.extensions?.EXT_meshopt_compression;
  if (ext) {
    if (ext.buffer !== undefined && ext.buffer !== 0) {
      throw new GlbDecodeError(`meshopt bufferView ${bufferViewIndex} references buffer ${ext.buffer} — GLB-only pipeline`);
    }
    await MeshoptDecoder.ready;
    const compressed = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    out = await MeshoptDecoder.decodeGltfBufferAsync(ext.count, ext.byteStride, compressed, ext.mode, ext.filter ?? "NONE");
  } else {
    const start = bv.byteOffset ?? 0;
    out = bin.subarray(start, start + bv.byteLength);
  }
  cache.set(bufferViewIndex, out);
  return out;
}

/**
 * Read one accessor into tightly-packed bytes. Handles interleaved
 * bufferViews (byteStride) by gathering each vertex's components.
 */
async function readAccessor(
  json: any,
  bin: Uint8Array,
  cache: Map<number, Uint8Array>,
  accessorIndex: number,
): Promise<{ componentType: ComponentType; itemSize: number; count: number; normalized: boolean; bytes: Uint8Array }> {
  const acc = json.accessors?.[accessorIndex];
  if (!acc) throw new GlbDecodeError(`missing accessor ${accessorIndex}`);
  if (acc.sparse !== undefined) {
    throw new GlbDecodeError(`sparse accessor ${accessorIndex} unsupported — fall back to GLTFLoader`);
  }
  const itemSize = TYPE_COMPONENTS[acc.type as string];
  if (itemSize === undefined) throw new GlbDecodeError(`unsupported accessor type ${String(acc.type)}`);
  if (acc.type === "MAT2" || acc.type === "MAT3" || acc.type === "MAT4") {
    throw new GlbDecodeError(`matrix accessor ${accessorIndex} (${acc.type}) unsupported for geometry attributes`);
  }
  const compSize = componentSize(acc.componentType);
  const count: number = acc.count;
  const packedBytes = count * itemSize * compSize;
  const bytes = new Uint8Array(packedBytes);
  if (acc.bufferView === undefined) {
    // No bufferView: spec says the accessor is zero-filled.
    return { componentType: acc.componentType, itemSize, count, normalized: acc.normalized === true, bytes };
  }
  const bv = json.bufferViews[acc.bufferView];
  const viewBytes = await bufferViewBytes(json, bin, acc.bufferView, cache);
  const stride = bv.byteStride ?? itemSize * compSize;
  const base = acc.byteOffset ?? 0;
  const itemBytes = itemSize * compSize;
  if (stride === itemBytes && base === 0 && viewBytes.byteLength >= packedBytes) {
    // Fast path: already tightly packed at the view start.
    bytes.set(viewBytes.subarray(0, packedBytes));
  } else {
    for (let i = 0; i < count; i++) {
      const src = base + i * stride;
      if (src + itemBytes > viewBytes.byteLength) {
        throw new GlbDecodeError(`accessor ${accessorIndex} reads past its bufferView`);
      }
      bytes.set(viewBytes.subarray(src, src + itemBytes), i * itemBytes);
    }
  }
  return { componentType: acc.componentType, itemSize, count, normalized: acc.normalized === true, bytes };
}

/** Decode GLB bytes into packed per-primitive geometry (fallback / core). */
export async function decodeGlb(glbBytes: Uint8Array): Promise<DecodedGlb> {
  const { json, bin } = parseGlbContainer(glbBytes);
  const cache = new Map<number, Uint8Array>();
  const primitives: DecodedPrimitive[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const attributes: DecodedAttribute[] = [];
      for (const [name, accessorIndex] of Object.entries<number>(prim.attributes ?? {})) {
        const a = await readAccessor(json, bin, cache, accessorIndex);
        attributes.push({ name, ...a });
      }
      let index: DecodedIndex | null = null;
      if (prim.indices !== undefined) {
        const ix = await readAccessor(json, bin, cache, prim.indices);
        if (ix.componentType !== 5123 && ix.componentType !== 5125) {
          throw new GlbDecodeError(`index accessor uses componentType ${ix.componentType}`);
        }
        index = { componentType: ix.componentType, count: ix.count, bytes: ix.bytes };
      }
      primitives.push({ attributes, index, material: prim.material });
    }
  }
  return { primitives };
}

/**
 * Exact SAB payload size for these GLB bytes, from the JSON accessor
 * metadata alone (no meshopt decode). The main thread allocates exactly
 * this much; the worker still reports overflow if the estimate ever lies.
 */
export function estimateSabPayloadBytes(glbBytes: Uint8Array): number {
  const { json } = parseGlbContainer(glbBytes);
  let total = 0;
  const add = (accessorIndex: number | undefined) => {
    if (accessorIndex === undefined) return;
    const acc = json.accessors?.[accessorIndex];
    if (!acc) return;
    const itemSize = TYPE_COMPONENTS[acc.type as string];
    if (itemSize === undefined) return;
    total += acc.count * itemSize * componentSize(acc.componentType);
  };
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const accessorIndex of Object.values<number>(prim.attributes ?? {})) add(accessorIndex);
      add(prim.indices);
    }
  }
  return total;
}

/**
 * Decode GLB bytes into a SAB arena (worker path). The worker allocates
 * each attribute/index byte range in the arena and copies the decoded
 * packed bytes in; the returned descriptors let the main thread build
 * BufferGeometry views over the SAB without copying the vertex data.
 * @throws SabOverflowError when the arena is too small (neededBytes set).
 */
export async function decodeGlbIntoSab(glbBytes: Uint8Array, arena: SabArena): Promise<SabDecodeResult> {
  const decoded = await decodeGlb(glbBytes);
  let totalBytes = 0;
  const primitives: SabPrimitiveDesc[] = decoded.primitives.map((prim) => {
    const attributes: SabAttributeDesc[] = prim.attributes.map((attr) => {
      const byteOffset = arena.alloc(attr.bytes.byteLength);
      arena.write(byteOffset, attr.bytes);
      totalBytes += attr.bytes.byteLength;
      return {
        name: attr.name,
        componentType: attr.componentType,
        itemSize: attr.itemSize,
        count: attr.count,
        normalized: attr.normalized,
        byteOffset,
      };
    });
    let index: SabIndexDesc | null = null;
    if (prim.index) {
      const byteOffset = arena.alloc(prim.index.bytes.byteLength);
      arena.write(byteOffset, prim.index.bytes);
      totalBytes += prim.index.bytes.byteLength;
      index = { componentType: prim.index.componentType, count: prim.index.count, byteOffset };
    }
    return { attributes, index, material: prim.material };
  });
  return { primitives, totalBytes };
}

export { COMPONENTS };
