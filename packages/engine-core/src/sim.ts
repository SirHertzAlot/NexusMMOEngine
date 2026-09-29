/**
 * Headless benchmark: 1000 entities x 300 ticks (slice 1.2).
 *
 * Drives a SimWorld through the TickLoop with synthetic timestamps
 * (exactly one STEP_MS per frame — the accumulator path, without
 * waiting on the wall clock), runs the intent + integrate systems,
 * builds a changed-only delta per tick, and writes parseable artifacts:
 *   sim-artifacts/snapshot-0.bin    full snapshot, tick 0
 *   sim-artifacts/snapshot-300.bin  full snapshot, tick 300
 *   sim-artifacts/deltas.bin        u32-LE length-prefixed delta stream
 *
 * Then verifies, from disk:
 * 1. snapshot-0 round-trips through disk identically,
 * 2. snapshot-300 matches live state exactly (full compare),
 * 3. applying the 300 deltas onto snapshot-0 EXACTLY reproduces
 *    snapshot-300 (the multiplayer replication invariant).
 *
 * Reports mean/p95/max tick time and headroom against the 33.333 ms
 * budget, split into systems vs delta-encode costs.
 *
 * Deterministic: all randomness comes from a seeded PRNG, so artifacts
 * are reproducible run to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { addComponent } from "bitecs";
import * as C from "./components.js";
import { splitU64 } from "./components.js";
import {
  applyDelta,
  compareStates,
  stateFromCollected,
} from "./delta-apply.js";
import {
  collectDeltaState,
  collectFullState,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
} from "./snapshot.js";
import { PLAYER_SPEED, IntentSystem, IntegrateSystem, type SimSystem } from "./systems.js";
import { STEP_MS, TickLoop } from "./tick-loop.js";
import { SimWorld, type QueuedIntent } from "./world.js";

const ENTITY_COUNT = 1000;
const TICK_COUNT = 300;
const N_MOVERS = 600;
const N_PLAYERS = 300;
const N_PROPS = ENTITY_COUNT - N_MOVERS - N_PLAYERS; // 100

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnMover(sim: SimWorld, prng: () => number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, C.Transform, eid);
  addComponent(sim.ecs, C.Velocity, eid);
  const T = C.Transform;
  const V = C.Velocity;
  T.px[eid] = (prng() - 0.5) * 100;
  T.py[eid] = (prng() - 0.5) * 100;
  T.pz[eid] = (prng() - 0.5) * 100;
  T.qw[eid] = 1;
  T.sx[eid] = 1; T.sy[eid] = 1; T.sz[eid] = 1;
  V.lx[eid] = (prng() - 0.5) * 4;
  V.ly[eid] = (prng() - 0.5) * 4;
  V.lz[eid] = (prng() - 0.5) * 4;
  return eid;
}

function spawnPlayer(sim: SimWorld, prng: () => number): number {
  const eid = spawnMover(sim, prng);
  addComponent(sim.ecs, C.PlayerIntent, eid);
  addComponent(sim.ecs, C.Health, eid);
  C.Health.current[eid] = 100;
  C.Health.max[eid] = 100;
  return eid;
}

function spawnProp(sim: SimWorld, prng: () => number, index: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, C.Transform, eid);
  addComponent(sim.ecs, C.Health, eid);
  addComponent(sim.ecs, C.Chunk, eid);
  const T = C.Transform;
  T.px[eid] = (prng() - 0.5) * 200;
  T.py[eid] = 0;
  T.pz[eid] = (prng() - 0.5) * 200;
  T.qw[eid] = 1;
  T.sx[eid] = 1; T.sy[eid] = 1; T.sz[eid] = 1;
  C.Health.current[eid] = 50;
  C.Health.max[eid] = 50;
  const id = splitU64(BigInt(index));
  const seed = splitU64(0x9e3779b97f4a7c15n ^ BigInt(index));
  C.Chunk.chunkIdHi[eid] = id.hi;
  C.Chunk.chunkIdLo[eid] = id.lo;
  C.Chunk.seedHi[eid] = seed.hi;
  C.Chunk.seedLo[eid] = seed.lo;
  C.Chunk.lod[eid] = index % 4;
  return eid;
}

interface TickTiming {
  systemsMs: number;
  deltaMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, "..", "sim-artifacts");
  fs.mkdirSync(outDir, { recursive: true });

  const prng = mulberry32(1337);
  const sim = new SimWorld();
  const systems: SimSystem[] = [new IntentSystem(), new IntegrateSystem()];
  const tracker = new DeltaTracker();

  // --- spawn the world -------------------------------------------------
  const players: number[] = [];
  const props: number[] = [];
  const playerPhase: number[] = [];
  for (let i = 0; i < N_MOVERS; i++) spawnMover(sim, prng);
  for (let i = 0; i < N_PLAYERS; i++) {
    players.push(spawnPlayer(sim, prng));
    playerPhase.push(prng() * Math.PI * 2);
  }
  for (let i = 0; i < N_PROPS; i++) props.push(spawnProp(sim, prng, i));

  const timings: TickTiming[] = [];
  const deltaChunks: Buffer[] = [];

  const randomizeIntents = (tick: number): void => {
    for (let i = 0; i < players.length; i++) {
      const a = playerPhase[i] + tick * 0.07;
      const intent: QueuedIntent = {
        mx: Math.cos(a),
        my: 0,
        mz: Math.sin(a),
        lookYaw: a,
        lookPitch: 0,
        jump: tick % 90 === 0,
        buttons: tick % 60 < 30 ? 1 : 0,
      };
      sim.queueIntent(players[i], intent);
    }
  };

  // Mid-run churn: despawn 10 props, spawn 10 movers. Freed slots are
  // recycled eagerly, so this exercises the generation bump on slot
  // reuse inside the delta stream.
  const churned = { done: false };
  const churn = (): void => {
    for (let i = 0; i < 10; i++) sim.despawn(props[i]);
    for (let i = 0; i < 10; i++) spawnMover(sim, prng);
    churned.done = true;
  };

  const doTick = (tick: number): void => {
    const t0 = performance.now();
    sim.beginTick(tick);
    randomizeIntents(tick);
    if (tick === 150 && !churned.done) churn();
    const dt = STEP_MS / 1000;
    for (const s of systems) s.step(sim, dt);
    sim.emitTick(tick);
    const t1 = performance.now();

    const deltaState = collectDeltaState(sim, tick, tick - 1, tracker);
    const deltaBytes = encodeDelta(deltaState);
    tracker.commit(sim);
    sim.endTick();
    const t2 = performance.now();

    timings.push({ systemsMs: t1 - t0, deltaMs: t2 - t1 });
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32LE(deltaBytes.length, 0);
    deltaChunks.push(len, Buffer.from(deltaBytes));
  };

  // --- snapshot 0 ------------------------------------------------------
  const snap0Bytes = encodeSnapshot(collectFullState(sim, 0));
  const snap0State = stateFromCollected(decodeSnapshot(snap0Bytes));
  fs.writeFileSync(path.join(outDir, "snapshot-0.bin"), snap0Bytes);
  tracker.commit(sim);
  sim.endTick();

  // --- run 300 ticks through the fixed-timestep loop -------------------
  const loop = new TickLoop((i) => doTick(i + 1));
  loop.frame(0); // arm the clock
  for (let f = 1; f <= TICK_COUNT; f++) loop.frame(f * STEP_MS);

  // --- snapshot 300 ----------------------------------------------------
  const snap300Bytes = encodeSnapshot(collectFullState(sim, TICK_COUNT));
  fs.writeFileSync(path.join(outDir, "snapshot-300.bin"), snap300Bytes);
  fs.writeFileSync(path.join(outDir, "deltas.bin"), Buffer.concat(deltaChunks));

  // --- verify from disk ------------------------------------------------
  const readSnap0 = decodeSnapshot(
    new Uint8Array(fs.readFileSync(path.join(outDir, "snapshot-0.bin"))),
  );
  const snap0DiskCheck = compareStates(snap0State, stateFromCollected(readSnap0));

  const liveState = stateFromCollected(collectFullState(sim, TICK_COUNT));
  const snap300Disk = stateFromCollected(
    decodeSnapshot(new Uint8Array(fs.readFileSync(path.join(outDir, "snapshot-300.bin")))),
  );
  const finalCheck = compareStates(liveState, snap300Disk);

  // Delta chain: snapshot-0 + deltas 1..300 must exactly equal snapshot-300.
  const stream = fs.readFileSync(path.join(outDir, "deltas.bin"));
  const chained = stateFromCollected(readSnap0);
  let off = 0;
  let deltaCount = 0;
  while (off < stream.length) {
    const len = stream.readUInt32LE(off);
    off += 4;
    const bytes = new Uint8Array(stream.buffer, stream.byteOffset + off, len);
    off += len;
    applyDelta(chained, decodeDelta(bytes));
    deltaCount += 1;
  }
  const chainCheck = compareStates(chained, snap300Disk);

  // --- report ----------------------------------------------------------
  const totals = timings.map((t) => t.systemsMs + t.deltaMs).sort((a, b) => a - b);
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const p95 = percentile(totals, 95);
  const max = totals[totals.length - 1];
  const budget = STEP_MS;
  const sysMean = timings.reduce((a, t) => a + t.systemsMs, 0) / timings.length;
  const deltaMean = timings.reduce((a, t) => a + t.deltaMs, 0) / timings.length;
  const loopStats = loop.stats();

  const ok = (c: { equal: boolean; diffs: string[] }): string =>
    c.equal ? "PASS" : `FAIL (${c.diffs.slice(0, 3).join("; ")})`;

  console.log(`sim: ${ENTITY_COUNT} entities x ${TICK_COUNT} ticks @ ${STEP_MS.toFixed(3)} ms`);
  console.log(`tick time  mean ${mean.toFixed(3)} ms | p95 ${p95.toFixed(3)} ms | max ${max.toFixed(3)} ms`);
  console.log(`  systems mean ${sysMean.toFixed(3)} ms | delta encode+commit mean ${deltaMean.toFixed(3)} ms`);
  console.log(`headroom vs ${budget.toFixed(3)} ms budget: mean ${(100 * (budget - mean) / budget).toFixed(1)}% | p95 ${(100 * (budget - p95) / budget).toFixed(1)}%`);
  console.log(`tick loop: ${loopStats.ticks} ticks, ${loopStats.spiralEvents} spiral events`);
  console.log(`artifacts: snapshot-0 ${snap0Bytes.length} B, snapshot-300 ${snap300Bytes.length} B, deltas stream ${stream.length} B (${deltaCount} deltas)`);
  console.log(`player speed constant: ${PLAYER_SPEED} u/s (intent system)`);
  console.log("verify:");
  console.log(`  snapshot-0 disk round-trip ......... ${ok(snap0DiskCheck)}`);
  console.log(`  snapshot-300 vs live state ........ ${ok(finalCheck)}`);
  console.log(`  delta chain 0 + 1..300 == snap-300  ${ok(chainCheck)}`);

  if (!snap0DiskCheck.equal || !finalCheck.equal || !chainCheck.equal) {
    console.error("VERIFICATION FAILED");
    process.exitCode = 1;
  }
}

main();
