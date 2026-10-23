/**
 * Persistence layer P5: host resource reports + resource-aware
 * chunk assignment.
 *
 * - Host reports: the sidecar's periodic upsert keyed by hostId
 *   (bootstrap apiKey auth, server-stamped reportedAt, state-not-event
 *   semantics mirroring presence/heartbeats — no opId), TTL'd and
 *   reaped by the same stale sweep as regions; a stale report no
 *   longer influences assignment.
 * - Assignment policy: pure and deterministic — bigger host gets a
 *   strictly bigger range, same inputs give the same range, and a
 *   range held by a live lease is never assigned to another shard.
 * - Registration: assignment mode (hostId, no chunkRange) rides the
 *   existing path and the lease carries the assigned range + epoch;
 *   explicit-range registration is unchanged.
 *
 * Seam: WorldCore over MemoryWorldStore + the policy directly, same
 * style as the P1 tests; one webrpc section for the wire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import express from "express";
import type { AddressInfo } from "node:net";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { createWebrpcRouter } from "../src/adapters/webrpc.js";
import {
  DefaultChunkAssignmentPolicy,
  hostWeight,
} from "../src/assignment.js";
import {
  WorldError,
  type ChunkRange,
  type HostResourceReport,
  type WorldStore,
} from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const GIB = 1024 * 1024 * 1024;
const SPACE: ChunkRange = { x0: 0, x1: 4096, z0: 0, z1: 4096 };
const SMALL = { hostId: "host-small", cpuCores: 2, ramTotalBytes: 4 * GIB, ramFreeBytes: 2 * GIB };
const BIG = { hostId: "host-big", cpuCores: 16, ramTotalBytes: 64 * GIB, ramFreeBytes: 32 * GIB };
// Weights: small 2*4 = 8, big 16*64 = 1024. Shares of 4096:
// small round(4096 * 8/1032) = 32, big round(4096 * 1024/1032) = 4064.

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

function isWorldError(code: number) {
  return (e: unknown) => {
    assert.ok(e instanceof WorldError && e.code === code, `expected WorldError ${code}, got ${String(e)}`);
    return true;
  };
}

function report(host: typeof SMALL | typeof BIG, over: Record<string, unknown> = {}) {
  return { ...host, apiKey: API_KEY, ...over };
}

function storedReport(host: typeof SMALL | typeof BIG, reportedAt: number): HostResourceReport {
  return { ...host, reportedAt };
}

function overlaps(a: ChunkRange, b: ChunkRange): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

// ------------------------------------------------------------ host reports

test("reportHostResources stores a server-stamped report and re-reports replace it", async () => {
  const { core, store } = await makeCore();
  const before = Date.now();
  const stored = await core.reportHostResources(report(SMALL));
  assert.equal(stored.hostId, "host-small");
  assert.equal(stored.cpuCores, 2);
  assert.ok(stored.reportedAt >= before && stored.reportedAt <= Date.now(), "reportedAt is server-stamped");
  assert.equal(stored.shardLoad, undefined);
  assert.deepEqual(await store.getHostReport("host-small"), stored);

  const updated = await core.reportHostResources(report(SMALL, { ramFreeBytes: 1 * GIB, shardLoad: 0.25 }));
  assert.equal(updated.ramFreeBytes, 1 * GIB);
  assert.equal(updated.shardLoad, 0.25);
  assert.equal((await store.listHostReports()).length, 1, "one row per host: the upsert replaced, not appended");
});

test("reportHostResources rejects a bad api key with 401 and stores nothing; disabled without a key hash", async () => {
  const { core, store } = await makeCore();
  await assert.rejects(core.reportHostResources(report(SMALL, { apiKey: "wrong-key-123456" })), isWorldError(401));
  assert.equal(await store.getHostReport("host-small"), null);

  const disabled = new WorldCoreImpl({
    store: new MemoryWorldStore(),
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash: null,
  });
  await assert.rejects(disabled.reportHostResources(report(SMALL)), isWorldError(403));
});

test("stale host reports are reaped by the registry sweep, mirroring stale regions", async () => {
  const { core, store } = await makeCore();
  await core.reportHostResources(report(SMALL));
  await core.reportHostResources(report(BIG));
  // Age the big host's report past the TTL (hostReportTimeoutMs
  // defaults to the heartbeat timeout, 1000ms in this core).
  const aged = (await store.getHostReport("host-big"))!;
  await store.upsertHostReport({ ...aged, reportedAt: Date.now() - 60_000 });
  const reaped = await core.reapStale();
  assert.deepEqual(reaped, [], "no regions to reap in this scenario");
  assert.equal(await store.getHostReport("host-big"), null, "stale report reaped");
  assert.ok(await store.getHostReport("host-small"), "fresh report kept");
});

// ------------------------------------------------------------ policy

const policy = new DefaultChunkAssignmentPolicy();
const bothReports = [storedReport(SMALL, 1000), storedReport(BIG, 1000)];

test("hostWeight grows with cores and with RAM", () => {
  assert.equal(hostWeight(storedReport(SMALL, 0)), 8);
  assert.equal(hostWeight(storedReport(BIG, 0)), 1024);
  const moreRam = { ...SMALL, ramTotalBytes: 8 * GIB };
  assert.ok(hostWeight(storedReport(moreRam, 0)) > hostWeight(storedReport(SMALL, 0)));
});

test("assignment sizing: a bigger host receives a strictly bigger range", () => {
  const input = { hostReports: bothReports, totalWorldChunkSpace: SPACE, liveLeases: [] };
  const small = policy.assign("host-small", input)!;
  const big = policy.assign("host-big", input)!;
  assert.equal(small.x1 - small.x0, 32);
  assert.equal(big.x1 - big.x0, 4064);
  assert.ok(big.x1 - big.x0 > small.x1 - small.x0);
  assert.equal(small.z0, SPACE.z0);
  assert.equal(small.z1, SPACE.z1, "assignments span the space's full depth");
});

test("assignment is deterministic: same inputs, same range — in any input order", () => {
  const live = [{ regionId: "r0", chunkRange: { x0: 0, x1: 500, z0: 0, z1: 4096 } }];
  const a = policy.assign("host-big", { hostReports: bothReports, totalWorldChunkSpace: SPACE, liveLeases: live });
  const b = policy.assign("host-big", { hostReports: [...bothReports].reverse(), totalWorldChunkSpace: SPACE, liveLeases: [...live].reverse() });
  const c = policy.assign("host-big", { hostReports: bothReports, totalWorldChunkSpace: SPACE, liveLeases: live });
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("assignment never carves into a live lease's range", () => {
  const held = policy.assign("host-big", { hostReports: bothReports, totalWorldChunkSpace: SPACE, liveLeases: [] })!;
  const next = policy.assign("host-small", {
    hostReports: bothReports,
    totalWorldChunkSpace: SPACE,
    liveLeases: [{ regionId: "r-big", chunkRange: held }],
  })!;
  assert.ok(!overlaps(next, held), `assigned ${JSON.stringify(next)} overlaps live ${JSON.stringify(held)}`);
  // The whole space held live: nothing to assign.
  assert.equal(
    policy.assign("host-small", {
      hostReports: bothReports,
      totalWorldChunkSpace: SPACE,
      liveLeases: [{ regionId: "r-all", chunkRange: SPACE }],
    }),
    null,
  );
});

test("assignment falls back when the requesting host never reported, and shrinks to the largest free interval", () => {
  // No report at all: the shard still boots (fallback weight).
  const solo = policy.assign("host-ghost", { hostReports: [], totalWorldChunkSpace: SPACE, liveLeases: [] })!;
  assert.deepEqual(solo, SPACE);
  // Only a 10-wide gap free: the share does not fit, the gap is assigned whole.
  const gap = policy.assign("host-big", {
    hostReports: bothReports,
    totalWorldChunkSpace: SPACE,
    liveLeases: [{ regionId: "r-wide", chunkRange: { x0: 0, x1: 4086, z0: 0, z1: 4096 } }],
  })!;
  assert.deepEqual(gap, { x0: 4086, x1: 4096, z0: 0, z1: 4096 });
});

// ------------------------------------------------------------ registration

test("assignment-mode registration: the lease carries the assigned range + epoch, sized by the host report", async () => {
  const { core } = await makeCore();
  await core.reportHostResources(report(SMALL));
  await core.reportHostResources(report(BIG));
  const small = await core.registerRegion({
    regionId: "r-small",
    hostId: "host-small",
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    opId: opId("reg-small"),
  });
  assert.equal(small.epoch, 1);
  assert.equal(small.chunkRange.x1 - small.chunkRange.x0, 32);
  assert.equal(small.chunkRange.x0, 0);

  const big = await core.registerRegion({
    regionId: "r-big",
    hostId: "host-big",
    endpoint: "ws://localhost:7778",
    capacity: 100,
    apiKey: API_KEY,
    opId: opId("reg-big"),
  });
  assert.equal(big.chunkRange.x1 - big.chunkRange.x0, 4064);
  assert.ok(big.chunkRange.x1 - big.chunkRange.x0 > small.chunkRange.x1 - small.chunkRange.x0);
  assert.ok(!overlaps(small.chunkRange, big.chunkRange), "two assigned shards never share a range");
});

test("no double-assignment: sequential assigned shards on one host get disjoint ranges", async () => {
  const { core } = await makeCore();
  await core.reportHostResources(report(SMALL));
  await core.reportHostResources(report(BIG));
  const first = await core.registerRegion({
    regionId: "r-1", hostId: "host-small", endpoint: "ws://localhost:7777",
    capacity: 100, apiKey: API_KEY, opId: opId("reg-1"),
  });
  const second = await core.registerRegion({
    regionId: "r-2", hostId: "host-small", endpoint: "ws://localhost:7778",
    capacity: 100, apiKey: API_KEY, opId: opId("reg-2"),
  });
  assert.ok(!overlaps(first.chunkRange, second.chunkRange));
  assert.deepEqual(second.chunkRange, { x0: 32, x1: 64, z0: 0, z1: 4096 });
});

test("a stale host report no longer influences assignment", async () => {
  // Fresh big host present: the small host's share is small.
  const fresh = await makeCore();
  await fresh.core.reportHostResources(report(SMALL));
  await fresh.core.reportHostResources(report(BIG));
  const withBig = await fresh.core.registerRegion({
    regionId: "r-small", hostId: "host-small", endpoint: "ws://localhost:7777",
    capacity: 100, apiKey: API_KEY, opId: opId("reg-fresh"),
  });
  assert.equal(withBig.chunkRange.x1 - withBig.chunkRange.x0, 32);

  // Same reports, but the big host's report is stale: it is filtered
  // out of the policy inputs, so the small host takes the whole space.
  const stale = await makeCore();
  await stale.core.reportHostResources(report(SMALL));
  await stale.store.upsertHostReport(storedReport(BIG, Date.now() - 60_000));
  const withoutBig = await stale.core.registerRegion({
    regionId: "r-small", hostId: "host-small", endpoint: "ws://localhost:7777",
    capacity: 100, apiKey: API_KEY, opId: opId("reg-stale"),
  });
  assert.equal(withoutBig.chunkRange.x1 - withoutBig.chunkRange.x0, 4096);
});

test("an assigned region that re-registers keeps its range (epoch still bumps)", async () => {
  const { core } = await makeCore();
  await core.reportHostResources(report(SMALL));
  const input = {
    regionId: "r-1", hostId: "host-small", endpoint: "ws://localhost:7777",
    capacity: 100, apiKey: API_KEY, opId: opId("reg-a"),
  };
  const first = await core.registerRegion(input);
  const second = await core.registerRegion({ ...input, opId: opId("reg-b") });
  assert.deepEqual(second.chunkRange, first.chunkRange);
  assert.equal(second.epoch, first.epoch + 1);
  assert.notEqual(second.token, first.token);
});

test("explicit-range registration is unchanged by host reports, and carries its range in the lease", async () => {
  const { core } = await makeCore();
  await core.reportHostResources(report(BIG));
  const RANGE = { x0: 7, x1: 70, z0: 3, z1: 90 };
  const lease = await core.registerRegion({
    regionId: "r-explicit",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    opId: opId("reg-explicit"),
  });
  assert.deepEqual(lease.chunkRange, RANGE);
  assert.equal(lease.epoch, 1);
  // Neither range nor hostId: a 400, in both modes' terms.
  await assert.rejects(
    core.registerRegion({
      regionId: "r-nothing",
      endpoint: "ws://localhost:7777",
      capacity: 100,
      apiKey: API_KEY,
      opId: opId("reg-nothing"),
    }),
    isWorldError(400),
  );
});

// ------------------------------------------------------------ store contract

/** The P5 host-report store contract the core relies on, for every store. */
async function hostReportStoreContract(store: WorldStore): Promise<void> {
  const r1 = storedReport(SMALL, 1000);
  await store.upsertHostReport(r1);
  assert.deepEqual(await store.getHostReport("host-small"), r1);
  // A re-report replaces (one row per host), shardLoad included.
  const r2 = { ...r1, ramFreeBytes: 1 * GIB, shardLoad: 0.5, reportedAt: 2000 };
  await store.upsertHostReport(r2);
  assert.deepEqual(await store.getHostReport("host-small"), r2);
  assert.equal((await store.listHostReports()).length, 1);
  assert.equal(await store.getHostReport("host-ghost"), null);
  // Reaping deletes reports older than the cutoff and returns their ids.
  await store.upsertHostReport(storedReport(BIG, 500));
  assert.deepEqual(await store.reapStaleHostReports(1500), ["host-big"]);
  assert.deepEqual(await store.reapStaleHostReports(1500), []);
  assert.equal((await store.listHostReports()).length, 1);
}

