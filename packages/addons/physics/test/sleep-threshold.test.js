// @mmo-engine/addon-physics tests: the point-velocity sleep threshold.
//
// Jolt's default is 0.03 m/s. A larger threshold lets resting bodies sleep sooner;
// the question these tests answer is whether a sleeping rig still wakes when
// something lands on it. The sweep that measures the cost is in
// bench/addon-sleep-threshold.mjs.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType, RagdollRig } = require('../index.js');

const DEFAULT_THRESHOLD = 0.03;

function ids(n, first = 100n) {
  const out = new BigUint64Array(n);
  for (let i = 0; i < n; i++) out[i] = first + BigInt(i);
  return out;
}

// Roots four metres apart, so neighbouring rigs never touch.
function spots(n, y = 1.2) {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[3 * i] = 4 * i;
    out[3 * i + 1] = y;
    out[3 * i + 2] = 0;
  }
  return out;
}

function addFloor(w) {
  w.addBodies({
    count: 1,
    entityIds: new BigUint64Array([1n]),
    shapeKind: new Uint8Array([ShapeKind.Box]),
    halfExtents: new Float32Array([200, 0.5, 200]),
    radius: new Float32Array([0]),
    mass: new Float32Array([0]),
    friction: new Float32Array([0.8]),
    restitution: new Float32Array([0]),
    motionType: new Uint8Array([MotionType.Static]),
    layer: new Uint8Array([0]),
    pos: new Float32Array([0, -0.5, 0]),
    quat: new Float32Array([0, 0, 0, 1]),
    linVel: new Float32Array(3),
    angVel: new Float32Array(3),
  });
}

function rootOf(w, id) {
  const out = new Float32Array(3);
  w.copyRagdollRoots(new BigUint64Array([id]), out);
  return out;
}

test('the sleep threshold defaults to 0.03 m/s and round-trips', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.ok(Math.abs(w.sleepThreshold() - DEFAULT_THRESHOLD) < 1e-6);
  w.setSleepThreshold(0.25);
  assert.ok(Math.abs(w.sleepThreshold() - 0.25) < 1e-6);
});

test('setSleepThreshold rejects negative, non-finite and non-numeric values and keeps the old one', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.throws(() => w.setSleepThreshold(-0.1), RangeError);
  assert.throws(() => w.setSleepThreshold(NaN), RangeError);
  assert.throws(() => w.setSleepThreshold(Infinity), RangeError);
  assert.throws(() => w.setSleepThreshold('0.3'), TypeError);
  assert.ok(Math.abs(w.sleepThreshold() - DEFAULT_THRESHOLD) < 1e-6);
});

test('a resting rig falls asleep under a 0.3 m/s threshold', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  w.setSleepThreshold(0.3);
  w.addRagdolls(ids(4), RagdollRig.Light, spots(4));
  assert.strictEqual(w.ragdollActiveBodies(), 4 * 5, 'every body starts awake');
  for (let i = 0; i < 8 * 30; i++) w.step(1 / 30, 2);
  assert.strictEqual(w.ragdollActiveBodies(), 0, 'settled rigs should sleep');
});

test('a sleeping rig wakes and moves when a sphere lands on it', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  w.setSleepThreshold(0.3);
  const rig = ids(1);
  w.addRagdolls(rig, RagdollRig.Light, spots(1));
  for (let i = 0; i < 8 * 30; i++) w.step(1 / 30, 2);
  assert.strictEqual(w.ragdollActiveBodies(), 0, 'the rig should be asleep before the drop');
  const before = rootOf(w, rig[0]);

  // A 5 kg sphere, 0.3 m across, 2 m above the rig's root.
  w.addBodies({
    count: 1,
    entityIds: new BigUint64Array([50n]),
    shapeKind: new Uint8Array([ShapeKind.Sphere]),
    halfExtents: new Float32Array([0, 0, 0]),
    radius: new Float32Array([0.3]),
    mass: new Float32Array([5]),
    friction: new Float32Array([0.5]),
    restitution: new Float32Array([0]),
    motionType: new Uint8Array([MotionType.Dynamic]),
    layer: new Uint8Array([1]),
    pos: new Float32Array([before[0], before[1] + 2, before[2]]),
    quat: new Float32Array([0, 0, 0, 1]),
    linVel: new Float32Array(3),
    angVel: new Float32Array(3),
  });
  let maxActive = 0;
  for (let i = 0; i < 2 * 30; i++) {
    w.step(1 / 30, 2);
    maxActive = Math.max(maxActive, w.ragdollActiveBodies());
  }
  const after = rootOf(w, rig[0]);
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  assert.ok(maxActive > 0, 'the impact should wake the rig');
  assert.ok(moved > 0.01, `a sleeping rig does not move on its own; it moved ${moved} m`);
});

test('ragdollActiveBodies is zero with no rigs, and the threshold change keeps the rigs present', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.strictEqual(w.ragdollActiveBodies(), 0);
  addFloor(w);
  w.addRagdolls(ids(2), RagdollRig.Light, spots(2));
  w.setSleepThreshold(0.5);
  assert.strictEqual(w.ragdollCount(), 2);
  assert.strictEqual(w.ragdollUnits(), 2 * 2);
});
