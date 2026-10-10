/**
 * TL0: generate 3 baseline GLBs by hand (minimal valid glTF 2.0 binary).
 * A prop (box), a character-ish mesh (two boxes), and a vista piece
 * (subdivided plane). Measurement baselines, not art.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "baselines");
mkdirSync(root, { recursive: true });

/** Build a minimal GLB from a list of {positions: Float32Array, indices: Uint16Array, color: [r,g,b]} meshes. */
function buildGlb(meshes) {
  // Concatenate all vertex data into one buffer
  let vtxBytes = 0, idxBytes = 0;
  for (const m of meshes) {
    vtxBytes += m.positions.byteLength;
    idxBytes += m.indices.byteLength;
  }
  const bin = Buffer.alloc(vtxBytes + idxBytes);
  let vtxOffset = 0, idxOffset = vtxBytes;
  const accessors = [];
  const bufferViews = [];
  const meshDefs = [];

  for (const m of meshes) {
    const vtxStart = vtxOffset;
    Buffer.from(m.positions.buffer).copy(bin, vtxOffset);
    vtxOffset += m.positions.byteLength;
    const idxStart = idxOffset;
    Buffer.from(m.indices.buffer).copy(bin, idxOffset);
    idxOffset += m.indices.byteLength;

    // bounds
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], m.positions[i + a]);
        max[a] = Math.max(max[a], m.positions[i + a]);
      }
    }

    const vtxView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: vtxStart, byteLength: m.positions.byteLength, target: 34962 });
    const idxView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: idxStart, byteLength: m.indices.byteLength, target: 34963 });
    const vtxAcc = accessors.length;
    accessors.push({ bufferView: vtxView, componentType: 5126, count: m.positions.length / 3, type: "VEC3", min, max });
    const idxAcc = accessors.length;
    accessors.push({ bufferView: idxView, componentType: 5123, count: m.indices.length, type: "SCALAR" });

    const matIdx = meshDefs.length; // one material per mesh for simplicity
    meshDefs.push({
      primitives: [{ attributes: { POSITION: vtxAcc }, indices: idxAcc, material: matIdx }],
    });
  }

  const materials = meshes.map((m) => ({
    pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  }));

  const json = {
    asset: { version: "2.0", generator: "tl0-baselines" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    accessors,
    materials,
    meshes: meshDefs,
    nodes: meshDefs.map((_, i) => ({ mesh: i })),
    scenes: [{ nodes: meshDefs.map((_, i) => i) }],
    scene: 0,
  };
  const jsonStr = JSON.stringify(json);
  const jsonBuf = Buffer.from(jsonStr, "utf8");
  // pad JSON to 4-byte alignment with spaces
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  // pad BIN to 4-byte alignment
  const binPad = (4 - (bin.length % 4)) % 4;
  const binPadded = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = Buffer.alloc(total);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4; // magic 'glTF'
  glb.writeUInt32LE(2, o); o += 4; // version
  glb.writeUInt32LE(total, o); o += 4; // length
  glb.writeUInt32LE(jsonPadded.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4; // 'JSON'
  jsonPadded.copy(glb, o); o += jsonPadded.length;
  glb.writeUInt32LE(binPadded.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4; // 'BIN\0'
  binPadded.copy(glb, o);
  return glb;
}

function box(w, h, d) {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const positions = new Float32Array([
    -hw,-hh,-hd,  hw,-hh,-hd,  hw,hh,-hd,  -hw,hh,-hd, // back
    -hw,-hh,hd,   hw,-hh,hd,   hw,hh,hd,   -hw,hh,hd,  // front
    -hw,-hh,-hd,  -hw,hh,-hd,  -hw,hh,hd,   -hw,-hh,hd, // left
    hw,-hh,-hd,   hw,hh,-hd,   hw,hh,hd,    hw,-hh,hd,  // right
    -hw,hh,-hd,   hw,hh,-hd,   hw,hh,hd,    -hw,hh,hd,  // top
    -hw,-hh,-hd,  hw,-hh,-hd,  hw,-hh,hd,   -hw,-hh,hd, // bottom
  ]);
  const indices = new Uint16Array([
    0,1,2, 0,2,3, 4,6,5, 4,7,6, 8,9,10, 8,10,11,
    12,14,13, 12,15,14, 16,17,18, 16,18,19, 20,22,21, 20,23,22,
  ]);
  return { positions, indices };
}

function translate(mesh, x, y, z) {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] += x; p[i+1] += y; p[i+2] += z; }
  return { ...mesh, positions: p };
}

// 1. Prop: crate
{
  const glb = buildGlb([{ ...box(1, 1, 1), color: [0.55, 0.35, 0.17] }]);
  writeFileSync(join(root, "prop-crate.glb"), glb);
  console.log(`prop-crate.glb: ${glb.length} bytes`);
}

// 2. Character-ish: body + head
{
  const glb = buildGlb([
    { ...translate(box(0.6, 0.9, 0.35), 0, 1.0, 0), color: [0.29, 0.48, 0.6] },
    { ...translate(box(0.35, 0.35, 0.35), 0, 1.75, 0), color: [0.85, 0.63, 0.4] },
  ]);
  writeFileSync(join(root, "character-humanoid.glb"), glb);
  console.log(`character-humanoid.glb: ${glb.length} bytes`);
}

// 3. Vista: subdivided plane with sine displacement
{
  const N = 24;
  const positions = new Float32Array((N + 1) * (N + 1) * 3);
  let vi = 0;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = (ix / N - 0.5) * 20, z = (iz / N - 0.5) * 20;
      const y = Math.sin(x * 0.5) * Math.cos(z * 0.5) * 1.5;
      positions[vi++] = x; positions[vi++] = y; positions[vi++] = z;
    }
  }
  const indices = new Uint16Array(N * N * 6);
  let ii = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * (N + 1) + ix, b = a + 1, c = a + N + 1, d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  const glb = buildGlb([{ positions, indices, color: [0.23, 0.42, 0.23] }]);
  writeFileSync(join(root, "vista-terrain.glb"), glb);
  console.log(`vista-terrain.glb: ${glb.length} bytes`);
}

console.log("baselines written to", root);
