/**
 * PL3c: guilds, parties, friends and blocks as world records every region shares. The store contract
 * runs against the memory store and SurrealDB (embedded, or WORLD_TEST_DB_URL); the core's version
 * guard and id allocation run over the memory store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import type { SocialRecord, WorldStore } from "../src/types.js";
import { surrealTestOptions } from "./surreal-test-db.js";

async function socialStoreContract(store: WorldStore): Promise<void> {
  assert.equal(await store.getSocialRecord("guild", "7"), null);
  const r: SocialRecord = { kind: "guild", key: "7", doc: { name: "Wolves", members: [{ name: "Ana" }] }, version: 1, regionId: "r1", updatedAt: 1 };
  await store.putSocialRecord(r);
  await store.putSocialRecord({ kind: "friends", key: "ana", doc: ["Bo"], version: 1, regionId: "r1", updatedAt: 1 });
  assert.deepEqual(await store.getSocialRecord("guild", "7"), r);
  await store.putSocialRecord({ ...r, doc: null, version: 2, regionId: "r2" });
  assert.deepEqual(await store.getSocialRecord("guild", "7"), { ...r, doc: null, version: 2, regionId: "r2" }, "a tombstone replaces the record");
  assert.deepEqual((await store.listSocialRecords("guild")).map((x) => x.key), ["7"], "listed by kind");
  assert.deepEqual((await store.listSocialRecords("friends")).map((x) => x.doc), [["Bo"]]);
  const a = await store.allocateSocialIds("guild", 3);
  const b = await store.allocateSocialIds("guild", 2);
  assert.equal(new Set([...a, ...b]).size, 5, "never issued twice");
  assert.ok(a.every((id) => Number.isInteger(id) && id > 0));
}

test("social store contract: memory", async () => {
  await socialStoreContract(new MemoryWorldStore());
});

test("social store contract: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("social_" + Date.now()));
  try {
    await store.connect();
    await socialStoreContract(store);
  } finally {
    await store.close();
  }
});

test("core: puts are version-guarded and idempotent; ids are world-wide", async () => {
  const API_KEY = "social-test-key";
  const core = new WorldCoreImpl({ store: new MemoryWorldStore(), heartbeatTimeoutMs: 60_000, heartbeatIntervalMs: 60_000, apiKeyHash: await argon2.hash(API_KEY) });
  for (const [regionId, x0] of [["r1", 0], ["r2", 100]] as const) {
    await core.registerRegion({ regionId, chunkRange: { x0, x1: x0 + 100, z0: 0, z1: 100 }, endpoint: "ws://x", capacity: 10, apiKey: API_KEY, opId: `reg-${regionId}` });
  }
  const put = (caller: string, expectedVersion: number, doc: unknown, opId: string) =>
    core.putSocialRecord(caller, { regionId: caller, kind: "guild", key: "1", doc, expectedVersion, opId });

  assert.equal((await put("r1", 0, { motd: "a" }, "op-1")).version, 1);
  assert.equal((await put("r1", 0, { motd: "a" }, "op-1")).version, 1, "a replayed op returns its first result");
  assert.equal((await put("r2", 1, { motd: "b" }, "op-2")).version, 2);
  await assert.rejects(put("r1", 1, { motd: "stale" }, "op-3"), (e: { code?: number }) => e.code === 409, "a stale writer is refused");
  const all = await core.getSocialRecords("r1", { regionId: "r1", kind: "guild" });
  assert.deepEqual(all.map((r) => [r.key, r.version, r.regionId, r.doc]), [["1", 2, "r2", { motd: "b" }]]);

  const ids1 = await core.allocateSocialIds("r1", { regionId: "r1", kind: "guild", count: 4, opId: "ids-1" });
  const ids2 = await core.allocateSocialIds("r2", { regionId: "r2", kind: "guild", count: 4, opId: "ids-2" });
  assert.equal(new Set([...ids1, ...ids2]).size, 8, "two regions never get the same id");
  assert.deepEqual(await core.allocateSocialIds("r1", { regionId: "r1", kind: "guild", count: 4, opId: "ids-1" }), ids1, "idempotent on opId");
});
