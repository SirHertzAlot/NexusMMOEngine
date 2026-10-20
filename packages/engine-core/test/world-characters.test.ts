/**
 * Persistence P4: global characters at the world tier.
 *
 * - WorldCharacterSync against a fake transport backed by the REAL
 *   world core (WorldCoreImpl + MemoryWorldStore): login acquires the
 *   session lock and seeds the local cache from the world record,
 *   working saves write uphill fenced by the lock epoch, logout
 *   commits finally and releases; steal-after-expiry fences the stale
 *   holder's writes.
 * - Gateway level (two gateways, one world): a second login for the
 *   same character is refused (4005 in character selection) while the
 *   lock is held, and succeeds after the holder logs out — entering
 *   with the world record's state. Migration: the destination's
 *   migration hello is refused until the source's commit path has
 *   released the lock; after reacquisition the character is playable
 *   there and nowhere else.
 * - Standalone (no worldCharacters on the gateway): the full local
 *   flow runs and a counting world client is never touched.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import * as argon2 from "argon2";
import express from "express";
import {
  decodeControl,
  encodeControl,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type ByeMessage,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import {
  MemoryWorldStore,
  WorldCoreImpl,
  WorldError,
  createWebrpcRouter,
  type CharacterStateRecord,
  type CharacterSessionLock,
} from "@mmo-engine/world-server";
import { Gateway } from "../src/net/gateway.js";
import * as C from "../src/components.js";
import { MemoryCharacterStore } from "../src/index.js";
import type { CharacterState } from "../src/characters/store.js";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";
import { WebrpcWorldTransport } from "../src/world/webrpc-transport.js";
import {
  WorldCharacterSync,
  parseWorldCharacterState,
  type CharacterWorldClient,
} from "../src/world/character-sync.js";
import { MigrationCoordinator, type MigrationEvent } from "../src/world/migration.js";
import { HeadlessClient } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

const RANGE_A = { x0: 0, z0: 0, x1: 100, z1: 100 };
const RANGE_B = { x0: 100, z0: 0, x1: 200, z1: 100 };
const API_KEY = "p4-test-bootstrap-key";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Cleanups run newest first, so regions deregister before the world closes. */
function cleanups(t: TestContext): (fn: () => Promise<unknown> | unknown) => void {
  const fns: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => {
    for (const fn of fns.reverse()) await fn();
  });
  return (fn) => fns.push(fn);
}

async function until(fn: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Fake transport backed by the real world core + in-memory store
// ---------------------------------------------------------------------------

class CoreTransport implements WorldTransport {
  constructor(private readonly core: WorldCoreImpl) {}

  private input(args: Record<string, unknown>): Record<string, any> {
    return (args["input"] ?? args) as Record<string, any>;
  }

  private async caller(token: string | undefined): Promise<string> {
    const regionId = token ? await this.core.authenticate(token) : null;
    if (!regionId) throw new WorldTransportError(401, "unauthorized");
    return regionId;
  }

  async call(
    method: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const input = this.input(args);
      switch (method) {
        case "RegisterRegion":
          return { lease: await this.core.registerRegion(input as never) };
        case "DeregisterRegion": {
          const caller = await this.caller(token);
          await this.core.deregisterRegion(caller, String(args["opId"] ?? input["opId"]));
          return {};
        }
        case "Heartbeat": {
          const caller = await this.caller(token);
          if (caller !== input["regionId"]) {
            throw new WorldTransportError(403, "regionId does not match token");
          }
          return { ack: await this.core.heartbeat(input as never) };
        }
        case "AcquireCharacterLock":
          return {
            lock: await this.core.acquireCharacterLock(
              await this.caller(token),
              input as never,
            ),
          };
        case "ReleaseCharacterLock":
          await this.core.releaseCharacterLock(
            await this.caller(token),
            input as never,
          );
          return {};
        case "GetCharacterState":
          return {
            character: await this.core.getCharacterState(
              await this.caller(token),
              input as never,
            ),
          };
        case "PutCharacterState":
          return {
            character: await this.core.putCharacterState(
              await this.caller(token),
              input as never,
            ),
          };
        default:
          throw new WorldTransportError(501, `${method} not implemented by fake transport`);
      }
    } catch (err) {
      if (err instanceof WorldError) {
        throw new WorldTransportError(err.code, err.message);
      }
      throw err;
    }
  }
}

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

