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

// Phase 2 (zero-copy): component arrays indexed by eid, mirroring the
// bitECS Transform + Velocity stores. Tests use small arrays with
// explicit eid assignment (floor -> eid 0, sphere -> eid 1).
function compArrays(n) {
  return {
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    qx: new Float32Array(n), qy: new Float32Array(n), qz: new Float32Array(n),
    qw: new Float32Array(n),
    lx: new Float32Array(n), ly: new Float32Array(n), lz: new Float32Array(n),
    ax: new Float32Array(n), ay: new Float32Array(n), az: new Float32Array(n),
  };
}

function readOne(w, id, eid = 0) {
  const c = compArrays(eid + 1);
  w.copyResults(1, new BigUint64Array([id]), new Int32Array([eid]),
    c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw,
    c.lx, c.ly, c.lz, c.ax, c.ay, c.az);
  return {
    pos: new Float32Array([c.px[eid], c.py[eid], c.pz[eid]]),
    quat: new Float32Array([c.qx[eid], c.qy[eid], c.qz[eid], c.qw[eid]]),
    lin: new Float32Array([c.lx[eid], c.ly[eid], c.lz[eid]]),
    ang: new Float32Array([c.ax[eid], c.ay[eid], c.az[eid]]),
  };
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
  const { pos, lin } = readOne(w, 2n, 1);
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
  const eids = new Int32Array([0]);
  const c = compArrays(1);
  c.qw[0] = 1;
  const flags = new Uint8Array([SyncFlags.None]);
  for (let i = 1; i <= 60; i++) {
    c.px[0] = i / 10; // drive +x at 6 u/s
    w.syncBodies(1, ids, eids,
      c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw, flags, 1 / 60);
    w.step(1 / 60, 1);
  }
  const got = readOne(w, 4n, 0);
  assert.ok(Math.abs(got.pos[0] - 6) < 0.01, `kinematic x=${got.pos[0]}`);
});

test('dynamic teleport via syncBodies flag repositions the body', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloorAndSphere(w, 5);
  for (let i = 0; i < 180; i++) w.step(1 / 60, 2);
  const ids = new BigUint64Array([2n]);
  const eids = new Int32Array([1]);
  const c = compArrays(2);
  c.px[1] = 10; c.py[1] = 8; c.pz[1] = -3; c.qw[1] = 1;
  w.syncBodies(
    1, ids, eids,
    c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw,
    new Uint8Array([SyncFlags.Teleport]),
    1 / 60,
  );
  const got = readOne(w, 2n, 1);
  assert.ok(Math.abs(got.pos[0] - 10) < 1e-6, `teleport x=${got.pos[0]}`);
  assert.ok(Math.abs(got.pos[1] - 8) < 1e-6, `teleport y=${got.pos[1]}`);
  // ...and it keeps simulating afterwards (falls from the new height).
  for (let i = 0; i < 30; i++) w.step(1 / 60, 2);
  const after = readOne(w, 2n, 1);
  assert.ok(after.pos[1] < 8, `still falling: y=${after.pos[1]}`);
});

test('syncBodies without teleport leaves a dynamic body alone', (t) => {
  const w = createWorld();
  t.after(() => w.destroy());
  addFloorAndSphere(w, 5);
  for (let i = 0; i < 180; i++) w.step(1 / 60, 2);
  const before = readOne(w, 2n, 1).pos[1];
  const ids = new BigUint64Array([2n]);
  const eids = new Int32Array([1]);
  const c = compArrays(2);
  c.px[1] = 99; c.py[1] = 99; c.pz[1] = 99; c.qw[1] = 1; // must be ignored: no teleport flag
  w.syncBodies(
    1, ids, eids,
    c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw,
    new Uint8Array([SyncFlags.None]),
    1 / 60,
  );
  w.step(1 / 60, 1);
  const after = readOne(w, 2n, 1).pos[1];
  assert.ok(Math.abs(after - before) < 0.01, `dynamic untouched: ${before} -> ${after}`);
});

test('terrain: add, replace, and remove height fields by key', () => {
  const w = createWorld();
  try {
    const flat = new Float32Array(16 * 16).fill(1);
    assert.strictEqual(w.terrainCount(), 0);
    assert.strictEqual(w.addTerrain(7n, 0, 0, 16 / 15, flat, 0.8), true);
    assert.strictEqual(w.addTerrain(7n, 0, 0, 16 / 15, flat, 0.8), true, 're-adding replaces');
    assert.strictEqual(w.addTerrain(8n, 16, 0, 16 / 15, flat, 0.8), true);
    assert.strictEqual(w.terrainCount(), 2);
    assert.strictEqual(w.bodyCount(), 0, 'terrain is not an entity body');
    w.removeTerrain(7n);
    w.removeTerrain(7n); // idempotent
    assert.strictEqual(w.terrainCount(), 1);
  } finally {
    w.destroy();
  }
});

test('terrain: rejects bad input without crashing', () => {
  const w = createWorld();
  try {
    assert.throws(() => w.addTerrain(1, 0, 0, 1, new Float32Array(16), 0.8), /bigint/);
    assert.throws(() => w.addTerrain(1n, 0, 0, 1, new Float32Array(20), 0.8), /square/);
    assert.throws(() => w.addTerrain(1n, 0, 0, 1, new Float64Array(16), 0.8), /Float32Array/);
    assert.strictEqual(w.addTerrain(1n, 0, 0, 1, new Float32Array(25), 0.8), false, 'odd side');
    assert.strictEqual(w.addTerrain(1n, 0, 0, 0, new Float32Array(16), 0.8), false, 'zero spacing');
    assert.strictEqual(w.terrainCount(), 0);
  } finally {
    w.destroy();
  }
});

// A batch of n static spheres on a grid, ids idBase+1 .. idBase+n.
function bulkDesc(n, idBase = 0) {
  const pos = new Float32Array(3 * n);
  const quat = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    pos[3 * i] = (i % 300) * 2;
    pos[3 * i + 2] = Math.floor(i / 300) * 2;
    quat[4 * i + 3] = 1;
  }
  return {
    count: n,
    entityIds: BigUint64Array.from({ length: n }, (_, i) => BigInt(idBase + i + 1)),
    shapeKind: new Uint8Array(n).fill(ShapeKind.Sphere),
    halfExtents: new Float32Array(3 * n),
    radius: new Float32Array(n).fill(0.3),
    mass: new Float32Array(n).fill(1),
    friction: new Float32Array(n).fill(0.5),
    restitution: new Float32Array(n),
    motionType: new Uint8Array(n).fill(MotionType.Static),
    layer: new Uint8Array(n),
    pos,
    quat,
    linVel: new Float32Array(3 * n),
    angVel: new Float32Array(3 * n),
  };
}

test('addBodies returns how many bodies the pool refused, and only those', () => {
  const w = createWorld();
  try {
    const cap = w.bodyCapacity;
    assert.ok(cap > 0, `pool size ${cap}`);
    assert.equal(w.addBodies(bulkDesc(3)), 0);
    // Bodies already in the world are skipped as before, and are not refusals.
    assert.equal(w.addBodies(bulkDesc(3)), 0);
    assert.equal(w.bodyCount(), 3);
    // Fill the pool, then go four past it: exactly four are refused.
    assert.equal(w.addBodies(bulkDesc(cap - 3 + 4, 3)), 4);
    assert.equal(w.bodyCount(), cap);
  } finally {
    w.destroy();
  }
});
