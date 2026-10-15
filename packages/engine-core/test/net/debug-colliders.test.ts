/**
 * DebugSource.colliders — the editor's Colliders overlay reads the live
 * sim's BodyConfig bodies near a point: static boxes/spheres (structures,
 * scatter props) and kinematic capsules (characters), read-only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { AssetRef, BodyConfig, MotionType, ShapeKind, SimWorld, Transform } from "../../src/index.js";
import { makeDebugSource, MAX_DEBUG_COLLIDERS } from "../../src/net/debug-source.js";

function spawn(
  sim: SimWorld,
  kind: number,
  motion: number,
  x: number,
  y: number,
  z: number,
  half: [number, number, number],
  radius = 0,
  yaw = 0,
  asset = 0,
): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = y;
  Transform.pz[eid] = z;
  Transform.qy[eid] = Math.sin(yaw / 2);
  Transform.qw[eid] = Math.cos(yaw / 2);
  BodyConfig.shapeKind[eid] = kind;
  BodyConfig.motionType[eid] = motion;
  BodyConfig.halfX[eid] = half[0];
  BodyConfig.halfY[eid] = half[1];
  BodyConfig.halfZ[eid] = half[2];
  BodyConfig.radius[eid] = radius;
  if (asset) {
    addComponent(sim.ecs, AssetRef, eid);
    AssetRef.assetHash[eid] = asset;
  }
  return eid;
}

const src = (world: SimWorld) => makeDebugSource({ world, navigation: null, loadedTileBounds: () => [] });

test("colliders lists static boxes (yaw, asset) and spheres near the query, not far ones", () => {
  const world = new SimWorld();
  const house = spawn(world, ShapeKind.Box, MotionType.Static, 512, 0, 632, [5, 7, 9], 0, 0.5, 0xabcd);
  const rock = spawn(world, ShapeKind.Sphere, MotionType.Static, 510, 1, 620, [0, 0, 0], 1.5);
  spawn(world, ShapeKind.Box, MotionType.Static, 900, 0, 900, [1, 1, 1]);
  const res = src(world).colliders(512, 632, 50);
  assert.equal(res.query, "colliders");
  assert.equal(res.total, 2);
  const h = res.colliders.find((c) => c.id === String(world.wireId(house)))!;
  assert.deepEqual([h.shape, h.motion, h.hx, h.hy, h.hz, h.asset], [0, 0, 5, 7, 9, 0xabcd]);
  assert.ok(Math.abs(h.yaw - 0.5) < 1e-5);
  const r = res.colliders.find((c) => c.id === String(world.wireId(rock)))!;
  assert.deepEqual([r.shape, r.r, r.y], [1, 1.5, 1]);
});

test("colliders includes kinematic capsules but skips dynamic bodies and bodyless entities", () => {
  const world = new SimWorld();
  const p = spawn(world, ShapeKind.Capsule, MotionType.Kinematic, 1, 0, 1, [0, 0.55, 0], 0.35);
  spawn(world, ShapeKind.Box, MotionType.Dynamic, 2, 0, 2, [1, 1, 1]);
  const bare = world.spawn();
  addComponent(world.ecs, Transform, bare);
  const res = src(world).colliders(0, 0, 10);
  assert.equal(res.total, 1);
  assert.deepEqual([res.colliders[0].shape, res.colliders[0].hy, res.colliders[0].r], [2, Math.fround(0.55), Math.fround(0.35)]);
  assert.equal(res.colliders[0].id, String(world.wireId(p)));
});

test("colliders caps the list but still counts every match", () => {
  const world = new SimWorld();
  for (let i = 0; i < MAX_DEBUG_COLLIDERS + 5; i++) spawn(world, ShapeKind.Box, MotionType.Static, i % 50, 0, 0, [1, 1, 1]);
  const res = src(world).colliders(25, 0, 100);
  assert.equal(res.colliders.length, MAX_DEBUG_COLLIDERS);
  assert.equal(res.total, MAX_DEBUG_COLLIDERS + 5);
});

test("colliders is read-only and rejects a non-finite query", () => {
  const world = new SimWorld();
  const e = spawn(world, ShapeKind.Box, MotionType.Static, 1, 2, 3, [1, 1, 1]);
  src(world).colliders(0, 0, 10);
  assert.equal(Transform.px[e], 1);
  assert.equal(src(world).colliders(NaN, 0, 10).total, 0);
});