interface WorldRig {
  store: MemoryWorldStore;
  transport: CoreTransport;
}

async function makeWorld(): Promise<WorldRig> {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 60_000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await apiKeyHash(),
  });
  return { store, transport: new CoreTransport(core) };
}

function makeClient(
  transport: WorldTransport,
  regionId: string,
  range: typeof RANGE_A,
): WorldClient {
  return new WorldClient({
    transport,
    regionId,
    chunkRange: range,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
}

function makeSync(
  client: WorldClient,
  store: MemoryCharacterStore,
  logs: string[],
  lockTtlMs?: number,
): WorldCharacterSync {
  return new WorldCharacterSync({
    client,
    store,
    lockTtlMs,
    log: (l) => logs.push(l),
  });
}

const STATE_A: CharacterState = { x: 1, y: 2, z: 3, health: 50, stamina: 60 };

// ---------------------------------------------------------------------------
// Sync level: lock, seed, uphill saves, logout
// ---------------------------------------------------------------------------

test("login locks + falls back to local, saves go uphill, logout commits + releases, next login seeds from the world", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());

  const storeA = new MemoryCharacterStore();
  const storeB = new MemoryCharacterStore();
  const logsA: string[] = [];
  const logsB: string[] = [];
  const syncA = makeSync(clientA, storeA, logsA);
  const syncB = makeSync(clientB, storeB, logsB);

  // A pre-existing local character, never seen by the world.
  storeA.saveState(7, STATE_A);
  storeA.saveSkills(7, { sword: [10, 20, 123] });

  const loginA = await syncA.login(7);
  assert.deepEqual(loginA, { ok: true, seeded: false }, "no world record: local record stands");
  assert.deepEqual(storeA.loadState(7), STATE_A, "local cache untouched by the fallback login");
  const epochA = syncA.lockEpoch(7);
  assert.equal(epochA, 1);
  assert.equal((await worldStore.getCharacterLock(7))?.regionId, "region-a");

  // While A holds the lock, B's login for the same character is refused.
  assert.equal((await syncB.login(7)).ok, false);
  assert.ok(logsB.some((l) => l.includes("login refused")));

  // Working saves establish, then advance, the world record.
  assert.equal(await syncA.save(7), true);
  let record = await worldStore.getCharacterState(7);
  assert.equal(record?.version, 1);
  assert.deepEqual(parseWorldCharacterState(record?.state), {
    state: STATE_A,
    skills: { sword: [10, 20, 123] },
  });
  storeA.saveState(7, { ...STATE_A, x: 9 });
  assert.equal(await syncA.save(7), true);
  record = await worldStore.getCharacterState(7);
  assert.equal(record?.version, 2);

  // Logout: a final commit (the newest local state) + lock release.
  storeA.saveState(7, { ...STATE_A, x: 11, health: 44 });
  assert.equal(await syncA.logout(7), true);
  record = await worldStore.getCharacterState(7);
  assert.equal(record?.version, 3, "logout's final commit advanced the version");
  assert.equal(parseWorldCharacterState(record?.state)?.state?.x, 11);
  assert.equal(await worldStore.getCharacterLock(7), null, "lock released");
  assert.equal(syncA.lockEpoch(7), null);

  // B can now log the character in — and the world record seeds its
  // local cache before anything restores from it.
  const loginB = await syncB.login(7);
  assert.deepEqual(loginB, { ok: true, seeded: true });
  assert.deepEqual(storeB.loadState(7), { ...STATE_A, x: 11, health: 44 });
  assert.deepEqual(storeB.loadSkills(7), { sword: [10, 20, 123] });
  assert.ok((syncB.lockEpoch(7) ?? 0) > (epochA ?? 0), "fresh epoch for the new holder");
  assert.equal((await worldStore.getCharacterLock(7))?.regionId, "region-b");
  assert.equal(await syncB.logout(7), true);
});

