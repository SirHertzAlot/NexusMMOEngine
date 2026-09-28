/**
 * Reboot-test fixture child (slice 1.4). NOT a test file — it is spawned
 * by reboot.test.ts. Modes:
 *
 *   run <dbPath> <dir>         Tick a deterministic world until SIGTERM;
 *                              saves every 300 ticks AND via the shutdown
 *                              hook, then exits 0.
 *   boot <dbPath> <dir>        Restore the latest snapshot, write
 *                              after.json/after.bin (restored state), tick
 *                              10 more, write continued.json/continued.bin.
 *                              Exits 2 when no snapshot exists.
 *   reference <dir> <tickCap>  Fresh world ticked 0..tickCap with no DB;
 *                              writes reference.json/reference.bin.
 *
 * All modes share buildWorld() and doTick() so that "restore, then tick
 * 10" is bit-identical to an uninterrupted run to the same tick.
 */

import { addComponent, defineQuery } from "bitecs";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SimWorld,
  SnapshotStore,
  installShutdownHook,
  Transform,
  Velocity,
  PlayerIntent,
  Chunk,
  Health,
  IntentSystem,
  IntegrateSystem,
  collectFullState,
  encodeSnapshot,
  type SimSystem,
} from "../../src/index.js";

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

const playerQuery = defineQuery([PlayerIntent]);
const systems: SimSystem[] = [new IntentSystem(), new IntegrateSystem()];

/** 1000 entities shaped like the slice-1.2 sim driver. */
function buildWorld(): { sim: SimWorld; players: number[] } {
  const prng = mulberry32(1337);
  const sim = new SimWorld();
  for (let i = 0; i < 600; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    Transform.px[e] = prng() * 100;
    Transform.py[e] = prng() * 100;
    Transform.pz[e] = prng() * 100;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Velocity.lx[e] = (prng() - 0.5) * 4;
    Velocity.ly[e] = (prng() - 0.5) * 4;
    Velocity.lz[e] = (prng() - 0.5) * 4;
  }
  for (let i = 0; i < 300; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    addComponent(sim.ecs, PlayerIntent, e);
    addComponent(sim.ecs, Health, e);
    Transform.px[e] = prng() * 100;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Health.current[e] = 100;
    Health.max[e] = 100;
  }
  for (let i = 0; i < 100; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Health, e);
    addComponent(sim.ecs, Chunk, e);
    Transform.px[e] = prng() * 200;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Health.current[e] = 50;
    Health.max[e] = 50;
    Chunk.lod[e] = i % 4;
  }
  return { sim, players: [...playerQuery(sim.ecs)] };
}

/**
 * Intents are a pure function of (tick, player index) — no PRNG state,
 * so every child mode computes identical intents for identical ticks.
 */
function driveIntents(sim: SimWorld, players: number[], tick: number): void {
  for (let k = 0; k < players.length; k++) {
    sim.queueIntent(players[k], {
      mx: Math.sin(tick * 0.05 + k) > 0 ? 1 : -1,
      my: 0,
      mz: 0,
      lookYaw: 0,
      lookPitch: 0,
      jump: false,
      buttons: 0,
    });
  }
}

/** One tick, mirroring the slice-1.2 sim driver ordering. */
function doTick(sim: SimWorld, players: number[], tick: number): void {
  sim.beginTick(); // drain the previous tick's queued intents
  driveIntents(sim, players, tick);
  if (tick === 150) {
    // Deterministic churn: despawn 20 movers, respawn 20 (fixed values,
    // no PRNG — identical in every mode).
    for (let i = 0; i < 20; i++) sim.despawn(i);
    for (let i = 0; i < 20; i++) {
      const e = sim.spawn();
      addComponent(sim.ecs, Transform, e);
      addComponent(sim.ecs, Velocity, e);
      Transform.px[e] = i;
      Transform.qw[e] = 1;
      Transform.sx[e] = 1;
      Transform.sy[e] = 1;
      Transform.sz[e] = 1;
    }
  }
  const dt = 1 / 30;
  for (const s of systems) s.step(sim, dt);
  sim.endTick();
}

function writeState(
  dir: string,
  name: string,
  sim: SimWorld,
  tick: number,
): void {
  const state = collectFullState(sim, tick);
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ tick, entityCount: state.transforms.length }),
  );
  fs.writeFileSync(
    path.join(dir, `${name}.bin`),
    Buffer.from(encodeSnapshot(state)),
  );
}

async function runMode(dbPath: string, dir: string): Promise<void> {
  const store = new SnapshotStore({ dbPath });
  const { sim, players } = buildWorld();
  let tick = 0;
  installShutdownHook(store, () => ({ tick, sim }), {
    onSaved: (r, signal) =>
      fs.appendFileSync(
        path.join(dir, "child.log"),
        `saved tick ${r.tick} (${r.bytes} bytes, ${r.ms.toFixed(2)} ms) on ${signal}\n`,
      ),
  });
  for (let t = 1; ; t++) {
    doTick(sim, players, t);
    tick = t;
    if (store.shouldSave(t)) store.saveWorld(t, sim);
    if (t % 50 === 0) {
      fs.writeFileSync(path.join(dir, "tick.txt"), String(t));
      // Yield to the event loop so the pending SIGTERM is delivered;
      // a fully synchronous loop would never observe the signal.
      await new Promise((r) => setImmediate(r));
    }
  }
}

async function bootMode(dbPath: string, dir: string): Promise<void> {
  const store = new SnapshotStore({ dbPath });
  const sim = new SimWorld();
  const restoredTick = store.restoreInto(sim);
  store.close();
  if (restoredTick === null) {
    console.error("[child] boot: no snapshot in DB");
    process.exit(2);
  }
  const players = [...playerQuery(sim.ecs)];
  writeState(dir, "after", sim, restoredTick);
  for (let t = restoredTick + 1; t <= restoredTick + 10; t++) {
    doTick(sim, players, t);
  }
  writeState(dir, "continued", sim, restoredTick + 10);
}

async function referenceMode(dir: string, tickCap: number): Promise<void> {
  const { sim, players } = buildWorld();
  for (let t = 1; t <= tickCap; t++) doTick(sim, players, t);
  writeState(dir, "reference", sim, tickCap);
}

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "run") await runMode(a, b);
  else if (mode === "boot") await bootMode(a, b);
  else if (mode === "reference") await referenceMode(a, Number(b));
  else {
    console.error(`[child] unknown mode: ${mode}`);
    process.exit(3);
  }
}

main().catch((err) => {
  console.error("[child] fatal:", err);
  process.exit(1);
});
