// @mmo-engine/addon-physics tests (Phase 2).
//
// Covers the N-API boundary contract: lifetime (explicit destroy +
// finalizer backstop), input validation, bulk add/remove/sync/copy,
// the sphere-on-floor acceptance scene, kinematic following, and
// dynamic teleport. Cross-process determinism lives in
// determinism.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType, SyncFlags } = require('../index.js');

function desc(overrides = {}) {
  return {
    count: 1,
    entityIds: new BigUint64Array([7n]),
    shapeKind: new Uint8Array([ShapeKind.Sphere]),
    halfExtents: new Float32Array(3),
    radius: new Float32Array([0.5]),
    mass: new Float32Array([1]),
    friction: new Float32Array([0.5]),
    restitution: new Float32Array([0]),
    motionType: new Uint8Array([MotionType.Dynamic]),
    layer: new Uint8Array([1]),
    pos: new Float32Array([0, 5, 0]),
    quat: new Float32Array([0, 0, 0, 1]),
    linVel: new Float32Array(3),
    angVel: new Float32Array(3),
    ...overrides,
  };
}

function addFloorAndSphere(w, sphereY = 5) {
  w.addBodies({
    count: 2,
    entityIds: new BigUint64Array([1n, 2n]),
    shapeKind: new Uint8Array([ShapeKind.Box, ShapeKind.Sphere]),
    halfExtents: new Float32Array([50, 0.5, 50, 0, 0, 0]),
    radius: new Float32Array([0, 0.5]),
    mass: new Float32Array([0, 1]),
    friction: new Float32Array([0.8, 0.5]),
    restitution: new Float32Array([0, 0]),
    motionType: new Uint8Array([MotionType.Static, MotionType.Dynamic]),
    layer: new Uint8Array([0, 1]),
    pos: new Float32Array([0, -0.5, 0, 0, sphereY, 0]),
    quat: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    linVel: new Float32Array(6),
    angVel: new Float32Array(6),
  });
}

function readOne(w, id) {
  const ids = new BigUint64Array([id]);
  const pos = new Float32Array(3);
  const quat = new Float32Array(4);
  const lin = new Float32Array(3);
  const ang = new Float32Array(3);
  w.copyResults(1, ids, pos, quat, lin, ang);
  return { pos, quat, lin, ang };
}

test('lifetime: create, bodyCount, explicit destroy is idempotent', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.strictEqual(w.bodyCount(), 0);
  w.addBodies(desc());
  assert.strictEqual(w.bodyCount(), 1);
  w.destroy();
  w.destroy(); // idempotent — safe in cleanup paths
  assert.throws(() => w.bodyCount(), /destroyed/);
  assert.throws(() => w.step(1 / 60, 1), /destroyed/);
});

test('validation: wrong array types and short arrays throw', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.throws(() => w.addBodies(desc({ pos: [0, 5, 0] })), /Float32Array/);
  assert.throws(
    () => w.addBodies(desc({ count: 2, entityIds: new BigUint64Array([1n]) })),
    /shorter than required/,
  );
  assert.throws(() => w.step(0, 1), /dt > 0/);
  assert.throws(() => w.step(1 / 60, 0), /subSteps >= 1/);
  assert.throws(() => w.removeBodies(new Float64Array([1])), /BigUint64Array/);
});

test('bulk add is idempotent; remove is idempotent', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  const d = desc({ count: 3 });
  d.entityIds = new BigUint64Array([3n, 1n, 2n]); // unsorted input is fine
  d.shapeKind = new Uint8Array([ShapeKind.Sphere, ShapeKind.Sphere, ShapeKind.Sphere]);
  d.halfExtents = new Float32Array(9);
  d.radius = new Float32Array([0.5, 0.5, 0.5]);
  d.mass = new Float32Array([1, 1, 1]);
  d.friction = new Float32Array([0.5, 0.5, 0.5]);
  d.restitution = new Float32Array([0, 0, 0]);
  d.motionType = new Uint8Array([MotionType.Dynamic, MotionType.Dynamic, MotionType.Dynamic]);
  d.layer = new Uint8Array([1, 1, 1]);
  d.pos = new Float32Array([0, 5, 0, 2, 5, 0, -2, 5, 0]);
  d.quat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  d.linVel = new Float32Array(9);
  d.angVel = new Float32Array(9);
  w.addBodies(d);
  assert.strictEqual(w.bodyCount(), 3);
  w.addBodies(d); // same ids again: no duplicates
  assert.strictEqual(w.bodyCount(), 3);
  w.removeBodies(new BigUint64Array([2n, 99n])); // 99n unknown: no-op
  assert.strictEqual(w.bodyCount(), 2);
  w.removeBodies(new BigUint64Array([1n, 3n]));
  assert.strictEqual(w.bodyCount(), 0);
});