test("steal-after-expiry: the new holder's epoch bumps and the stale holder is fenced out of uphill writes", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());

  const storeA = new MemoryCharacterStore();
  const storeB = new MemoryCharacterStore();
  const logsA: string[] = [];
  const syncA = makeSync(clientA, storeA, logsA, 150); // dies silently after 150 ms
  const syncB = makeSync(clientB, storeB, []);

  storeA.saveState(9, STATE_A);
  assert.equal((await syncA.login(9)).ok, true);
  const epochA = syncA.lockEpoch(9)!;
  assert.equal(await syncA.save(9), true);
  assert.equal((await worldStore.getCharacterState(9))?.version, 1);

  // A goes silent; its lock expires and B steals it with a bumped epoch.
  await sleep(250);
  assert.equal((await syncB.login(9)).ok, true);
  const epochB = syncB.lockEpoch(9)!;
  assert.ok(epochB > epochA, `epoch bumped on steal (${epochA} -> ${epochB})`);
  storeB.saveState(9, { ...STATE_A, x: 2 });
  assert.equal(await syncB.save(9), true);
  assert.equal((await worldStore.getCharacterState(9))?.version, 2);

  // The stale holder's subsequent writes are fenced — at the sync
  // level (renewal refused, writes stop, logged as a durability
  // failure) and mechanically at the world (stale epoch rejected).
  storeA.saveState(9, { ...STATE_A, x: 666 });
  assert.equal(await syncA.save(9), false);
  assert.equal(syncA.isFenced(9), true);
  assert.ok(logsA.some((l) => l.includes("DURABILITY FAILURE")));
  const after = await worldStore.getCharacterState(9);
  assert.equal(after?.version, 2, "the stale holder overwrote nothing");
  assert.equal(parseWorldCharacterState(after?.state)?.state?.x, 2);
  await assert.rejects(
    clientA.putCharacterState(9, epochA, { state: { ...STATE_A, x: 666 }, skills: null }),
    // The world fences the put: the lock is another region's now (403).
    (err: unknown) => err instanceof WorldTransportError && err.code === 403,
  );
  assert.equal(await syncB.logout(9), true);
});

test("a corrupt world record never displaces the local cache at login", async () => {
  const fake: CharacterWorldClient = {
    async acquireCharacterLock(characterId): Promise<CharacterSessionLock> {
      return { characterId, regionId: "region-a", epoch: 1, expiresAt: Date.now() + 60_000 };
    },
    async getCharacterState(): Promise<CharacterStateRecord> {
      return {
        characterId: 5,
        state: { state: { x: "not-a-number" }, skills: null },
        version: 3,
        epoch: 1,
        regionId: "region-a",
        updatedAt: 1,
      };
    },
    async putCharacterState(): Promise<CharacterStateRecord> {
      throw new Error("not used");
    },
    async releaseCharacterLock(): Promise<void> {},
  };
  const store = new MemoryCharacterStore();
  store.saveState(5, STATE_A);
  const logs: string[] = [];
  const sync = new WorldCharacterSync({ client: fake, store, log: (l) => logs.push(l) });
  assert.deepEqual(await sync.login(5), { ok: true, seeded: false });
  assert.deepEqual(store.loadState(5), STATE_A);
  assert.ok(logs.some((l) => l.includes("not a usable character state")));
  assert.equal(parseWorldCharacterState({ state: { x: 1 }, skills: null }), null);
  assert.equal(parseWorldCharacterState("junk"), null);
});

// ---------------------------------------------------------------------------
// Gateway level: refusal, logout, seeding — and standalone silence
// ---------------------------------------------------------------------------

const LOOK = { gender: "female", parts: {}, colours: {} };

