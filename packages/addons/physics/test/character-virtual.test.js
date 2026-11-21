// @mmo-engine/addon-physics tests: Jolt CharacterVirtual (the first slice).
//
// A capsule walking at a static box stops at the box's face, and walks the full
// distance when nothing is in its way (the control, so the stop is the box's
// doing). Also the lifecycle and the input checks.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWorld, ShapeKind, MotionType } = require('../index.js');

const RADIUS = 0.4;
const HALF_HEIGHT = 0.9;
const DT = 1 / 30;
const STEPS = 120; // 4 s at 30 Hz

// A static box centred on (x, 0, 0) with half extents (1, 2, 1): its faces are at x - 1 and x + 1.
function addBox(w, id, x) {
  w.addBodies({
    count: 1,
    entityIds: new BigUint64Array([id]),
    shapeKind: new Uint8Array([ShapeKind.Box]),
    halfExtents: new Float32Array([1, 2, 1]),
    radius: new Float32Array([0]),
    mass: new Float32Array([0]),
    friction: new Float32Array([0.8]),
    restitution: new Float32Array([0]),
    motionType: new Uint8Array([MotionType.Static]),
    layer: new Uint8Array([0]),
    pos: new Float32Array([x, 0, 0]),
    quat: new Float32Array([0, 0, 0, 1]),
    linVel: new Float32Array(3),
    angVel: new Float32Array(3),
  });
}

// Walks the character at 4 m/s along +x for STEPS updates; returns the furthest and the last x.
function walk(w, id) {
  w.setCharacterVelocity(id, 4, 0, 0);
  let furthest = -Infinity;
  for (let i = 0; i < STEPS; i++) {
    w.updateCharacter(id, DT, 0, 0, 0);
    furthest = Math.max(furthest, w.characterPosition(id)[0]);
  }
  return { furthest, x: w.characterPosition(id)[0] };
}

test('a capsule walking at a box stops at its face, not in it', () => {
  const w = createWorld();
  addBox(w, 1n, 4); // the near face is at x = 3
  assert.equal(w.addCharacter(2n, RADIUS, HALF_HEIGHT, 0, 0, 0), true);
  const { furthest, x } = walk(w, 2n);
  // The surface stops at x = 3, so the centre stops at 3 - 0.4 = 2.6, less Jolt's
  // 0.02 m contact padding.
  assert.ok(x > 2.5 && x < 2.62, `stopped at x=${x}, want about 2.6`);
  assert.ok(furthest < 2.65, `went into the box: furthest x=${furthest}`);
  w.destroy();
});

test('with nothing in its way the same capsule walks the full distance (the control)', () => {
  const w = createWorld();
  assert.equal(w.addCharacter(2n, RADIUS, HALF_HEIGHT, 0, 0, 0), true);
  const { x } = walk(w, 2n);
  assert.ok(x > 15.5, `only reached x=${x}; 4 m/s for 4 s should give about 16`);
  w.destroy();
});

test('a duplicate id and a zero radius are refused, and removal is idempotent', () => {
  const w = createWorld();
  assert.equal(w.addCharacter(5n, RADIUS, HALF_HEIGHT, 0, 0, 0), true);
  assert.equal(w.addCharacter(5n, RADIUS, HALF_HEIGHT, 9, 0, 0), false);
  assert.equal(w.addCharacter(6n, 0, HALF_HEIGHT, 0, 0, 0), false);
  assert.equal(w.characterCount(), 1);
  assert.deepEqual(w.characterPosition(5n), [0, 0, 0]);
  w.removeCharacter(5n);
  w.removeCharacter(5n);
  assert.equal(w.characterCount(), 0);
  assert.ok(w.characterPosition(5n).every(Number.isNaN));
  w.destroy();
});

test('ids must be BigInts', () => {
  const w = createWorld();
  assert.throws(() => w.addCharacter(1, RADIUS, HALF_HEIGHT, 0, 0, 0), TypeError);
  w.destroy();
});

test('followCharacters moves characters exactly as characterPosition, setCharacterVelocity and updateCharacter', () => {
  // Same box, same walkers, two worlds: one moved by the single calls, one by the batch. Positions match bit for
  // bit; a walker too far from its target is flagged, not moved; an unknown id gives NaN.
  const make = () => {
    const w = createWorld();
    addBox(w, 1n, 0);
    for (let i = 0; i < 6; i++) assert.strictEqual(w.addCharacter(BigInt(10 + i), RADIUS, HALF_HEIGHT, -4 + i * 0.3, HALF_HEIGHT + RADIUS, i - 3), true);
    return w;
  };
  const single = make();
  const batch = make();
  try {
    const ids = new BigUint64Array([10n, 11n, 12n, 13n, 14n, 15n, 99n]);
    const targets = new Float64Array(ids.length * 3);
    const out = new Float32Array(ids.length * 4);
    for (let t = 0; t < 60; t++) {
      for (let i = 0; i < ids.length; i++) {
        const cur = batch.characterPosition(ids[i]);
        targets[3 * i] = cur[0] + 0.12 * Math.cos(i + t * 0.1);
        targets[3 * i + 1] = cur[1];
        targets[3 * i + 2] = cur[2] + 0.05;
      }
      if (t === 30) targets[0] += 5; // too far: flagged
      batch.followCharacters(ids, targets, ids.length, DT, 2, out);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const cur = single.characterPosition(id);
        const dx = targets[3 * i] - cur[0], dy = targets[3 * i + 1] - cur[1], dz = targets[3 * i + 2] - cur[2];
        const far = dx * dx + dy * dy + dz * dz > 4;
        if (!far) {
          single.setCharacterVelocity(id, dx / DT, dy / DT, dz / DT);
          single.updateCharacter(id, DT, 0, 0, 0);
        }
        assert.strictEqual(out[4 * i + 3], far ? 1 : 0, `flag of ${id} at tick ${t}`);
        if (far) continue;
        const at = single.characterPosition(id);
        for (let k = 0; k < 3; k++) assert.ok(Object.is(out[4 * i + k], Math.fround(at[k])), `${id} axis ${k} at tick ${t}: ${out[4 * i + k]} vs ${at[k]}`);
      }
    }
    assert.ok(Number.isNaN(out[4 * 6]), 'an unknown id gives NaN');
    batch.followCharacters(ids, targets, 0, DT, 2, new Float32Array(0)); // nothing to do
    assert.throws(() => batch.followCharacters(ids, targets, ids.length, DT, 2, new Float32Array(4)), RangeError);
    assert.throws(() => batch.followCharacters(ids, new Float32Array(21), ids.length, DT, 2, out), TypeError);
  } finally {
    single.destroy();
    batch.destroy();
  }
});
