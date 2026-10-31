// @mmo-engine/addon-physics tests: the thread pool option (createWorld({ threads }))
// and the rig body readout (copyRagdollBodies). That a thread pool gives the same
// result as one thread is pinned in determinism.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType, RagdollRig } = require('../index.js');

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

test('createWorld takes no options, or threads from 0 to 64, and each world runs rigs', (t) => {
  for (const options of [undefined, {}, { threads: 0 }, { threads: 1 }, { threads: 4 }, { threads: 64 }]) {
    const w = createWorld(options);
    t.after(() => w.destroy());
    addFloor(w);
    w.addRagdolls(ids(2), RagdollRig.Light, spots(2));
    w.step(1 / 30, 2);
    assert.strictEqual(w.ragdollCount(), 2, `threads option ${JSON.stringify(options)}`);
    w.destroy();
  }
});

test('createWorld refuses a bad options value or thread count', () => {
  assert.throws(() => createWorld(5), TypeError);
  assert.throws(() => createWorld(null), TypeError);
  assert.throws(() => createWorld({ threads: '4' }), TypeError);
  assert.throws(() => createWorld({ threads: -1 }), RangeError);
  assert.throws(() => createWorld({ threads: 1.5 }), RangeError);
  assert.throws(() => createWorld({ threads: 65 }), RangeError);
  assert.throws(() => createWorld({ threads: NaN }), RangeError);
  assert.throws(() => createWorld({ threads: Infinity }), RangeError);
});

test('a thread pool world keeps a rig crowd on the floor', (t) => {
  const w = createWorld({ threads: 4 });
  t.after(() => w.destroy());
  addFloor(w);
  const n = 8;
  w.addRagdolls(ids(n), RagdollRig.Light, spots(n, 1.5));
  for (let i = 0; i < 6 * 30; i++) w.step(1 / 30, 2);
  const roots = new Float32Array(3 * n);
  w.copyRagdollRoots(ids(n), roots);
  for (let i = 0; i < n; i++) {
    const y = roots[3 * i + 1];
    assert.ok(Number.isFinite(y), `rig ${i} has a non-finite root`);
    assert.ok(y > -0.5, `rig ${i} fell through the floor: y = ${y}`);
  }
});

test('thread pool worlds start and stop cleanly, one after another', () => {
  for (let i = 0; i < 4; i++) {
    const w = createWorld({ threads: 4 });
    addFloor(w);
    w.addRagdolls(ids(2), RagdollRig.Full, spots(2));
    for (let s = 0; s < 10; s++) w.step(1 / 30, 2);
    w.destroy();
  }
});

test('copyRagdollBodies writes 13 floats per body, root first, and refuses bad input without writing', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  w.addRagdolls(new BigUint64Array([100n]), RagdollRig.Full, new Float32Array([0, 2, 0]));
  w.addRagdolls(new BigUint64Array([101n]), RagdollRig.Light, new Float32Array([4, 2, 0]));
  const both = new BigUint64Array([100n, 101n]);
  const bodies = new Float32Array(13 * (11 + 5));
  assert.strictEqual(w.copyRagdollBodies(both, bodies), 13 * 16);

  // Body 0 of each rig is its root, which copyRagdollRoots reports.
  const roots = new Float32Array(6);
  w.copyRagdollRoots(both, roots);
  assert.deepStrictEqual(Array.from(bodies.subarray(0, 3)), Array.from(roots.subarray(0, 3)));
  assert.deepStrictEqual(Array.from(bodies.subarray(13 * 11, 13 * 11 + 3)), Array.from(roots.subarray(3, 6)));

  // Each rotation (x y z w, at offsets 3 to 6 of a body's 13 floats) is a unit quaternion.
  for (let b = 0; b < 16; b++) {
    const o = 13 * b + 3;
    const len = Math.hypot(bodies[o], bodies[o + 1], bodies[o + 2], bodies[o + 3]);
    assert.ok(Math.abs(len - 1) < 1e-4, `body ${b} quaternion length ${len}`);
  }

  // Refusals write nothing: an unknown id, and a buffer short for every body.
  const sentinel = new Float32Array(13 * 16).fill(7);
  assert.throws(() => w.copyRagdollBodies(new BigUint64Array([999n]), sentinel), RangeError);
  assert.throws(() => w.copyRagdollBodies(both, new Float32Array(13 * 11)), RangeError);
  assert.ok(sentinel.every((x) => x === 7), 'a refused call wrote into the buffer');

  // No rigs asked for means nothing to write.
  assert.strictEqual(w.copyRagdollBodies(new BigUint64Array(0), new Float32Array(0)), 0);

  // Argument types are checked.
  assert.throws(() => w.copyRagdollBodies(both, new Float64Array(13 * 16)), TypeError);
  assert.throws(() => w.copyRagdollBodies([100n], bodies), TypeError);
});
