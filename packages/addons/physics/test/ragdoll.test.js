// @mmo-engine/addon-physics tests: server ragdolls.
//
// Covers the budget (units, and refusals that change nothing), the lifecycle
// (add, remove, idempotent removal, destroy), rigs settling on a floor beside
// bodies, and the N-API input checks. Cost numbers are in
// bench/addon-ragdoll-cost.mjs.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType, RagdollRig } = require('../index.js');

const FULL_UNITS = 5;
const LIGHT_UNITS = 2;
const DEFAULT_BUDGET = 240;

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

function rootsOf(w, idList) {
  const out = new Float32Array(3 * idList.length);
  w.copyRagdollRoots(idList, out);
  return out;
}

test('a full rig dropped on a floor comes to rest on it', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  const id = ids(1);
  w.addRagdolls(id, RagdollRig.Full, spots(1));
  const y0 = rootsOf(w, id)[1];
  for (let i = 0; i < 240; i++) w.step(1 / 30, 2);
  const [x, y, z] = rootsOf(w, id);
  assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
  assert.ok(y < y0 - 0.5, `fell from ${y0} to ${y}`);
  assert.ok(y > 0.05, `root centre ${y} is below the floor`);
  assert.ok(y < 0.6, `root centre ${y} did not come to rest on the floor`);
});

test('budget: 48 full rigs fit, and a 49th is refused with nothing changed', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(48), RagdollRig.Full, spots(48));
  assert.strictEqual(w.ragdollCount(), 48);
  assert.strictEqual(w.ragdollUnits(), 48 * FULL_UNITS);
  assert.strictEqual(w.ragdollBudget(), DEFAULT_BUDGET);
  assert.throws(
    () => w.addRagdolls(ids(1, 900n), RagdollRig.Full, spots(1)),
    (err) => err instanceof RangeError && /budget exceeded/.test(err.message),
  );
  assert.strictEqual(w.ragdollCount(), 48);
  assert.strictEqual(w.ragdollUnits(), DEFAULT_BUDGET);
});

test('budget: 120 light rigs fit, and a 121st is refused', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(120), RagdollRig.Light, spots(120));
  assert.strictEqual(w.ragdollCount(), 120);
  assert.strictEqual(w.ragdollUnits(), 120 * LIGHT_UNITS);
  assert.throws(
    () => w.addRagdolls(ids(1, 900n), RagdollRig.Light, spots(1)),
    RangeError,
  );
  assert.strictEqual(w.ragdollCount(), 120);
});

test('a mixed batch over budget is refused whole', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(47), RagdollRig.Full, spots(47)); // 235 units
  w.addRagdolls(ids(2, 300n), RagdollRig.Light, spots(2)); // 239 units
  assert.strictEqual(w.ragdollUnits(), 239);
  // One light rig (2 units) would make 241: refused, nothing added.
  assert.throws(
    () => w.addRagdolls(ids(1, 400n), RagdollRig.Light, spots(1)),
    RangeError,
  );
  assert.strictEqual(w.ragdollCount(), 49);
  assert.strictEqual(w.ragdollUnits(), 239);
});

test('removing frees budget; removal is idempotent and ignores unknown ids', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  const three = ids(3);
  w.addRagdolls(three, RagdollRig.Full, spots(3));
  assert.strictEqual(w.ragdollUnits(), 3 * FULL_UNITS);
  w.removeRagdolls(new BigUint64Array([three[0], three[0], 999n]));
  assert.strictEqual(w.ragdollCount(), 2);
  assert.strictEqual(w.ragdollUnits(), 2 * FULL_UNITS);
  w.removeRagdolls(new BigUint64Array([three[0]]));
  assert.strictEqual(w.ragdollCount(), 2);
  // The freed budget takes a new rig with a fresh id.
  w.addRagdolls(ids(1, 700n), RagdollRig.Full, spots(1));
  assert.strictEqual(w.ragdollCount(), 3);
});

test('a refused batch changes nothing: duplicate ids and unknown rig kinds', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(1), RagdollRig.Full, spots(1));
  assert.throws(
    () => w.addRagdolls(new BigUint64Array([50n, 50n]), RagdollRig.Full, spots(2)),
    /already present or repeated/,
  );
  assert.throws(
    () => w.addRagdolls(ids(1), RagdollRig.Full, spots(1)),
    /already present or repeated/,
  );
  assert.throws(
    () => w.addRagdolls(ids(1, 60n), 7, spots(1)),
    /unknown rig kind/,
  );
  assert.strictEqual(w.ragdollCount(), 1);
  assert.strictEqual(w.ragdollUnits(), FULL_UNITS);
});

test('lowering the budget refuses new rigs and keeps the ones present', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(4), RagdollRig.Full, spots(4)); // 20 units
  w.setRagdollBudget(10);
  assert.strictEqual(w.ragdollBudget(), 10);
  assert.strictEqual(w.ragdollCount(), 4);
  assert.strictEqual(w.ragdollUnits(), 4 * FULL_UNITS);
  assert.throws(
    () => w.addRagdolls(ids(1, 800n), RagdollRig.Light, spots(1)),
    RangeError,
  );
});

test('copyRagdollRoots gives NaN for an unknown id', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  w.addRagdolls(ids(1), RagdollRig.Full, spots(1, 3.0));
  const out = rootsOf(w, new BigUint64Array([100n, 999n]));
  assert.ok(Number.isFinite(out[1]) && Math.abs(out[1] - 3.0) < 0.01);
  assert.ok(Number.isNaN(out[3]) && Number.isNaN(out[4]) && Number.isNaN(out[5]));
});

test('ten rigs and a floor stay on the floor for a long run', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloor(w);
  const list = ids(10);
  w.addRagdolls(list, RagdollRig.Light, spots(10));
  for (let i = 0; i < 300; i++) w.step(1 / 30, 2);
  const roots = rootsOf(w, list);
  for (let i = 0; i < 10; i++) {
    const y = roots[3 * i + 1];
    assert.ok(Number.isFinite(y) && y > 0.0, `rig ${i} at y=${y}`);
  }
});

test('input checks: wrong types, short arrays and bad budgets throw', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  assert.throws(() => w.addRagdolls([1n], RagdollRig.Full, spots(1)), TypeError);
  assert.throws(
    () => w.addRagdolls(ids(2), RagdollRig.Full, spots(1)),
    RangeError,
  );
  assert.throws(() => w.setRagdollBudget(-1), RangeError);
  assert.throws(() => w.setRagdollBudget(2.5), RangeError);
  assert.throws(() => w.setRagdollBudget('10'), TypeError);
});

test('destroy with rigs present is clean and idempotent', () => {
  const w = createWorld();
  addFloor(w);
  w.addRagdolls(ids(5), RagdollRig.Full, spots(5));
  w.destroy();
  w.destroy();
  assert.throws(() => w.ragdollCount(), /destroyed/);
});
