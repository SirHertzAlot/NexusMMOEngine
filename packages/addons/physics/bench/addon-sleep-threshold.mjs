// Round 1. Its pose check is superseded: a 1 mm change to the start grid moves the default's
// own settled pose by 263 mm RMS (48 full rigs), so a single-trajectory pose bar measures chaos,
// not quality. Round 2 (addon-sleep-ensemble.mjs) replaces the pose check. The settle cost and
// the wake numbers here stand as measured.
//
// Sleep threshold through the addon: which point-velocity sleep threshold should a
// world default to? Every candidate is compared with the default that shipped before round 2,
// Jolt's 0.03 m/s, on cost and on settle quality.
//
// Cost, per crowd: the physics time spent settling, the sum of every step over the
// first 20 s after the crowd is dropped; and the step time once it has settled.
// Quality, per crowd, against the default run on the same grid:
//   pose    each rig's root, averaged over the last 2 s, compared rig by rig: the RMS
//           and the largest distance. A rig frozen before it has finished moving shows
//           up here as the slide it did not make.
// And for the wake check, against the default's answer to the same hit:
//   impact  how far the hit rig moves when a 5 kg sphere lands on it from 2 m, and
//           whether the rig wakes at all.
//
// The bar is written here, before any run, and the sweep does not move it. A candidate
// passes when both capped crowds (48 full rigs, 120 light rigs) are asleep within the
// 20 s warm-up, with a pose RMS of at most 10 mm and a largest distance of at most
// 25 mm; and the wake check wakes the hit rig and moves it within 20 mm of the
// default's distance. The passing candidate with the lowest settle cost becomes the
// default. If none passes, the default stays where it is.
//
// Usage:
//   node bench/addon-sleep-threshold.mjs            full sweep (3 repeats), writes
//                                                   docs/addon-sleep-threshold-results.json
//   node bench/addon-sleep-threshold.mjs --quick    one repeat, prints the JSON, no file
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
const DEFAULT_THRESHOLD = 0.03;
const THRESHOLDS = [0.03, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0];
const CONFIGS = [
  { rig: 'full', requested: 16 },
  { rig: 'full', requested: 48 },
  { rig: 'light', requested: 16 },
  { rig: 'light', requested: 120 },
];
// The crowds the bar applies to: the caps the budget allows (48 full, 120 light).
const CAPPED = CONFIGS.filter((c) => c.requested === (c.rig === 'full' ? 48 : 120));
const BAR = { sleepWithinSeconds: WARM_SECONDS, poseRmsMm: 10, poseMaxMm: 25, impactMetres: 0.02 };
const REPEATS = 3;

const round = (x) => Math.round(x * 100) / 100;

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
  const ids = new BigUint64Array(accepted);
  for (let i = 0; i < accepted; i++) ids[i] = 1000n + BigInt(i);
  if (accepted > 0) {
    w.addRagdolls(ids, rig === 'full' ? RagdollRig.Full : RagdollRig.Light, grid(accepted));
  }
  return { w, accepted, ids };
}

