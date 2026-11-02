/**
 * Slice C: accounts on the world server. The store contract runs against the memory store and
 * SurrealDB (embedded, or WORLD_TEST_DB_URL); the core's duplicate refusal, opId replay and region
 * checks run over the memory store; the webrpc routes run over HTTP with Zod-strict edges.
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
import type { AccountRecord, WorldStore } from "../src/types.js";
import { surrealTestOptions } from "./surreal-test-db.js";

const API_KEY = "accounts-test-key";

async function accountStoreContract(store: WorldStore): Promise<void> {
  assert.equal(await store.getAccount("ana"), null);
  const a: AccountRecord = { username: "ana", passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA", createdAt: 5 };
  await store.createAccount(a);
  assert.deepEqual(await store.getAccount("ana"), a);
  assert.equal(await store.getAccount("Ana"), null, "usernames are matched exactly");
  await assert.rejects(store.createAccount({ ...a, passwordHash: "other" }), "a second create of a username is refused");
  assert.deepEqual(await store.getAccount("ana"), a, "the refused create leaves the first account in place");
}

test("account store contract: memory", async () => {
  await accountStoreContract(new MemoryWorldStore());
});

test("account store contract: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("accounts_" + Date.now()));
  try {
    await store.connect();
    await accountStoreContract(store);
  } finally {
    await store.close();
  }
});

async function coreWithRegion() {
  const core = new WorldCoreImpl({
    store: new MemoryWorldStore(),
    heartbeatTimeoutMs: 60_000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  await core.registerRegion({
    regionId: "r1",
    chunkRange: { x0: 0, x1: 100, z0: 0, z1: 100 },
    endpoint: "ws://x",
    capacity: 10,
    apiKey: API_KEY,
    opId: "reg-r1",
  });
  return core;
}

test("core: create once, replay by opId, refuse a taken name, read back", async () => {
  const core = await coreWithRegion();
  const hash = await argon2.hash("secret-pass");
  const created = await core.createAccount("r1", { regionId: "r1", username: "ana", passwordHash: hash, opId: "op-1" });
  assert.equal(created.username, "ana");
  assert.equal(
    (await core.createAccount("r1", { regionId: "r1", username: "ana", passwordHash: hash, opId: "op-1" })).createdAt,
    created.createdAt,
    "a replayed opId returns its first result",
  );
  await assert.rejects(
    core.createAccount("r1", { regionId: "r1", username: "ana", passwordHash: hash, opId: "op-2" }),
    (e: { code?: number }) => e.code === 409,
    "a second account under the same name is 409",
  );
  assert.equal((await core.getAccount("r1", { regionId: "r1", username: "ana" }))?.passwordHash, hash);
  assert.equal(await core.getAccount("r1", { regionId: "r1", username: "nobody" }), null);
});

test("core: a region can only act as itself and must be registered", async () => {
  const core = await coreWithRegion();
  const hash = await argon2.hash("secret-pass");
  await assert.rejects(
    core.getAccount("r1", { regionId: "r2", username: "ana" }),
    (e: { code?: number }) => e.code === 403,
  );
  await assert.rejects(
    core.createAccount("ghost", { regionId: "ghost", username: "ana", passwordHash: hash, opId: "op-g" }),
    (e: { code?: number }) => e.code === 404,
  );
});

test("accounts over webrpc: create, read, 409 on a taken name, 403 for a foreign region, 400 on bad input", async () => {
  const core = await coreWithRegion();
  const app = express();
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  test.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await (async () => {
    const res = await fetch(`${base}/rpc/World/RegisterRegion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { regionId: "r9", chunkRange: { x0: 200, x1: 300, z0: 0, z1: 100 }, endpoint: "ws://y", capacity: 10, apiKey: API_KEY, opId: "op-reg-r9" } }),
    });
    return ((await res.json()) as { lease: { token: string } }).lease.token;
  })();
  const post = async (method: string, body: unknown, bearer = token) => {
    const res = await fetch(`${base}/rpc/World/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const hash = await argon2.hash("pw-over-wire");

  const made = await post("CreateAccount", { input: { regionId: "r9", username: "bo_1", passwordHash: hash, opId: "w-1" } });
  assert.equal(made.status, 200);
  assert.equal((made.json["account"] as AccountRecord).username, "bo_1");

  const read = await post("GetAccount", { input: { regionId: "r9", username: "bo_1" } });
  assert.equal(read.status, 200);
  assert.equal((read.json["account"] as AccountRecord).passwordHash, hash);

  const missing = await post("GetAccount", { input: { regionId: "r9", username: "nobody" } });
  assert.equal(missing.status, 200);
  assert.equal(missing.json["account"], null);

  const taken = await post("CreateAccount", { input: { regionId: "r9", username: "bo_1", passwordHash: hash, opId: "w-2" } });
  assert.equal(taken.status, 409);

  const foreign = await post("GetAccount", { input: { regionId: "r1", username: "bo_1" } });
  assert.equal(foreign.status, 403);

  const badName = await post("CreateAccount", { input: { regionId: "r9", username: "x", passwordHash: hash, opId: "w-3" } });
  assert.equal(badName.status, 400, "usernames keep the region's 3-32 character rule");

  const plain = await post("CreateAccount", { input: { regionId: "r9", username: "cy_2", passwordHash: "plaintext", opId: "w-4" } });
  assert.equal(plain.status, 400, "a password must arrive as an argon2id hash");

  const unauthed = await post("GetAccount", { input: { regionId: "r9", username: "bo_1" } }, "not-a-token");
  assert.equal(unauthed.status, 401);
});
