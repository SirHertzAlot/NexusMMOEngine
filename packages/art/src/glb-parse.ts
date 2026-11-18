/**
 * Internal Node-only glTF 2.0 binary (`.glb`) container, accessor, and node
 * transform helpers shared by the B1 geometry baker and B2 animation clip baker.
 *
 * Node-only module: do NOT re-export from `browser.ts`.
 */

import * as THREE from "three";

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"
export const GLB_CHUNK_BIN = 0x004e4942; // "BIN\0"

const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const COMP_BYTE_SIZE: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    roughnessFactor?: number;
    metallicFactor?: number;
  };
}

export interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfAnimationSampler {
  input: number;
  output: number;
  interpolation?: string;
}

export interface GltfAnimationChannel {
  sampler: number;
  target: {
    node?: number;
    path: string;
  };
}

export interface GltfAnimation {
  name?: string;
  channels?: GltfAnimationChannel[];
  samplers?: GltfAnimationSampler[];
}

export interface GltfJson {
  extensionsRequired?: string[];
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  materials?: GltfMaterial[];
  meshes?: Array<{ name?: string; primitives?: GltfPrimitive[] }>;
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  animations?: GltfAnimation[];
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) {
    throw new Error(`external or unsupported glTF buffer URI "${uri.slice(0, 48)}"`);
  }
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (meta.includes(";base64")) {
    return Uint8Array.from(Buffer.from(body, "base64"));
  }
  return Uint8Array.from(Buffer.from(decodeURIComponent(body), "utf8"));
}

function readScalarAt(view: DataView, byteOff: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case 5126:
      return view.getFloat32(byteOff, true);
    case 5125:
      return view.getUint32(byteOff, true);
    case 5123: {
      const v = view.getUint16(byteOff, true);
      return normalized ? v / 65535 : v;
    }
    case 5121: {
      const v = view.getUint8(byteOff);
      return normalized ? v / 255 : v;
    }
    case 5122: {
      const v = view.getInt16(byteOff, true);
      return normalized ? Math.max(-1, v / 32767) : v;
    }
    case 5120: {
      const v = view.getInt8(byteOff);
      return normalized ? Math.max(-1, v / 127) : v;
    }
    default:
      throw new Error(`unsupported glTF componentType ${componentType}`);
  }
}