test('sphere dropped onto static floor settles at rest height', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloorAndSphere(w, 5);
  for (let i = 0; i < 180; i++) w.step(1 / 60, 2);
  const { pos, lin } = readOne(w, 2n);
  // Radius 0.5 resting on a floor whose top is y=0 => y ~= 0.5.
  // Jolt's contact solver leaves a small penetration slop; the
  // acceptance bound is |y - 0.5| < 0.05 with ~zero velocity.
  assert.ok(Math.abs(pos[1] - 0.5) < 0.05, `rest y=${pos[1]}`);
  assert.ok(Math.abs(lin[1]) < 0.05, `rest vy=${lin[1]}`);
  assert.ok(Math.abs(pos[0]) < 0.05 && Math.abs(pos[2]) < 0.05);
});

test('kinematic body follows syncBodies targets', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addBodies(
    desc({
      entityIds: new BigUint64Array([4n]),
      shapeKind: new Uint8Array([ShapeKind.Box]),
      halfExtents: new Float32Array([1, 1, 1]),
      motionType: new Uint8Array([MotionType.Kinematic]),
      layer: new Uint8Array([1]),
      pos: new Float32Array([0, 0, 0]),
    }),
  );
  const ids = new BigUint64Array([4n]);
  const pos = new Float32Array(3);
  const quat = new Float32Array([0, 0, 0, 1]);
  const zero = new Float32Array(3);
  const flags = new Uint8Array([SyncFlags.None]);
  for (let i = 1; i <= 60; i++) {
    pos[0] = i / 10; // drive +x at 6 u/s
    w.syncBodies(1, ids, pos, quat, zero, zero, flags, 1 / 60);
    w.step(1 / 60, 1);
  }
  const got = readOne(w, 4n);
  assert.ok(Math.abs(got.pos[0] - 6) < 0.01, `kinematic x=${got.pos[0]}`);
});

test('dynamic teleport via syncBodies flag repositions the body', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloorAndSphere(w, 5);
  for (let i = 0; i < 180; i++) w.step(1 / 60, 2);
  const ids = new BigUint64Array([2n]);
  w.syncBodies(
    1, ids,
    new Float32Array([10, 8, -3]),
    new Float32Array([0, 0, 0, 1]),
    new Float32Array(3), new Float32Array(3),
    new Uint8Array([SyncFlags.Teleport]),
    1 / 60,
  );
  const got = readOne(w, 2n);
  assert.ok(Math.abs(got.pos[0] - 10) < 1e-6, `teleport x=${got.pos[0]}`);
  assert.ok(Math.abs(got.pos[1] - 8) < 1e-6, `teleport y=${got.pos[1]}`);
  // ...and it keeps simulating afterwards (falls from the new height).
  for (let i = 0; i < 30; i++) w.step(1 / 60, 2);
  const after = readOne(w, 2n);
  assert.ok(after.pos[1] < 8, `still falling: y=${after.pos[1]}`);
});

test('syncBodies without teleport leaves a dynamic body alone', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloorAndSphere(w, 5);
  for (let i = 0; i < 180; i++) w.step(1 / 60, 2);
  const before = readOne(w, 2n).pos[1];
  const ids = new BigUint64Array([2n]);
  w.syncBodies(
    1, ids,
    new Float32Array([99, 99, 99]), // must be ignored: no teleport flag
    new Float32Array([0, 0, 0, 1]),
    new Float32Array(3), new Float32Array(3),
    new Uint8Array([SyncFlags.None]),
    1 / 60,
  );
  w.step(1 / 60, 1);
  const after = readOne(w, 2n).pos[1];
  assert.ok(Math.abs(after - before) < 0.01, `dynamic untouched: ${before} -> ${after}`);
});
