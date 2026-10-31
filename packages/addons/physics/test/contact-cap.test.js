// @mmo-engine/addon-physics tests: the contact cap.
//
// Jolt keeps at most 10,240 contact constraints per world (the addon's limit).
// Past that Jolt drops contacts for the step and reports it. These tests check
// that an awake crowd at the default budget stays clear of the cap, and that a
// crowd which fills it is reported through lastStepErrors(). The fill points
// for full and light rigs are measured in bench/addon-contact-cap.mjs.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType, RagdollRig, UpdateError } = require('../index.js');

const FULL_BODIES = 11;
const LIGHT_BODIES = 5;

function ids(n, first = 1000n) {
  const out = new BigUint64Array(n);
  for (let i = 0; i < n; i++) out[i] = first + BigInt(i);
  return out;
}

// Rigs on a grid 0.9 m apart, as the cost bench lays them out: awake crowds
// collide with their neighbours, which is where the contacts come from.
function crowd(n) {
  const out = new Float32Array(3 * n);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  for (let i = 0; i < n; i++) {
    out[3 * i] = (i % cols - (cols - 1) / 2) * 0.9;
    out[3 * i + 1] = 1.2 + 0.3 * (i % 3);
    out[3 * i + 2] = (Math.floor(i / cols) - (cols - 1) / 2) * 0.9;
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

// Runs an awake crowd for `steps` ticks; returns the OR of every step's errors
// and the number of bodies still simulating at the end.
function awakeCrowd(kind, n, steps) {
  const w = createWorld();
  try {
    w.setSleepThreshold(0); // nothing sleeps, so every rig keeps colliding
    addFloor(w);
    w.addRagdolls(ids(n), kind, crowd(n));
    let errors = 0;
    for (let i = 0; i < steps; i++) {
      w.step(1 / 30, 2);
      errors |= w.lastStepErrors();
    }
    return { errors, active: w.ragdollActiveBodies() };
  } finally {
    w.destroy();
  }
}

test("the update error bits are Jolt's", () => {
  assert.deepStrictEqual(UpdateError, {
    ManifoldCacheFull: 1,
    BodyPairCacheFull: 2,
    ContactConstraintsFull: 4,
  });
});

test('an empty world reports no errors', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  assert.strictEqual(w.lastStepErrors(), 0);
  for (let i = 0; i < 10; i++) w.step(1 / 30, 2);
  assert.strictEqual(w.lastStepErrors(), 0);
});

test('48 full rigs awake at the default budget keep every step clear of the cap', () => {
  const { errors, active } = awakeCrowd(RagdollRig.Full, 48, 150);
  assert.strictEqual(active, 48 * FULL_BODIES, 'every body of the crowd is awake');
  assert.strictEqual(errors, 0, `the cap was reported: ${errors}`);
});

test('120 light rigs awake at the default budget keep every step clear of the cap', () => {
  const { errors, active } = awakeCrowd(RagdollRig.Light, 120, 150);
  assert.strictEqual(active, 120 * LIGHT_BODIES, 'every body of the crowd is awake');
  assert.strictEqual(errors, 0, `the cap was reported: ${errors}`);
});

test('a sheet of touching spheres fills the contact cap, and the world reports it', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.setSleepThreshold(0);
  addFloor(w);
  // 80 x 80 spheres of radius 0.1 on the floor, touching their neighbours: a
  // floor contact and up to four neighbour contacts each, more than 10,240.
  const side = 80;
  const r = 0.1;
  const n = side * side;
  const pos = new Float32Array(3 * n);
  const quat = new Float32Array(4 * n);
  const eids = new BigUint64Array(n);
  for (let i = 0; i < n; i++) {
    pos[3 * i] = (i % side - (side - 1) / 2) * 2 * r;
    pos[3 * i + 1] = r + 0.001;
    pos[3 * i + 2] = (Math.floor(i / side) - (side - 1) / 2) * 2 * r;
    quat[4 * i + 3] = 1;
    eids[i] = 10000n + BigInt(i);
  }
  w.addBodies({
    count: n,
    entityIds: eids,
    shapeKind: new Uint8Array(n).fill(ShapeKind.Sphere),
    halfExtents: new Float32Array(3 * n),
    radius: new Float32Array(n).fill(r),
    mass: new Float32Array(n).fill(1),
    friction: new Float32Array(n).fill(0.5),
    restitution: new Float32Array(n),
    motionType: new Uint8Array(n).fill(MotionType.Dynamic),
    layer: new Uint8Array(n).fill(1),
    pos,
    quat,
    linVel: new Float32Array(3 * n),
    angVel: new Float32Array(3 * n),
  });
  for (let i = 0; i < 20; i++) {
    w.step(1 / 30, 2);
    const errors = w.lastStepErrors();
    assert.ok((errors & UpdateError.ContactConstraintsFull) !== 0,
      `step ${i}: the cap was not reported (errors ${errors})`);
    assert.strictEqual(errors & ~7, 0, 'only the three known bits can be set');
  }
  // Jolt drops the extra contacts for the step; the spheres stay finite.
  const slot = new Int32Array(n);
  for (let i = 0; i < n; i++) slot[i] = i;
  const out = Array.from({ length: 13 }, () => new Float32Array(n));
  w.copyResults(n, eids, slot, ...out);
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(out[0][i]) && Number.isFinite(out[1][i]) && Number.isFinite(out[2][i]),
      `sphere ${i} is not finite`);
  }
});
