/**
 * Slice B end to end: a real world server over webrpc, two regions with
 * WorldClient + MigrationCoordinator, and fake ECS hosts. Every path of
 * WORLD-SERVER-SPEC §6: commit, walk back, timeout expiry, a late commit
 * refused, and the source dying mid-migration.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import * as argon2 from "argon2";
import express from "express";
import { createWebrpcRouter, MemoryWorldStore, WorldCoreImpl } from "@mmo-engine/world-server";
import { WorldClient } from "../src/world/client.js";
import { WebrpcWorldTransport } from "../src/world/webrpc-transport.js";
import { MigrationCoordinator, type MigrationEvent, type MigrationHost } from "../src/world/migration.js";

const API_KEY = "test-bootstrap-key-123";
const CHUNK = 16;
// Region a owns chunks x 0..9, region b owns x 10..19 (world x 0..160..320).
const RANGE_A = { x0: 0, x1: 10, z0: 0, z1: 10 };
const RANGE_B = { x0: 10, x1: 20, z0: 0, z1: 10 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cleanups run newest first, so regions deregister before the world closes. */
function cleanups(t: TestContext): (fn: () => Promise<unknown> | unknown) => void {
  const fns: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => { for (const fn of fns.reverse()) await fn(); });
  return (fn) => fns.push(fn);
}

async function worldServer(t: TestContext, opts: { migrationTimeoutMs?: number; heartbeatTimeoutMs?: number } = {}) {
  const defer = cleanups(t);
  const core = new WorldCoreImpl({
    store: new MemoryWorldStore(),
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 10_000,
    heartbeatIntervalMs: 1000,
    migrationTimeoutMs: opts.migrationTimeoutMs ?? 10_000,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  const app = express();
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  defer(() => new Promise<void>((r) => server.close(() => r())));
  return { core, defer, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** An ECS stand-in: entity id -> state. */
class FakeHost implements MigrationHost {
  readonly entities = new Map<string, Record<string, unknown>>();
  readonly redirects: Array<{ entityId: string; endpoint: string; migrationId: string }> = [];
  serialize(id: string) { return this.entities.get(id) ?? null; }
  instantiate(id: string, state: Record<string, unknown> | null) { this.entities.set(id, state ?? {}); }
  drop(id: string) { this.entities.delete(id); }
  has(id: string) { return this.entities.has(id); }
  redirect(entityId: string, endpoint: string, migrationId: string) { this.redirects.push({ entityId, endpoint, migrationId }); }
}

async function region(w: { url: string; defer: (fn: () => unknown) => void }, regionId: string, chunkRange: typeof RANGE_A) {
  const { url } = w;
  const client = new WorldClient({
    transport: new WebrpcWorldTransport(url),
    regionId,
    chunkRange,
    endpoint: `ws://${regionId}.local:7777`,
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000, // the tests drive heartbeats by hand
    onError: (err, ctx) => { if (ctx !== "deregister") throw new Error(`${regionId} ${ctx}: ${(err as Error).message}`); },
  });
  await client.start();
  const host = new FakeHost();
  const coord = new MigrationCoordinator({ world: client, host, chunkRange, chunkSize: CHUNK, retryAfterMs: 50, log: () => {} });
  const events: MigrationEvent[] = [];
  coord.onEvent((e) => events.push(e));
  /** One heartbeat, its ack handed to the coordinator. */
  const beat = async () => { const ack = await client.heartbeat(); if (ack) await coord.onAck(ack); };
  w.defer(() => client.stop());
  return { client, host, coord, events, beat };
}

const PLAYER = "player:42";
const STATE = { hp: 87, pos: [161, 3, 40], bag: [{ def: 7, n: 2 }] };

test("commit: the player crosses a->b; b takes it from the world, a drops it; one owner throughout", async (t) => {
  const w = await worldServer(t);
  const a = await region(w, "a", RANGE_A);
  const b = await region(w, "b", RANGE_B);
  await a.beat(); await b.beat(); // both learn the registry

  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 150, z: 40 }]); // chunk 9: still a's
  assert.equal(a.coord.pendingOutgoing.size, 0);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]); // chunk 10: b's
  const begun = a.events.find((e) => e.kind === "begun")!;
  assert.ok(begun && begun.kind === "begun" && begun.toRegion === "b");
  assert.deepEqual(a.host.redirects, [{ entityId: PLAYER, endpoint: "ws://b.local:7777", migrationId: begun.migrationId }]);
  // a still simulates it: brief dual simulation, single authority.
  assert.ok(a.host.has(PLAYER));
  // A second observe doesn't begin twice.
  await a.coord.observe([{ entityId: PLAYER, x: 170, z: 40 }]);
  assert.equal(a.events.filter((e) => e.kind === "begun").length, 1);

  // The client reaches b with the migration id.
  assert.equal(await b.coord.accept(begun.migrationId), true);
  assert.deepEqual(b.host.entities.get(PLAYER), STATE);
  assert.ok(a.host.has(PLAYER), "a keeps it until it hears the commit");
  await a.beat();
  assert.equal(a.host.has(PLAYER), false);
  assert.deepEqual(a.events.map((e) => e.kind), ["begun", "handed_off"]);
  assert.deepEqual(b.events.map((e) => e.kind), ["accepted"]);
  // Repeated acks and accepts change nothing.
  await a.beat(); await b.beat();
  assert.equal(await b.coord.accept(begun.migrationId), true);
  assert.deepEqual(b.events.map((e) => e.kind), ["accepted"]);
});