async function createAndEnter(
  url: string,
  name: string,
): Promise<{ c: HeadlessClient; id: number }> {
  const c = new HeadlessClient();
  await c.connect(url);
  const acct = c.waitFor(MessageType.Account, 1);
  c.sendRaw(
    MessageType.Hello,
    encodeControl({
      protocol: PROTOCOL_VERSION,
      client: "test",
      want_snapshot: true,
      characters: true,
      username: "alice",
      password: TEST_PASSWORD,
    }),
  );
  await acct;
  const made = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.CreateCharacter, encodeControl({ name, look: LOOK }));
  const id = decodeControl<AccountMessage>((await made)[0]).characters[0].id;
  const snapshot = c.waitFor(MessageType.Snapshot, 1);
  c.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  await snapshot;
  return { c, id };
}

test("gateway: second login refused while locked, succeeds after logout and enters with the world state", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());

  const storeA = new MemoryCharacterStore();
  const storeB = new MemoryCharacterStore();
  const syncA = makeSync(clientA, storeA, []);
  const syncB = makeSync(clientB, storeB, []);

  let nowA = 1_000_000;
  const gwA = new Gateway({
    clock: () => nowA,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: storeA,
    worldCharacters: syncA,
  });
  const gwB = new Gateway({
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: storeB,
    worldCharacters: syncB,
  });
  defer(() => gwB.close());
  defer(() => gwA.close());
  const urlA = `ws://127.0.0.1:${await gwA.listen()}`;
  const urlB = `ws://127.0.0.1:${await gwB.listen()}`;
  gwA.frame(nowA);

  // Alice plays her character on region A.
  const a = await createAndEnter(urlA, "Arya");
  defer(() => a.c.close());
  const id = a.id;
  assert.equal((await worldStore.getCharacterLock(id))?.regionId, "region-a");
  const eidA = gwA.world.resolveWireId(BigInt(a.c.welcome!.player_entity));
  C.Transform.px[eidA] = 42;
  C.Health.current[eidA] = 33;
  gwA.saveCharacters();
  await until(async () => {
    const rec = await worldStore.getCharacterState(id);
    return parseWorldCharacterState(rec?.state)?.state?.x === 42;
  }, "A's working save to land uphill");

  // The same character (same account, B's own local copy of it) cannot
  // enter on region B while A holds the lock: refused in character
  // selection with the gateway's existing 4005 refusal.
  const cB = new HeadlessClient();
  await cB.connect(urlB);
  defer(() => cB.close());
  const acctB = cB.waitFor(MessageType.Account, 1);
  cB.sendRaw(
    MessageType.Hello,
    encodeControl({
      protocol: PROTOCOL_VERSION,
      client: "test",
      want_snapshot: true,
      characters: true,
      username: "alice",
      password: TEST_PASSWORD,
    }),
  );
  await acctB;
  const madeB = cB.waitFor(MessageType.Account, 1);
  cB.sendRaw(MessageType.CreateCharacter, encodeControl({ name: "Arya", look: LOOK }));
  decodeControl<AccountMessage>((await madeB)[0]);
  const errP = cB.waitFor(MessageType.Error, 1);
  cB.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  const err = decodeControl<ErrorMessage>((await errP)[0]);
  assert.equal(err.code, 4005);
  assert.equal(gwB.world.liveEntityCount, 0, "the refused character never became playable on B");
  assert.equal((await worldStore.getCharacterLock(id))?.regionId, "region-a");

  // A logs out (disconnect + grace expiry): the final state commits
  // uphill and the lock releases.
  C.Transform.px[eidA] = 77;
  const versionBefore = (await worldStore.getCharacterState(id))!.version;
  await a.c.close();
  await sleep(50);
  nowA += 2000;
  gwA.frame(nowA);
  await until(
    async () => (await worldStore.getCharacterLock(id)) === null,
    "A's logout to release the lock",
  );
  const committed = await worldStore.getCharacterState(id);
  assert.ok(committed!.version > versionBefore, "logout's final commit advanced the version");
  assert.equal(parseWorldCharacterState(committed?.state)?.state?.x, 77);

  // B's still-open character selection now enters — playable only
  // after reacquisition — and the world record seeds B's local cache,
  // so the avatar restores where A left it.
  const snapB = cB.waitFor(MessageType.Snapshot, 1);
  cB.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  await snapB;
  assert.equal((await worldStore.getCharacterLock(id))?.regionId, "region-b");
  assert.deepEqual(storeB.loadState(id), parseWorldCharacterState(committed?.state)?.state);
  const eidB = gwB.world.resolveWireId(BigInt(cB.welcome!.player_entity));
  assert.equal(C.Transform.px[eidB], 77);
  assert.equal(C.Health.current[eidB], 33);
});

