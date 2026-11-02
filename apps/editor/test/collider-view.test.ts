import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugCollider } from "@mmo-engine/protocol";
import { colliderCounts, colliderKey, colliderLines } from "../src/inspectors/collider-view.js";

const base: DebugCollider = { id: "1", shape: 0, motion: 0, x: 0, y: 0, z: 0, hx: 1, hy: 1, hz: 1, r: 0, yaw: 0, asset: 0 };
const body = (o: Partial<DebugCollider>): DebugCollider => ({ ...base, ...o });

/** min/max of one axis (0 x, 1 y, 2 z) over a segment buffer. */
function extent(a: Float32Array, axis: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < a.length; i += 3) {
    lo = Math.min(lo, a[i]);
    hi = Math.max(hi, a[i]);
  }
  return [lo, hi];
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-5;

test("a box is 12 edges, centred, spanning its half extents", () => {
  const { box } = colliderLines([body({ x: 10, y: 2, z: -5, hx: 2, hy: 3, hz: 1 })]);
  assert.equal(box.length, 12 * 2 * 3);
  assert.deepEqual([extent(box, 0), extent(box, 1), extent(box, 2)], [[8, 12], [-1, 5], [-6, -4]]);
});

test("a box turns by its yaw about +Y", () => {
  const { box } = colliderLines([body({ hx: 2, hz: 1, yaw: Math.PI / 2 })]);
  const [x0, x1] = extent(box, 0);
  const [z0, z1] = extent(box, 2);
  assert.ok(near(x0, -1) && near(x1, 1) && near(z0, -2) && near(z1, 2));
});

test("spheres lie on their radius; capsules stand on their feet", () => {
  const { sphere, capsule } = colliderLines([
    body({ shape: 1, x: 1, y: 2, z: 3, r: 1.5 }),
    body({ shape: 2, motion: 1, x: 5, y: 0, z: 5, hy: 0.55, r: 0.35 }),
  ]);
  for (let i = 0; i < sphere.length; i += 3) {
    assert.ok(near(Math.hypot(sphere[i] - 1, sphere[i + 1] - 2, sphere[i + 2] - 3), 1.5));
  }
  const [y0, y1] = extent(capsule, 1);
  assert.ok(near(y0, 0) && near(y1, 1.8));
});

test("counts per kind, and a key that changes with the set only", () => {
  const list = [body({ id: "1" }), body({ id: "2", shape: 1, r: 1 }), body({ id: "3", shape: 2, motion: 1, hy: 1, r: 1 })];
  assert.deepEqual(colliderCounts(list), { box: 1, sphere: 1, capsule: 1 });
  assert.equal(colliderKey(list), colliderKey(list.map((c) => ({ ...c }))));
  assert.notEqual(colliderKey(list), colliderKey([list[0], list[1], { ...list[2], x: 4 }]));
  assert.notEqual(colliderKey(list), colliderKey(list.slice(0, 2)));
});
