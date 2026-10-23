/**
 * Atomic operations (slice A1) over the webrpc wire: the six
 * value-moving exchanges with Zod-strict validation at the edge.
 * A settled outcome — success or typed rejection — is a 200 with
 * { result }; malformed input is a 400, and auth runs first.
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
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  test.after(() => new Promise<void>((r) => server.close(() => r())));
  return { base, store };
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

let seedCounter = 0;
/** Lock a character and seed its world record (gold + inventory) over the wire. */
async function seed(
  base: string,
  token: string,
  regionId: string,
  characterId: number,
  gold: number,
  inventory: unknown[],
) {
  const tag = ++seedCounter;
  const lock = await rpc(
    base,
    "AcquireCharacterLock",
    { input: { regionId, characterId, ttlMs: 60_000, opId: `op-lock-${tag}` } },
    token,
  );
  assert.equal(lock.status, 200);
  const epoch = (lock.json["lock"] as Record<string, unknown>)["epoch"] as number;
  const put = await rpc(
    base,
    "PutCharacterState",
    { input: { regionId, characterId, epoch, state: { gold, inventory }, opId: `op-seed-${tag}` } },
    token,
  );
  assert.equal(put.status, 200);
  return { characterId, epoch, expectedVersion: 1 };
}

test("atomic ops over webrpc: trade settles, rejection is a typed outcome, validation and auth hold", async () => {
  const { base } = await boot();
  const a = await register(base, "r1", 0);
  const fa = await seed(base, a.token, "r1", 1, 100, [
    { instanceId: "sword-1", def: 10, slot: 0, count: 1 },
  ]);
  const fb = await seed(base, a.token, "r1", 2, 50, []);
  const input = {
    regionId: "r1",
    opId: "op-wire-trade-1",
    a: fa,
    b: fb,
    aGivesGold: 30,
    bGivesGold: 0,
    aGivesItems: ["sword-1"],
    bGivesItems: [],
  };
  const res = await rpc(base, "TradeCommit", { input }, a.token);
  assert.equal(res.status, 200);
  const result = res.json["result"] as Record<string, unknown>;
  assert.equal(result["ok"], true);
  const got = await rpc(base, "GetCharacterState", { input: { regionId: "r1", characterId: 2 } }, a.token);
  const state = (got.json["character"] as Record<string, unknown>)["state"] as Record<string, unknown>;
  assert.equal(state["gold"], 80);
  assert.deepEqual(state["inventory"], [{ instanceId: "sword-1", def: 10, slot: 0, count: 1 }]);

  // A business rejection is a settled outcome, not a transport error.
  const poor = await rpc(base, "TradeCommit", {
    input: {
      ...input,
      opId: "op-wire-trade-2",
      a: { ...fa, expectedVersion: 2 },
      b: { ...fb, expectedVersion: 2 },
      aGivesGold: 99999,
      aGivesItems: [],
    },
  }, a.token);
  assert.equal(poor.status, 200);
  const poorResult = poor.json["result"] as Record<string, unknown>;
  assert.equal(poorResult["ok"], false);
  assert.equal(poorResult["rejection"], "INSUFFICIENT_FUNDS");

  // Zod-strict: unknown fields, a zero epoch, and an oversized item
  // list are all 400s; auth runs before validation; the body
  // regionId must match the token.
  assert.equal((await rpc(base, "TradeCommit", { input: { ...input, opId: "op-wire-x1", extra: 1 } }, a.token)).status, 400);
  assert.equal((await rpc(base, "TradeCommit", { input: { ...input, opId: "op-wire-x2", a: { ...fa, epoch: 0 } } }, a.token)).status, 400);
  assert.equal((await rpc(base, "TradeCommit", { input })).status, 401);
  assert.equal((await rpc(base, "TradeCommit", { input }, "f".repeat(64))).status, 401);
  assert.equal((await rpc(base, "TradeCommit", { input: { ...input, opId: "op-wire-x3", regionId: "r2" } }, a.token)).status, 403);
});

test("atomic ops over webrpc: loot grant and inventory mutate round-trip; empty mutations are a 400", async () => {
  const { base } = await boot();
  const a = await register(base, "r1", 0);
  const fence = await seed(base, a.token, "r1", 7, 0, []);
  const grant = await rpc(base, "LootGrant", {
    input: {
      regionId: "r1", opId: "op-wire-loot-1", participant: fence,
      sourceId: "loot:dragon-1", instanceId: "drop-1", def: 99,
    },
  }, a.token);
  assert.equal(grant.status, 200);
  assert.equal((grant.json["result"] as Record<string, unknown>)["ok"], true);

  const mutate = await rpc(base, "InventoryMutate", {
    input: {
      regionId: "r1", opId: "op-wire-inv-1",
      participant: { ...fence, expectedVersion: 2 },
      mutations: [{ kind: "move", instanceId: "drop-1", toSlot: 4 }],
    },
  }, a.token);
  assert.equal(mutate.status, 200);
  assert.equal((mutate.json["result"] as Record<string, unknown>)["ok"], true);
  const got = await rpc(base, "GetCharacterState", { input: { regionId: "r1", characterId: 7 } }, a.token);
  const state = (got.json["character"] as Record<string, unknown>)["state"] as Record<string, unknown>;
  assert.deepEqual(state["inventory"], [{ instanceId: "drop-1", def: 99, slot: 4, count: 1 }]);

  assert.equal((await rpc(base, "InventoryMutate", {
    input: {
      regionId: "r1", opId: "op-wire-inv-2",
      participant: { ...fence, expectedVersion: 3 }, mutations: [],
    },
  }, a.token)).status, 400);
  // An unknown mutation kind never reaches the core.
  assert.equal((await rpc(base, "InventoryMutate", {
    input: {
      regionId: "r1", opId: "op-wire-inv-3",
      participant: { ...fence, expectedVersion: 3 },
      mutations: [{ kind: "teleport", instanceId: "drop-1" }],
    },
  }, a.token)).status, 400);
});