export function readAccessorValues(
  gltf: GltfJson,
  buffers: readonly Uint8Array[],
  accessorIndex: number,
  expectedType?: string,
): { values: number[]; componentCount: number; accessorType: string } {
  const acc = gltf.accessors?.[accessorIndex];
  if (!acc) throw new Error(`missing glTF accessor ${accessorIndex}`);
  if (expectedType && acc.type !== expectedType) {
    throw new Error(`accessor ${accessorIndex} expected type "${expectedType}", got "${acc.type}"`);
  }
  const comps = TYPE_COMPONENTS[acc.type];
  const compSize = COMP_BYTE_SIZE[acc.componentType];
  if (!comps || !compSize) {
    throw new Error(`unsupported accessor format ${acc.type}/${acc.componentType}`);
  }
  if (acc.bufferView === undefined) {
    return {
      values: new Array<number>(acc.count * comps).fill(0),
      componentCount: comps,
      accessorType: acc.type,
    };
  }
  const bv = gltf.bufferViews?.[acc.bufferView];
  if (!bv) throw new Error(`missing glTF bufferView ${acc.bufferView}`);
  const buf = buffers[bv.buffer];
  if (!buf) throw new Error(`missing glTF buffer ${bv.buffer}`);

  const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : comps * compSize;
  const baseOff = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const lastNeeded = baseOff + (acc.count > 0 ? (acc.count - 1) * stride + comps * compSize : 0);
  if (lastNeeded > buf.byteLength) {
    throw new Error(`accessor ${accessorIndex} out of bounds (${lastNeeded} > ${buf.byteLength})`);
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const norm = Boolean(acc.normalized);
  const out = new Array<number>(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    const elemStart = baseOff + i * stride;
    for (let c = 0; c < comps; c++) {
      out[i * comps + c] = readScalarAt(view, elemStart + c * compSize, acc.componentType, norm);
    }
  }
  return { values: out, componentCount: comps, accessorType: acc.type };
}

export function nodeLocalMatrix(node: GltfNode): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (node.matrix && node.matrix.length === 16) {
    m.fromArray(node.matrix);
    return m;
  }
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return m.compose(
    new THREE.Vector3(t[0], t[1], t[2]),
    new THREE.Quaternion(r[0], r[1], r[2], r[3]),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

export function parseGlbChunks(glbBytes: Uint8Array): { gltf: GltfJson; buffers: Uint8Array[] } {
  if (glbBytes.byteLength < 12) throw new Error("GLB truncated (< 12 bytes)");
  const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLen = view.getUint32(8, true);
  if (magic !== GLB_MAGIC || version !== 2) {
    throw new Error(`not a glTF 2.0 binary (magic=0x${magic.toString(16)}, version=${version})`);
  }
  if (totalLen > glbBytes.byteLength) {
    throw new Error(`GLB length header (${totalLen}) exceeds byteLength (${glbBytes.byteLength})`);
  }

  let off = 12;
  let gltfJson: GltfJson | null = null;
  let binChunk: Uint8Array | null = null;
  while (off + 8 <= totalLen) {
    const chunkLen = view.getUint32(off, true);
    const chunkType = view.getUint32(off + 4, true);
    const dataStart = off + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd > totalLen) throw new Error("GLB chunk exceeds container length");
    const slice = glbBytes.subarray(dataStart, dataEnd);
    if (chunkType === GLB_CHUNK_JSON && gltfJson === null) {
      gltfJson = JSON.parse(Buffer.from(slice).toString("utf8")) as GltfJson;
    } else if (chunkType === GLB_CHUNK_BIN && binChunk === null) {
      binChunk = slice;
    }
    off = dataEnd;
  }

  if (!gltfJson) throw new Error("GLB missing JSON chunk");
  const req = gltfJson.extensionsRequired ?? [];
  if (req.length > 0) {
    throw new Error(`unsupported required glTF extension(s): ${req.join(", ")}`);
  }

  const buffers: Uint8Array[] = [];
  for (let i = 0; i < (gltfJson.buffers?.length ?? 0); i++) {
    const b = gltfJson.buffers![i];
    if (b.uri) {
      buffers.push(decodeDataUri(b.uri));
    } else if (i === 0 && binChunk) {
      buffers.push(binChunk);
    } else {
      throw new Error(`missing binary data for glTF buffer ${i}`);
    }
  }
  return { gltf: gltfJson, buffers };
}

/** Build a lightweight `THREE.Group` hierarchy mirroring GLB nodes/bones for clip validation & playback. */
export function buildGlbNodeHierarchy(gltf: GltfJson): THREE.Group {
  const root = new THREE.Group();
  const nodes = gltf.nodes ?? [];
  const objs = nodes.map((n, idx) => {
    const obj = new THREE.Object3D();
    obj.name = THREE.PropertyBinding.sanitizeNodeName(n.name ?? `node_${idx}`);
    if (n.matrix && n.matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(n.matrix);
      m.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      const t = n.translation ?? [0, 0, 0];
      const r = n.rotation ?? [0, 0, 0, 1];
      const s = n.scale ?? [1, 1, 1];
      obj.position.set(t[0], t[1], t[2]);
      obj.quaternion.set(r[0], r[1], r[2], r[3]);
      obj.scale.set(s[0], s[1], s[2]);
    }
    return obj;
  });

  const childSet = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    for (const c of nodes[i].children ?? []) {
      if (objs[c]) {
        objs[i].add(objs[c]);
        childSet.add(c);
      }
    }
  }

  const sceneIdx = gltf.scene ?? 0;
  const roots = gltf.scenes?.[sceneIdx]?.nodes;
  if (roots && roots.length > 0) {
    for (const r of roots) {
      if (objs[r]) root.add(objs[r]);
    }
  } else {
    for (let i = 0; i < objs.length; i++) {
      if (!childSet.has(i)) root.add(objs[i]);
    }
  }
  root.updateMatrixWorld(true);
  return root;
}