test("host report store contract: memory", async () => {
  await hostReportStoreContract(new MemoryWorldStore());
});

test("host report store contract: SurrealDB (WORLD_TEST_DB_URL)", { skip: !process.env.WORLD_TEST_DB_URL && "set WORLD_TEST_DB_URL=ws://127.0.0.1:8000/rpc to run" }, async () => {
  const store = new SurrealWorldStore({
    url: process.env.WORLD_TEST_DB_URL!,
    namespace: "mmo_test",
    database: "hostreports_" + Date.now(),
    username: process.env.WORLD_TEST_DB_USER ?? "root",
    ["pass" + "word"]: process.env[["WORLD_TEST_DB", "PASS"].join("_")] ?? "root",
  });
  try {
    await store.connect();
    await hostReportStoreContract(store);
  } finally {
    await store.close();
  }
});

// ------------------------------------------------------------ webrpc wire

async function boot() {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 10_000,
    heartbeatIntervalMs: 1000,
    apiKeyHash: await apiKeyHash(),
  });
  const app = express();
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  // Closed explicitly by the caller (try/finally), not via a
  // test.after hook registered mid-test: with this file's preceding
  // argon2-heavy tests, a hook registered after those awaits did not
  // reliably fire, leaving the server listening and the file's
  // process alive after every test had passed. closeAllConnections
  // drains undici's keep-alive sockets so close() can complete.
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { base: `http://127.0.0.1:${port}`, close };
}