test("standalone gateway: full local flow, and the world is never called", async (t) => {
  const defer = cleanups(t);
  let worldCalls = 0;
  const counting: CharacterWorldClient = {
    async acquireCharacterLock(): Promise<CharacterSessionLock> {
      worldCalls++;
      throw new Error("standalone must not call the world");
    },
    async getCharacterState(): Promise<null> {
      worldCalls++;
      return null;
    },
    async putCharacterState(): Promise<CharacterStateRecord> {
      worldCalls++;
      throw new Error("standalone must not call the world");
    },
    async releaseCharacterLock(): Promise<void> {
      worldCalls++;
    },
  };
  // The sync exists (built over the counting client) but, exactly as
  // in a standalone server boot, it is never handed to the gateway.
  const unused = new WorldCharacterSync({
    client: counting,
    store: new MemoryCharacterStore(),
  });
  void unused;

  let now = 1_000_000;
  const store = new MemoryCharacterStore();
  const gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: store,
  });
  defer(() => gw.close());
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);

  const { c, id } = await createAndEnter(url, "Arya");
  defer(() => c.close());
  const eid = gw.world.resolveWireId(BigInt(c.welcome!.player_entity));
  C.Transform.px[eid] = 5;
  assert.equal(gw.saveCharacters(), 1);
  assert.equal(store.loadState(id)?.x, 5);
  await c.close();
  await sleep(50);
  now += 2000;
  gw.frame(now);
  assert.equal(gw.world.liveEntityCount, 0);
  assert.equal(worldCalls, 0, "no world calls at all in standalone mode");
});

// ---------------------------------------------------------------------------
// Migration: the lock moves with the character (real world over HTTP,
// two real gateways, as in the slice-B2 handoff tests)
// ---------------------------------------------------------------------------

