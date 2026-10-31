// Contact cap through the addon: where a ragdoll world fills Jolt's contact
// limit, and what the addon reports and does when it does.
//
// Jolt keeps at most 10,240 contact constraints per world (the addon's limit,
// native/physics_world.cpp). Past that it drops contacts for the step, and
// PhysicsWorld.lastStepErrors() reports it as UpdateError.ContactConstraintsFull.
// For each rig kind and scenario this bench:
//   - times the step at each rig count, with the budget lifted, so the count is
//     what the world holds;
//   - reports the cap bit per run, and bisects for the first count that sets it
//     (to within FILL_TOLERANCE rigs);
//   - records how fast the rig bodies move and how many fall through the floor at
//     the end of each run, to show what a dropped contact does.
//
// Scenarios, as bench/ragdoll-cost.cpp defines them:
//   settle  rigs 0.9 m apart, sleeping on (0.03 m/s); the 2 s after the drop.
//   awake   rigs 0.9 m apart, sleeping off (threshold 0); 1 s warm-up, 3 s measured.
//   apart   rigs 4 m apart, sleeping off, so no two rigs touch; 1 s, then 3 s.
// The default budget (240 units) holds 48 full or 120 light rigs; those counts
// are in the sweep and marked in the results.
//
// Usage:
//   node bench/addon-contact-cap.mjs          full sweep (3 repeats) and the fill
//                                             search; writes docs/addon-contact-cap-results.json
//   node bench/addon-contact-cap.mjs --quick  one repeat, three counts, no fill search, no file

