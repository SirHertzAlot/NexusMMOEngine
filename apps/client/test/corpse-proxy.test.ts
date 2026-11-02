/** The drawn corpse: one box per rig part, placed from the physics pose, and retired once. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CorpseProxy } from "../src/render/animal/corpse-proxy.js";
import { RAGDOLL_PARTS } from "../src/physics/physics-world.js";
import { RIG_PARTS } from "../src/physics/ragdoll-rig.js";

describe("CorpseProxy", () => {
  it("has a box per rig part, sized from its half extents", () => {
    const p = new CorpseProxy(1);
    const meshes = p.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    assert.equal(meshes.length, RAGDOLL_PARTS);
    meshes.forEach((m, i) => {
      const [hx, hy, hz] = RIG_PARTS[i]!.halfExtents;
      m.geometry.computeBoundingBox();
      const size = new THREE.Vector3();
      m.geometry.boundingBox!.getSize(size);
      assert.ok(Math.abs(size.x - hx * 2) < 1e-6 && Math.abs(size.y - hy * 2) < 1e-6 && Math.abs(size.z - hz * 2) < 1e-6);
    });
    p.dispose();
  });

  it("places each part from its pose: centre, then quaternion xyzw", () => {
    const p = new CorpseProxy(2);
    const pose = new Float32Array(RAGDOLL_PARTS * 7);
    for (let i = 0; i < RAGDOLL_PARTS; i++) pose.set([i, i + 0.5, -i, 0, 0.6, 0, 0.8], i * 7);
    p.place(pose);
    const m = p.group.children[3] as THREE.Mesh;
    assert.deepEqual(m.position.toArray(), [3, 3.5, -3]);
    assert.ok(Math.abs(m.quaternion.y - 0.6) < 1e-6 && Math.abs(m.quaternion.w - 0.8) < 1e-6);
    p.dispose();
  });

  it("retire empties the drawing once and is idempotent", () => {
    const scene = new THREE.Group();
    const p = new CorpseProxy(3);
    scene.add(p.group);
    p.retire();
    assert.equal(p.spent, true);
    assert.equal(scene.children.length, 0);
    p.retire(); // second call: no error, still spent
    assert.equal(p.spent, true);
  });
});
