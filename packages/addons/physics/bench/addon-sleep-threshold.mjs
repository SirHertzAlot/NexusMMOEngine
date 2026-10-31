// Sleep threshold through the addon: does a larger point-velocity sleep threshold
// let a resting crowd sleep, how long does that take, what does the step cost once
// it has, and does a sleeping rig still wake when something lands on it?
//
// The crowd is the resting scenario of addon-ragdoll-cost.mjs: rigs on a 0.9 m
// grid, sleep on, two substeps. Each run warms up for 20 s, which is long enough
// for the slow thresholds to put a crowd to sleep (about 15 s at 0.1 m/s for 48
// full rigs), and records how many ragdoll bodies are still simulating at 5, 10 and
// 20 s and the first whole second with none awake. The step time is measured for 2 s
// after warm-up. The wake check settles 16 light rigs for 20 s, drops a 5 kg sphere
// 2 m onto the middle one, and reports whether any body woke and how far that rig's
// root moved.
//
// Usage:
//   node bench/addon-sleep-threshold.mjs            full sweep (3 repeats), writes
//                                                   docs/addon-sleep-threshold-results.json
//   node bench/addon-sleep-threshold.mjs --quick    one repeat, no file
//   node bench/addon-sleep-threshold.mjs --run --rig full|light --requested N --threshold T
//                                                   one crowd run, prints one JSON line
//   node bench/addon-sleep-threshold.mjs --wake --threshold T
//                                                   one wake check, prints one JSON line

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
const RESULTS = path.join(here, '..', '..', '..', '..', 'docs', 'addon-sleep-threshold-results.json');
const TICK_HZ = 30;
const SUBSTEPS = 2;
const WARM_SECONDS = 20;
const MEASURE_STEPS = 2 * TICK_HZ;
const WAKE_STEPS = 2 * TICK_HZ;
const BODIES = { full: 11, light: 5 };
const UNITS = { full: 5, light: 2 };
const THRESHOLDS = [0.03, 0.1, 0.3, 1.0];
const CONFIGS = [
  { rig: 'full', requested: 16 },
  { rig: 'full', requested: 48 },
  { rig: 'light', requested: 16 },
  { rig: 'light', requested: 120 },
];
const REPEATS = 3;

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

// Same grid as addon-ragdoll-cost.mjs: 0.9 m apart, drop height steps by 0.3 m.
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

// A world with the floor, the threshold set, and as many rigs as the budget takes.
function build(rig, requested, threshold) {
  const w = createWorld();
  addFloor(w);
  w.setSleepThreshold(threshold);
  const fit = Math.floor((w.ragdollBudget() - w.ragdollUnits()) / UNITS[rig]);
  const accepted = Math.min(requested, fit);
  if (accepted > 0) {
    const idList = new BigUint64Array(accepted);
    for (let i = 0; i < accepted; i++) idList[i] = 1000n + BigInt(i);
    w.addRagdolls(idList, rig === 'full' ? RagdollRig.Full : RagdollRig.Light, grid(accepted));
  }
  return { w, accepted };
}

function runOnce({ rig, requested, threshold }) {
  const { w, accepted } = build(rig, requested, threshold);
  try {
    const dt = 1 / TICK_HZ;
    const awakeEachSecond = [];
    let timeToAsleepS = null;
    for (let sec = 1; sec <= WARM_SECONDS; sec++) {
      for (let i = 0; i < TICK_HZ; i++) w.step(dt, SUBSTEPS);
      const awake = w.ragdollActiveBodies();
      awakeEachSecond.push(awake);
      if (timeToAsleepS === null && accepted > 0 && awake === 0) timeToAsleepS = sec;
    }
    const samples = [];
    for (let i = 0; i < MEASURE_STEPS; i++) {
      const t0 = performance.now();
      w.step(dt, SUBSTEPS);
      samples.push(performance.now() - t0);
    }
    return {
      rig,
      requested,
      accepted,
      threshold,
      bodies: accepted * BODIES[rig],
      awakeAt5s: awakeEachSecond[4],
      awakeAt10s: awakeEachSecond[9],
      awakeAt20s: awakeEachSecond[WARM_SECONDS - 1],
      awakeAfterMeasure: w.ragdollActiveBodies(),
      timeToAsleepS,
      stepMs: median(samples),
      meanStepMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    };
  } finally {
    w.destroy();
  }
}

