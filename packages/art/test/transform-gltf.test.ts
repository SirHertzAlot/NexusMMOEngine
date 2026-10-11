/**
 * gltf-transform step (TL1c): prune+dedup and texture config.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  transformGlb,
  hasGltfTransform,
  DEFAULT_TEXTURE_CONFIG,
} from "../src/transform-gltf.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, "fixtures", "transform");
const testGlb = join(fixtureDir, "test-box.glb");

// Reuse the minimal GLB builder from compress tests
function makeTestGlb(): Buffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
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
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
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

describe("transform-gltf", () => {
  before(() => {
    mkdirSync(fixtureDir, { recursive: true });
    if (!existsSync(testGlb)) {
      writeFileSync(testGlb, makeTestGlb());
    }
  });

  it("has sane default texture config", () => {
    const slots = new Map(DEFAULT_TEXTURE_CONFIG.map((c) => [c.slot, c.format]));
    assert.equal(slots.get("baseColor"), "webp");
    assert.equal(slots.get("normal"), "ktx2-uastc");
    assert.equal(slots.get("occlusion"), "ktx2-uastc");
    assert.equal(slots.get("metallicRoughness"), "ktx2-uastc");
  });

  it("detects gltf-transform availability", async () => {
    const available = await hasGltfTransform(process.env.GLTF_TRANSFORM_BIN);
    assert.equal(typeof available, "boolean");
  });

  it("runs prune+dedup", async () => {
    const bin = process.env.GLTF_TRANSFORM_BIN ?? "gltf-transform";
    if (!(await hasGltfTransform(bin))) {
      console.log("skipping: gltf-transform not available");
      return;
    }
    const result = await transformGlb(testGlb, { binPath: bin, skipTextures: true });
    assert.ok(result.rawBytes > 0);
    assert.ok(result.transformedBytes > 0);
    assert.ok(result.cleanupRemoved >= 0);
    assert.match(result.output, /\.transformed\.glb$/);
  });

  it("throws on missing binary", async () => {
    await assert.rejects(
      transformGlb(testGlb, { binPath: "/nonexistent/gltf-transform" })
    );
  });
});