'use strict';

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWorld, ShapeKind, MotionType, RagdollRig, UpdateError } = require('../index.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(here, '..', '..', '..', '..', 'docs', 'addon-contact-cap-results.json');
const TICK_HZ = 30;
const SUBSTEPS = 2;
const CAP_CONTACTS = 10240;
const DEFAULT_BUDGET_UNITS = 240;
const FILL_TOLERANCE = 4;
const CAP_BIT = UpdateError.ContactConstraintsFull;
const FLOATS_PER_BODY = 13;

const RIG = { full: RagdollRig.Full, light: RagdollRig.Light };
const BODIES = { full: 11, light: 5 };
const UNITS = { full: 5, light: 2 };
const DEFAULT_COUNT = { full: DEFAULT_BUDGET_UNITS / UNITS.full, light: DEFAULT_BUDGET_UNITS / UNITS.light };

const SCENARIOS = {
  settle: { spacing: 0.9, sleep: null, warm: 0, measure: 2 * TICK_HZ },
  awake: { spacing: 0.9, sleep: 0, warm: 1 * TICK_HZ, measure: 3 * TICK_HZ },
  apart: { spacing: 4.0, sleep: 0, warm: 1 * TICK_HZ, measure: 3 * TICK_HZ },
};
const COUNTS = {
  full: [48, 96, 192, 384, 512, 768, 1024, 1536, 2048],
  light: [120, 240, 480, 960, 1440, 1920, 2400, 3200],
};
const QUICK_COUNTS = { full: [48, 512, 1024], light: [120, 1440, 2400] };

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

// Roots on a grid `spacing` apart, dropped from 1.2 to 1.8 m, as the C++ bench does.
function layout(n, spacing) {
  const out = new Float32Array(3 * n);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  for (let i = 0; i < n; i++) {
    out[3 * i] = (i % cols - (cols - 1) / 2) * spacing;
    out[3 * i + 1] = 1.2 + 0.3 * (i % 3);
    out[3 * i + 2] = (Math.floor(i / cols) - (cols - 1) / 2) * spacing;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One run on a fresh world: n rigs of one kind in one scenario.
function run(rig, scenario, n) {
  const s = SCENARIOS[scenario];
  const w = createWorld();
  try {
    w.setRagdollBudget(1_000_000_000);
    if (s.sleep !== null) w.setSleepThreshold(s.sleep);
    addFloor(w);
    const idList = new BigUint64Array(n);
    for (let i = 0; i < n; i++) idList[i] = 1000n + BigInt(i);
    w.addRagdolls(idList, RIG[rig], layout(n, s.spacing));

    const dt = 1 / TICK_HZ;
    let errors = 0;
    for (let i = 0; i < s.warm; i++) {
      w.step(dt, SUBSTEPS);
      errors |= w.lastStepErrors();
    }
    const samples = [];
    for (let i = 0; i < s.measure; i++) {
      const t0 = performance.now();
      w.step(dt, SUBSTEPS);
      samples.push(performance.now() - t0);
      errors |= w.lastStepErrors();
    }

    // What the bodies did by the end: fastest body, and bodies through the floor
    // (the floor's top is at y = 0).
    const out = new Float32Array(n * BODIES[rig] * FLOATS_PER_BODY);
    const written = w.copyRagdollBodies(idList, out);
    let maxSpeed = 0;
    let throughFloor = 0;
    for (let b = 0; b < written; b += FLOATS_PER_BODY) {
      const vx = out[b + 7];
      const vy = out[b + 8];
      const vz = out[b + 9];
      maxSpeed = Math.max(maxSpeed, Math.hypot(vx, vy, vz));
      if (out[b + 1] < -0.25) throughFloor++;
    }
    return {
      errors,
      stepMs: median(samples),
      maxSpeed,
      throughFloor,
      bodies: written / FLOATS_PER_BODY,
      activeBodies: w.ragdollActiveBodies(),
    };
  } finally {
    w.destroy();
  }
}

// Repeats a run and combines them: median step time, OR of the cap bits, and the
// worst body speed and fall-through count.
function measure(rig, scenario, n, repeats) {
  const runs = Array.from({ length: repeats }, () => run(rig, scenario, n));
  return {
    rig,
    scenario,
    requested: n,
    bodies: runs[0].bodies,
    stepMs: median(runs.map((r) => r.stepMs)),
    runsMs: runs.map((r) => Number(r.stepMs.toFixed(3))),
    errors: runs.reduce((acc, r) => acc | r.errors, 0),
    capFilled: runs.some((r) => (r.errors & CAP_BIT) !== 0),
    activeBodies: runs[0].activeBodies,
    maxSpeed: Math.max(...runs.map((r) => r.maxSpeed)),
    throughFloor: Math.max(...runs.map((r) => r.throughFloor)),
  };
}

// First count that sets the cap bit, between the largest clean count and the
// smallest filled one in the sweep. Bisects with one run per probe.
function findFill(rig, scenario, rows) {
  const sorted = rows.filter((r) => r.rig === rig && r.scenario === scenario).sort((a, b) => a.requested - b.requested);
  let lo = 0;
  let hi = null;
  for (const row of sorted) {
    if (row.capFilled) {
      hi = row.requested;
      break;
    }
    lo = row.requested;
  }
  if (hi === null) return { rig, scenario, lastClean: lo, firstFull: null };
  while (hi - lo > FILL_TOLERANCE) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = run(rig, scenario, mid);
    if ((probe.errors & CAP_BIT) !== 0) hi = mid;
    else lo = mid;
    process.stderr.write(`  fill ${rig} ${scenario}: ${mid} ${(probe.errors & CAP_BIT) !== 0 ? 'full' : 'clean'}\n`);
  }
  return { rig, scenario, lastClean: lo, firstFull: hi };
}

function main(argv) {
  const quick = argv.includes('--quick');
  const repeats = quick ? 1 : 3;
  const counts = quick ? QUICK_COUNTS : COUNTS;
  const rows = [];
  for (const rig of ['full', 'light']) {
    for (const scenario of Object.keys(SCENARIOS)) {
      for (const n of counts[rig]) {
        const row = measure(rig, scenario, n, repeats);
        rows.push(row);
        process.stderr.write(
          `${rig} ${scenario} ${n}: ${row.stepMs.toFixed(2)} ms, cap ${row.capFilled ? 'FULL' : 'clear'}, max ${row.maxSpeed.toFixed(1)} m/s\n`,
        );
      }
    }
  }
  const fill = [];
  if (!quick) {
    for (const rig of ['full', 'light']) {
      for (const scenario of Object.keys(SCENARIOS)) fill.push(findFill(rig, scenario, rows));
    }
  }
  const doc = {
    capContacts: CAP_CONTACTS,
    budgetUnits: DEFAULT_BUDGET_UNITS,
    defaultCount: DEFAULT_COUNT,
    tickHz: TICK_HZ,
    substeps: SUBSTEPS,
    fillTolerance: FILL_TOLERANCE,
    repeats,
    scenarios: SCENARIOS,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
    },
    results: rows,
    fill,
  };
  if (quick) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), RESULTS)}\n`);
}

main(process.argv.slice(2));
