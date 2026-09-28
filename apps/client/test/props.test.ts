/**
 * Instanced props: a few draw calls for thousands of scatter entities,
 * dense slots after removals, growth past the initial capacity, and hover
 * mapping back to wire ids.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { EntityMirror } from "@mmo-engine/mirror";
import { isProp, PropRenderer } from "../src/render/props.js";

function prop(wireId: bigint, x: number, body?: "box" | "sphere"): EntityMirror {
  return {
    wireId,
    transform: { wireId, px: x, py: 1, pz: 2, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
    asset: { wireId, assetHash: body === "sphere" ? 7 : 3, variant: 0 },
    ...(body
      ? {
          body: {
            wireId, shapeKind: body === "sphere" ? 1 : 0, halfX: 0.5, halfY: 1, halfZ: 0.5, radius: 0.4,
            mass: 0, motionType: 0, layer: 0, friction: 0.8, restitution: 0,
          },
        }
      : {}),
  };
}

const xOf = (r: PropRenderer, wireId: bigint): number => {
  for (const mesh of r.pickTargets() as THREE.InstancedMesh[]) {
    for (let i = 0; i < mesh.count; i++) {
      const hit = { object: mesh, instanceId: i } as unknown as THREE.Intersection;
      if (r.wireIdOf(hit) === wireId) {
        const m = new THREE.Matrix4();
        mesh.getMatrixAt(i, m);
        return new THREE.Vector3().setFromMatrixPosition(m).x;
      }
    }
  }
  return NaN;
};

describe("PropRenderer", () => {
  it("draws props by shape in a few instanced meshes", () => {
    const r = new PropRenderer();
    for (let i = 0; i < 600; i++) r.sync(BigInt(i + 1), prop(BigInt(i + 1), i, i % 3 === 0 ? "sphere" : i % 3 === 1 ? "box" : undefined));
    assert.equal(r.count, 600);
    assert.equal(r.batchCount, 3, "box, sphere, cone");
    const total = (r.pickTargets() as THREE.InstancedMesh[]).reduce((n, m) => n + m.count, 0);
    assert.equal(total, 600, "grown past the initial capacity");
    assert.equal(xOf(r, 300n), 299);
    r.dispose();
  });

  it("keeps slots dense on removal and maps hits to the moved prop", () => {
    const r = new PropRenderer();
    for (const id of [1n, 2n, 3n, 4n]) r.sync(id, prop(id, Number(id) * 10));
    r.remove(2n);
    r.remove(2n); // idempotent
    const [mesh] = r.pickTargets() as THREE.InstancedMesh[];
    assert.equal(mesh.count, 3);
    for (const id of [1n, 3n, 4n]) assert.equal(xOf(r, id), Number(id) * 10, `prop ${id} kept its place`);
    assert.deepEqual([...r.wireIds()].sort(), [1n, 3n, 4n]);
    r.dispose();
  });

  it("moves a prop when its transform row changes, and highlights on hover", () => {
    const r = new PropRenderer();
    const e = prop(9n, 5);
    r.sync(9n, e);
    r.sync(9n, { ...e, transform: { ...e.transform!, px: 42 } });
    assert.equal(xOf(r, 9n), 42);
    r.setHover(9n);
    const [mesh] = r.pickTargets() as THREE.InstancedMesh[];
    const c = new THREE.Color();
    mesh.getColorAt(0, c);
    assert.ok(c.r > 0.9 && c.g > 0.9, "hover colour");
    r.setHover(null);
    mesh.getColorAt(0, c);
    assert.ok(!(c.r > 0.9 && c.g > 0.9), "restored");
    r.dispose();
  });

  it("only takes scatter entities, never players", () => {
    const p = prop(1n, 0);
    assert.equal(isProp(p), true);
    assert.equal(isProp({ ...p, intent: { wireId: 1n, mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 } }), false);
    assert.equal(isProp({ wireId: 2n, transform: p.transform }), false);
  });
});
