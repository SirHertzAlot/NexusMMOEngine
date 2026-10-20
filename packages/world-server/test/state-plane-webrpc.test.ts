/**
 * Persistence layer P1 over the webrpc wire: epoch-fenced shard
 * snapshots, the ledger stream, and character records + session locks,
 * with Zod-strict validation at the edge.
 */
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
  app.use(express.json({ limit: "256kb" }));
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  test.after(() => new Promise<void>((r) => server.close(() => r())));
  return { base };
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

let regCounter = 0;
async function register(base: string, regionId: string, x0: number) {
  const res = await rpc(base, "RegisterRegion", {
    input: {
      regionId,
      chunkRange: { x0, x1: x0 + 100, z0: 0, z1: 100 },
      endpoint: "ws://localhost:7777",
      capacity: 1000,
      apiKey: API_KEY,
      opId: `op-reg-${regionId}-${++regCounter}`,
    },
  });
  assert.equal(res.status, 200);
  return res.json["lease"] as { token: string; epoch: number; regionId: string };
}

test("state plane over webrpc: snapshot put/get, stale epoch 409, bad input 400, auth first", async () => {
  const { base } = await boot();
  const lease = await register(base, "r1", 0);
  assert.equal(lease.epoch, 1);
  const key = "0:100:0:100";
  const input = {
    regionId: "r1",
    rangeKey: key,
    tick: 300,
    epoch: lease.epoch,
    digest: "deadbeef",
    payload: { entities: [1, 2] },
    opId: "op-snap-1",
  };
  const put = await rpc(base, "PutShardSnapshot", { input }, lease.token);
  assert.equal(put.status, 200);
  assert.equal((put.json["snapshot"] as Record<string, unknown>)["tick"], 300);

  const got = await rpc(base, "GetShardSnapshot", { input: { regionId: "r1", rangeKey: key } }, lease.token);
  assert.equal(got.status, 200);
  assert.deepEqual((got.json["snapshot"] as Record<string, unknown>)["payload"], { entities: [1, 2] });
  const none = await rpc(base, "GetShardSnapshot", { input: { regionId: "r1", rangeKey: "100:200:0:100" } }, lease.token);
  assert.equal(none.status, 200);
  assert.equal(none.json["snapshot"], null);

  // Re-register: new token, epoch 2. Writing at epoch 1 is fenced (409).
  const lease2 = await register(base, "r1", 0);
  assert.equal(lease2.epoch, 2);
  const stale = await rpc(base, "PutShardSnapshot", { input: { ...input, opId: "op-snap-2", tick: 600 } }, lease2.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.json["code"], 409);

  // Validation: strict shape, well-formed rangeKey, epoch >= 1.
  assert.equal((await rpc(base, "PutShardSnapshot", { input: { ...input, opId: "op-snap-3", epoch: 2, extra: 1 } }, lease2.token)).status, 400);
  assert.equal((await rpc(base, "PutShardSnapshot", { input: { ...input, opId: "op-snap-4", epoch: 2, rangeKey: "r1" } }, lease2.token)).status, 400);
  assert.equal((await rpc(base, "PutShardSnapshot", { input: { ...input, opId: "op-snap-5", epoch: 0 } }, lease2.token)).status, 400);

  // Auth before validation, and the body regionId must match the token.
  assert.equal((await rpc(base, "PutShardSnapshot", { input })).status, 401);
  assert.equal((await rpc(base, "PutShardSnapshot", { input }, "f".repeat(64))).status, 401);
  assert.equal((await rpc(base, "PutShardSnapshot", { input: { ...input, regionId: "r2" } }, lease2.token)).status, 403);
});

test("ledger over webrpc: append acks the head, reads return the tail", async () => {
  const { base } = await boot();
  const lease = await register(base, "r1", 0);
  const key = "0:100:0:100";
  const append = {
    regionId: "r1",
    rangeKey: key,
    epoch: lease.epoch,
    opId: "op-led-1",
    events: [
      { seq: 1, tick: 10, payload: { item: 1 } },
      { seq: 2, tick: 20, payload: { item: 2 } },
    ],
  };
  const first = await rpc(base, "AppendLedgerEvents", { input: append }, lease.token);
  assert.equal(first.status, 200);
  assert.equal(first.json["ackedSeq"], 2);
  const replay = await rpc(base, "AppendLedgerEvents", { input: { ...append, opId: "op-led-2" } }, lease.token);
  assert.equal(replay.json["ackedSeq"], 2);
  const head = await rpc(base, "GetLedgerHead", { input: { regionId: "r1", rangeKey: key } }, lease.token);
  assert.equal(head.json["ackedSeq"], 2);
  const tail = await rpc(base, "GetLedgerEvents", { input: { regionId: "r1", rangeKey: key, afterSeq: 1 } }, lease.token);
  assert.deepEqual((tail.json["events"] as Array<Record<string, unknown>>).map((e) => e["seq"]), [2]);
  const bad = await rpc(base, "AppendLedgerEvents", { input: { ...append, opId: "op-led-3", events: [{ seq: 0, tick: 1, payload: {} }] } }, lease.token);
  assert.equal(bad.status, 400);
  assert.equal((await rpc(base, "GetLedgerHead", { input: { regionId: "r1", rangeKey: key } })).status, 401);
});

test("characters over webrpc: lock, versioned put, conflict 409, release", async () => {
  const { base } = await boot();
  const a = await register(base, "r1", 0);
  const b = await register(base, "r2", 100);
  const lockIn = { regionId: "r1", characterId: 7, ttlMs: 60_000, opId: "op-lock-1" };
  const lock = await rpc(base, "AcquireCharacterLock", { input: lockIn }, a.token);
  assert.equal(lock.status, 200);
  assert.equal((lock.json["lock"] as Record<string, unknown>)["epoch"], 1);
  // Contended acquire from another region: 409.
  const contended = await rpc(base, "AcquireCharacterLock", { input: { ...lockIn, regionId: "r2", opId: "op-lock-2" } }, b.token);
  assert.equal(contended.status, 409);

  const putIn = { regionId: "r1", characterId: 7, epoch: 1, state: { hp: 10 }, opId: "op-char-1" };
  const put = await rpc(base, "PutCharacterState", { input: putIn }, a.token);
  assert.equal(put.status, 200);
  assert.equal((put.json["character"] as Record<string, unknown>)["version"], 1);
  const got = await rpc(base, "GetCharacterState", { input: { regionId: "r2", characterId: 7 } }, b.token);
  assert.deepEqual((got.json["character"] as Record<string, unknown>)["state"], { hp: 10 });

  const rel = await rpc(base, "ReleaseCharacterLock", { input: { regionId: "r1", characterId: 7, epoch: 1, opId: "op-rel-1" } }, a.token);
  assert.equal(rel.status, 200);
  const lockAfter = await rpc(base, "GetCharacterLock", { input: { regionId: "r1", characterId: 7 } }, a.token);
  assert.equal(lockAfter.json["lock"], null);
  const bad = await rpc(base, "AcquireCharacterLock", { input: { ...lockIn, opId: "op-lock-3", ttlMs: 0 } }, a.token);
  assert.equal(bad.status, 400);
});
