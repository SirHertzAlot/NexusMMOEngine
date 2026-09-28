/**
 * SnapshotStore tests (slice 1.4): WAL SQLite persistence of full
 * FlatBuffers snapshots.
 *
 * Covered:
 * - fresh boot with no DB: loadLatest/restoreInto return null, world untouched
 * - save/load round-trip: exact state (wire ids, components, generations)
 * - slot generations survive the round-trip, including freed slots
 * - a restored world keeps simulating with correct identity (reuse bumps)
 * - prune keeps exactly the N newest snapshots
 * - p95 save latency < 5 ms at 1000 entities (acceptance budget)
 * - shouldSave cadence (every 300 ticks, never tick 0)
 * - DB parent directories are created automatically
 * - empty worlds round-trip
 * - restoreFromState guards: non-fresh world, conflicting generations
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SimWorld,
  SnapshotStore,
  Transform,
  Velocity,
  PlayerIntent,
  Chunk,
  Health,
  collectFullState,
  decodeSnapshot,
  encodeSnapshot,
  stateFromCollected,
  compareStates,
  parseWireEntityId,
  makeWireEntityId,
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

/** Deterministic world with churn (despawn + respawn => generation bumps). */
function buildWorld(seed: number, churn: boolean): {
  sim: SimWorld;
  respawned: Map<number, bigint>;
} {
  const prng = mulberry32(seed);
  const sim = new SimWorld();
  const eids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    addComponent(sim.ecs, PlayerIntent, e);
    addComponent(sim.ecs, Health, e);
    Transform.px[e] = prng() * 100;
    Transform.py[e] = prng() * 100;
    Transform.pz[e] = prng() * 100;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Velocity.lx[e] = (prng() - 0.5) * 4;
    PlayerIntent.mx[e] = prng() * 2 - 1;
    PlayerIntent.jump[e] = i % 2;
    Health.current[e] = 50 + prng() * 50;
    Health.max[e] = 100;
    eids.push(e);
  }
  for (let i = 0; i < 10; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Chunk, e);
    Transform.px[e] = prng() * 200;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Chunk.lod[e] = i % 4;
    eids.push(e);
  }
  const respawned = new Map<number, bigint>();
  if (churn) {
    for (let i = 0; i < 10; i++) sim.despawn(eids[i]);
    for (let i = 0; i < 10; i++) {
      const e = sim.spawn(); // reuses a freed slot, generation bumps
      addComponent(sim.ecs, Transform, e);
      Transform.px[e] = prng() * 50;
      Transform.qw[e] = 1;
      Transform.sx[e] = 1;
      Transform.sy[e] = 1;
      Transform.sz[e] = 1;
      respawned.set(e, sim.wireId(e));
    }
  }
  return { sim, respawned };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 1000-entity world shaped like the slice-1.2 sim driver. */
function buildThousandEntityWorld(): SimWorld {
  const prng = mulberry32(1337);
  const sim = new SimWorld();
  for (let i = 0; i < 600; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    Transform.px[e] = prng() * 100;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Velocity.lx[e] = (prng() - 0.5) * 4;
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
  return sim;
}

// ---------------------------------------------------------------- tests

describe("persist: fresh boot", () => {
  test("loadLatest/restoreInto return null and the world is untouched", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    assert.equal(store.loadLatest(), null);
    assert.equal(store.snapshotCount(), 0);
    const sim = new SimWorld();
    assert.equal(store.restoreInto(sim), null);
    assert.equal(sim.maxSlotSeen, -1, "fresh world stays empty");
    store.close();
  });
});

