/**
 * Slice B: migration arbitration (WORLD-SERVER-SPEC §6), every path:
 * commit, abort, timeout expiry, source death (target backstop), retries,
 * and who may do what. The store contract runs against the memory store
 * always and against a SurrealDB server when WORLD_TEST_DB_URL is set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { surrealTestOptions } from "./surreal-test-db.js";
import { WorldError, type MigrationRecord, type WorldStore } from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const B = { x0: 100, x1: 200, z0: 0, z1: 100 };
const C = { x0: 200, x1: 300, z0: 0, z1: 100 };
let hash: string | null = null;
let n = 0;
const op = () => `op-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function world(opts: { migrationTimeoutMs?: number; heartbeatTimeoutMs?: number; store?: WorldStore } = {}) {
  hash ??= await argon2.hash(API_KEY);
  const store = opts.store ?? new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 10_000,
    heartbeatIntervalMs: 100,
    migrationTimeoutMs: opts.migrationTimeoutMs ?? 10_000,
    apiKeyHash: hash,
  });
  for (const [id, range] of [["a", A], ["b", B], ["c", C]] as const) {
    await core.registerRegion({ regionId: id, chunkRange: range, endpoint: `ws://${id}:7777`, capacity: 100, apiKey: API_KEY, opId: op() });
  }
  return { core, store };
}

const STATE = { pos: [99.5, 2, 50], hp: 87, inventory: [{ def: 12, n: 3 }] };
const begin = (core: WorldCoreImpl, entityId = "player:7", opId = op()) =>
  core.beginMigration("a", { opId, entityId, fromRegion: "a", toRegion: "b", entityState: STATE });

async function rejectsWith(p: Promise<unknown>, code: number): Promise<void> {
  await assert.rejects(p, (e) => e instanceof WorldError && e.code === code);
}

test("commit path: begin records the state, the target reads it and commits, both sides see committed", async () => {
  const { core } = await world();
  const { migrationId } = await begin(core);
  assert.match(migrationId, /^mig-[0-9a-f]{24}$/);
  // Both parties see it begun in their heartbeat acks.
  const ackB = await core.heartbeat({ regionId: "b", load: 0, tickJitterMs: 0, entityCount: 0 });
  assert.deepEqual(ackB.migrations, [{ migrationId, entityId: "player:7", fromRegion: "a", toRegion: "b", state: "begun" }]);
  const rec = await core.getMigration("b", migrationId);
  assert.deepEqual(rec.entityState, STATE);
  await core.commitMigration("b", { migrationId, opId: op() });
  const ackA = await core.heartbeat({ regionId: "a", load: 0, tickJitterMs: 0, entityCount: 0 });
  assert.equal(ackA.migrations[0].state, "committed");
  // A third region hears nothing about it.
  const ackC = await core.heartbeat({ regionId: "c", load: 0, tickJitterMs: 0, entityCount: 0 });
  assert.deepEqual(ackC.migrations, []);
});

test("only the source begins, only the target commits, outsiders can't read", async () => {
  const { core } = await world();
  await rejectsWith(core.beginMigration("b", { opId: op(), entityId: "e1", fromRegion: "a", toRegion: "b", entityState: {} }), 403);
  await rejectsWith(core.beginMigration("a", { opId: op(), entityId: "e1", fromRegion: "a", toRegion: "a", entityState: {} }), 400);
  const { migrationId } = await begin(core);
  await rejectsWith(core.commitMigration("a", { migrationId, opId: op() }), 403);
  await rejectsWith(core.commitMigration("c", { migrationId, opId: op() }), 403);
  await rejectsWith(core.getMigration("c", migrationId), 403);
  await rejectsWith(core.getMigration("a", "mig-000000000000000000000000"), 404);
});

test("one open migration per entity; the target must be live", async () => {
  const { core } = await world({ heartbeatTimeoutMs: 400 });
  await core.heartbeat({ regionId: "b", load: 0, tickJitterMs: 0, entityCount: 0 });
  await begin(core, "e1");
  await rejectsWith(begin(core, "e1"), 409);
  await sleep(450); // b falls silent
  await core.heartbeat({ regionId: "a", load: 0, tickJitterMs: 0, entityCount: 0 });
  await rejectsWith(begin(core, "e2"), 409);
});

test("retries are idempotent: same opId, same migration; a repeated commit is fine", async () => {
  const { core } = await world();
  const opId = op();
  const first = await begin(core, "e1", opId);
  const again = await begin(core, "e1", opId);
  assert.equal(again.migrationId, first.migrationId);
  const commitOp = op();
  await core.commitMigration("b", { migrationId: first.migrationId, opId: commitOp });
  await core.commitMigration("b", { migrationId: first.migrationId, opId: commitOp });
  await core.commitMigration("b", { migrationId: first.migrationId, opId: op() }); // a new op on a committed migration
  await rejectsWith(core.abortMigration("a", { migrationId: first.migrationId, opId: op(), reason: "late" }), 409);
});

test("abort path: either party aborts while begun; the target can no longer commit", async () => {
  const { core } = await world();
  const { migrationId } = await begin(core);
  await core.abortMigration("a", { migrationId, opId: op(), reason: "entity walked back" });
  const rec = await core.getMigration("b", migrationId);
  assert.equal(rec.state, "aborted");
  assert.equal(rec.reason, "entity walked back");
  await rejectsWith(core.commitMigration("b", { migrationId, opId: op() }), 409);
  await core.abortMigration("b", { migrationId, opId: op(), reason: "again" }); // already aborted: fine
  // The entity can migrate again.
  await begin(core);
});

test("timeout path: an uncommitted migration expires, the commit is refused, the source keeps authority", async () => {
  const { core } = await world({ migrationTimeoutMs: 100 });
  const { migrationId } = await begin(core);
  assert.deepEqual(await core.expireMigrations(), []);
  await sleep(150);
  assert.deepEqual(await core.expireMigrations(), [migrationId]);
  await rejectsWith(core.commitMigration("b", { migrationId, opId: op() }), 409);
  const ackA = await core.heartbeat({ regionId: "a", load: 0, tickJitterMs: 0, entityCount: 0 });
  assert.equal(ackA.migrations[0].state, "expired");
  assert.equal((await core.getMigration("a", migrationId)).reason, "not committed in time");
});

test("source death: with A gone, B still reads the state from the world and commits", async () => {
  const { core } = await world({ heartbeatTimeoutMs: 400 });
  await core.heartbeat({ regionId: "b", load: 0, tickJitterMs: 0, entityCount: 0 });
  const { migrationId } = await begin(core);
  await sleep(450);
  await core.heartbeat({ regionId: "b", load: 0, tickJitterMs: 0, entityCount: 0 });
  assert.deepEqual(await core.reapStale(), ["a", "c"]);
  const regions = await core.listRegions();
  assert.deepEqual(regions.map((r) => [r.regionId, r.live]), [["b", true]]);
  const rec = await core.getMigration("b", migrationId);
  assert.deepEqual(rec.entityState, STATE);
  await core.commitMigration("b", { migrationId, opId: op() });
  assert.equal((await core.getMigration("b", migrationId)).state, "committed");
});

test("commit racing expiry: exactly one of them wins", async () => {
  const { core } = await world({ migrationTimeoutMs: 50 });
  for (let i = 0; i < 20; i++) {
    const { migrationId } = await begin(core, `race-${i}`);
    await sleep(60);
    const [c] = await Promise.allSettled([core.commitMigration("b", { migrationId, opId: op() }), core.expireMigrations()]);
    const state = (await core.getMigration("b", migrationId)).state;
    if (c.status === "fulfilled") assert.equal(state, "committed");
    else assert.equal(state, "expired");
  }
});

/** The store contract the core relies on, for every store. */
async function storeContract(store: WorldStore): Promise<void> {
  const now = Date.now();
  const id = "mig-" + Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24);
  const m: MigrationRecord = { migrationId: id, entityId: "ent:" + id, fromRegion: "ra", toRegion: "rb", state: "begun", entityState: { nested: { a: [1, 2] }, s: "x" }, reason: "", createdAt: now - 1000, updatedAt: now - 1000 };
  await store.createMigration(m);
  assert.deepEqual(await store.getMigration(id), m);
  assert.equal((await store.getBegunMigrationForEntity(m.entityId))?.migrationId, id);
  assert.ok((await store.listBegunBefore(now)).includes(id));
  assert.ok(!(await store.listBegunBefore(now - 2000)).includes(id));
  assert.equal((await store.listMigrationsForRegion("rb", now)).filter((x) => x.migrationId === id).length, 1);
  const done = await store.resolveMigration(id, "committed", "", now);
  assert.equal(done?.state, "committed");
  assert.equal(await store.resolveMigration(id, "expired", "late", now), null); // compare-and-set
  assert.equal(await store.getBegunMigrationForEntity(m.entityId), null);
  assert.equal((await store.listMigrationsForRegion("ra", now)).filter((x) => x.migrationId === id).length, 1);
  assert.equal((await store.listMigrationsForRegion("ra", now + 1)).filter((x) => x.migrationId === id).length, 0);
  assert.ok((await store.pruneMigrations(now + 1)) >= 1);
  assert.equal(await store.getMigration(id), null);
}

test("store contract: memory", async () => {
  await storeContract(new MemoryWorldStore());
});

test("store contract: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("migration_" + Date.now()));
  try {
    await store.connect();
    await storeContract(store);
    // The whole commit/expire flow on SurrealDB too.
    const { core } = await world({ store, migrationTimeoutMs: 100 });
    const { migrationId } = await begin(core, "surreal-e1");
    assert.deepEqual((await core.getMigration("b", migrationId)).entityState, STATE);
    await core.commitMigration("b", { migrationId, opId: op() });
    const second = await begin(core, "surreal-e2");
    await sleep(150);
    assert.deepEqual(await core.expireMigrations(), [second.migrationId]);
  } finally {
    await store.close();
  }
});
