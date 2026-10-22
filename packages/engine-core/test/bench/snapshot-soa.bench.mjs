/**
 * Phase 3 benchmark gate: SoA wire encoding (direct from SAB-backed
 * stores) vs the old collect + row-encode path. Same world state, same
 * bytes — the only difference is the intermediate row-object copy.
 *
 * Run: node packages/engine-core/test/bench/snapshot-soa.bench.mjs
 * (from the repo root, after building @mmo-engine/engine-core).
 */
import { addComponent, defineQuery } from "bitecs";
import {
  Action,
  AssetRef,
  BodyConfig,
  Chunk,
  collectDeltaState,
  collectFullState,
  DeltaTracker,
  encodeDelta,
  encodeDeltaFromSim,
  encodeSnapshot,
  encodeSnapshotFromSim,
  Health,
  Locomotion,
  SimWorld,
  Transform,
  Velocity,
} from "../../dist/src/index.js";
import { Animation } from "../../dist/src/components.js";

/** World with N entities: all move (Transform+Velocity+Health), 10% carry the rest. */
function makeWorld(n) {
  const sim = new SimWorld();
  for (let i = 0; i < n; i++) {
    const e = sim.spawn();
    for (const c of [Transform, Velocity, Health]) addComponent(sim.ecs, c, e);
    Transform.px[e] = i * 0.5; Transform.py[e] = (i % 97) - 48; Transform.pz[e] = i * 0.25;
    Transform.qx[e] = 0; Transform.qy[e] = 0; Transform.qz[e] = 0; Transform.qw[e] = 1;
    Transform.sx[e] = 1; Transform.sy[e] = 1; Transform.sz[e] = 1;
    Velocity.lx[e] = 0.1; Velocity.ly[e] = 0; Velocity.lz[e] = -0.1;
    Velocity.ax[e] = 0; Velocity.ay[e] = 0.01; Velocity.az[e] = 0;
    Health.current[e] = 100 - (i % 30); Health.max[e] = 100;
    if (i % 10 === 0) {
      for (const c of [BodyConfig, AssetRef, Locomotion, Action, Animation]) addComponent(sim.ecs, c, e);
      BodyConfig.shapeKind[e] = 1; BodyConfig.halfX[e] = 0.5; BodyConfig.halfY[e] = 1;
      BodyConfig.halfZ[e] = 0.5; BodyConfig.radius[e] = 0.25; BodyConfig.mass[e] = 80;
      BodyConfig.motionType[e] = 2; BodyConfig.layer[e] = 3;
      BodyConfig.friction[e] = 0.8; BodyConfig.restitution[e] = 0.1;
      AssetRef.assetHash[e] = 0xdeadbeef; AssetRef.variant[e] = 3;
      Locomotion.mode[e] = 1; Locomotion.abilities[e] = 3; Locomotion.breath[e] = 0.75;
      Action.move[e] = 4; Action.started[e] = 99; Action.seq[e] = 2; Action.yaw[e] = 1.57;
      Animation.clipId[e] = 7; Animation.startTick[e] = 5;
      Animation.rate[e] = 1.25; Animation.layerMask[e] = 3;
    }
  }
  // A couple of chunks (cold path, heights off).
  for (let i = 0; i < 2; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Chunk, e);
    Chunk.chunkIdHi[e] = 0x12345678; Chunk.chunkIdLo[e] = 0x9abcdef0;
    Chunk.seedHi[e] = 0xfedcba98; Chunk.seedLo[e] = 0x76543210;
    Chunk.lod[e] = 3;
  }
  return sim;
}

