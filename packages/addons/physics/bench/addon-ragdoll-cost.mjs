// Server ragdoll cost through the addon: the path the engine runs.
//
// What it measures: the step time of a world holding N rigs on one floor, in
// the production configuration (sleep on, the addon's two substeps, its limits).
// Each run drops the rigs on a grid 0.9 m apart from 1.2 to 1.8 m, warms up for
// 5 s, then measures 2 s at 30 Hz. That is the resting scenario of the cost
// gate, through the addon rather than Jolt directly.
//
// Budgets: `default` is the world's budget (240 units: 48 full or 120 light
// rigs). `uncapped` raises it, to show what the cap prevents. A spawner asks for
// `requested` rigs and adds only what fits, as game code would.
//
// Usage:
//   node bench/addon-ragdoll-cost.mjs            full sweep (3 repeats), writes
//                                                docs/addon-ragdoll-results.json
//   node bench/addon-ragdoll-cost.mjs --quick    one repeat, no file
//   node bench/addon-ragdoll-cost.mjs --run --rig full|light --requested N \
//        --budget default|uncapped               one run, prints one JSON line

'use strict';

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWorld, ShapeKind, MotionType, RagdollRig } = require('../index.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(here, '..', '..', '..', '..', 'docs', 'addon-ragdoll-results.json');
const TICK_HZ = 30;
const SUBSTEPS = 2;
const WARM_STEPS = 5 * TICK_HZ;
const MEASURE_STEPS = 2 * TICK_HZ;
const UNITS = { full: 5, light: 2 };

const CONFIGS = [
  { rig: 'full', budget: 'uncapped', label: 'full rigs, no cap (before)' },
  { rig: 'full', budget: 'default', label: 'full rigs, capped' },
  { rig: 'light', budget: 'uncapped', label: 'light rigs, no cap' },
  { rig: 'light', budget: 'default', label: 'light rigs, capped (after)' },
];
const COUNTS = [16, 64, 128, 256];

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

// Same grid as the C++ cost bench: 0.9 m apart, drop height steps by 0.3 m.
function grid(n) {
  const out = new Float32Array(3 * n);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  for (let i = 0; i < n; i++) {
    out[3 * i] = (i % cols - (cols - 1) / 2) * 0.9;
    out[3 * i + 1] = 1.2 + 0.3 * (i % 3);
    out[3 * i + 2] = (Math.floor(i / cols) - (cols - 1) / 2) * 0.9;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runOnce({ rig, requested, budget }) {
  const w = createWorld();
  try {
    if (budget === 'uncapped') w.setRagdollBudget(1_000_000_000);
    addFloor(w);
    const unitsEach = UNITS[rig];
    const fit = Math.floor((w.ragdollBudget() - w.ragdollUnits()) / unitsEach);
    const accepted = Math.min(requested, fit);
    if (accepted > 0) {
      const idList = new BigUint64Array(accepted);
      for (let i = 0; i < accepted; i++) idList[i] = 1000n + BigInt(i);
      w.addRagdolls(idList, rig === 'full' ? RagdollRig.Full : RagdollRig.Light, grid(accepted));
    }
    const dt = 1 / TICK_HZ;
    for (let i = 0; i < WARM_STEPS; i++) w.step(dt, SUBSTEPS);
    const samples = [];
    for (let i = 0; i < MEASURE_STEPS; i++) {
      const t0 = performance.now();
      w.step(dt, SUBSTEPS);
      samples.push(performance.now() - t0);
    }
    return {
      rig,
      budget,
      requested,
      accepted,
      units: w.ragdollUnits(),
      budgetUnits: w.ragdollBudget(),
      stepMs: median(samples),
    };
  } finally {
    w.destroy();
  }
}

function runChild(config, requested) {
  const out = execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--run', '--rig', config.rig, '--requested', String(requested), '--budget', config.budget],
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop());
}

function sweep(repeats) {
  const results = [];
  for (const config of CONFIGS) {
    for (const requested of COUNTS) {
      const runs = [];
      for (let r = 0; r < repeats; r++) runs.push(runChild(config, requested));
      const first = runs[0];
      results.push({
        label: config.label,
        rig: config.rig,
        budget: config.budget,
        requested,
        accepted: first.accepted,
        units: first.units,
        budgetUnits: first.budgetUnits,
        stepMs: median(runs.map((run) => run.stepMs)),
        runsMs: runs.map((run) => Number(run.stepMs.toFixed(3))),
      });
      process.stderr.write(`${config.label} requested ${requested}: ${first.accepted} accepted, ${median(runs.map((run) => run.stepMs)).toFixed(2)} ms\n`);
    }
  }
  return results;
}

function main(argv) {
  if (argv.includes('--run')) {
    const get = (flag) => argv[argv.indexOf(flag) + 1];
    const out = runOnce({
      rig: get('--rig'),
      requested: Number(get('--requested')),
      budget: get('--budget'),
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const quick = argv.includes('--quick');
  const repeats = quick ? 1 : 3;
  const results = sweep(repeats);
  const doc = {
    tickHz: TICK_HZ,
    substeps: SUBSTEPS,
    scenario: 'resting: rigs 0.9 m apart, sleep on, 5 s warm-up, 2 s measured',
    repeats,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
    },
    results,
  };
  if (quick) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), RESULTS)}\n`);
}

main(process.argv.slice(2));
