// Determinism probe: builds a fixed physics scene, steps it, and prints an exact
// float fingerprint (f32 bits as hex) of every dynamic body and every rig body.
// Run in a FRESH process per probe. test/determinism.test.js spawns it several
// times, with the single-threaded job system (no argument, or 0) and with a
// thread pool (the argument is the thread count), and compares the output byte
// for byte.
//
// The scene exercises the solver paths that matter: stacked spheres (contact
// chains), mixed shapes/masses/friction, initial velocities, a kinematic platform
// carrying a dynamic box, and rigs (two full, two light) falling onto the floor.

'use strict';

const { createWorld, ShapeKind, MotionType, RagdollRig } = require('../index.js');

function bits(f32arr) {
  const u = new Uint32Array(f32arr.buffer, f32arr.byteOffset, f32arr.length);
  return [...u].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const FULL_RIGS = [2000n, 2001n];
const LIGHT_RIGS = [3000n, 3001n];
const FULL_BODIES = 11;
const LIGHT_BODIES = 5;

function main() {
  const threads = Number(process.argv[2] ?? 0);
  const w = createWorld({ threads });

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

  // Rigs come after the bodies, in ascending id order within each kind.
  w.addRagdolls(new BigUint64Array(FULL_RIGS), RagdollRig.Full,
    new Float32Array([10, 3, 0, 14, 3, 0]));
  w.addRagdolls(new BigUint64Array(LIGHT_RIGS), RagdollRig.Light,
    new Float32Array([18, 3, 0, 22, 3, 0]));

  // Phase 2 (zero-copy): sync/copy use component arrays indexed by eid
  // (insertion order: floor=0, platform=1, box=2, spheres=3..7).
  const PLAT_EID = 1;
  const platIds = new BigUint64Array([PLATFORM]);
  const platEids = new Int32Array([PLAT_EID]);
  const c = {
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    qx: new Float32Array(n), qy: new Float32Array(n), qz: new Float32Array(n),
    qw: new Float32Array(n),
    lx: new Float32Array(n), ly: new Float32Array(n), lz: new Float32Array(n),
    ax: new Float32Array(n), ay: new Float32Array(n), az: new Float32Array(n),
  };
  c.qw.fill(1);
  const noFlags = new Uint8Array([0]);
  for (let step = 0; step < 240; step++) {
    c.px[PLAT_EID] = -6 + step * (4 / 240);
    c.py[PLAT_EID] = 1.5;
    c.pz[PLAT_EID] = 0;
    w.syncBodies(1, platIds, platEids,
      c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw, noFlags, 1 / 60);
    w.step(1 / 60, 2);
  }

  const dynIds = new BigUint64Array([BOX, ...spheres]);
  const dynEids = new Int32Array([2, 3, 4, 5, 6, 7]);
  const m = dynIds.length;
  w.copyResults(m, dynIds, dynEids,
    c.px, c.py, c.pz, c.qx, c.qy, c.qz, c.qw,
    c.lx, c.ly, c.lz, c.ax, c.ay, c.az);
  // Gather into dense fingerprint arrays in dyn order (same as before).
  const oPos = new Float32Array(m * 3);
  const oQuat = new Float32Array(m * 4);
  const oLin = new Float32Array(m * 3);
  const oAng = new Float32Array(m * 3);
  for (let k = 0; k < m; k++) {
    const e = dynEids[k];
    oPos.set([c.px[e], c.py[e], c.pz[e]], k * 3);
    oQuat.set([c.qx[e], c.qy[e], c.qz[e], c.qw[e]], k * 4);
    oLin.set([c.lx[e], c.ly[e], c.lz[e]], k * 3);
    oAng.set([c.ax[e], c.ay[e], c.az[e]], k * 3);
  }

  // Every body of every rig, rigs in id order, 13 floats per body.
  const rigIds = new BigUint64Array([...FULL_RIGS, ...LIGHT_RIGS]);
  const rigBodies = FULL_RIGS.length * FULL_BODIES + LIGHT_RIGS.length * LIGHT_BODIES;
  const rigOut = new Float32Array(rigBodies * 13);
  const written = w.copyRagdollBodies(rigIds, rigOut);
  if (written !== rigOut.length) {
    throw new Error(`copyRagdollBodies wrote ${written} floats, expected ${rigOut.length}`);
  }

  const fp = [bits(oPos), bits(oQuat), bits(oLin), bits(oAng), bits(rigOut)].join('|');
  process.stdout.write(`bodies=${w.bodyCount()} rigBodies=${rigBodies} fp=${fp}\n`);
  w.destroy();
}

main();