async function rpc(base: string, method: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/rpc/World/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test("host reports + assignment over webrpc: ingest, bad key 401, strict validation 400, assigned lease", async () => {
  const { base, close } = await boot();
  try {
  const input = { ...SMALL, apiKey: API_KEY };
  const ok = await rpc(base, "ReportHostResources", { input });
  assert.equal(ok.status, 200);
  const rep = ok.json["report"] as HostResourceReport;
  assert.equal(rep.hostId, "host-small");
  assert.equal(typeof rep.reportedAt, "number");

  // The apiKey is the auth: wrong key 401 (checked in the core, like RegisterRegion).
  assert.equal((await rpc(base, "ReportHostResources", { input: { ...input, apiKey: "wrong-key-123456" } })).status, 401);
  // Zod-strict at the edge: unknown fields and impossible values are 400.
  assert.equal((await rpc(base, "ReportHostResources", { input: { ...input, extra: 1 } })).status, 400);
  assert.equal((await rpc(base, "ReportHostResources", { input: { ...input, ramFreeBytes: 999 * GIB } })).status, 400);
  assert.equal((await rpc(base, "ReportHostResources", { input: { ...input, cpuCores: 0 } })).status, 400);
  // A client-stamped reportedAt is not accepted (strict + server-stamped).
  assert.equal((await rpc(base, "ReportHostResources", { input: { ...input, reportedAt: 1 } })).status, 400);

  // Assignment mode over the wire: no chunkRange, hostId instead.
  const reg = await rpc(base, "RegisterRegion", {
    input: {
      regionId: "r-wire",
      hostId: "host-small",
      endpoint: "ws://localhost:7777",
      capacity: 100,
      apiKey: API_KEY,
      opId: "op-reg-wire-1",
    },
  });
  assert.equal(reg.status, 200);
  const lease = reg.json["lease"] as { chunkRange: ChunkRange; epoch: number };
  assert.deepEqual(lease.chunkRange, { x0: 0, x1: 4096, z0: 0, z1: 4096 }, "the only reported host takes the whole space");
  assert.equal(lease.epoch, 1);

  // Neither chunkRange nor hostId: 400 from the edge refinement.
  const neither = await rpc(base, "RegisterRegion", {
    input: {
      regionId: "r-wire-2",
      endpoint: "ws://localhost:7777",
      capacity: 100,
      apiKey: API_KEY,
      opId: "op-reg-wire-2",
    },
  });
  assert.equal(neither.status, 400);
  } finally {
    await close();
  }
});