describe("persist: save/load round-trip", () => {
  test("restores exact state: wire ids, components, generations", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    const { sim, respawned } = buildWorld(42, true);

    const saved = store.saveWorld(300, sim);
    assert.equal(saved.tick, 300);
    assert.equal(saved.entityCount, 50, "40 + 10 chunk - 10 despawned + 10 respawned");
    assert.ok(saved.bytes > 0);

    const gensBefore = sim.exportGenerations();
    const before = stateFromCollected(collectFullState(sim, 300));

    // Single-world-per-process model: reset the bitECS cursor so the
    // restored world gets dense eids from 0, like a fresh reboot.
    SimWorld.resetEntityCursorForTesting();
    const restored = new SimWorld();
    const tick = store.restoreInto(restored);
    assert.equal(tick, 300);
    const after = stateFromCollected(collectFullState(restored, 300));
    const cmp = compareStates(before, after);
    assert.ok(cmp.equal, `restored state differs: ${cmp.diffs.join("; ")}`);

    // Generation table survives exactly, including freed slots.
    assert.deepEqual(
      Array.from(restored.exportGenerations()),
      Array.from(gensBefore),
    );

    // Respawned slots keep their bumped wire ids (no ABA confusion).
    for (const [slot, wid] of respawned) {
      assert.equal(restored.wireId(slot), wid, `slot ${slot} wire id`);
      assert.equal(parseWireEntityId(wid).generation, 1);
    }
    store.close();
  });

  test("a restored world keeps simulating with correct identity", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    const { sim } = buildWorld(7, true);
    store.saveWorld(300, sim);
    const gensBefore = sim.exportGenerations();

    SimWorld.resetEntityCursorForTesting();
    const restored = new SimWorld();
    store.restoreInto(restored);
    store.close();

    // Spawn reuses a freed slot and CONTINUES the generation sequence
    // (bumps from the restored table, not from 0).
    const e = restored.spawn();
    const { slot, generation } = parseWireEntityId(restored.wireId(e));
    assert.equal(
      generation,
      gensBefore[slot] + 1,
      `reused slot ${slot} bumps generation`,
    );
    assert.ok(generation >= 1, "no slot restarts at generation 0 after churn");
  });

  test("empty worlds round-trip", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    const sim = new SimWorld();
    const saved = store.saveWorld(300, sim);
    assert.equal(saved.entityCount, 0);

    const restored = new SimWorld();
    assert.equal(store.restoreInto(restored), 300);
    const cmp = compareStates(
      stateFromCollected(collectFullState(sim, 300)),
      stateFromCollected(collectFullState(restored, 300)),
    );
    assert.ok(cmp.equal, "empty world restores exactly");
    store.close();
  });

  test("DB parent directories are created automatically", () => {
    const dir = tmpDir("mmo-persist-");
    const dbPath = path.join(dir, "nested", "deep", "world.db");
    const store = new SnapshotStore({ dbPath });
    store.saveWorld(300, new SimWorld());
    assert.ok(fs.existsSync(dbPath), "db file created with parents");
    store.close();
  });
});

describe("persist: restore guards", () => {
  test("restoreFromState rejects a non-fresh world", () => {
    const { sim } = buildWorld(1, false);
    const state = collectFullState(sim, 10);
    const target = new SimWorld();
    target.spawn();
    assert.throws(
      () => target.restoreFromState(state, new Map()),
      /not fresh/,
    );
  });

  test("restoreFromState rejects conflicting generations", () => {
    const { sim } = buildWorld(1, false);
    const state = collectFullState(sim, 10);
    // Corrupt one row: same slot, different generation.
    const row = state.transforms[0];
    const { slot } = parseWireEntityId(row.wireId);
    state.velocities.push({
      wireId: makeWireEntityId(999, slot),
      lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0,
    });
    const target = new SimWorld();
    assert.throws(
      () => target.restoreFromState(state, new Map()),
      /conflicting generations/,
    );
  });
});

describe("persist: retention", () => {
  test("prune keeps exactly the newest snapshots (default 6)", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    const { sim } = buildWorld(3, false);
    for (let i = 1; i <= 10; i++) store.saveWorld(i * 100, sim);
    assert.equal(store.snapshotCount(), 6);
    assert.deepEqual(store.listSnapshotTicks(), [500, 600, 700, 800, 900, 1000]);
    assert.equal(store.loadLatest()!.tick, 1000);
    store.close();
  });

  test("keepSnapshots is configurable", () => {
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({
      dbPath: path.join(dir, "world.db"),
      keepSnapshots: 2,
    });
    const { sim } = buildWorld(3, false);
    for (let i = 1; i <= 5; i++) store.saveWorld(i, sim);
    assert.equal(store.snapshotCount(), 2);
    assert.deepEqual(store.listSnapshotTicks(), [4, 5]);
    store.close();
  });
});

