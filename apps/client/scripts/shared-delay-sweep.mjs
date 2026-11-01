// Tunes the render delay for shared bodies. A server moves a body at 30 Hz;
// snapshots reach the client over a lossy link with latency, jitter and drops.
// For each delay, render at 60 fps, draw the body through SnapshotInterpolator
// and report: the position error against the true path at the drawn time, the
// largest single-frame jump, and how often the drawn body has to hold (no
// snapshot yet covers the drawn time, so it stalls).
//
// Usage: node scripts/shared-delay-sweep.mjs [--out file.json]   (run after npm run build:lib)
import { SnapshotInterpolator } from "../dist/src/physics/snapshot-interpolator.js";
import { writeFileSync } from "node:fs";

const TICK_HZ = 30, TICK = 1 / TICK_HZ;
const FRAME = 1 / 60, SECONDS = 60, LATENCY = 0.05; // the client's known one-way latency
const DELAYS = [0.05, 0.1, 0.15];
const JITTERS = [0.0, 0.05, 0.1]; // seconds of uniform jitter on arrival
const DROP = 0.05;

// True path: a loop with turns, so speed and direction change.
const truth = (t) => ({ x: 4 * Math.cos(0.7 * t), y: 0.5 * Math.sin(1.3 * t), z: 3 * Math.sin(0.7 * t) });
const quat = (t) => { const a = 0.9 * t, h = a / 2; return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }; };

// Seeded PRNG so every delay sees the same network.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function network(jitter, seed) {
  const r = rng(seed);
  const arrivals = [];
  const ticks = Math.round(SECONDS * TICK_HZ);
  for (let k = 0; k <= ticks; k++) {
    if (r() < DROP) continue;
    arrivals.push({ at: k * TICK + LATENCY + r() * jitter, tick: k });
  }
  arrivals.sort((a, b) => a.at - b.at);
  return arrivals;
}

function run(delay, jitter, seed) {
  const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: delay, capacity: 64 });
  const arrivals = network(jitter, seed);
  let next = 0;
  let errSum = 0, errMax = 0, n = 0, stalls = 0, maxStep = 0, prev = null;
  for (let f = 0; f * FRAME < SECONDS; f++) {
    const now = f * FRAME; // client clock; the server clock is now - LATENCY
    const serverNow = now - LATENCY;
    while (next < arrivals.length && arrivals[next].at <= now) {
      const k = arrivals[next++].tick;
      si.push({ tick: k, pos: truth(k * TICK), quat: quat(k * TICK) });
    }
    if (si.size === 0) continue;
    const target = serverNow - delay;
    const pose = si.sample(serverNow);
    if (!pose) continue;
    const want = truth(target);
    const e = Math.hypot(pose.pos.x - want.x, pose.pos.y - want.y, pose.pos.z - want.z);
    errSum += e; errMax = Math.max(errMax, e); n++;
    if (prev) maxStep = Math.max(maxStep, Math.hypot(pose.pos.x - prev.x, pose.pos.y - prev.y, pose.pos.z - prev.z));
    prev = pose.pos;
    // A stall: the drawn time is past the newest snapshot, so the body holds.
    if (target >= (arrivals.slice(0, next).reduce((m, a) => Math.max(m, a.tick), 0)) * TICK) stalls++;
  }
  return { meanErrCm: (100 * errSum) / n, p99ErrCm: 100 * errMax, maxStepCm: 100 * maxStep, stallPct: (100 * stalls) / n };
}

const results = [];
for (const delay of DELAYS) for (const jitter of JITTERS) {
  const runs = [1, 2, 3].map((seed) => run(delay, jitter, seed));
  const med = (k) => [...runs.map((r) => r[k])].sort((a, b) => a - b)[1];
  const row = { delaySeconds: delay, jitterSeconds: jitter, meanErrCm: med("meanErrCm"), maxErrCm: med("p99ErrCm"), maxStepCm: med("maxStepCm"), stallPct: med("stallPct") };
  results.push(row);
  console.log(`delay ${delay.toFixed(2)} s  jitter ${(jitter * 1000).toFixed(0).padStart(3)} ms  err ${row.meanErrCm.toFixed(2)} cm (max ${row.maxErrCm.toFixed(1)})  step ${row.maxStepCm.toFixed(2)} cm  stall ${row.stallPct.toFixed(2)}%`);
}
const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify({ tickHz: TICK_HZ, latency: LATENCY, drop: DROP, seconds: SECONDS, results }, null, 2));
