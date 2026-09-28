// Determinism probe: builds a fixed physics scene, steps it, and prints
// an exact float fingerprint (f32 bits as hex) of every dynamic body's
// final position/velocity. Run in a FRESH process per probe —
// test/determinism.test.js spawns this 3x and requires byte-identical
// output (Jolt is deterministic given the same binary and the same
// mutating-API call order).
//
// The scene exercises the solver paths that matter: stacked spheres
// (contact chains), mixed shapes/masses/friction, initial velocities,
// and a kinematic platform carrying a dynamic box.

'use strict';

const { createWorld, ShapeKind, MotionType } = require('../index.js');

function bits(f32arr) {
  const u = new Uint32Array(f32arr.buffer, f32arr.byteOffset, f32arr.length);
  return [...u].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function main() {
  const w = createWorld();

  // Entity ids (u64 wire ids, ascending => deterministic insertion order).
  const FLOOR = 1n;
  const PLATFORM = 2n; // kinematic
  const BOX = 3n; // dynamic box riding the platform
  const spheres = [10n, 11n, 12n, 13n, 14n]; // dynamic spheres, stacked

  const n = 3 + spheres.length;
  const entityIds = new BigUint64Array(n);
  const shapeKind = new Uint8Array(n);
  const halfExtents = new Float32Array(n * 3);
  const radius = new Float32Array(n);
  const mass = new Float32Array(n);
  const friction = new Float32Array(n);
  const restitution = new Float32Array(n);
  const motionType = new Uint8Array(n);
  const layer = new Uint8Array(n);
  const pos = new Float32Array(n * 3);
  const quat = new Float32Array(n * 4);
  const linVel = new Float32Array(n * 3);
  const angVel = new Float32Array(n * 3);

  let i = 0;
  const put = (id, sk, he, r, m, fr, re, mt, ly, p, lv) => {
    entityIds[i] = id;
    shapeKind[i] = sk;
    halfExtents.set(he, i * 3);
    radius[i] = r;
    mass[i] = m;
    friction[i] = fr;
    restitution[i] = re;
    motionType[i] = mt;
    layer[i] = ly;
    pos.set(p, i * 3);
    quat.set([0, 0, 0, 1], i * 4);
    linVel.set(lv, i * 3);
    i++;
  };

  // Static floor: top surface at y=0.
  put(FLOOR, ShapeKind.Box, [50, 0.5, 50], 0, 0, 0.9, 0,
    MotionType.Static, 0, [0, -0.5, 0], [0, 0, 0]);
  // Kinematic platform, driven +x.
  put(PLATFORM, ShapeKind.Box, [2, 0.25, 2], 0, 0, 0.6, 0,
    MotionType.Kinematic, 1, [-6, 1.5, 0], [0, 0, 0]);
  // Dynamic box starting on the platform.
  put(BOX, ShapeKind.Box, [0.4, 0.4, 0.4], 0, 2, 0.7, 0.1,
    MotionType.Dynamic, 1, [-6, 2.4, 0.3], [0, 0, 0]);
  // Stack of spheres with mixed radii/masses and sideways velocities.
  const stackX = [1.5, -2.0, 3.25, -0.75, 2.5];
  for (let s = 0; s < spheres.length; s++) {
    put(
      spheres[s], ShapeKind.Sphere, [0, 0, 0], 0.35 + 0.1 * s,
      0.5 + s, 0.4 + 0.1 * s, 0.05 * s,
      MotionType.Dynamic, 1,
      [stackX[s], 4 + s * 1.6, 0.5 * s],
      [0.6 * (s % 2 === 0 ? 1 : -1), 0, 0.2 * s],
    );
  }

  w.addBodies({
    count: n, entityIds, shapeKind, halfExtents, radius, mass, friction,
    restitution, motionType, layer, pos, quat, linVel, angVel,
  });

  // 4 seconds at 60 Hz, 2 substeps: the platform drives +x the whole run.
  const platIds = new BigUint64Array([PLATFORM]);
  const platPos = new Float32Array(3);
  const platQuat = new Float32Array([0, 0, 0, 1]);
  const zero3 = new Float32Array(3);
  const noFlags = new Uint8Array([0]);
  for (let step = 0; step < 240; step++) {
    platPos[0] = -6 + step * (4 / 240);
    platPos[1] = 1.5;
    platPos[2] = 0;
    w.syncBodies(1, platIds, platPos, platQuat, zero3, zero3, noFlags, 1 / 60);
    w.step(1 / 60, 2);
  }

  const dynIds = new BigUint64Array([BOX, ...spheres]);
  const m = dynIds.length;
  const oPos = new Float32Array(m * 3);
  const oQuat = new Float32Array(m * 4);
  const oLin = new Float32Array(m * 3);
  const oAng = new Float32Array(m * 3);
  w.copyResults(m, dynIds, oPos, oQuat, oLin, oAng);

  const fp = [bits(oPos), bits(oQuat), bits(oLin), bits(oAng)].join('|');
  process.stdout.write(`bodies=${w.bodyCount()} fp=${fp}\n`);
  w.destroy();
}

main();
