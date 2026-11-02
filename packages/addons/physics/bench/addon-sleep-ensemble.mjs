// Sleep threshold, round 2: settle quality against the default's own spread.
//
// Round 1 (addon-sleep-threshold.mjs) checked each candidate's resting pose against one trajectory
// of the default. A 1 mm change to the start grid moves the default's own settled pose by 263 mm
// RMS (48 full rigs) and 609 mm (120 light rigs), so that check measured chaos, not quality. Its
// pose bar is superseded by this round.
//
// Round 2 runs each crowd from five start grids (the round-1 grid with 1 mm random offsets, seeds
// 1 to 5), for the default and for every candidate, over a 60 s horizon. Per run:
//   cost       physics time over the whole 60 s (every step timed; roots are read outside the timing)
//   height     the crowd's mean root height, from each rig's mean over the final 2 s
//   footprint  the crowd's mean distance from its centre, over the same 2 s
//   awake      bodies awake at 20 s and at 60 s
// Per seed, the wake check settles 16 light rigs for 60 s, drops a 5 kg sphere from 2 m onto the
// middle rig, and records how far that rig moves over the next 2 s and whether it wakes.
//
// The bar, fixed before this round runs. An earlier draft compared each candidate run with the
// range of the default's five runs. An identical candidate would land inside that range only two
// thirds of the time per run, so the draft could not pass anything on its merits. It was replaced
// before any round-2 run.
//   quality  for each crowd and each of height and footprint, the candidate's five-run mean is
//            within 3 standard errors of the default's (Welch: SE = sqrt(varDefault/5 + varCandidate/5)).
//            The z value is reported, so a different cut-off can be applied to the same data.
//   impact   the mean displacement is within 20 mm of the default's, and the hit rig wakes in every seed.
//   sleep    not a pass condition. Time to sleep is part of the cost, since a candidate that sleeps
//            late costs more.
// The passing threshold with the lowest total cost becomes the default. The default is always in
// the running, so a tie keeps it. If no candidate passes, the default stays.
//
// Usage: node bench/addon-sleep-ensemble.mjs
//        (writes docs/addon-sleep-threshold-ensemble-results.json; several minutes)

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
const RESULTS = path.join(here, '..', '..', '..', '..', 'docs', 'addon-sleep-threshold-ensemble-results.json');
const TICK_HZ = 30;
const SUBSTEPS = 2;
const HORIZON_STEPS = 60 * TICK_HZ;
const WARM_STEPS = 20 * TICK_HZ;
const WINDOW_STEPS = 2 * TICK_HZ;
const WAKE_RIGS = 16;
const SEEDS = [1, 2, 3, 4, 5];
const DEFAULT_THRESHOLD = 0.03;
const THRESHOLDS = [DEFAULT_THRESHOLD, 0.05, 0.1, 0.15, 0.2];
const CROWDS = [
  { rig: 'full', requested: 48 },
  { rig: 'light', requested: 120 },
];
const Z_BAR = 3;
const IMPACT_BAR_M = 0.02;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};
const round = (x, digits = 3) => Number(x.toFixed(digits));
const key = (rig, requested, threshold) => `${rig}-${requested}-${threshold}`;

// mulberry32: a small generator, so each seed gives its own offsets.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// The round-1 grid: 0.9 m apart, drop height steps by 0.3 m, with 1 mm random offsets in x and z.
function grid(n, seed) {
  const out = new Float32Array(3 * n);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rnd = rng(seed * 7919 + n);
  for (let i = 0; i < n; i++) {
    out[3 * i] = (i % cols - (cols - 1) / 2) * 0.9 + 0.001 * (2 * rnd() - 1);
    out[3 * i + 1] = 1.2 + 0.3 * (i % 3);
    out[3 * i + 2] = (Math.floor(i / cols) - (cols - 1) / 2) * 0.9 + 0.001 * (2 * rnd() - 1);
  }
  return out;
}

function idList(n) {
  const ids = new BigUint64Array(n);
  for (let i = 0; i < n; i++) ids[i] = 1000n + BigInt(i);
  return ids;
}