test("walk back: the player steps back before b takes it; the migration is aborted and b can't take it", async (t) => {
  const w = await worldServer(t);
  const a = await region(w, "a", RANGE_A);
  const b = await region(w, "b", RANGE_B);
  await a.beat(); await b.beat();
  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]);
  const { migrationId } = a.coord.pendingOutgoing.get(PLAYER)!;
  await a.coord.observe([{ entityId: PLAYER, x: 155, z: 40 }]);
  assert.equal(a.coord.pendingOutgoing.size, 0);
  assert.equal(await b.coord.accept(migrationId), false);
  assert.equal(b.host.has(PLAYER), false);
  assert.ok(a.host.has(PLAYER));
  assert.deepEqual(a.events.map((e) => e.kind), ["begun", "walked_back"]);
});

test("timeout: b never takes it; the world expires the migration, a keeps the player and retries later", async (t) => {
  const w = await worldServer(t, { migrationTimeoutMs: 100 });
  const { core } = w;
  const a = await region(w, "a", RANGE_A);
  const b = await region(w, "b", RANGE_B);
  await a.beat(); await b.beat();
  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]);
  const { migrationId } = a.coord.pendingOutgoing.get(PLAYER)!;
  await sleep(150);
  assert.deepEqual(await core.expireMigrations(), [migrationId]);
  await a.beat();
  assert.ok(a.host.has(PLAYER));
  assert.equal(a.coord.pendingOutgoing.size, 0);
  assert.deepEqual(a.events.map((e) => e.kind), ["begun", "kept"]);
  // A late client arrival at b is refused, and b holds no copy.
  assert.equal(await b.coord.accept(migrationId), false);
  assert.equal(b.host.has(PLAYER), false);
  // After the retry delay, a tries again.
  await sleep(60);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]);
  assert.equal(a.events.filter((e) => e.kind === "begun").length, 2);
});

test("late commit: b instantiated it but the migration expired first; b drops its copy", async (t) => {
  const w = await worldServer(t, { migrationTimeoutMs: 100 });
  const { core } = w;
  const a = await region(w, "a", RANGE_A);
  const b = await region(w, "b", RANGE_B);
  await a.beat(); await b.beat();
  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]);
  const { migrationId } = a.coord.pendingOutgoing.get(PLAYER)!;
  // b instantiates, then the world expires it before b's commit lands.
  const realCommit = b.client.commitMigration.bind(b.client);
  b.client.commitMigration = async (id: string) => { await sleep(150); await core.expireMigrations(); return realCommit(id); };
  assert.equal(await b.coord.accept(migrationId), false);
  assert.equal(b.host.has(PLAYER), false, "no second owner");
  await a.beat();
  assert.ok(a.host.has(PLAYER));
  assert.deepEqual(b.events.map((e) => e.kind), ["refused"]);
});

test("source death: a dies mid-migration; once the world reaps it, b's ack shows the orphan and b takes it", async (t) => {
  const w = await worldServer(t, { heartbeatTimeoutMs: 300 });
  const { core } = w;
  const a = await region(w, "a", RANGE_A);
  const b = await region(w, "b", RANGE_B);
  await a.beat(); await b.beat();
  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 161, z: 40 }]);
  // a goes silent (dies). b keeps beating; while a is merely late b waits.
  await b.beat();
  assert.equal(b.host.has(PLAYER), false);
  await sleep(350);
  await b.beat(); // keeps b live
  assert.deepEqual(await core.reapStale(), ["a"]);
  await b.beat(); // registry changed: b refreshes, sees a gone, takes the orphan
  assert.deepEqual(b.host.entities.get(PLAYER), STATE);
  const accepted = b.events.find((e) => e.kind === "accepted");
  assert.ok(accepted && accepted.kind === "accepted" && accepted.backstop);
});

test("chunks nobody owns keep the entity where it is", async (t) => {
  const w = await worldServer(t);
  const a = await region(w, "a", RANGE_A);
  await a.beat();
  a.host.entities.set(PLAYER, STATE);
  await a.coord.observe([{ entityId: PLAYER, x: 40, z: 400 }]); // chunk z 25: no region
  assert.equal(a.coord.pendingOutgoing.size, 0);
  assert.deepEqual(a.events, []);
});
