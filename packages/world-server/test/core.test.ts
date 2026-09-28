import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { WorldError } from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_B = { x0: 100, x1: 200, z0: 0, z1: 100 }; // adjacent, no overlap
const RANGE_OVERLAP = { x0: 50, x1: 150, z0: 0, z1: 100 };

async function makeCore(opts?: { apiKeyHash?: string | null }) {
  const store = new MemoryWorldStore();
  const apiKeyHash =
    opts?.apiKeyHash === undefined ? await argon2.hash(API_KEY) : opts.apiKeyHash;
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash,
  });
  return { core, store };
}

function regInput(regionId: string, range = RANGE_A, apiKey = API_KEY) {
  return {
    regionId,
    chunkRange: range,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey,
    opId: `op-${regionId}-${Math.random().toString(36).slice(2)}`,
  };
}

test("register returns a lease with a bearer token and bumps the registry", async () => {
  const { core, store } = await makeCore();
  const lease = await core.registerRegion(regInput("r1"));
  assert.equal(lease.regionId, "r1");
  assert.match(lease.token, /^[0-9a-f]{64}$/);
  assert.equal(lease.heartbeatIntervalMs, 100);
  assert.equal(await store.getRegistryVersion(), 1);
  const rec = await store.getRegion("r1");
  assert.ok(rec);
  assert.equal(rec.endpoint, "ws://localhost:7777");
});

test("register rejects a bad api key with 401", async () => {
  const { core } = await makeCore();
  await assert.rejects(core.registerRegion(regInput("r1", RANGE_A, "wrong")), (e) => {
    assert.ok(e instanceof WorldError && e.code === 401);
    return true;
  });
});

test("register disabled when no api key hash is configured", async () => {
  const { core } = await makeCore({ apiKeyHash: null });
  await assert.rejects(core.registerRegion(regInput("r1")), (e) => {
    assert.ok(e instanceof WorldError && e.code === 403);
    return true;
  });
});

test("register rejects chunk ranges overlapping a live region with 409", async () => {
  const { core } = await makeCore();
  await core.registerRegion(regInput("r1", RANGE_A));
  await assert.rejects(core.registerRegion(regInput("r2", RANGE_OVERLAP)), (e) => {
    assert.ok(e instanceof WorldError && e.code === 409);
    return true;
  });
  // Adjacent (touching, not overlapping) is fine.
  const lease = await core.registerRegion(regInput("r2", RANGE_B));
  assert.equal(lease.regionId, "r2");
});

test("re-registering the same region rotates the token", async () => {
  const { core } = await makeCore();
  const a = await core.registerRegion(regInput("r1"));
  const b = await core.registerRegion(regInput("r1"));
  assert.notEqual(a.token, b.token);
  assert.equal(await core.authenticate(a.token), null);
  assert.equal(await core.authenticate(b.token), "r1");
});

test("authenticate resolves tokens and rejects garbage", async () => {
  const { core } = await makeCore();
  const lease = await core.registerRegion(regInput("r1"));
  assert.equal(await core.authenticate(lease.token), "r1");
  assert.equal(await core.authenticate("0".repeat(64)), null);
});

test("heartbeat updates stats and returns an ack", async () => {
  const { core, store } = await makeCore();
  await core.registerRegion(regInput("r1"));
  const ack = await core.heartbeat({
    regionId: "r1",
    load: 0.5,
    tickJitterMs: 2.5,
    entityCount: 42,
  });
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.migrations, []);
  const rec = await store.getRegion("r1");
  assert.equal(rec?.load, 0.5);
  assert.equal(rec?.entityCount, 42);
});

test("heartbeat for an unknown region throws 404", async () => {
  const { core } = await makeCore();
  await assert.rejects(
    core.heartbeat({ regionId: "nope", load: 0, tickJitterMs: 0, entityCount: 0 }),
    (e) => {
      assert.ok(e instanceof WorldError && e.code === 404);
      return true;
    },
  );
});

test("deregister removes the region and is idempotent on opId", async () => {
  const { core, store } = await makeCore();
  await core.registerRegion(regInput("r1"));
  await core.deregisterRegion("r1", "op-1");
  assert.equal(await store.getRegion("r1"), null);
  // Same opId again: no error, no double-apply.
  await core.deregisterRegion("r1", "op-1");
  // Different opId on a missing region: still fine.
  await core.deregisterRegion("r1", "op-2");
});

test("reapStale removes silent regions and keeps live ones", async () => {
  const { core, store } = await makeCore();
  await core.registerRegion(regInput("r1"));
  await core.registerRegion(regInput("r2", RANGE_B));
  // Age r1's heartbeat beyond the timeout.
  const rec = (await store.getRegion("r1"))!;
  rec.lastHeartbeat = Date.now() - 60_000;
  await store.upsertRegion(rec);
  const reaped = await core.reapStale();
  assert.deepEqual(reaped, ["r1"]);
  assert.equal(await store.getRegion("r1"), null);
  assert.ok(await store.getRegion("r2"));
});

test("reportSnapshot updates tick stats; unknown regions are ignored", async () => {
  const { core, store } = await makeCore();
  await core.registerRegion(regInput("r1"));
  await core.reportSnapshot({ regionId: "r1", tick: 900, entityCount: 7, digest: "abc" });
  assert.equal((await store.getRegion("r1"))?.lastTick, 900);
  // Lossy-OK: must not throw.
  await core.reportSnapshot({ regionId: "ghost", tick: 1, entityCount: 0, digest: "x" });
});

test("getRegionByTokenHash resolves the indexed lookup directly", async () => {
  const { core, store } = await makeCore();
  const lease = await core.registerRegion(regInput("r1"));
  const rec = await store.getRegion("r1");
  assert.ok(rec?.tokenHash);
  // sha256Hex(token) is what the core stores; look it up by hash.
  const found = await store.getRegionByTokenHash(rec.tokenHash);
  assert.equal(found?.regionId, "r1");
  assert.equal(await store.getRegionByTokenHash("f".repeat(64)), null);
  // Rotating the token invalidates the old hash.
  const lease2 = await core.registerRegion(regInput("r1"));
  assert.notEqual(lease2.token, lease.token);
  assert.equal(await store.getRegionByTokenHash(rec.tokenHash), null);
  assert.equal(await core.authenticate(lease.token), null);
  assert.equal(await core.authenticate(lease2.token), "r1");
});
