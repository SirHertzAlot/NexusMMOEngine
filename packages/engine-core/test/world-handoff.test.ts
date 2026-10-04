/**
 * Slice B2 end to end: a real world server, two real Gateways as regions
 * a and b (each with a WorldClient and a MigrationCoordinator over the
 * gateway's MigrationHost), and a client on the real wire protocol. The
 * player walks over the border; a redirects the client with a ticket, b
 * lets it in without a password, a drops its copy on the commit.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import * as argon2 from "argon2";
import express from "express";
import { decodeControl, MessageType, type ByeMessage } from "@mmo-engine/protocol";
import { createWebrpcRouter, MemoryWorldStore, WorldCoreImpl } from "@mmo-engine/world-server";
import { Gateway } from "../src/net/gateway.js";
import * as C from "../src/components.js";
import { WorldClient } from "../src/world/client.js";
import { WebrpcWorldTransport } from "../src/world/webrpc-transport.js";
import { MigrationCoordinator, type MigrationEvent } from "../src/world/migration.js";
import { HeadlessClient } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

const API_KEY = "test-bootstrap-key-123";
const CHUNK = 16;
// Region a owns chunks x 0..9, region b owns x 10..19 (world x 0..160..320).
const RANGE_A = { x0: 0, x1: 10, z0: 0, z1: 10 };
const RANGE_B = { x0: 10, x1: 20, z0: 0, z1: 10 };

/** Cleanups run newest first, so regions deregister before the world closes. */
function cleanups(t: TestContext): (fn: () => Promise<unknown> | unknown) => void {
  const fns: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => { for (const fn of fns.reverse()) await fn(); });
  return (fn) => fns.push(fn);
}