// One crowd from one start grid, over the full horizon.
function runCrowd({ rig, requested, threshold, seed }) {
  const w = createWorld();
  try {
    addFloor(w);
    w.setSleepThreshold(threshold);
    const ids = idList(requested);
    w.addRagdolls(ids, rig === 'full' ? RagdollRig.Full : RagdollRig.Light, grid(requested, seed));
    const dt = 1 / TICK_HZ;
    const n = 3 * requested;
    const sum = new Float64Array(n);
    const buf = new Float32Array(n);
    let costMs = 0;
    let warmCostMs = 0;
    let awakeAt20s = 0;
    for (let i = 0; i < HORIZON_STEPS; i++) {
      const t0 = performance.now();
      w.step(dt, SUBSTEPS);
      const ms = performance.now() - t0;
      costMs += ms;
      if (i < WARM_STEPS) warmCostMs += ms;
      if (i === WARM_STEPS - 1) awakeAt20s = w.ragdollActiveBodies();
      if (i >= HORIZON_STEPS - WINDOW_STEPS) {
        w.copyRagdollRoots(ids, buf);
        for (let k = 0; k < n; k++) sum[k] += buf[k];
      }
    }
    const awakeAtEnd = w.ragdollActiveBodies();
    const rigMean = (r) => [sum[3 * r] / WINDOW_STEPS, sum[3 * r + 1] / WINDOW_STEPS, sum[3 * r + 2] / WINDOW_STEPS];
    let cx = 0;
    let cz = 0;
    for (let r = 0; r < requested; r++) {
      const [x, , z] = rigMean(r);
      cx += x;
      cz += z;
    }
    cx /= requested;
    cz /= requested;
    let height = 0;
    let footprint = 0;
    for (let r = 0; r < requested; r++) {
      const [x, y, z] = rigMean(r);
      height += y;
      footprint += Math.hypot(x - cx, z - cz);
    }
    return {
      rig,
      requested,
      threshold,
      seed,
      awakeAt20s,
      awakeAtEnd,
      warmCostMs: round(warmCostMs, 1),
      costMs: round(costMs, 1),
      height: height / requested,
      footprint: footprint / requested,
    };
  } finally {
    w.destroy();
  }
}

// Settle 16 light rigs for 60 s, then drop a 5 kg sphere from 2 m onto the middle rig.
function runWake({ threshold, seed }) {
  const w = createWorld();
  try {
    addFloor(w);
    w.setSleepThreshold(threshold);
    const ids = idList(WAKE_RIGS);
    w.addRagdolls(ids, RagdollRig.Light, grid(WAKE_RIGS, seed));
    const dt = 1 / TICK_HZ;
    for (let i = 0; i < HORIZON_STEPS; i++) w.step(dt, SUBSTEPS);
    const awakeBeforeDrop = w.ragdollActiveBodies();
    const target = new BigUint64Array([ids[Math.floor(WAKE_RIGS / 2)]]);
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
    for (let i = 0; i < WINDOW_STEPS; i++) {
      w.step(dt, SUBSTEPS);
      maxAwake = Math.max(maxAwake, w.ragdollActiveBodies());
    }
    const after = rootNow();
    return {
      threshold,
      seed,
      awakeBeforeDrop,
      woke: maxAwake > 0,
      movedMetres: Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]),
    };
  } finally {
    w.destroy();
  }
}

// Each run is its own process, so the timings are clean.
function runChild(args) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function sweep() {
  const crowdRuns = {};
  for (const c of CROWDS) {
    for (const threshold of THRESHOLDS) {
      const runs = SEEDS.map((seed) => runChild([
        '--crowd', '--rig', c.rig, '--requested', String(c.requested),
        '--threshold', String(threshold), '--seed', String(seed),
      ]));
      crowdRuns[key(c.rig, c.requested, threshold)] = runs;
      process.stderr.write(`${c.rig} ${c.requested} at ${threshold}: height ${runs.map((r) => round(r.height, 4)).join(' ')} m, footprint ${runs.map((r) => round(r.footprint, 4)).join(' ')} m, cost ${round(mean(runs.map((r) => r.costMs)), 0)} ms, awake at 60 s ${runs.map((r) => r.awakeAtEnd).join(' ')}\n`);
    }
  }
  const wakeRuns = {};
  for (const threshold of THRESHOLDS) {
    wakeRuns[threshold] = SEEDS.map((seed) => runChild(['--wake', '--threshold', String(threshold), '--seed', String(seed)]));
    process.stderr.write(`wake at ${threshold}: moved mm ${wakeRuns[threshold].map((r) => round(r.movedMetres * 1000, 1)).join(' ')}, woke in every seed ${wakeRuns[threshold].every((r) => r.woke)}\n`);
  }
  return { crowdRuns, wakeRuns };
}

// Welch-style z: the candidate's five-run mean minus the default's, over its standard error.
function zScore(def, cand) {
  const diff = mean(cand) - mean(def);
  const se = Math.sqrt(variance(def) / def.length + variance(cand) / cand.length);
  if (se === 0) return diff === 0 ? 0 : Math.sign(diff) * Infinity;
  return diff / se;
}

