import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import express from "express";
import type { AddressInfo } from "node:net";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { createWebrpcRouter } from "../src/adapters/webrpc.js";

const API_KEY = "test-bootstrap-key-123";

async function boot() {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 10_000,
    heartbeatIntervalMs: 1000,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  test.after(() => new Promise<void>((r) => server.close(() => r())));
  return { base };
}

async function rpc(
  base: string,
  method: string,
  body: unknown,
  token?: string,
  contentType = "application/json",
) {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/rpc/World/${method}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

const REG_INPUT = {
  regionId: "r1",
  chunkRange: { x0: 0, x1: 100, z0: 0, z1: 100 },
  endpoint: "ws://localhost:7777",
  capacity: 1000,
  apiKey: API_KEY,
  opId: "op-1",
};

test("healthz answers", async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

test("full region lifecycle over the webrpc wire protocol", async () => {
  const { base } = await boot();

  const reg = await rpc(base, "RegisterRegion", { input: REG_INPUT });
  assert.equal(reg.status, 200);
  const lease = reg.json["lease"] as Record<string, unknown>;
  assert.equal(lease["regionId"], "r1");
  const token = lease["token"] as string;
  assert.match(token, /^[0-9a-f]{64}$/);

  const hb = await rpc(
    base,
    "Heartbeat",
    { input: { regionId: "r1", load: 0.1, tickJitterMs: 1, entityCount: 3 } },
    token,
  );
  assert.equal(hb.status, 200);
  assert.equal((hb.json["ack"] as Record<string, unknown>)["ok"], true);

  const snap = await rpc(
    base,
    "ReportSnapshot",
    { input: { regionId: "r1", tick: 300, entityCount: 3, digest: "deadbeef" } },
    token,
  );
  assert.equal(snap.status, 200);

  const dereg = await rpc(
    base,
    "DeregisterRegion",
    { regionId: "r1", opId: "op-2" },
    token,
  );
  assert.equal(dereg.status, 200);

  const hb2 = await rpc(
    base,
    "Heartbeat",
    { input: { regionId: "r1", load: 0, tickJitterMs: 0, entityCount: 0 } },
    token,
  );
  // The region is gone, so its bearer token is revoked: 401, not 404.
  assert.equal(hb2.status, 401);
});

test("register rejects a bad api key with 401 + webrpc error envelope", async () => {
  const { base } = await boot();
  const res = await rpc(base, "RegisterRegion", {
    input: { ...REG_INPUT, apiKey: "nope-nope-nope" },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json["code"], 401);
  assert.ok(typeof res.json["msg"] === "string");
});

test("register rejects invalid payloads with 400", async () => {
  const { base } = await boot();
  const res = await rpc(base, "RegisterRegion", {
    input: { ...REG_INPUT, chunkRange: { x0: 10, x1: 5, z0: 0, z1: 1 } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json["code"], 400);
});

test("authenticated methods require a bearer token", async () => {
  const { base } = await boot();
  const noToken = await rpc(base, "Heartbeat", {
    input: { regionId: "r1", load: 0, tickJitterMs: 0, entityCount: 0 },
  });
  assert.equal(noToken.status, 401);

  const badToken = await rpc(
    base,
    "Heartbeat",
    { input: { regionId: "r1", load: 0, tickJitterMs: 0, entityCount: 0 } },
    "f".repeat(64),
  );
  assert.equal(badToken.status, 401);
});

test("regionId must match the bearer token", async () => {
  const { base } = await boot();
  const reg = await rpc(base, "RegisterRegion", { input: REG_INPUT });
  const token = (reg.json["lease"] as Record<string, unknown>)["token"] as string;
  const res = await rpc(
    base,
    "Heartbeat",
    { input: { regionId: "r2", load: 0, tickJitterMs: 0, entityCount: 0 } },
    token,
  );
  assert.equal(res.status, 403);
});

test("slice B methods authenticate first", async () => {
  const { base } = await boot();
  for (const m of ["ListRegions", "BeginMigration", "CommitMigration", "AbortMigration", "GetMigration"]) {
    const noToken = await rpc(base, m, {});
    assert.equal(noToken.status, 401, m);
    const badToken = await rpc(base, m, {}, "f".repeat(64));
    assert.equal(badToken.status, 401, m);
  }
});

test("migration over webrpc: list, begin, read, commit; wrong party 403; bad input 400", async () => {
  const { base } = await boot();
  const tok = async (regionId: string, x0: number) => {
    const r = await rpc(base, "RegisterRegion", { input: { ...REG_INPUT, regionId, chunkRange: { x0, x1: x0 + 100, z0: 0, z1: 100 }, opId: "op-reg-" + regionId } });
    return (r.json["lease"] as Record<string, unknown>)["token"] as string;
  };
  const a = await tok("ra", 0);
  const b = await tok("rb", 100);

  const list = await rpc(base, "ListRegions", {}, a);
  assert.deepEqual((list.json["regions"] as Array<{ regionId: string; live: boolean }>).map((r) => [r.regionId, r.live]), [["ra", true], ["rb", true]]);
  assert.ok(!JSON.stringify(list.json).includes("Hash"), "no hashes leak");

  const input = { opId: "op-m1", entityId: "player:9", fromRegion: "ra", toRegion: "rb", entityState: { hp: 5 } };
  assert.equal((await rpc(base, "BeginMigration", { input }, b)).status, 403, "only the source begins");
  const begun = await rpc(base, "BeginMigration", { input }, a);
  assert.equal(begun.status, 200);
  const migrationId = begun.json["migrationId"] as string;
  assert.match(migrationId, /^mig-[0-9a-f]{24}$/);

  const got = await rpc(base, "GetMigration", { migrationId }, b);
  assert.deepEqual((got.json["migration"] as Record<string, unknown>)["entityState"], { hp: 5 });
  assert.equal((await rpc(base, "CommitMigration", { migrationId, opId: "op-c1" }, a)).status, 403, "only the target commits");
  assert.equal((await rpc(base, "CommitMigration", { migrationId, opId: "op-c1" }, b)).status, 200);
  assert.equal((await rpc(base, "AbortMigration", { migrationId, opId: "op-a1", reason: "late" }, a)).status, 409);

  // Validation: strict shapes, bounded state, well-formed ids.
  assert.equal((await rpc(base, "BeginMigration", { input: { ...input, opId: "op-m2", extra: 1 } }, a)).status, 400);
  assert.equal((await rpc(base, "BeginMigration", { input: { ...input, opId: "op-m3", entityState: "not an object" } }, a)).status, 400);
  const big = { blob: "x".repeat(70 * 1024) };
  const tooBig = await rpc(base, "BeginMigration", { input: { ...input, opId: "op-m4", entityId: "player:10", entityState: big } }, a);
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.json["msg"] as string, /entityState/);
  assert.equal((await rpc(base, "CommitMigration", { migrationId: "mig-nope", opId: "op-c2" }, b)).status, 400);
});

test("dungeon results over webrpc: ingest, idempotent replay, bad input 400", async () => {
  const { base } = await boot();
  const reg = await rpc(base, "RegisterRegion", { input: REG_INPUT });
  const token = (reg.json["lease"] as Record<string, unknown>)["token"] as string;
  const results = [{
    instance: "run-abc",
    dungeon: "grim-1",
    entrance: "barrow-gate",
    outcome: "cleared",
    startedAt: 1000,
    endedAt: 2000,
    members: [7],
    kills: [{ characterId: 7, kind: "goblin", count: 2 }],
    deaths: [],
    loot: [{ characterId: 7, def: 11 }],
  }];
  const first = await rpc(base, "ReportDungeonResults", { input: { regionId: "r1", results } }, token);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json["ingested"], ["run-abc"]);
  const replay = await rpc(base, "ReportDungeonResults", { input: { regionId: "r1", results } }, token);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json["ingested"], ["run-abc"]);
  const bad = await rpc(base, "ReportDungeonResults", { input: { regionId: "r1", results: [{ ...results[0], outcome: "exploded" }] } }, token);
  assert.equal(bad.status, 400);
  const noToken = await rpc(base, "ReportDungeonResults", { input: { regionId: "r1", results } });
  assert.equal(noToken.status, 401);
});

test("presence over webrpc: report, query, bad input 400", async () => {
  const { base } = await boot();
  const reg = await rpc(base, "RegisterRegion", { input: REG_INPUT });
  const token = (reg.json["lease"] as Record<string, unknown>)["token"] as string;
  const set = await rpc(base, "SetPresence", { input: { regionId: "r1", names: ["Aria"] } }, token);
  assert.equal(set.status, 200);
  const got = await rpc(base, "QueryPresence", { input: { regionId: "r1", names: ["Aria", "Nobody"] } }, token);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json["online"], { Aria: "r1", Nobody: null });
  const bad = await rpc(base, "SetPresence", { input: { regionId: "r1", names: [""] } }, token);
  assert.equal(bad.status, 400);
  const noToken = await rpc(base, "QueryPresence", { input: { regionId: "r1", names: ["Aria"] } });
  assert.equal(noToken.status, 401);
});

test("non-JSON content-type is rejected with 415", async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/rpc/World/RegisterRegion`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello",
  });
  assert.equal(res.status, 415);
});