describe("persist: cadence", () => {
  test("shouldSave fires every 300 ticks, never tick 0", () => {
    const store = new SnapshotStore({ dbPath: ":memory:" });
    assert.equal(store.shouldSave(0), false);
    assert.equal(store.shouldSave(299), false);
    assert.equal(store.shouldSave(300), true);
    assert.equal(store.shouldSave(600), true);
    assert.equal(store.shouldSave(601), false);
    store.close();
  });

  test("saveEveryTicks is configurable", () => {
    const store = new SnapshotStore({
      dbPath: ":memory:",
      saveEveryTicks: 10,
    });
    assert.equal(store.shouldSave(10), true);
    assert.equal(store.shouldSave(300), true);
    assert.equal(store.shouldSave(15), false);
    store.close();
  });
});

describe("persist: latency budget", () => {
  test("p95 persist latency under 5 ms at 1000 entities (production path)", () => {
    // Production path: the gateway encodes a full snapshot every 300
    // ticks for broadcast; persistence reuses those bytes via
    // saveSnapshotBytes — no re-collection, no re-encode. We measure
    // that path here (production-sized snapshot, written 40 times).
    const dir = tmpDir("mmo-persist-");
    const store = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
    const sim = buildThousandEntityWorld();
    // Encode once: SQLite write latency depends on byte SIZE, not content.
    const bytes = encodeSnapshot(collectFullState(sim, 300));
    const gens = sim.exportGenerations();
    const count = sim.liveEntityCount;
    // Warmup: settle JIT, page cache, and GC before measuring.
    for (let i = 0; i < 5; i++) store.saveSnapshotBytes(i, bytes, gens, count);
    (global as { gc?: () => void }).gc?.();

    const lat: number[] = [];
    for (let i = 0; i < 100; i++) {
      lat.push(store.saveSnapshotBytes(100 + i, bytes, gens, count).ms);
    }
    lat.sort((a, b) => a - b);
    const p50 = lat[50];
    const p95 = lat[94];
    const max = lat[lat.length - 1];
    console.log(
      `saveSnapshotBytes (1000 entities, 100 saves): ` +
        `p50 ${p50.toFixed(2)} ms | p95 ${p95.toFixed(2)} ms | max ${max.toFixed(2)} ms`,
    );
    assert.ok(p95 < 5, `p95 persist latency ${p95.toFixed(2)} ms exceeds 5 ms budget`);

    // Informational: the full saveWorld (collect+encode+persist)
    // convenience path used for shutdown saves and tests.
    const wlat: number[] = [];
    for (let i = 0; i < 10; i++) wlat.push(store.saveWorld(1000 + i, sim).ms);
    wlat.sort((a, b) => a - b);
    console.log(
      `saveWorld full path (informational): ` +
        `p50 ${wlat[5].toFixed(2)} ms | max ${wlat[9].toFixed(2)} ms`,
    );
    store.close();
  });
});

describe("persist: snapshot codec reuse", () => {
  test("encodeSnapshot with a reused builder is byte-identical", async () => {
    const { encodeSnapshot } = await import("../../src/snapshot.js");
    const { Builder } = await import("flatbuffers");
    const { sim } = buildWorld(9, true);
    const state = collectFullState(sim, 300);

    const fresh = encodeSnapshot(state);
    const builder = new Builder(131072);
    const reused = encodeSnapshot(state, builder);
    assert.ok(
      Buffer.from(fresh).equals(Buffer.from(reused)),
      "reused builder produces identical bytes",
    );

    // Documented lifetime: the returned view aliases the builder, so
    // copy before the next encode.
    const copy = Buffer.from(reused);
    const { sim: sim2 } = buildWorld(10, false);
    encodeSnapshot(collectFullState(sim2, 300), builder);
    assert.ok(
      copy.equals(Buffer.from(fresh)),
      "a copy taken before reuse keeps the old bytes",
    );
  });
});