function evaluate(crowdRuns, wakeRuns) {
  const defaultWakeMean = mean(wakeRuns[DEFAULT_THRESHOLD].map((r) => r.movedMetres));
  const rows = THRESHOLDS.map((threshold) => {
    const isDefault = threshold === DEFAULT_THRESHOLD;
    const quality = CROWDS.map((c) => {
      const def = crowdRuns[key(c.rig, c.requested, DEFAULT_THRESHOLD)];
      const cand = crowdRuns[key(c.rig, c.requested, threshold)];
      return {
        rig: c.rig,
        requested: c.requested,
        heightZ: round(zScore(def.map((r) => r.height), cand.map((r) => r.height)), 2),
        footprintZ: round(zScore(def.map((r) => r.footprint), cand.map((r) => r.footprint)), 2),
        meanCostMs: round(mean(cand.map((r) => r.costMs)), 1),
        awakeAt20s: cand.map((r) => r.awakeAt20s),
        awakeAtEnd: cand.map((r) => r.awakeAtEnd),
      };
    });
    const wake = wakeRuns[threshold];
    const movedMean = mean(wake.map((r) => r.movedMetres));
    const impact = {
      meanMm: round(movedMean * 1000, 1),
      defaultMeanMm: round(defaultWakeMean * 1000, 1),
      diffMm: round((movedMean - defaultWakeMean) * 1000, 1),
      withinBar: Math.abs(movedMean - defaultWakeMean) <= IMPACT_BAR_M,
      hitRigWakesEverySeed: wake.every((r) => r.woke),
    };
    const qualityPass = quality.every((q) => Math.abs(q.heightZ) <= Z_BAR && Math.abs(q.footprintZ) <= Z_BAR);
    return {
      threshold,
      quality,
      impact,
      qualityPass,
      totalCostMs: round(quality.reduce((sum, q) => sum + q.meanCostMs, 0), 1),
      passes: isDefault || (qualityPass && impact.withinBar && impact.hitRigWakesEverySeed),
    };
  });
  // rows[0] is the default and always passes, so the list is never empty.
  const passing = rows.filter((row) => row.passes);
  const best = passing.reduce((a, b) => (b.totalCostMs < a.totalCostMs ? b : a));
  const decision = {
    threshold: best.threshold,
    changed: best.threshold !== DEFAULT_THRESHOLD,
    reason: best.threshold === DEFAULT_THRESHOLD
      ? 'no passing candidate is cheaper than the default, so the default stays'
      : `lowest total cost among the ${passing.length} passing thresholds (default included)`,
  };
  return { rows, decision };
}

function main(argv) {
  const get = (flag) => argv[argv.indexOf(flag) + 1];
  if (argv.includes('--crowd')) {
    const out = runCrowd({
      rig: get('--rig'),
      requested: Number(get('--requested')),
      threshold: Number(get('--threshold')),
      seed: Number(get('--seed')),
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (argv.includes('--wake')) {
    process.stdout.write(`${JSON.stringify(runWake({ threshold: Number(get('--threshold')), seed: Number(get('--seed')) }))}\n`);
    return;
  }
  const { crowdRuns, wakeRuns } = sweep();
  const { rows, decision } = evaluate(crowdRuns, wakeRuns);
  for (const row of rows) {
    const q = row.quality.map((c) => `${c.rig} ${c.requested}: z height ${c.heightZ}, footprint ${c.footprintZ}`).join('; ');
    process.stderr.write(`candidate ${row.threshold}: ${row.passes ? 'passes' : 'fails'} (${q}; impact ${row.impact.diffMm} mm; wakes in every seed ${row.impact.hitRigWakesEverySeed}), total cost ${row.totalCostMs} ms\n`);
  }
  process.stderr.write(`decision: ${decision.threshold} m/s (${decision.reason})\n`);
  const doc = {
    tickHz: TICK_HZ,
    substeps: SUBSTEPS,
    horizonSeconds: HORIZON_STEPS / TICK_HZ,
    windowSeconds: WINDOW_STEPS / TICK_HZ,
    seeds: SEEDS,
    scenario: 'five start grids per crowd (round-1 grid, 1 mm random offsets); 60 s horizon; height and footprint over the final 2 s; wake check on 16 light rigs settled 60 s, then a 5 kg sphere dropped 2 m onto the middle rig',
    defaultThreshold: DEFAULT_THRESHOLD,
    bar: { zMax: Z_BAR, impactMetres: IMPACT_BAR_M, hitRigWakesEverySeed: true, sleepIsPassCondition: false },
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
    },
    crowdRuns,
    wakeRuns,
    evaluation: rows,
    decision,
  };
  writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), RESULTS)}\n`);
}

main(process.argv.slice(2));
