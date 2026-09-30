/**
 * Levels of detail: the simplifier (meshoptimizer, WebAssembly) builds a
 * lighter chain that shares the model's vertices and keeps its material
 * groups; InstancedProps moves each prop to the level its distance calls
 * for (one draw call per level in use), with hysteresis at the boundaries,
 * and reports what the props cost.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { TransformRow } from "@mmo-engine/protocol";
import { InstancedProps, type PropModels } from "../src/render/instanced-props.js";
import { lodDistance, simplifyLods, type LodLevel } from "../src/render/lod.js";

function transform(wireId: bigint, x: number, z: number): TransformRow {
  return { wireId, px: x, py: 0, pz: z, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 };
}

/** A dense sphere in two material groups (top and bottom halves). */
function dense(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(2, 64, 48);
  const half = Math.floor(g.index!.count / 6) * 3;
  g.clearGroups();
  g.addGroup(0, half, 0);
  g.addGroup(half, g.index!.count - half, 1);
  return g;
}

describe("levels of detail", () => {
  it("simplify to lighter levels that share the vertices and keep the material groups", async () => {
    const g = dense();
    const full = g.index!.count / 3;
    const lods = await simplifyLods(g);
    assert.ok(lods.length >= 2, `a chain (${lods.length} levels)`);
    let prev = full;
    let prevDistance = 0;
    for (const l of lods) {
      const tris = l.geometry.index!.count / 3;
      assert.ok(tris < prev * 0.9, `lighter (${tris} of ${prev})`);
      assert.equal(l.geometry.getAttribute("position"), g.getAttribute("position"), "the model's vertex buffer, shared");
      assert.equal(l.geometry.groups.length, 2);
      assert.equal(l.geometry.groups[1].start, l.geometry.groups[0].count, "groups back to back");
      assert.ok(l.distance > prevDistance, "each further out than the last");
      assert.ok(l.error >= 0 && l.error <= 0.05 * 4 + 1e-6, `within 5% of the model's size (${l.error} m)`);
      prev = tris;
      prevDistance = l.distance;
    }
    assert.deepEqual(await simplifyLods(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3))), [], "no index, no chain");
  });

  it("switch levels with distance: one draw call per level in use, fewer triangles far away", async () => {
    const g = dense();
    const lods: LodLevel[] = [
      { geometry: (await simplifyLods(g, [0.25]))[0].geometry, distance: 40, error: 0.1 },
    ];
    const models: PropModels = { model: () => ({ key: "tree", geometry: g, lods }) };
    const props = new InstancedProps(models);
    const asset = { assetHash: 1, variant: 0 };
    props.add(1n, transform(1n, 10, 0), null, new THREE.Color(), asset);
    props.add(2n, transform(2n, 100, 0), null, new THREE.Color(), asset);
    props.updateLod(new THREE.Vector3(0, 0, 0));
    let s = props.stats();
    assert.deepEqual(s.perLevel, [1, 1], "the near prop at full detail, the far one simplified");
    assert.equal(s.drawCalls, 2);
    assert.ok(s.triangles < s.fullTriangles, `${s.triangles} of ${s.fullTriangles} triangles`);
    // Walk out: both far away, one draw call.
    props.updateLod(new THREE.Vector3(-200, 0, 0));
    s = props.stats();
    assert.deepEqual(s.perLevel, [0, 2]);
    assert.equal(s.drawCalls, 1);
    // Hysteresis: at 38 m (inside the 40 m boundary but within 10%) the far level holds…
    props.updateLod(new THREE.Vector3(10 - 38, 0, 0));
    assert.equal(props.stats().perLevel[0], 0, "no flicker just inside the boundary");
    // …and comes back to full detail well inside it.
    props.updateLod(new THREE.Vector3(10 - 20, 0, 0));
    assert.equal(props.stats().perLevel[0], 1);
    // Picking still finds props on any level; removal keeps levels dense.
    props.remove(1n);
    assert.equal(props.stats().props, 1);
    props.dispose();
  });

  it("uses a level from where its error is a few pixels, never nearer than a step per level", () => {
    assert.equal(lodDistance(0, 2), 36, "a perfect level still waits for its step");
    assert.ok(lodDistance(0.5, 1) > 100, "half a metre off shows until well out");
  });
});