// One crowd: warm up for 20 s (every step timed, for the settle cost), then time 2 s and
// average each rig's root over those 2 s (for the pose). The roots are read outside the
// timed step, so reading them does not count toward the step time.
function runOnce({ rig, requested, threshold }) {
  const { w, accepted, ids } = build(rig, requested, threshold);
  try {
    const dt = 1 / TICK_HZ;
    const awakeEachSecond = [];
    const warmMs = [];
    let timeToAsleepS = null;
    for (let sec = 1; sec <= WARM_SECONDS; sec++) {
      for (let i = 0; i < TICK_HZ; i++) {
        const t0 = performance.now();
        w.step(dt, SUBSTEPS);
        warmMs.push(performance.now() - t0);
      }
      const awake = w.ragdollActiveBodies();
      awakeEachSecond.push(awake);
      if (timeToAsleepS === null && accepted > 0 && awake === 0) timeToAsleepS = sec;
    }
    const n = 3 * accepted;
    const sum = new Float64Array(n);
    const sumSq = new Float64Array(n);
    const buf = new Float32Array(n);
    const samples = [];
    for (let i = 0; i < MEASURE_STEPS; i++) {
      const t0 = performance.now();
      w.step(dt, SUBSTEPS);
      samples.push(performance.now() - t0);
      if (accepted > 0) {
        w.copyRagdollRoots(ids, buf);
        for (let k = 0; k < n; k++) {
          sum[k] += buf[k];
          sumSq[k] += buf[k] * buf[k];
        }
      }
    }
    const mean = Array.from(sum, (v) => v / MEASURE_STEPS);
    // Jitter: each rig's RMS distance from its own window mean, averaged over the rigs.
    let jitter = 0;
    for (let r = 0; r < accepted; r++) {
      let variance = 0;
      for (let c = 0; c < 3; c++) {
        const k = 3 * r + c;
        variance += sumSq[k] / MEASURE_STEPS - mean[k] * mean[k];
      }
      jitter += Math.sqrt(Math.max(0, variance));
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
      settleCostMs: warmMs.reduce((a, b) => a + b, 0),
      stepMs: median(samples),
      meanStepMs: samples.reduce((a, b) => a + b, 0) / samples.length,
      jitterRmsMm: accepted > 0 ? (1000 * jitter) / accepted : 0,
      rootsMean: mean,
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

// Per-rig distance between two sets of roots (3 floats per rig): RMS and largest, in mm.
function poseError(a, b) {
  const n = Math.min(a.length, b.length) / 3;
  let sq = 0;
  let max = 0;
  for (let r = 0; r < n; r++) {
    const d = Math.hypot(a[3 * r] - b[3 * r], a[3 * r + 1] - b[3 * r + 1], a[3 * r + 2] - b[3 * r + 2]);
    sq += d * d;
    max = Math.max(max, d);
  }
  return { rmsMm: n ? 1000 * Math.sqrt(sq / n) : 0, maxMm: 1000 * max };
}

function runChild(args) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function sweep(repeats) {
  const results = [];
  for (const c of CONFIGS) {
    // Each run is its own process, so the timings are clean. The physics is deterministic
    // per process, so the awake counts and roots match across repeats; only the timings vary.
    const runsByThreshold = new Map();
    for (const threshold of THRESHOLDS) {
      const runs = [];
      for (let r = 0; r < repeats; r++) {
        runs.push(runChild(['--run', '--rig', c.rig, '--requested', String(c.requested), '--threshold', String(threshold)]));
      }
      runsByThreshold.set(threshold, runs);
      const first = runs[0];
      const asleep = first.timeToAsleepS === null ? 'not within 20 s' : `at ${first.timeToAsleepS} s`;
      process.stderr.write(`threshold ${threshold} ${c.rig} ${c.requested}: asleep ${asleep}, settle ${round(median(runs.map((run) => run.settleCostMs)))} ms, step ${round(median(runs.map((run) => run.stepMs)))} ms\n`);
    }
    const reference = runsByThreshold.get(DEFAULT_THRESHOLD)[0];
    for (const threshold of THRESHOLDS) {
      const runs = runsByThreshold.get(threshold);
      const first = runs[0];
      const pose = poseError(first.rootsMean, reference.rootsMean);
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
        settleCostMs: round(median(runs.map((run) => run.settleCostMs))),
        stepMs: round(median(runs.map((run) => run.stepMs))),
        meanStepMs: round(median(runs.map((run) => run.meanStepMs))),
        runsMs: runs.map((run) => round(run.stepMs)),
        poseRmsMm: round(pose.rmsMm),
        poseMaxMm: round(pose.maxMm),
        jitterRmsMm: round(first.jitterRmsMm),
      });
    }
  }
  const wakes = THRESHOLDS.map((threshold) => runChild(['--wake', '--threshold', String(threshold)]));
  return { results, wakes };
}

// Applies the bar, then picks the passing candidate with the lowest settle cost (both
// capped crowds summed). If none passes, the default stays.
function evaluate(results, wakes) {
  const wakeAt = (t) => wakes.find((w) => w.threshold === t);
  const defaultWake = wakeAt(DEFAULT_THRESHOLD);
  const rows = THRESHOLDS.map((threshold) => {
    const crowds = CAPPED.map((c) => results.find((r) => r.threshold === threshold && r.rig === c.rig && r.requested === c.requested));
    const wake = wakeAt(threshold);
    const checks = {
      asleepWithinWarmUp: crowds.every((r) => r.timeToAsleepS !== null && r.timeToAsleepS <= BAR.sleepWithinSeconds),
      poseRmsWithinBar: crowds.every((r) => r.poseRmsMm <= BAR.poseRmsMm),
      poseMaxWithinBar: crowds.every((r) => r.poseMaxMm <= BAR.poseMaxMm),
      hitRigWakes: wake.woke,
      impactWithinBar: Math.abs(wake.movedMetres - defaultWake.movedMetres) <= BAR.impactMetres,
    };
    return {
      threshold,
      checks,
      passes: Object.values(checks).every(Boolean),
      settleCostMs: round(crowds.reduce((sum, r) => sum + r.settleCostMs, 0)),
    };
  });
  const passing = rows.filter((row) => row.passes && row.threshold !== DEFAULT_THRESHOLD);
  const decision = passing.length === 0
    ? { threshold: DEFAULT_THRESHOLD, reason: 'no candidate passes the bar, so the default stays' }
    : {
      threshold: passing.reduce((best, row) => (row.settleCostMs < best.settleCostMs ? row : best)).threshold,
      reason: `lowest settle cost among the ${passing.length} passing threshold(s)`,
    };
  return { rows, decision };
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
  const { rows, decision } = evaluate(results, wakes);
  for (const row of rows) {
    const failed = Object.entries(row.checks).filter(([, ok]) => !ok).map(([name]) => name);
    process.stderr.write(`bar at ${row.threshold}: ${row.passes ? 'passes' : `fails (${failed.join(', ')})`}, settle cost ${row.settleCostMs} ms\n`);
  }
  process.stderr.write(`decision: ${decision.threshold} m/s (${decision.reason})\n`);
  const doc = {
    tickHz: TICK_HZ,
    substeps: SUBSTEPS,
    scenario: 'resting: 0.9 m grid, sleep on, 20 s warm-up (every step timed), then 2 s timed with each rig\'s root averaged; wake check: 16 light rigs settled 20 s, a 5 kg sphere dropped 2 m onto the middle rig',
    defaultThreshold: DEFAULT_THRESHOLD,
    repeats,
    bar: BAR,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
    },
    results,
    wakes,
    evaluation: rows,
    decision,
  };
  if (quick) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), RESULTS)}\n`);
}

main(process.argv.slice(2));