function bytesEqual(a, b) {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

const fmt = (x) => x.toFixed(3);

for (const N of [2000, 10000]) {
  const sim = makeWorld(N);
  // Byte-equality guard: the two paths must emit identical wire bytes.
  const snapOld = encodeSnapshot(collectFullState(sim, 1));
  const snapNew = encodeSnapshotFromSim(sim, 1);
  if (!bytesEqual(snapOld, snapNew)) {
    console.error(`N=${N}: SNAPSHOT BYTES DIFFER (${snapOld.length} vs ${snapNew.length})`);
    process.exit(1);
  }

  const WARM = 20, ITERS = 200;
  for (let i = 0; i < WARM; i++) { encodeSnapshot(collectFullState(sim, 1)); encodeSnapshotFromSim(sim, 1); }
  // Paired + order-alternating samples: both paths encode the same state
  // back-to-back, so GC/thermal drift hits both equally instead of
  // biasing whichever path ran second.
  const snapOldSamples = [], snapNewSamples = [];
  for (let i = 0; i < ITERS; i++) {
    const timed = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
    if (i % 2 === 0) {
      snapOldSamples.push(timed(() => encodeSnapshot(collectFullState(sim, 1))));
      snapNewSamples.push(timed(() => encodeSnapshotFromSim(sim, 1)));
    } else {
      snapNewSamples.push(timed(() => encodeSnapshotFromSim(sim, 1)));
      snapOldSamples.push(timed(() => encodeSnapshot(collectFullState(sim, 1))));
    }
  }
  const stat = (s) => {
    s.sort((a, b) => a - b);
    return { mean: s.reduce((x, y) => x + y, 0) / s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)] };
  };
  const snapOldT = stat(snapOldSamples), snapNewT = stat(snapNewSamples);

  // Delta: every entity moves every tick (worst case, like B4).
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  const q = defineQuery([Transform]);
  for (let i = 0; i < WARM; i++) {
    for (const e of q(sim.ecs)) Transform.px[e] += 0.01;
    encodeDelta(collectDeltaState(sim, 2, 1, tracker));
    encodeDeltaFromSim(sim, 2, 1, tracker);
    tracker.commit(sim);
    sim.endTick();
  }
  const deltaOldSamples = [], deltaNewSamples = [];
  for (let i = 0; i < ITERS; i++) {
    for (const e of q(sim.ecs)) Transform.px[e] += 0.01;
    const t0 = performance.now();
    const dOld = encodeDelta(collectDeltaState(sim, 2, 1, tracker));
    deltaOldSamples.push(performance.now() - t0);
    const t1 = performance.now();
    const dNew = encodeDeltaFromSim(sim, 2, 1, tracker);
    deltaNewSamples.push(performance.now() - t1);
    if (!bytesEqual(dOld, dNew)) {
      console.error(`N=${N}: DELTA BYTES DIFFER (iter ${i})`);
      process.exit(1);
    }
    tracker.commit(sim);
    sim.endTick();
  }
  const dOld = stat(deltaOldSamples), dNew = stat(deltaNewSamples);
  const snapGain = ((snapOldT.mean - snapNewT.mean) / snapOldT.mean) * 100;
  const deltaGain = ((dOld.mean - dNew.mean) / dOld.mean) * 100;
  console.log(`\nN=${N} entities (snapshot ${snapOld.length} bytes)`);
  console.log(`  snapshot old (collect+encode): mean ${fmt(snapOldT.mean)} ms  p50 ${fmt(snapOldT.p50)}  p95 ${fmt(snapOldT.p95)}  (${fmt(1000 / snapOldT.mean)} enc/s)`);
  console.log(`  snapshot new (SoA direct):     mean ${fmt(snapNewT.mean)} ms  p50 ${fmt(snapNewT.p50)}  p95 ${fmt(snapNewT.p95)}  (${fmt(1000 / snapNewT.mean)} enc/s)  Δ ${snapGain >= 0 ? "-" : "+"}${fmt(Math.abs(snapGain))}% time`);
  console.log(`  delta old (collect+encode):    mean ${fmt(dOld.mean)} ms  p50 ${fmt(dOld.p50)}  p95 ${fmt(dOld.p95)}  (${fmt(1000 / dOld.mean)} enc/s)`);
  console.log(`  delta new (SoA direct):        mean ${fmt(dNew.mean)} ms  p50 ${fmt(dNew.p50)}  p95 ${fmt(dNew.p95)}  (${fmt(1000 / dNew.mean)} enc/s)  Δ ${deltaGain >= 0 ? "-" : "+"}${fmt(Math.abs(deltaGain))}% time`);
}
console.log("\nByte equality: PASS (snapshot + delta, all N). Benchmark gate: improvement or neutral required.");
