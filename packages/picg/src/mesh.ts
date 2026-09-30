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

/**
 * A mesh as PCGM v3 (the layout above): what the engine's own generators
 * (dungeon shells) write, so their meshes take the same path as cooked
 * ones (optimizeMesh, the Pcg service, the client's decoder).
 */
export function encodePcgMesh(mesh: Partial<PcgMesh> & Pick<PcgMesh, "positions" | "indices">): Uint8Array {
  const vertexCount = mesh.positions.length / 3;
  const indexCount = mesh.indices.length;
  if (!Number.isInteger(vertexCount)) throw new Error("PCGM: positions must be xyz triples");
  if (indexCount % 3 !== 0) throw new Error("PCGM: indices must be triangles");
  for (const i of mesh.indices) if (i >= vertexCount) throw new Error(`PCGM: index ${i} out of range (${vertexCount} vertices)`);
  const check = (a: Float32Array | null | undefined, per: number, name: string): Float32Array | null => {
    if (!a) return null;
    if (a.length !== vertexCount * per) throw new Error(`PCGM: ${name} must have ${per} values per vertex`);
    return a;
  };
  const normals = check(mesh.normals, 3, "normals");
  const colors = check(mesh.colors, 4, "colors");
  const uvs = check(mesh.uvs, 2, "uvs");
  const materials = mesh.triangleMaterials ? mesh.materials ?? [] : [];
  if (mesh.triangleMaterials) {
    if (mesh.triangleMaterials.length !== indexCount / 3) throw new Error("PCGM: one material slot per triangle");
    for (const m of mesh.triangleMaterials) if (m >= materials.length) throw new Error(`PCGM: material slot ${m} has no name`);
  }
  const names = materials.map((n) => new TextEncoder().encode(n));
  const materialBytes = mesh.triangleMaterials ? 4 + names.reduce((n, b) => n + 4 + b.length, 0) + (indexCount / 3) * 4 : 0;
  const flags = (normals ? 1 : 0) | (colors ? 2 : 0) | (uvs ? 4 : 0) | (mesh.triangleMaterials ? 8 : 0);
  const size = 24 + vertexCount * 12 + indexCount * 4 + (normals ? vertexCount * 12 : 0) + (colors ? vertexCount * 16 : 0) + (uvs ? vertexCount * 8 : 0) + materialBytes;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, PCGM_MAGIC, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indexCount, true);
  view.setUint32(16, flags, true);
  view.setUint32(20, materialBytes, true);
  let offset = 24;
  const put = (a: Float32Array | Uint32Array): void => {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset);
    offset += a.byteLength;
  };
  put(mesh.positions);
  put(mesh.indices);
  if (normals) put(normals);
  if (colors) put(colors);
  if (uvs) put(uvs);
  if (mesh.triangleMaterials) {
    view.setUint32(offset, names.length, true);
    offset += 4;
    for (const b of names) {
      view.setUint32(offset, b.length, true);
      offset += 4;
      out.set(b, offset);
      offset += b.length;
    }
    put(mesh.triangleMaterials);
  }
  return out;
}