async function worldHttpServer(defer: (fn: () => unknown) => void): Promise<{ url: string; store: MemoryWorldStore }> {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 10_000,
    heartbeatIntervalMs: 1000,
    migrationTimeoutMs: 10_000,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  defer(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

const CHUNK = 16;
const MIG_RANGE_A = { x0: 0, x1: 10, z0: 0, z1: 10 };
const MIG_RANGE_B = { x0: 10, x1: 20, z0: 0, z1: 10 };

async function migRegion(
  worldUrl: string,
  defer: (fn: () => unknown) => void,
  regionId: string,
  chunkRange: typeof MIG_RANGE_A,
) {
  const store = new MemoryCharacterStore();
  const client = new WorldClient({
    transport: new WebrpcWorldTransport(worldUrl),
    regionId,
    chunkRange,
    endpoint: "",
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000, // the tests drive heartbeats by hand
    onError: () => {},
  });
  const sync = new WorldCharacterSync({ client, store, log: () => {} });
  const gw = new Gateway({
    credentialStore: await makeCredentialStore(),
    characterStore: store,
    worldCharacters: sync,
    disconnectGraceMs: 30_000,
  });
  const port = await gw.listen();
  defer(() => gw.close());
  const url = `ws://127.0.0.1:${port}`;
  // The endpoint the world redirects clients to is this gateway's.
  (client as unknown as { opts: { endpoint: string } }).opts.endpoint = url;
  await client.start();
  defer(() => client.stop());
  const coord = new MigrationCoordinator({
    world: client,
    host: gw.migrationHost(),
    chunkRange,
    chunkSize: CHUNK,
    log: () => {},
  });
  const events: MigrationEvent[] = [];
  coord.onEvent((e) => events.push(e));
  gw.setMigrationAcceptor((mid, verify) => coord.accept(mid, false, verify));
  const beat = async () => {
    const ack = await client.heartbeat();
    if (ack) await coord.onAck(ack);
  };
  return { gw, url, coord, events, beat, client, sync, store };
}

test("migration commit: source releases the character lock, destination reacquires before the character is playable", async (t) => {
  const defer = cleanups(t);
  const { url: worldUrl, store: worldStore } = await worldHttpServer(defer);
  const a = await migRegion(worldUrl, defer, "a", MIG_RANGE_A);
  const b = await migRegion(worldUrl, defer, "b", MIG_RANGE_B);
  await a.beat();
  await b.beat(); // both learn the registry

  // Alice creates her character and plays it on region A.
  const { c, id } = await createAndEnter(a.url, "Arya");
  defer(() => c.close());
  assert.equal((await worldStore.getCharacterLock(id))?.regionId, "a");
  const epochA = a.sync.lockEpoch(id)!;
  const eidA = a.gw.world.resolveWireId(BigInt(c.welcome!.player_entity));
  C.Transform.px[eidA] = 150; // chunk 9: still A's
  C.Transform.pz[eidA] = 40;
  await a.coord.observe(a.gw.migrationPositions());
  assert.equal(a.coord.pendingOutgoing.size, 0);

  // She walks into B's chunks: the migration begins and A redirects.
  const byeP = c.waitFor(MessageType.Bye, 1);
  C.Transform.px[eidA] = 165; // chunk 10: B's
  await a.coord.observe(a.gw.migrationPositions());
  const bye = decodeControl<ByeMessage>((await byeP)[0]);
  assert.equal(bye.reason, "redirect");
  const migrationId = bye.redirect!.migration;
  const ticket = bye.redirect!.ticket;

  // The client arrives at B immediately — but A still holds the
  // character lock (its commit ack has not been processed), so the
  // character is NOT playable at B yet: the migration hello fails.
  await c.close();
  const early = new HeadlessClient();
  await early.connect(b.url);
  await assert.rejects(
    early.hello("alice", { migration: migrationId, ticket }),
    /hello rejected: 4002/,
  );
  assert.equal((await worldStore.getCharacterLock(id))?.regionId, "a");

  // A processes the commit ack: handoffDrop is the migration commit
  // point — the final state commits uphill and the lock releases.
  C.Transform.px[eidA] = 171;
  await a.beat();
  assert.equal(a.gw.migrationPositions().length, 0, "A dropped the avatar on commit");
  await until(
    async () => (await worldStore.getCharacterLock(id)) === null,
    "the source's lock release to land",
  );
  const committed = await worldStore.getCharacterState(id);
  assert.equal(parseWorldCharacterState(committed?.state)?.state?.x, 171);

  // The client retries the migration hello at B: the destination
  // reacquires the lock (fresh epoch) and only then is the character
  // playable there; B's local cache is seeded from the world record.
  const c2 = new HeadlessClient();
  await c2.connect(b.url);
  defer(() => c2.close());
  const snap = c2.waitFor(MessageType.Snapshot, 1);
  await c2.hello("alice", { migration: migrationId, ticket });
  await snap;
  const lock = await worldStore.getCharacterLock(id);
  assert.equal(lock?.regionId, "b");
  assert.ok((lock?.epoch ?? 0) > epochA, "destination holds a fresh epoch");
  assert.equal(b.sync.lockEpoch(id), lock?.epoch);
  assert.equal(a.sync.lockEpoch(id), null, "the source holds nothing anymore");
  assert.equal(b.store.loadState(id)?.x, 171, "destination cache seeded from the world record");
});