// Settle 16 light rigs, then drop a sphere onto the middle one.
function wakeCheck(threshold) {
  const w = createWorld();
  try {
    addFloor(w);
    w.setSleepThreshold(threshold);
    const n = 16;
    const idList = new BigUint64Array(n);
    for (let i = 0; i < n; i++) idList[i] = 1000n + BigInt(i);
    w.addRagdolls(idList, RagdollRig.Light, grid(n));
    const dt = 1 / TICK_HZ;
    for (let i = 0; i < WARM_SECONDS * TICK_HZ; i++) w.step(dt, SUBSTEPS);
    const awakeBeforeDrop = w.ragdollActiveBodies();
    const target = new BigUint64Array([1000n + BigInt(Math.floor(n / 2))]);
    const rootNow = () => {
      const out = new Float32Array(3);
      w.copyRagdollRoots(target, out);
      return out;
    };
    const before = rootNow();
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
    let maxAwake = 0;
    for (let i = 0; i < WAKE_STEPS; i++) {
      w.step(dt, SUBSTEPS);
      maxAwake = Math.max(maxAwake, w.ragdollActiveBodies());
    }
    const after = rootNow();
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    return { threshold, awakeBeforeDrop, woke: maxAwake > 0, maxAwake, movedMetres: moved };
  } finally {
    w.destroy();
  }
}

function runChild(args) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function sweep(repeats) {
  const results = [];
  for (const threshold of THRESHOLDS) {
    for (const c of CONFIGS) {
      const runs = [];
      for (let r = 0; r < repeats; r++) {
        runs.push(runChild(['--run', '--rig', c.rig, '--requested', String(c.requested), '--threshold', String(threshold)]));
      }
      // The physics is deterministic per process, so the awake counts match across
      // repeats; only the timings vary. The first run's counts stand for all of them.
      const first = runs[0];
      results.push({
        threshold,
        rig: c.rig,
        requested: c.requested,
        accepted: first.accepted,
        bodies: first.bodies,
        awakeAt5s: first.awakeAt5s,
        awakeAt10s: first.awakeAt10s,
        awakeAt20s: first.awakeAt20s,
        awakeAfterMeasure: first.awakeAfterMeasure,
        timeToAsleepS: first.timeToAsleepS,
        stepMs: median(runs.map((run) => run.stepMs)),
        meanStepMs: median(runs.map((run) => run.meanStepMs)),
        runsMs: runs.map((run) => Number(run.stepMs.toFixed(3))),
      });
      const asleep = first.timeToAsleepS === null ? 'not within 20 s' : `at ${first.timeToAsleepS} s`;
      process.stderr.write(`threshold ${threshold} ${c.rig} ${c.requested}: awake ${first.awakeAt5s}/${first.bodies} at 5 s, ${first.awakeAt20s} at 20 s; asleep ${asleep}; step ${median(runs.map((run) => run.stepMs)).toFixed(3)} ms\n`);
    }
  }
  const wakes = THRESHOLDS.map((threshold) => runChild(['--wake', '--threshold', String(threshold)]));
  for (const wake of wakes) {
    process.stderr.write(`wake at threshold ${wake.threshold}: awake before drop ${wake.awakeBeforeDrop}, woke ${wake.woke}, moved ${wake.movedMetres.toFixed(3)} m\n`);
  }
  return { results, wakes };
}

function main(argv) {
  const get = (flag) => argv[argv.indexOf(flag) + 1];
  if (argv.includes('--run')) {
    const out = runOnce({
      rig: get('--rig'),
      requested: Number(get('--requested')),
      threshold: Number(get('--threshold')),
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (argv.includes('--wake')) {
    process.stdout.write(`${JSON.stringify(wakeCheck(Number(get('--threshold'))))}\n`);
    return;
  }
  const quick = argv.includes('--quick');
  const repeats = quick ? 1 : REPEATS;
  const { results, wakes } = sweep(repeats);
  const doc = {
    tickHz: TICK_HZ,
    substeps: SUBSTEPS,
    scenario: 'resting: 0.9 m grid, sleep on, 20 s warm-up, 2 s measured; wake check: 16 light rigs settled 20 s, a 5 kg sphere dropped 2 m onto the middle rig',
    defaultThreshold: 0.03,
    repeats,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
    },
    results,
    wakes,
  };
  if (quick) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), RESULTS)}\n`);
}

main(process.argv.slice(2));
