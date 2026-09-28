/**
 * PCGM — pcg-core's binary mesh (pcg_api.h, pcg_mesh_binary.cpp), decoded
 * into typed arrays the renderer uploads as-is. Little-endian:
 *
 *   header  'PCGM' | version | vertexCount | indexCount | flags (v2+)
 *           | materialSectionBytes (v3)          (16 / 20 / 24 bytes)
 *   float32 xyz positions [vertexCount * 3]
 *   uint32  triangle indices [indexCount]
 *   flags & 1: float32 normals [vertexCount * 3]
 *   flags & 2: float32 rgba colours [vertexCount * 4]
 *   flags & 4: float32 uvs [vertexCount * 2]
 *   flags & 8 (v3): u32 slotCount, slotCount x (u32 byteLength, UTF-8 name),
 *                   u32 material slot per triangle
 */

export const PCGM_MAGIC = 0x4d474350;

export interface PcgMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array | null;
  colors: Float32Array | null;
  uvs: Float32Array | null;
  /** Material slot names, and each triangle's slot (null without materials). */
  materials: string[];
  triangleMaterials: Uint32Array | null;
}

function floats(bytes: Uint8Array, offset: number, count: number): Float32Array {
  // Copy: the section may not be 4-byte aligned in the source buffer.
  const out = new Float32Array(count);
  new Uint8Array(out.buffer).set(bytes.subarray(offset, offset + count * 4));
  return out;
}

function uints(bytes: Uint8Array, offset: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  new Uint8Array(out.buffer).set(bytes.subarray(offset, offset + count * 4));
  return out;
}

export function decodePcgMesh(buffer: ArrayBuffer | Uint8Array): PcgMesh {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== PCGM_MAGIC) throw new Error("PCGM: bad magic");
  const version = view.getUint32(4, true);
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const flags = version >= 2 ? view.getUint32(16, true) : 0;
  let offset = version >= 3 ? 24 : version === 2 ? 20 : 16;
  const need = (n: number): void => {
    if (offset + n > bytes.byteLength) throw new Error(`PCGM: truncated (need ${offset + n} bytes, have ${bytes.byteLength})`);
  };
  need(vertexCount * 12 + indexCount * 4);
  const positions = floats(bytes, offset, vertexCount * 3);
  offset += vertexCount * 12;
  const indices = uints(bytes, offset, indexCount);
  offset += indexCount * 4;
  let normals: Float32Array | null = null;
  let colors: Float32Array | null = null;
  let uvs: Float32Array | null = null;
  if (flags & 1) {
    need(vertexCount * 12);
    normals = floats(bytes, offset, vertexCount * 3);
    offset += vertexCount * 12;
  }
  if (flags & 2) {
    need(vertexCount * 16);
    colors = floats(bytes, offset, vertexCount * 4);
    offset += vertexCount * 16;
  }
  if (flags & 4) {
    need(vertexCount * 8);
    uvs = floats(bytes, offset, vertexCount * 2);
    offset += vertexCount * 8;
  }
  const materials: string[] = [];
  let triangleMaterials: Uint32Array | null = null;
  if (version >= 3 && flags & 8) {
    need(4);
    const slots = view.getUint32(offset, true);
    offset += 4;
    const text = new TextDecoder();
    for (let i = 0; i < slots; i++) {
      need(4);
      const len = view.getUint32(offset, true);
      offset += 4;
      need(len);
      materials.push(text.decode(bytes.subarray(offset, offset + len)));
      offset += len;
    }
    const triangles = Math.floor(indexCount / 3);
    need(triangles * 4);
    triangleMaterials = uints(bytes, offset, triangles);
  }
  for (let i = 0; i < indexCount; i++) {
    if (indices[i] >= vertexCount) throw new Error(`PCGM: index ${indices[i]} out of range (${vertexCount} vertices)`);
  }
  return { positions, indices, normals, colors, uvs, materials, triangleMaterials };
}
