/**
 * The Terrain panel draws exactly the surface the server grounds players
 * on: same vertex <-> sample mapping as the client mesh, and the same
 * triangles as engine-core's terrainHeightAt. If these drift, what a
 * designer sculpts is not what players stand on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { terrainHeightAt } from "@mmo-engine/engine-core";
import {
  buildChunkGeometry,
  heightColor,
  writeChunkGeometry,
} from "../src/terrain/terrain-view.js";

const SIZE = 16;

function bumpyHeights(): Float32Array {
  const h = new Float32Array(256);
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) h[j * 16 + i] = Math.fround(Math.sin(i * 0.9) * 2 + Math.cos(j * 1.3) + ((i * j) % 3));
  }
  return h;
}

/** A chunk mesh placed like the panel places it (chunk 0,0). */
function chunkMesh(heights: Float32Array): THREE.Mesh {
  const geometry = buildChunkGeometry(SIZE);
  writeChunkGeometry(geometry, heights, { min: -3, max: 5 });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(SIZE / 2, 0, SIZE / 2);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("terrain view geometry", () => {
  it("maps vertex v to sample (v % 16, v / 16) at local i*16/15", () => {
    const h = bumpyHeights();
    const mesh = chunkMesh(h);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const world = new THREE.Vector3();
    for (const v of [0, 15, 16 * 7 + 3, 255]) {
      world.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld);
      const i = v % 16;
      const j = Math.floor(v / 16);
      assert.ok(Math.abs(world.x - (i * SIZE) / 15) < 1e-5, `x of vertex ${v}`);
      assert.ok(Math.abs(world.z - (j * SIZE) / 15) < 1e-5, `z of vertex ${v}`);
      assert.equal(world.y, h[v]);
    }
  });

  it("the drawn surface equals the server's grounding surface everywhere", () => {
    const h = bumpyHeights();
    const mesh = chunkMesh(h);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    // Points inside cells on both triangles of the anti-diagonal split,
    // right on the diagonal, and near chunk edges.
    const points: Array<[number, number]> = [
      [0.3, 0.2], [0.9, 0.9], [5.1, 7.7], [5.9, 7.2], [8.53, 8.53], [15.7, 0.4], [0.2, 15.8], [11.11, 3.33],
    ];
    for (const [x, z] of points) {
      ray.set(new THREE.Vector3(x, 100, z), down);
      const hits = ray.intersectObject(mesh, false);
      assert.ok(hits.length > 0, `ray hit at ${x},${z}`);
      const drawn = hits[0].point.y;
      const grounded = terrainHeightAt(h, x, z, SIZE);
      assert.ok(Math.abs(drawn - grounded) < 1e-4, `(${x},${z}): drawn ${drawn} vs grounded ${grounded}`);
    }
  });

  it("colors run low -> high and clamp outside the range", () => {
    const c = new THREE.Color();
    const low = heightColor(-10, 0, 10, c).clone();
    const high = heightColor(99, 0, 10, c).clone();
    assert.ok(high.r > low.r && high.g > low.g, "high ground is lighter");
    assert.deepEqual(heightColor(0, 0, 10, c).toArray(), low.toArray(), "below range clamps to low");
  });
});
