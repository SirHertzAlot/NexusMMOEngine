/**
 * Slice C, region side: WorldCredentialStore reads and creates accounts at the world, caches hits,
 * copies CSV-only accounts up on first sign-in, and reports a taken name as "already exists".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WorldCredentialStore, type WorldAccountClient } from "../src/auth/world-credentials.js";
import { WorldTransportError } from "../src/world/client.js";
import type { CredentialRecord, CredentialStore } from "../src/auth/credentials.js";

class FakeWorldAccounts implements WorldAccountClient {
  readonly rows = new Map<string, { username: string; passwordHash: string; createdAt: number }>();
  gets = 0;
  creates = 0;
  async getAccount(username: string) {
    this.gets++;
    return this.rows.get(username) ?? null;
  }
  async createAccount(username: string, passwordHash: string) {
    this.creates++;
    if (this.rows.has(username)) throw new WorldTransportError(409, `account ${username} already exists`);
    const row = { username, passwordHash, createdAt: 1 };
    this.rows.set(username, row);
    return row;
  }
}

class MapCsv implements CredentialStore {
  constructor(readonly rows: Map<string, string>) {}
  async findUser(username: string): Promise<CredentialRecord | null> {
    const h = this.rows.get(username);
    return h === undefined ? null : { username, passwordHash: h };
  }
  async createUser(username: string, passwordHash: string): Promise<void> {
    this.rows.set(username, passwordHash);
  }
}

test("a world account is found and cached; a miss is not cached", async () => {
  const world = new FakeWorldAccounts();
  world.rows.set("ana", { username: "ana", passwordHash: "$argon2id$h1", createdAt: 1 });
  const store = new WorldCredentialStore(world);
  assert.deepEqual(await store.findUser("ana"), { username: "ana", passwordHash: "$argon2id$h1" });
  await store.findUser("ana");
  assert.equal(world.gets, 1, "a hit is served from the cache");
  assert.equal(await store.findUser("bo"), null);
  world.rows.set("bo", { username: "bo", passwordHash: "$argon2id$h2", createdAt: 1 });
  assert.equal((await store.findUser("bo"))?.passwordHash, "$argon2id$h2", "a miss is looked up again");
});

test("createUser writes to the world; a taken name throws 'already exists'", async () => {
  const world = new FakeWorldAccounts();
  const store = new WorldCredentialStore(world);
  await store.createUser("cy", "$argon2id$h3");
  assert.equal(world.rows.get("cy")?.passwordHash, "$argon2id$h3");
  await assert.rejects(store.createUser("cy", "$argon2id$h4"), /already exists/);
  assert.equal(world.rows.get("cy")?.passwordHash, "$argon2id$h3", "the first hash stands");
});

test("a CSV-only account is copied to the world on first sign-in", async () => {
  const world = new FakeWorldAccounts();
  const csv = new MapCsv(new Map([["dee", "$argon2id$old"]]));
  const store = new WorldCredentialStore(world, csv);
  assert.equal((await store.findUser("dee"))?.passwordHash, "$argon2id$old");
  assert.equal(world.rows.get("dee")?.passwordHash, "$argon2id$old", "copied up");
  const fresh = new WorldCredentialStore(world, new MapCsv(new Map()));
  assert.equal((await fresh.findUser("dee"))?.passwordHash, "$argon2id$old", "the world now answers");
});

test("a copy that loses a race to another region is still a hit", async () => {
  const world = new FakeWorldAccounts();
  // The world looks empty on the first read, then another region copies "eve" up first.
  let firstRead = true;
  const racing: WorldAccountClient = {
    getAccount: async (username) => {
      if (firstRead) {
        firstRead = false;
        world.rows.set(username, { username, passwordHash: "$argon2id$x", createdAt: 1 });
        return null;
      }
      return world.getAccount(username);
    },
    createAccount: (username, hash) => world.createAccount(username, hash),
  };
  const store = new WorldCredentialStore(racing, new MapCsv(new Map([["eve", "$argon2id$x"]])));
  assert.equal((await store.findUser("eve"))?.passwordHash, "$argon2id$x");
});

test("a world outage is an error, not a silent miss", async () => {
  const world: WorldAccountClient = {
    getAccount: async () => {
      throw new WorldTransportError(0, "world unreachable");
    },
    createAccount: async () => {
      throw new WorldTransportError(0, "world unreachable");
    },
  };
  await assert.rejects(new WorldCredentialStore(world).findUser("ana"), /unreachable/);
});