async function worldServer(defer: (fn: () => unknown) => void): Promise<string> {
  const core = new WorldCoreImpl({
    store: new MemoryWorldStore(),
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A region: a gateway serving players, registered with the world, handing players off. */
async function region(worldUrl: string, defer: (fn: () => unknown) => void, regionId: string, chunkRange: typeof RANGE_A, acceptor = true) {
  const gw = new Gateway({ credentialStore: await makeCredentialStore(), disconnectGraceMs: 30_000 });
  const port = await gw.listen();
  defer(() => gw.close());
  const url = `ws://127.0.0.1:${port}`;
  const client = new WorldClient({
    transport: new WebrpcWorldTransport(worldUrl),
    regionId,
    chunkRange,
    endpoint: url,
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000, // the tests drive heartbeats by hand
    onError: (err, ctx) => { if (ctx !== "deregister") throw new Error(`${regionId} ${ctx}: ${(err as Error).message}`); },
  });
  await client.start();
  defer(() => client.stop());
  const coord = new MigrationCoordinator({ world: client, host: gw.migrationHost(), chunkRange, chunkSize: CHUNK, log: () => {} });
  const events: MigrationEvent[] = [];
  coord.onEvent((e) => events.push(e));
  if (acceptor) gw.setMigrationAcceptor((id, verify) => coord.accept(id, false, verify));
  const beat = async () => { const ack = await client.heartbeat(); if (ack) await coord.onAck(ack); };
  return { gw, url, coord, events, beat };
}

/** Log in on `url` and wait for the snapshot. */
async function login(url: string, defer: (fn: () => unknown) => void, username = "alice") {
  const c = new HeadlessClient();
  await c.connect(url);
  defer(() => c.close());
  const snap = c.waitFor(MessageType.Snapshot, 1);
  const welcome = await c.hello(username, { username, password: TEST_PASSWORD });
  await snap;
  return { c, welcome };
}

/** Put the player's avatar at world (x, z) in `gw`. */
function place(gw: Gateway, wireId: string, x: number, z: number): void {
  const eid = gw.world.resolveWireId(BigInt(wireId));
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
}

const playersOf = (gw: Gateway) => gw.migrationPositions().map((p) => `${p.entityId}@${Math.round(p.x)}`);

test("a player walks from a into b: a redirects with a ticket, b takes the client without a password, a drops it", async (t) => {
  const defer = cleanups(t);
  const worldUrl = await worldServer(defer);
  const a = await region(worldUrl, defer, "a", RANGE_A);
  const b = await region(worldUrl, defer, "b", RANGE_B);
  await a.beat(); await b.beat(); // both learn the registry

  const { c, welcome } = await login(a.url, defer);
  place(a.gw, welcome.player_entity, 150, 40); // chunk 9: still a's
  await a.coord.observe(a.gw.migrationPositions());
  assert.equal(a.coord.pendingOutgoing.size, 0);

  const byeP = c.waitFor(MessageType.Bye, 1);
  place(a.gw, welcome.player_entity, 165, 40); // chunk 10: b's
  await a.coord.observe(a.gw.migrationPositions());
  const [byePayload] = await byeP;
  const bye = decodeControl<ByeMessage>(byePayload);
  assert.equal(bye.reason, "redirect");
  assert.equal(bye.redirect?.endpoint, b.url);
  assert.match(bye.redirect!.ticket, /^[0-9a-f]{64}$/);
  // The world never sees the ticket itself, only its hash.
  assert.equal(JSON.stringify(a.events).includes(bye.redirect!.ticket), false);

  // The client moves to b with the ticket: welcome + snapshot, no password.
  c.close();
  const c2 = new HeadlessClient();
  await c2.connect(b.url);
  defer(() => c2.close());
  const snap = c2.waitFor(MessageType.Snapshot, 1);
  const w2 = await c2.hello("alice", { migration: bye.redirect!.migration, ticket: bye.redirect!.ticket });
  await snap;
  assert.match(w2.session_token, /^[0-9a-f]{64}$/);
  assert.notEqual(w2.session_token, welcome.session_token, "b issues its own session");
  const eid = b.gw.world.resolveWireId(BigInt(w2.player_entity));
  assert.equal(Math.round(C.Transform.px[eid]), 165, "b spawned it where a had it");
  assert.deepEqual(b.events.map((e) => e.kind), ["accepted"]);

  // a keeps simulating it until its heartbeat ack says committed, then drops it.
  assert.deepEqual(playersOf(a.gw), ["player:alice@165"]);
  await a.beat();
  assert.deepEqual(playersOf(a.gw), []);
  assert.deepEqual(playersOf(b.gw), ["player:alice@165"]);
  assert.deepEqual(a.events.map((e) => e.kind), ["begun", "handed_off"]);

  // The session token from a is dead now: b has the player.
  const c3 = new HeadlessClient();
  await c3.connect(a.url);
  defer(() => c3.close());
  await assert.rejects(c3.hello("alice", { token: welcome.session_token }), /4002/);

  // The ticket was single use.
  const c4 = new HeadlessClient();
  await c4.connect(b.url);
  defer(() => c4.close());
  await assert.rejects(c4.hello("alice", { migration: bye.redirect!.migration, ticket: bye.redirect!.ticket }), /4002/);
});

test("a wrong ticket is refused before anything spawns; the client falls back to a, which still has the player", async (t) => {
  const defer = cleanups(t);
  const worldUrl = await worldServer(defer);
  const a = await region(worldUrl, defer, "a", RANGE_A);
  const b = await region(worldUrl, defer, "b", RANGE_B);
  await a.beat(); await b.beat();

  const { c, welcome } = await login(a.url, defer);
  const byeP = c.waitFor(MessageType.Bye, 1);
  place(a.gw, welcome.player_entity, 165, 40);
  await a.coord.observe(a.gw.migrationPositions());
  const bye = decodeControl<ByeMessage>((await byeP)[0]);
  c.close();

  const thief = new HeadlessClient();
  await thief.connect(b.url);
  defer(() => thief.close());
  await assert.rejects(thief.hello("mallory", { migration: bye.redirect!.migration, ticket: "0".repeat(64) }), /4002/);
  assert.deepEqual(playersOf(b.gw), [], "b spawned nothing");
  assert.deepEqual(b.events.map((e) => e.kind), ["refused"]);

  // Back to a with the session token, inside the grace period: same avatar.
  const back = new HeadlessClient();
  await back.connect(a.url);
  defer(() => back.close());
  const w = await back.hello("alice", { token: welcome.session_token });
  assert.equal(w.player_entity, welcome.player_entity);
  await a.beat();
  assert.deepEqual(playersOf(a.gw), ["player:alice@165"], "a still has it: nothing committed");
});

test("a region that isn't handing players off refuses a migration hello", async (t) => {
  const defer = cleanups(t);
  const worldUrl = await worldServer(defer);
  const b = await region(worldUrl, defer, "b", RANGE_B, false);
  const c = new HeadlessClient();
  await c.connect(b.url);
  defer(() => c.close());
  await assert.rejects(c.hello("alice", { migration: "mig-" + "a".repeat(24), ticket: "b".repeat(64) }), /4002/);
});
