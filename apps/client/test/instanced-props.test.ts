/**
 * InstancedProps: one draw call per shape, instances sized from their
 * BodyConfig and Transform, dense after removals, growing past capacity,
 * and picked / hover-tinted by wire id.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";
import { InstancedProps, propMatrix } from "../src/render/instanced-props.js";

const BOX = 0;
const SPHERE = 1;

function transform(wireId: bigint, x: number, z: number, scale = 1): TransformRow {
  return { wireId, px: x, py: 0, pz: z, qx: 0, qy: 0, qz: 0, qw: 1, sx: scale, sy: scale, sz: scale };
}

function body(wireId: bigint, shapeKind: number, half = 0.5): BodyConfigRow {
  return {
    wireId, shapeKind, halfX: half, halfY: 2 * half, halfZ: half, radius: half,
    mass: 0, friction: 0.5, restitution: 0, motionType: 0, layer: 0,
  };
}

const red = new THREE.Color(1, 0, 0);

/** Where the prop `wireId` is drawn: the instance a ray straight down onto it picks back. */
function positionOf(props: InstancedProps, wireId: bigint): THREE.Vector3 {
  const group = props.group.children as THREE.InstancedMesh[];
  for (const mesh of group) {
    for (let i = 0; i < mesh.count; i++) {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(i, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const ray = new THREE.Raycaster(new THREE.Vector3(p.x, 50, p.z), new THREE.Vector3(0, -1, 0));
      if (props.pick(ray)?.wireId === wireId) return p;
    }
  }
  throw new Error(`no instance for ${wireId}`);
}

describe("InstancedProps", () => {
  it("batches props by shape: one draw call each", () => {
    const props = new InstancedProps();
    for (let i = 0; i < 5; i++) props.add(BigInt(i), transform(BigInt(i), i * 10, 0), body(BigInt(i), BOX), red);
    props.add(9n, transform(9n, 0, 20), body(9n, SPHERE), red);
    assert.equal(props.count, 6);
    assert.equal(props.drawCalls, 2);
    props.dispose();
  });

  it("sizes a stand-in from its body alone: the body is world-final, the Transform scale is not applied again", () => {
    const m = propMatrix(transform(1n, 3, 4, 2), body(1n, BOX, 0.5));
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    assert.deepEqual([s.x, s.y, s.z].map((v) => +v.toFixed(5)), [1, 2, 1], "the body's size, whatever the Transform scale");
    const bare = propMatrix(transform(3n, 0, 0, 2), null);
    bare.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    assert.deepEqual([s.x, s.y, s.z].map((v) => +v.toFixed(5)), [2, 2, 2], "no body: a 1 m unit box at the Transform scale");
    const sphere = propMatrix(transform(2n, 0, 0), body(2n, SPHERE, 0.75));
    sphere.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    assert.equal(+s.x.toFixed(5), 0.75, "unit sphere scaled to the radius");
  });

  it("stays dense when props go: the last one moves into the hole", () => {
    const props = new InstancedProps();
    for (let i = 0; i < 4; i++) props.add(BigInt(i), transform(BigInt(i), i * 10, 0), body(BigInt(i), BOX), red);
    props.remove(1n);
    assert.equal(props.count, 3);
    assert.equal(props.has(1n), false);
    const mesh = props.group.children[0] as THREE.InstancedMesh;
    assert.equal(mesh.count, 3);
    // Every remaining prop is still where it was, and picks back to itself.
    for (const [wid, x] of [[0n, 0], [2n, 20], [3n, 30]] as const) {
      assert.equal(positionOf(props, wid).x, x, `prop ${wid}`);
    }
    props.dispose();
  });

  it("grows past its first capacity without losing instances", () => {
    const props = new InstancedProps();
    const n = 600;
    for (let i = 0; i < n; i++) props.add(BigInt(i), transform(BigInt(i), (i % 30) * 5, Math.floor(i / 30) * 5), body(BigInt(i), BOX, 0.4), red);
    assert.equal(props.count, n);
    assert.equal(props.drawCalls, 1);
    const mesh = props.group.children[0] as THREE.InstancedMesh;
    assert.equal(mesh.count, n);
    assert.ok(mesh.instanceMatrix.count >= n);
    assert.equal(positionOf(props, 457n).x, (457 % 30) * 5);
    props.dispose();
  });

  it("picks the prop under a ray and tints it while hovered", () => {
    const props = new InstancedProps();
    props.add(7n, transform(7n, 10, 10), body(7n, BOX), red);
    props.add(8n, transform(8n, -10, 10), body(8n, BOX), new THREE.Color(0, 0, 1));
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 50, 10), new THREE.Vector3(0, -1, 0));
    assert.equal(props.pick(ray)?.wireId, 7n);
    const mesh = props.group.children[0] as THREE.InstancedMesh;
    const c = new THREE.Color();
    props.setHovered(7n);
    mesh.getColorAt(0, c);
    assert.ok(c.g > 0.3, "tinted toward the hover colour");
    props.setHovered(null);
    mesh.getColorAt(0, c);
    assert.deepEqual([c.r, c.g, c.b], [1, 0, 0], "back to its own colour");
    props.dispose();
  });

  it("follows a changed Transform row and ignores an unchanged one", () => {
    const props = new InstancedProps();
    const b = body(5n, BOX);
    const t = transform(5n, 0, 0);
    props.add(5n, t, b, red);
    props.update(5n, t, b); // same rows: nothing to do
    props.update(5n, transform(5n, 40, 0), b);
    assert.equal(positionOf(props, 5n).x, 40);
    props.dispose();
  });
});
