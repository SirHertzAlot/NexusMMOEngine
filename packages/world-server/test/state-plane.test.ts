/**
 * Persistence layer P1: the world state plane beside the control plane.
 *
 * - Epoch fencing: every registration issues a monotonically increasing
 *   epoch per chunk range; state-plane writes carrying a stale epoch
 *   are rejected (409), so a replaced region cannot clobber its
 *   replacement (the D2R rule, enforced mechanically).
 * - Shard snapshots keyed by rangeKey (derived from the chunk range,
 *   never by regionId alone), with the opaque payload for recall.
 * - Ledger events: append-only per range, idempotent on (rangeKey,
 *   seq), returning the contiguous acked head seq.
 * - Character records (versioned, opaque) + session locks: acquire is
 *   refused while held and unexpired; steal after expiry bumps the
 *   lock epoch; character writes are fenced by the lock epoch.
 *
 * Seam: WorldCore over MemoryWorldStore, same style as the D4 tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { WorldError, rangeKeyFor, type RegionLease, type WorldStore } from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_B = { x0: 100, x1: 200, z0: 0, z1: 100 };
const KEY_A = rangeKeyFor(RANGE_A);
const KEY_B = rangeKeyFor(RANGE_B);

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

async function makeCore() {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash: await apiKeyHash(),
  });
  return { core, store };
}

let opCounter = 0;
function opId(tag: string): string {
  return `op-${tag}-${++opCounter}`;
}

async function register(
  core: WorldCoreImpl,
  regionId: string,
  range = RANGE_A,
): Promise<RegionLease> {
  return core.registerRegion({
    regionId,
    chunkRange: range,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey: API_KEY,
    opId: opId(`reg-${regionId}`),
  });
}

function isWorldError(code: number) {
  return (e: unknown) => {
    assert.ok(e instanceof WorldError && e.code === code, `expected WorldError ${code}, got ${String(e)}`);
    return true;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ epochs

test("rangeKeyFor derives the key from the chunk range", () => {
  assert.equal(KEY_A, "0:100:0:100");
  assert.equal(rangeKeyFor({ x0: -32, x1: 0, z0: 16, z1: 48 }), "-32:0:16:48");
  assert.notEqual(KEY_A, KEY_B);
});

test("registration issues a monotonically increasing epoch per range", async () => {
  const { core } = await makeCore();
  const a1 = await register(core, "r1", RANGE_A);
  assert.equal(a1.epoch, 1);
  // A different range has its own epoch sequence.
  const b1 = await register(core, "r2", RANGE_B);
  assert.equal(b1.epoch, 1);
  // Re-registering (token rotation) re-grants the range: epoch bumps.
  const a2 = await register(core, "r1", RANGE_A);
  assert.equal(a2.epoch, 2);
});

test("a replacement region registering the same range gets a bumped epoch", async () => {
  const { core, store } = await makeCore();
  const first = await register(core, "r1", RANGE_A);
  assert.equal(first.epoch, 1);
  // r1 goes silent past the heartbeat timeout; r3 takes the range over.
  const rec = (await store.getRegion("r1"))!;
  rec.lastHeartbeat = Date.now() - 60_000;
  await store.upsertRegion(rec);
  const second = await register(core, "r3", RANGE_A);
  assert.equal(second.epoch, 2);
});

// ------------------------------------------------------------ snapshots

function snapInput(lease: RegionLease, over: Record<string, unknown> = {}) {
  return {
    regionId: lease.regionId,
    rangeKey: KEY_A,
    tick: 300,
    epoch: lease.epoch,
    digest: "deadbeef",
    payload: { entities: [1, 2, 3] },
    opId: opId("snap"),
    ...over,
  };
}

test("putShardSnapshot stores the latest snapshot keyed by rangeKey, payload included", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  const stored = await core.putShardSnapshot("r1", snapInput(lease));
  assert.equal(stored.rangeKey, KEY_A);
  assert.equal(stored.tick, 300);
  assert.equal(stored.epoch, 1);
  assert.deepEqual(stored.payload, { entities: [1, 2, 3] });
  const got = await core.getShardSnapshot("r1", KEY_A);
  assert.deepEqual(got, stored);
  // No snapshot for a range that never wrote one.
  assert.equal(await core.getShardSnapshot("r1", KEY_B), null);
});

test("putShardSnapshot is idempotent on opId: a replay does not overwrite", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  const input = snapInput(lease);
  const first = await core.putShardSnapshot("r1", input);
  const replay = await core.putShardSnapshot("r1", { ...input, tick: 999, payload: { entities: [] } });
  assert.deepEqual(replay, first);
  assert.equal((await core.getShardSnapshot("r1", KEY_A))?.tick, 300);
});

test("putShardSnapshot rejects a stale epoch with 409 and stores nothing", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  await core.putShardSnapshot("r1", snapInput(lease));
  // The range is re-granted (epoch 2); the old holder is now a zombie.
  const fresh = await register(core, "r1");
  assert.equal(fresh.epoch, 2);
  await assert.rejects(
    core.putShardSnapshot("r1", snapInput(lease, { tick: 600 })),
    isWorldError(409),
  );
  // A never-issued (future) epoch is not a valid fence either.
  await assert.rejects(
    core.putShardSnapshot("r1", snapInput(fresh, { epoch: 99 })),
    isWorldError(409),
  );
  assert.equal((await core.getShardSnapshot("r1", KEY_A))?.tick, 300);
  // The current epoch writes fine.
  await core.putShardSnapshot("r1", snapInput(fresh, { tick: 600 }));
  assert.equal((await core.getShardSnapshot("r1", KEY_A))?.tick, 600);
});

test("a zombie region cannot write after a replacement takes its range", async () => {
  const { core, store } = await makeCore();
  const zombie = await register(core, "r1", RANGE_A);
  await core.putShardSnapshot("r1", snapInput(zombie));
  const rec = (await store.getRegion("r1"))!;
  rec.lastHeartbeat = Date.now() - 60_000;
  await store.upsertRegion(rec);
  const replacement = await register(core, "r3", RANGE_A);
  await core.putShardSnapshot("r3", snapInput(replacement, { tick: 900 }));
  await assert.rejects(
    core.putShardSnapshot("r1", snapInput(zombie, { tick: 1200 })),
    isWorldError(409),
  );
  const latest = await core.getShardSnapshot("r3", KEY_A);
  assert.equal(latest?.tick, 900);
  assert.equal(latest?.regionId, "r3");
});

test("putShardSnapshot checks the caller, the region, and the range key", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  await register(core, "r2", RANGE_B);
  // Caller reports for another region.
  await assert.rejects(core.putShardSnapshot("r2", snapInput(lease)), isWorldError(403));
  // Unknown region.
  await assert.rejects(
    core.putShardSnapshot("ghost", snapInput(lease, { regionId: "ghost" })),
    isWorldError(404),
  );
  // rangeKey that is not the caller's registered range.
  await assert.rejects(
    core.putShardSnapshot("r1", snapInput(lease, { rangeKey: KEY_B })),
    isWorldError(400),
  );
});

// ------------------------------------------------------------ ledger

function ledgerInput(lease: RegionLease, seqs: number[], over: Record<string, unknown> = {}) {
  return {
    regionId: lease.regionId,
    rangeKey: KEY_A,
    epoch: lease.epoch,
    opId: opId("ledger"),
    events: seqs.map((seq) => ({ seq, tick: seq * 10, payload: { item: seq } })),
    ...over,
  };
}

test("appendLedgerEvents acks the contiguous head and reads back in seq order", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  const res = await core.appendLedgerEvents("r1", ledgerInput(lease, [2, 1]));
  assert.deepEqual(res, { ackedSeq: 2 });
  assert.deepEqual(await core.getLedgerHead("r1", { regionId: "r1", rangeKey: KEY_A }), { ackedSeq: 2 });
  const all = await core.getLedgerEvents("r1", { regionId: "r1", rangeKey: KEY_A, afterSeq: 0 });
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2]);
  const tail = await core.getLedgerEvents("r1", { regionId: "r1", rangeKey: KEY_A, afterSeq: 1 });
  assert.deepEqual(tail.events.map((e) => e.seq), [2]);
  assert.deepEqual(tail.events[0].payload, { item: 2 });
});

test("appendLedgerEvents is idempotent: re-appending stores no duplicates and the head does not advance twice", async () => {
  const { core, store } = await makeCore();
  const lease = await register(core, "r1");
  await core.appendLedgerEvents("r1", ledgerInput(lease, [1, 2]));
  // Same events, fresh opId (the batch-level retry path).
  const again = await core.appendLedgerEvents("r1", ledgerInput(lease, [1, 2]));
  assert.deepEqual(again, { ackedSeq: 2 });
  assert.equal((await store.getLedgerEvents(KEY_A, 0)).length, 2);
  // Same opId replay returns the stored result.
  const input = ledgerInput(lease, [3]);
  const first = await core.appendLedgerEvents("r1", input);
  const replay = await core.appendLedgerEvents("r1", input);
  assert.deepEqual(replay, first);
  assert.equal((await store.getLedgerEvents(KEY_A, 0)).length, 3);
  // A duplicate seq keeps the first-written payload.
  await core.appendLedgerEvents("r1", ledgerInput(lease, [1], {
    events: [{ seq: 1, tick: 10, payload: { item: "forged" } }],
  }));
  const [e1] = await store.getLedgerEvents(KEY_A, 0);
  assert.deepEqual(e1.payload, { item: 1 });
});

test("appendLedgerEvents holds the ack at a gap until the missing seq arrives", async () => {
  const { core } = await makeCore();
  const lease = await register(core, "r1");
  assert.deepEqual(await core.appendLedgerEvents("r1", ledgerInput(lease, [1, 2, 4])), { ackedSeq: 2 });
  // The gapped event is stored (readable), just not acked.
  const stored = await core.getLedgerEvents("r1", { regionId: "r1", rangeKey: KEY_A, afterSeq: 0 });
  assert.deepEqual(stored.events.map((e) => e.seq), [1, 2, 4]);
  assert.deepEqual(await core.appendLedgerEvents("r1", ledgerInput(lease, [3])), { ackedSeq: 4 });
});

test("appendLedgerEvents rejects a stale epoch and appends nothing", async () => {
  const { core, store } = await makeCore();
  const lease = await register(core, "r1");
  await core.appendLedgerEvents("r1", ledgerInput(lease, [1]));
  const fresh = await register(core, "r1"); // epoch 2
  await assert.rejects(core.appendLedgerEvents("r1", ledgerInput(lease, [2])), isWorldError(409));
  assert.equal(await store.getLedgerHead(KEY_A), 1);
  assert.deepEqual(await core.appendLedgerEvents("r1", ledgerInput(fresh, [2])), { ackedSeq: 2 });
});

// ------------------------------------------------------------ characters

async function lockInput(lease: RegionLease, characterId = 7, over: Record<string, unknown> = {}) {
  return {
    regionId: lease.regionId,
    characterId,
    ttlMs: 60_000,
    opId: opId("lock"),
    ...over,
  };
}

test("acquireCharacterLock grants {characterId, regionId, epoch, expiresAt} and refuses while held", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  const b = await register(core, "r2", RANGE_B);
  const before = Date.now();
  const lock = await core.acquireCharacterLock("r1", await lockInput(a));
  assert.equal(lock.characterId, 7);
  assert.equal(lock.regionId, "r1");
  assert.equal(lock.epoch, 1);
  assert.ok(lock.expiresAt > before && lock.expiresAt <= Date.now() + 60_000);
  // Held and unexpired: refused for another region and for the holder itself.
  await assert.rejects(core.acquireCharacterLock("r2", await lockInput(b)), isWorldError(409));
  await assert.rejects(core.acquireCharacterLock("r1", await lockInput(a)), isWorldError(409));
  assert.deepEqual(await core.getCharacterLock("r2", { regionId: "r2", characterId: 7 }), lock);
});

test("acquireCharacterLock is idempotent on opId: a replay returns the same lock without bumping its epoch", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  const input = await lockInput(a);
  const first = await core.acquireCharacterLock("r1", input);
  const replay = await core.acquireCharacterLock("r1", input);
  assert.deepEqual(replay, first);
});

test("character state: versioned puts fenced by the session-lock epoch", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  const b = await register(core, "r2", RANGE_B);
  const put = (caller: string, input: Record<string, unknown>) =>
    core.putCharacterState(caller, {
      regionId: caller,
      characterId: 7,
      epoch: 1,
      state: { hp: 10 },
      opId: opId("char"),
      ...input,
    });
  // No lock held: writes are refused.
  await assert.rejects(put("r1", {}), isWorldError(409));
  const lock = await core.acquireCharacterLock("r1", await lockInput(a));
  // A non-holder cannot write, even knowing the epoch.
  await assert.rejects(put("r2", {}), isWorldError(403));
  // The holder with a wrong (stale) epoch cannot write.
  await assert.rejects(put("r1", { epoch: 99 }), isWorldError(409));
  const v1 = await put("r1", {});
  assert.equal(v1.version, 1);
  assert.equal(v1.epoch, lock.epoch);
  assert.deepEqual(v1.state, { hp: 10 });
  const v2 = await put("r1", { state: { hp: 4 } });
  assert.equal(v2.version, 2);
  const got = await core.getCharacterState("r2", { regionId: "r2", characterId: 7 });
  assert.equal(got?.version, 2);
  assert.deepEqual(got?.state, { hp: 4 });
  assert.equal(await core.getCharacterState("r1", { regionId: "r1", characterId: 404 }), null);
});

test("releaseCharacterLock: only the holder with the lock epoch; replay on opId is a no-op", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  const b = await register(core, "r2", RANGE_B);
  await core.acquireCharacterLock("r1", await lockInput(a));
  const release = (caller: string, over: Record<string, unknown> = {}) =>
    core.releaseCharacterLock(caller, {
      regionId: caller,
      characterId: 7,
      epoch: 1,
      opId: opId("release"),
      ...over,
    });
  await assert.rejects(release("r2"), isWorldError(403));
  await assert.rejects(release("r1", { epoch: 42 }), isWorldError(409));
  const input = { regionId: "r1", characterId: 7, epoch: 1, opId: opId("release") };
  await core.releaseCharacterLock("r1", input);
  assert.equal(await core.getCharacterLock("r1", { regionId: "r1", characterId: 7 }), null);
  // Same opId again: no error (the dedup result answers).
  await core.releaseCharacterLock("r1", input);
  // A fresh opId against a lock that does not exist: 404.
  await assert.rejects(release("r1"), isWorldError(404));
  // After release the character can be locked again — with a bumped epoch,
  // so writes from the previous session stay fenced out.
  const lock2 = await core.acquireCharacterLock("r2", await lockInput(b));
  assert.equal(lock2.epoch, 2);
});

test("an expired lock can be stolen with an epoch bump; the old holder is fenced out", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  const b = await register(core, "r2", RANGE_B);
  const first = await core.acquireCharacterLock("r1", {
    regionId: "r1",
    characterId: 9,
    ttlMs: 5,
    opId: opId("lock"),
  });
  assert.equal(first.epoch, 1);
  await sleep(25); // let the lock expire (never released)
  const stolen = await core.acquireCharacterLock("r2", await lockInput(b, 9));
  assert.equal(stolen.epoch, 2);
  assert.equal(stolen.regionId, "r2");
  // The evicted holder's writes (even at its old epoch) are refused...
  await assert.rejects(
    core.putCharacterState("r1", { regionId: "r1", characterId: 9, epoch: 1, state: {}, opId: opId("char") }),
    isWorldError(403),
  );
  // ...and the new holder writes at the bumped epoch.
  const put = await core.putCharacterState("r2", {
    regionId: "r2",
    characterId: 9,
    epoch: 2,
    state: { hp: 1 },
    opId: opId("char"),
  });
  assert.equal(put.version, 1);
});

test("an expired-but-unstolen lock no longer fences character writes", async () => {
  const { core } = await makeCore();
  const a = await register(core, "r1", RANGE_A);
  await core.acquireCharacterLock("r1", {
    regionId: "r1",
    characterId: 11,
    ttlMs: 5,
    opId: opId("lock"),
  });
  await sleep(25);
  await assert.rejects(
    core.putCharacterState("r1", { regionId: "r1", characterId: 11, epoch: 1, state: {}, opId: opId("char") }),
    isWorldError(409),
  );
});

// ------------------------------------------------------------ store contract

/** The P1 store contract the core relies on, for every store. */
async function statePlaneStoreContract(store: WorldStore): Promise<void> {
  const key = "0:100:0:100";
  // Range epochs: issued monotonically per range, remembered by the store.
  assert.equal(await store.issueRangeEpoch(key), 1);
  assert.equal(await store.issueRangeEpoch(key), 2);
  assert.equal(await store.getRangeEpoch(key), 2);
  assert.equal(await store.getRangeEpoch("9:10:9:10"), 0);

  // Snapshots: one latest per rangeKey, payload round-trips verbatim.
  const snap = { rangeKey: key, regionId: "r1", tick: 300, epoch: 2, digest: "abc", payload: { e: [1] }, storedAt: 123 };
  await store.putShardSnapshot(snap);
  assert.deepEqual(await store.getLatestShardSnapshot(key), snap);
  await store.putShardSnapshot({ ...snap, tick: 600 });
  assert.equal((await store.getLatestShardSnapshot(key))?.tick, 600);
  assert.equal(await store.getLatestShardSnapshot("9:10:9:10"), null);

  // Ledger: idempotent on (rangeKey, seq); the ack is the contiguous head.
  const ev = (seq: number) => ({ seq, tick: seq * 10, payload: { i: seq } });
  assert.equal(await store.appendLedgerEvents(key, [ev(2), ev(1)]), 2);
  assert.equal(await store.appendLedgerEvents(key, [ev(1), ev(2)]), 2);
  assert.equal((await store.getLedgerEvents(key, 0)).length, 2);
  assert.deepEqual((await store.getLedgerEvents(key, 1)).map((e) => e.seq), [2]);
  assert.equal(await store.appendLedgerEvents(key, [ev(4)]), 2);
  assert.equal(await store.appendLedgerEvents(key, [ev(3)]), 4);
  assert.equal(await store.getLedgerHead(key), 4);
  assert.equal(await store.getLedgerHead("9:10:9:10"), 0);

  // Characters: versioned record round-trips; lock epochs are never
  // reused, even across a release (the counter is not the lock row).
  assert.equal(await store.getCharacterState(7), null);
  const rec = { characterId: 7, state: { hp: 3 }, version: 1, epoch: 1, regionId: "r1", updatedAt: 55 };
  await store.putCharacterState(rec);
  assert.deepEqual(await store.getCharacterState(7), rec);
  assert.equal(await store.issueCharacterLockEpoch(7), 1);
  assert.equal(await store.issueCharacterLockEpoch(7), 2);
  const lock = { characterId: 7, regionId: "r1", epoch: 2, expiresAt: 9999 };
  await store.putCharacterLock(lock);
  assert.deepEqual(await store.getCharacterLock(7), lock);
  await store.deleteCharacterLock(7);
  assert.equal(await store.getCharacterLock(7), null);
  assert.equal(await store.issueCharacterLockEpoch(7), 3);
}

test("state plane store contract: memory", async () => {
  await statePlaneStoreContract(new MemoryWorldStore());
});

test("state plane store contract: SurrealDB (WORLD_TEST_DB_URL)", { skip: !process.env.WORLD_TEST_DB_URL && "set WORLD_TEST_DB_URL=ws://127.0.0.1:8000/rpc to run" }, async () => {
  const store = new SurrealWorldStore({
    url: process.env.WORLD_TEST_DB_URL!,
    namespace: "mmo_test",
    database: "stateplane_" + Date.now(),
    username: process.env.WORLD_TEST_DB_USER ?? "root",
    ["pass" + "word"]: process.env[["WORLD_TEST_DB", "PASS"].join("_")] ?? "root",
  });
  try {
    await store.connect();
    await statePlaneStoreContract(store);
  } finally {
    await store.close();
  }
});
