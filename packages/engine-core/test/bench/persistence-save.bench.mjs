/**
 * Persistence benchmark: what a world save costs the tick, and what a
 * cold start pays to load it back.
 *
 *   node packages/engine-core/test/bench/persistence-save.bench.mjs [N ...]
 *   (from the repo root, after building @mmo-engine/engine-core)
 *
 * For each entity count N: a world of N entities (movers with physics and
 * animation on one in ten), saved every "tick" through SnapshotStore into a
 * scratch SQLite file. Reports the end-to-end save latency (collect, encode,
 * insert, prune: SaveResult.ms) p50 / p99 / max over the saves, the snapshot
 * size, and the time to load the latest snapshot back into a fresh world.
 *
 * The store is a SQLite file in the OS temp dir, removed on exit. Saves run
 * on the tick's thread, so the p99 is what the 33 ms tick budget pays.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addComponent } from "bitecs";
import { Action, AssetRef, BodyConfig, Health, Locomotion, SimWorld, SnapshotStore, Transform, Velocity } from "../../dist/src/index.js";
import { Animation } from "../../dist/src/components.js";

const SAVES = 30;

/** Same shape as the snapshot bench: every entity moves, one in ten carries physics, locomotion, action and animation. */
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
  return sim;
}

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Save phase: the world is built and saved in this process. Returns the save latencies. */
function savePhase(n, dbPath) {
  const store = new SnapshotStore({ dbPath, keepSnapshots: 6, saveEveryTicks: 300 });
  const sim = makeWorld(n);
  const ms = [];
  let last = null;
  for (let i = 0; i < SAVES + 3; i++) {
    Transform.px[0] += 0.01; // the world changes between saves
    const r = store.saveWorld(300 * (i + 1), sim);
    if (i >= 3) ms.push(r.ms); // warm-up saves dropped
    last = r;
  }
  store.close();
  return { p50: quantile(ms, 0.5), p99: quantile(ms, 0.99), max: Math.max(...ms), bytes: last.bytes };
}

/** Load phase: a fresh process restores the latest snapshot into an empty world (restore needs a fresh entity-id space). */
function loadPhase(dbPath) {
  const store = new SnapshotStore({ dbPath, keepSnapshots: 6, saveEveryTicks: 300 });
  const t0 = performance.now();
  store.restoreInto(new SimWorld());
  const loadMs = performance.now() - t0;
  store.close();
  return { loadMs };
}

const child = (env) => {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ...env }, encoding: "utf8" });
  return JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
};

if (process.env.PERSIST_BENCH_PHASE === "save") {
  console.log("RESULT " + JSON.stringify(savePhase(Number(process.env.PERSIST_BENCH_N), process.env.PERSIST_BENCH_DB)));
} else if (process.env.PERSIST_BENCH_PHASE === "load") {
  console.log("RESULT " + JSON.stringify(loadPhase(process.env.PERSIST_BENCH_DB)));
} else {
  const counts = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);
  const sizes = counts.length ? counts : [1000, 5000, 10000];
  const dir = mkdtempSync(join(tmpdir(), "persist-bench-"));
  const rows = [];
  try {
    for (const n of sizes) {
      const dbPath = join(dir, `world-${n}.db`);
      const saved = child({ PERSIST_BENCH_PHASE: "save", PERSIST_BENCH_N: String(n), PERSIST_BENCH_DB: dbPath });
      const loaded = child({ PERSIST_BENCH_PHASE: "load", PERSIST_BENCH_DB: dbPath });
      rows.push({ entities: n, ...saved, ...loaded });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("entities | save p50 ms | save p99 ms | save max ms | snapshot KiB | load ms");
  for (const r of rows) {
    console.log(
      `${String(r.entities).padStart(8)} | ${r.p50.toFixed(2).padStart(11)} | ${r.p99.toFixed(2).padStart(11)} | ` +
        `${r.max.toFixed(2).padStart(11)} | ${(r.bytes / 1024).toFixed(0).padStart(12)} | ${r.loadMs.toFixed(1).padStart(7)}`,
    );
  }
}
