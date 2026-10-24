/**
 * Ingress hardening (roadmap T1, exit criterion X5): per-session intent
 * and pickup rate limits plus validation of untrusted input.
 *
 * A real Gateway (with an ItemService where pickups are involved) faces
 * real WebSocket clients on a synthetic clock:
 * - a legitimate intent rate passes untouched
 * - an intent flood is dropped, counted, and disconnects the abuser
 *   while other sessions keep playing
 * - updateIngress applies live and rejects bad tables
 * - a pickup flood is dropped and disconnects; a normal pickup works
 * - malformed, oversized, and out-of-range input is rejected (4003/4005)
 *   without crashing or disturbing other sessions
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AdminResult,
  type ErrorMessage,
  type InventoryMessage,
} from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import type { QueuedIntent } from "../../src/world.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Let in-flight socket messages reach the server before frames() run. */
const settle = (): Promise<void> => sleep(50);

const move = (mx: number, my: number, mz: number): QueuedIntent => ({
  mx, my, mz,
  lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
});

let now = 0;
let gw: Gateway | null = null;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

const POOL: PoolItemLike[] = ["a", "b", "c"].map((id, i) => ({
  id, rank: "common", source: "mob", item: "sword", seed: i,
  bundle: { Identity: { id, name: `Sword ${id}`, base: "sword" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { power: 10 } },
}));

function makeItems(): ItemService {
  const rules = engineDefaults();
  rules.items.bases.sword = {
    ...rules.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  return new ItemService({ defs: new ItemDefs(POOL, rules), loot: rules.loot, tickHz: 30 });
}

async function startItemGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  const items = makeItems();
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [items],
    items,
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

/** Advance the synthetic clock by n ticks, running the sim each tick. */
function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function join(url: string, username: string): Promise<{ client: HeadlessClient; entity: bigint }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, creds(username));
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

async function nextError(client: HeadlessClient, send: () => void): Promise<ErrorMessage> {
  const p = client.waitFor(MessageType.Error, 1);
  send();
  return decodeControl<ErrorMessage>((await p)[0]);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: ingress rate limits", () => {
  it("a legitimate intent rate passes untouched", async () => {
    const url = await startGateway();
    const { client, entity } = await join(url, "alice");
    // One intent a tick for ten ticks: the most a well-behaved client
    // ever sends (MirrorClient collapses same-tick changes into one).
    for (let t = 1; t <= 10; t++) {
      client.sendIntent(BigInt(t), entity, move(1, 0, 0));
      await settle();
      frames(1);
    }
    const last = client.payloads(MessageType.Delta).at(-1)!;
    assert.ok(last.length > 0, "deltas kept flowing");
    const stats = gw!.ingressStats();
    assert.deepEqual(stats, { droppedIntents: 0, droppedPickups: 0, abuseDisconnects: 0 });
    assert.ok(!client.closed, "the session stays open");
    await client.close();
  });

  it("an intent flood is dropped, counted, and disconnects the abuser; others play on", async () => {
    const url = await startGateway({
      ingress: { intentsPerSecond: 5, intentBurst: 3, maxViolations: 10, abuseWindowSeconds: 60 },
    });
    const victim = await join(url, "user-a");
    const attacker = await join(url, "user-b");
    victim.client.sendIntent(1n, victim.entity, move(1, 0, 0));

    // 30 intents in the same millisecond: 3 fit the burst, 27 are excess.
    for (let t = 1; t <= 30; t++) attacker.client.sendIntent(BigInt(t), attacker.entity, move(-1, 0, 0));
    await attacker.client.waitForClose();
    assert.equal(attacker.client.closeCode, 4000, "sustained abuse disconnects the session");

    const stats = gw!.ingressStats();
    // The 10th violation (maxViolations) disconnects. The transport decides
    // how many of the rest were already read off the wire: uWS stops at the
    // close, ws still delivers what it had buffered. So: at least the limit,
    // never more than the 27 sent past the burst.
    assert.ok(stats.droppedIntents >= 10 && stats.droppedIntents <= 27, `excess messages are counted up to the abuse limit: ${stats.droppedIntents}`);
    assert.equal(stats.abuseDisconnects, 1);

    // The authority is unaffected: the victim's intent still applies and
    // the server still answers them.
    await settle();
    const deltasP = victim.client.waitFor(MessageType.Delta, 10);
    frames(10);
    assert.equal((await deltasP).length, 10, "the good session keeps receiving deltas");
    assert.ok(!victim.client.closed, "and its connection stays open");
    const pongP = victim.client.waitFor(MessageType.Pong, 1);
    victim.client.sendPing();
    assert.equal((await pongP).length, 1, "and it is still answered");
    await victim.client.close();
    await attacker.client.close();
  });

  it("updateIngress applies live and rejects bad tables", async () => {
    const url = await startGateway();
    const { client, entity } = await join(url, "alice");
    gw!.updateIngress({ intentsPerSecond: 1, intentBurst: 1, maxViolations: 1000, abuseWindowSeconds: 60 });
    // 4 intents in the same millisecond under a burst of 1: 1 passes, 3 drop.
    for (let t = 1; t <= 4; t++) client.sendIntent(BigInt(t), entity, move(1, 0, 0));
    await settle();
    assert.equal(gw!.ingressStats().droppedIntents, 3);
    assert.ok(!client.closed, "far under the abuse budget: still connected");
    assert.throws(() => gw!.updateIngress({ intentBurst: 0 }), RangeError);
    assert.throws(() => gw!.updateIngress({ pickupsPerSecond: -2 }), RangeError);
    assert.throws(() => new Gateway({ ingress: { maxViolations: 1.5 } }), RangeError);
    await client.close();
  });
});

