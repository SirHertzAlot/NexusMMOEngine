#!/usr/bin/env node
/**
 * Sweep for the local-player walker prediction: how the visual error and the
 * correction lag depend on the snapshot rate and the visual blend time.
 *
 * The server is the same Rapier world as the client, plus server-only
 * knockbacks (a 0.5 m shove every 4 s) that the client does not predict. The
 * client sends its inputs with no latency, and snapshots arrive 100 ms late.
 * Needs a build first (npm run build:lib). Output: a table on stdout.
 */
import { createRapierPhysicsWorld } from "../dist/src/physics/index.js";
import { WalkerPredictor } from "../dist/src/physics/walker-prediction.js";

const DT = 1 / 60;
const TICKS = 60 * 12;
const LATENCY_TICKS = 6; // 100 ms
const RADIUS = 0.4, HALF = 0.5, SPEED = 4, CIRCLE = 10;
const START = { x: CIRCLE, y: RADIUS + HALF, z: 0 };
const W = SPEED / CIRCLE;
const KNOCK_EVERY = 240;
const KNOCK = { x: 0.5, y: 0, z: 0 };
const knockAt = (k) => (k > 0 && k % KNOCK_EVERY === 7 ? KNOCK : { x: 0, y: 0, z: 0 });
const truth = (k) => ({ x: CIRCLE * Math.cos(W * k * DT), y: START.y, z: CIRCLE * Math.sin(W * k * DT) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

async function world() {
  const w = await createRapierPhysicsWorld();
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 60, y: 0.5, z: 60 });
  return w;
}

async function run(rateHz, blendSeconds) {
  const server = await world();
  const client = await world();
  const sw = server.spawnWalker(START, RADIUS, HALF);
  const cw = client.spawnWalker(START, RADIUS, HALF);
  const pred = new WalkerPredictor(client, cw, DT, { blendSeconds, snapMetres: 1 }, START);
  const every = Math.round(60 / rateHz);
  const serverPos = [START];
  const errs = [];
  const pops = [];
  let prevVisual = START;
  for (let k = 1; k <= TICKS; k++) {
    const a = truth(k - 1), b = truth(k);
    const input = { x: b.x - a.x, y: 0, z: b.z - a.z };
    const k2 = knockAt(k);
    const st = server.moveWalker(sw, { x: input.x + k2.x, y: 0, z: input.z + k2.z });
    server.step(DT);
    serverPos[k] = { x: st.x, y: st.y, z: st.z };
    pred.step(input);
    const j = k - LATENCY_TICKS;
    if (j >= 0 && j % every === 0) pred.onSnapshot({ tick: j, pos: serverPos[j] });
    errs[k] = dist(pred.visual, serverPos[k]);
    // Pop: the drawn step differs from the walker's own step (its speed is the reference).
    const drawnStep = { x: pred.visual.x - prevVisual.x, y: pred.visual.y - prevVisual.y, z: pred.visual.z - prevVisual.z };
    pops[k] = dist(drawnStep, input);
    prevVisual = pred.visual;
    pred.decay(DT);
  }
  server.dispose();
  client.dispose();
  const mean = errs.slice(60).reduce((s, v) => s + v, 0) / (errs.length - 60);
  let peak = 0, lagSum = 0, lagN = 0;
  for (let k = KNOCK_EVERY + 7; k + 60 < TICKS; k += KNOCK_EVERY) {
    let p = 0;
    for (let i = k; i < k + 60; i++) p = Math.max(p, errs[i]);
    peak = Math.max(peak, p);
    let lag = 0;
    while (k + lag < TICKS && errs[k + lag] >= 0.05) lag++;
    lagSum += lag; lagN++;
  }
  const popMax = Math.max(...pops.slice(60));
  return { rateHz, blendSeconds, meanErrM: mean, peakErrM: peak, lagMs: (lagSum / lagN) * DT * 1000, popMax };
}

const rates = [10, 20, 30, 60];
const blends = [0.02, 0.05, 0.1, 0.2, 0.3];
const rows = [];
for (const rate of rates) for (const blend of blends) rows.push(await run(rate, blend));
console.log("rate Hz | blend s | mean err m | peak err m (1 s after knock) | correction lag ms | max drawn step error m");
for (const r of rows) {
  console.log(`${String(r.rateHz).padStart(7)} | ${r.blendSeconds.toFixed(2).padStart(7)} | ${r.meanErrM.toFixed(4).padStart(10)} | ${r.peakErrM.toFixed(4).padStart(28)} | ${r.lagMs.toFixed(0).padStart(17)} | ${r.popMax.toFixed(4).padStart(10)}`);
}