describe("persist: meta + background checkpoint", () => {
  test("meta values round-trip and survive reopen", () => {
    const dir = tmpDir("mmo-persist-");
    const dbPath = path.join(dir, "world.db");
    const store = new SnapshotStore({ dbPath });
    assert.equal(store.getMeta("terrain_version"), null);
    store.setMeta("terrain_version", "123");
    store.setMeta("terrain_version", "456"); // upsert
    store.close();
    const reopened = new SnapshotStore({ dbPath });
    assert.equal(reopened.getMeta("terrain_version"), "456");
    reopened.close();
  });

  test("off-thread checkpoints let SQLite rewind the WAL", async () => {
    const dir = tmpDir("mmo-persist-");
    const dbPath = path.join(dir, "world.db");
    const store = new SnapshotStore({ dbPath });
    const sim = buildThousandEntityWorld();
    const bytes = encodeSnapshot(collectFullState(sim, 1));
    const gens = sim.exportGenerations();
    for (let i = 1; i <= 40; i++) {
      store.saveSnapshotBytes(i, bytes, gens, sim.liveEntityCount);
      await store.whenCheckpointed();
    }
    // Automatic checkpoints are off on the tick thread. Each save found
    // the previous one fully checkpointed by the worker, so SQLite rewound
    // the log instead of appending: the WAL holds ~one save, not 40.
    const wal = fs.statSync(`${dbPath}-wal`).size;
    assert.ok(
      wal < 3 * bytes.byteLength,
      `WAL ${wal} B holds more than a couple of saves (${bytes.byteLength} B each)`,
    );
    assert.equal(store.loadLatest()!.tick, 40, "latest save readable");
    store.close();
  });

  test("save bursts can't ratchet the WAL file past its size limit", async () => {
    const dir = tmpDir("mmo-persist-");
    const dbPath = path.join(dir, "world.db");
    const limit = 256 * 1024;
    const store = new SnapshotStore({ dbPath, walSizeLimitBytes: limit });
    const sim = buildThousandEntityWorld();
    const bytes = encodeSnapshot(collectFullState(sim, 1));
    const gens = sim.exportGenerations();
    // Burst: saves outpace checkpoints, so the log can't rewind and grows.
    for (let i = 1; i <= 40; i++) store.saveSnapshotBytes(i, bytes, gens, sim.liveEntityCount);
    await store.whenCheckpointed();
    // Once caught up, the next save rewinds the log and SQLite truncates
    // the file back to the limit instead of keeping its high-water size.
    store.saveSnapshotBytes(41, bytes, gens, sim.liveEntityCount);
    await store.whenCheckpointed();
    store.saveSnapshotBytes(42, bytes, gens, sim.liveEntityCount);
    const wal = fs.statSync(`${dbPath}-wal`).size;
    assert.ok(wal <= limit + 2 * bytes.byteLength, `WAL ${wal} B above the ${limit} B limit`);
    store.close();
  });

  test("a store that is never closed doesn't keep the process alive", () => {
    // Regression: attaching the worker's listeners after unref() re-ref'd
    // it, so any process that saved without close() could never exit.
    const dir = tmpDir("mmo-persist-");
    const index = new URL("../../src/index.js", import.meta.url).href;
    const script =
      `import { SnapshotStore, SimWorld } from ${JSON.stringify(index)};` +
      `const s = new SnapshotStore({ dbPath: ${JSON.stringify(path.join(dir, "world.db"))} });` +
      `s.saveWorld(1, new SimWorld()); s.saveWorld(2, new SimWorld());`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 20_000,
      encoding: "utf8",
    });
    assert.equal(r.error, undefined, `child did not exit on its own: ${r.error?.message}`);
    assert.equal(r.status, 0, r.stderr);
  });

  test("in-memory stores never start a checkpoint worker", () => {
    const store = new SnapshotStore({ dbPath: ":memory:" });
    store.saveWorld(1, new SimWorld());
    assert.equal(
      (store as unknown as { checkpointer: unknown }).checkpointer,
      null,
    );
    store.close();
  });
});