describe("gateway: pickup rate limits", () => {
  it("a pickup flood is dropped and disconnects; a normal pickup still works", async () => {
    const url = await startItemGateway({
      admins: ["user-a"],
      ingress: { pickupsPerSecond: 2, pickupBurst: 2, maxViolations: 8, abuseWindowSeconds: 60 },
    });
    const attacker = await join(url, "user-a");
    // An admin drop lands at the caller's feet: in pickup range.
    const resP = attacker.client.waitFor(MessageType.Admin, 1);
    attacker.client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "drop", args: { base: "sword" } }));
    const dropped = decodeControl<AdminResult>((await resP)[0]);
    assert.equal(dropped.ok, true, dropped.message);
    const wid = dropped.message.split(" ").at(-1)!;

    // At a legitimate pace the pickup works: the bag answers.
    const invP = attacker.client.waitFor(MessageType.Inventory, 1);
    attacker.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: wid }));
    const bag = decodeControl<InventoryMessage>((await invP)[0]).bag;
    assert.equal(bag.filter((s) => s !== null).length, 1, "one pickup lands in the bag");

    // The item is gone, so the next request reaches the service and is
    // refused — then the flood: 18 requests in the same millisecond.
    const refused = await nextError(attacker.client, () =>
      attacker.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: wid })));
    assert.equal(refused.code, 4005);
    for (let i = 0; i < 18; i++) {
      attacker.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: wid }));
    }
    await attacker.client.waitForClose();
    assert.equal(attacker.client.closeCode, 4000, "sustained abuse disconnects the session");
    const stats = gw!.ingressStats();
    // Disconnect comes at the 8th violation (maxViolations); how many of the
    // 18 were already read depends on the transport (see the intent flood).
    assert.ok(stats.droppedPickups >= 8 && stats.droppedPickups <= 18, `excess pickups are counted up to the abuse limit: ${stats.droppedPickups}`);
    assert.equal(stats.abuseDisconnects, 1);

    // Another session is unaffected.
    const victim = await join(url, "user-b");
    const pongP = victim.client.waitFor(MessageType.Pong, 1);
    victim.client.sendPing();
    assert.equal((await pongP).length, 1, "the good session is still served");
    await victim.client.close();
    await attacker.client.close();
  });
});

describe("gateway: untrusted input", () => {
  it("malformed, oversized, and out-of-range input is rejected without disturbing others", async () => {
    const url = await startItemGateway({ admins: ["user-a"] });
    const attacker = await join(url, "user-a");
    const victim = await join(url, "user-b");

    // An unknown message type: 4003, and the session stays open.
    const unknown = await nextError(attacker.client, () =>
      attacker.client.sendRaw(0x99 as MessageType, new Uint8Array(0)));
    assert.equal(unknown.code, 4003);

    // Garbage where an intent decodes: 4003.
    const badIntent = await nextError(attacker.client, () =>
      attacker.client.sendRaw(MessageType.Intent, new Uint8Array([1, 2, 3])));
    assert.equal(badIntent.code, 4003);

    // A 60 KiB hello: under the 64 KiB frame cap, so the transport lets
    // it through — and the gateway rejects it without crashing.
    const probe = new HeadlessClient();
    probe.autoPong = false;
    await probe.connect(url);
    const badHello = await nextError(probe, () =>
      probe.sendRaw(MessageType.Hello, new Uint8Array(60 * 1024)));
    assert.equal(badHello.code, 4003);
    assert.ok(!probe.closed, "rejected, not disconnected");

    // An out-of-range entity id: no such ground item, refused — never applied.
    const noEntity = await nextError(attacker.client, () =>
      attacker.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: "18446744073709551615" })));
    assert.equal(noEntity.code, 4005);

    // A drop at the attacker's feet, then 50 m away: too far to pick up.
    const resP = attacker.client.waitFor(MessageType.Admin, 1);
    attacker.client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "drop", args: { base: "sword" } }));
    const dropped = decodeControl<AdminResult>((await resP)[0]);
    assert.equal(dropped.ok, true, dropped.message);
    const wid = dropped.message.split(" ").at(-1)!;
    attacker.client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "teleport", args: { x: 50, z: 50 } }));
    const tooFar = await nextError(attacker.client, () =>
      attacker.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: wid })));
    assert.equal(tooFar.code, 4005);
    assert.match(tooFar.message, /too far/);

    // Both sessions are alive and the server answers them.
    for (const c of [attacker.client, victim.client]) {
      const pongP = c.waitFor(MessageType.Pong, 1);
      c.sendPing();
      assert.equal((await pongP).length, 1, "still served after bad input");
    }
    const stats = gw!.ingressStats();
    assert.deepEqual(stats, { droppedIntents: 0, droppedPickups: 0, abuseDisconnects: 0 });
    await attacker.client.close();
    await victim.client.close();
    await probe.close();
  });
});
