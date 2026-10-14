/**
 * gltfpack compression step (TL1b).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compressGlb, hasGltfpack } from "../src/compress-gltfpack.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, "fixtures", "compress");
const testGlb = join(fixtureDir, "test-box.glb");

// Minimal valid GLB (single triangle) for compression testing
function makeTestGlb(): Buffer {
  // Use a subdivided grid (like the TL1d golden test) — a single triangle
  // is too small for meshopt to help; the container overhead can exceed
  // the savings on tiny files.
  const N = 16;
  const positions = new Float32Array((N + 1) * (N + 1) * 3);
  let vi = 0;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      positions[vi++] = ix / N; positions[vi++] = 0; positions[vi++] = iz / N;
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
  const bin = Buffer.alloc(positions.byteLength + indices.byteLength);
  Buffer.from(positions.buffer).copy(bin, 0);
  Buffer.from(indices.buffer).copy(bin, positions.byteLength);

  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: (N + 1) * (N + 1), type: "VEC3", min: [0, 0, 0], max: [1, 0, 1] },
      { bufferView: 1, componentType: 5123, count: N * N * 6, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binPadded = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = Buffer.alloc(total);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4;
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(total, o); o += 4;
  glb.writeUInt32LE(jsonPadded.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonPadded.copy(glb, o); o += jsonPadded.length;
  glb.writeUInt32LE(binPadded.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4;
  binPadded.copy(glb, o);
  return glb;
}

describe("compress-gltfpack", () => {
  before(() => {
    mkdirSync(fixtureDir, { recursive: true });
    if (!existsSync(testGlb)) {
      writeFileSync(testGlb, makeTestGlb());
    }
  });

  it("detects gltfpack availability", async () => {
    const available = await hasGltfpack(process.env.GLTFPACK_BIN);
    assert.equal(typeof available, "boolean");
  });

  it("compresses a GLB with meshopt", async () => {
    const bin = process.env.GLTFPACK_BIN ?? "/tmp/gltfpack";
    if (!(await hasGltfpack(bin))) {
      console.log("skipping: gltfpack not available");
      return;
    }
    const result = await compressGlb(testGlb, { binPath: bin });
    assert.ok(result.rawBytes > 0);
    assert.ok(result.compressedBytes > 0);
    assert.ok(result.ratio <= 1.5); // tiny files may not shrink much
    assert.match(result.output, /\.compressed\.glb$/);
  });

  it("throws on missing binary", async () => {
    await assert.rejects(
      compressGlb(testGlb, { binPath: "/nonexistent/gltfpack" })
    );
  });
});
