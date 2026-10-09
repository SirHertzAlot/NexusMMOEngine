import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { terrainHandler } from "../src/workers/handlers/terrain.js";

describe("terrain handler", () => {
  it("returns the bare geometry buffers for a 16x16 chunk", async () => {
    const heights = new Float32Array(256).fill(2);
    heights[0] = 5;
    const r = await terrainHandler.handle({ heights, chunkWorldSize: 16 });
    assert.equal(r.position.length, 320 * 3);
    assert.equal(r.normal.length, 320 * 3);
    assert.equal(r.index.length, 2070);
    assert.equal(r.bbox.length, 6);
    assert.equal(r.bbox[4], 5); // maxY
  });

  it("rejects a wrong-sized height array", async () => {
    await assert.rejects(
      terrainHandler.handle({ heights: new Float32Array(4), chunkWorldSize: 16 }),
      /want 256 heights, got 4/,
    );
  });
});

import { encodePcgMesh } from "@mmo-engine/picg";
import { pcgHandler } from "../src/workers/handlers/pcg.js";
import { bvhHandler } from "../src/workers/handlers/bvh.js";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

describe("pcg handler", () => {
  it("decodes geometry, rgb colours and bbox", async () => {
    const colors = new Float32Array(16).map((_, i) => (i % 4 === 3 ? 1 : 0.5 + (i % 4) / 10));
    const bytes = encodePcgMesh({ ...quad, colors });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = await pcgHandler.handle({ bytes: buf });
    assert.deepEqual([...r.index], [0, 1, 2, 0, 2, 3]);
    assert.deepEqual([...r.bbox], [0, 0, 0, 1, 1, 0]);
    assert.equal(r.color!.length, 12);
    assert.ok(Math.abs(r.color![3] - 0.5) < 1e-6 && Math.abs(r.color![4] - 0.6) < 1e-6);
  });

  it("rejects bytes that are not a PCGM mesh", async () => {
    await assert.rejects(pcgHandler.handle({ bytes: new ArrayBuffer(32) }), /bad magic/);
  });
});

describe("bvh handler", () => {
  it("builds a BVH that deserializes and raycasts", async () => {
    const positions = new Float32Array(quad.positions);
    const indices = new Uint16Array(quad.indices);
    const r = await bvhHandler.handle({ positions, indices });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    const bvh = MeshBVH.deserialize(r as any, g);
    const hit = bvh.raycastFirst(new THREE.Ray(new THREE.Vector3(0.5, 0.5, 5), new THREE.Vector3(0, 0, -1)), THREE.DoubleSide);
    assert.ok(hit);
    assert.equal(hit.distance, 5);
  });
});
