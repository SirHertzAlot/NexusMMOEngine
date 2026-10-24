/**
 * World chests over the wire (catalog 0x27): joining sends the chests; an
 * open drops the loot for the opener and tells every player the chest is
 * open; a second player finds it empty (4005); far away and bad shapes are
 * refused (4005, 4003).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { decodeControl, encodeControl, MessageType, type ChestsMessage, type ErrorMessage, type SpellMessage } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { BreakSystem, ChestSystem } from "../../src/interact/index.js";
import { AssetRef, Health, Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

function tick(): void {
  now += 1000 / 30;
  gw!.frame(now);
}

async function start(castSeconds = 0) {
  now = 1_000_000;
  const sim = new SimWorld();
  const drops: Array<[string, number]> = [];
  const chests = new ChestSystem({ drop: (_s, table, _x, _z, owner) => (drops.push([table, owner]), 1), now: () => now });
  const chest = sim.spawn();
  addComponent(sim.ecs, Transform, chest);
  Transform.px[chest] = 500;
  Transform.pz[chest] = 500;
  chests.register(chest, "arena/chest-0", { table: "chest-common", refillSeconds: 60, castSeconds });
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world: sim, systems: [chests], spawnPoint: { x: 0, z: 0 } });
  const port = await gw.listen();
  gw.frame(now);
  return { url: `ws://127.0.0.1:${port}`, sim, chest, drops };
}

async function join(url: string, name: string): Promise<{ client: HeadlessClient; chests: ChestsMessage }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const p = client.waitFor(MessageType.Interact, 1);
  await client.hello(name, { username: name, password: TEST_PASSWORD });
  return { client, chests: decodeControl<ChestsMessage>((await p)[0]!) };
}

/** Put the chest 1 m from `client`'s avatar. */
function beside(sim: SimWorld, chest: number, client: HeadlessClient): void {
  const avatar = sim.resolveWireId(BigInt(client.welcome!.player_entity));
  Transform.px[chest] = Transform.px[avatar]! + 1;
  Transform.pz[chest] = Transform.pz[avatar]!;
}

describe("gateway: world chests", () => {
  it("sends the chests on joining; an open drops the loot and every player sees it open; the next player finds it empty", async () => {
    const { url, sim, chest, drops } = await start();
    const alice = await join(url, "alice");
    const bob = await join(url, "user-a");
    assert.equal(alice.chests.chests.length, 1);
    const view = alice.chests.chests[0]!;
    assert.equal(view.entity, sim.wireId(chest).toString());
    assert.equal(view.open, false);

    let errP = alice.client.waitFor(MessageType.Error, 1);
    alice.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    assert.match(decodeControl<ErrorMessage>((await errP)[0]!).message, /too far/);

    beside(sim, chest, alice.client);
    alice.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    const seenP = bob.client.waitFor(MessageType.Interact, 1);
    await new Promise((r) => setTimeout(r, 50));
    tick();
    assert.equal(decodeControl<ChestsMessage>((await seenP)[0]!).chests[0]!.open, true);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]![0], "chest-common");

    errP = bob.client.waitFor(MessageType.Error, 1);
    bob.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    const err = decodeControl<ErrorMessage>((await errP)[0]!);
    assert.equal(err.code, 4005);
    await alice.client.close();
    await bob.client.close();
  });

  it("a chest with a cast time shows the bar, opens when it fills, and a move cancels it", async () => {
    const { url, sim, chest, drops } = await start(0.2);
    const { client, chests } = await join(url, "user-b");
    const entity = chests.chests[0]!.entity;
    beside(sim, chest, client);
    const startedP = client.waitFor(MessageType.Magic, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity }));
    const started = decodeControl<SpellMessage>((await startedP)[0]!);
    assert.deepEqual([started.spell, started.state, started.seconds], ["chest", "started", 0.2]);
    assert.equal(drops.length, 0, "nothing until the bar fills");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(drops.length, 1, "opened when it filled");

    // The chest refills; this time the player walks off mid-cast.
    now += 61_000;
    tick();
    const startedP2 = client.waitFor(MessageType.Magic, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity }));
    await startedP2;
    const stoppedP = client.waitFor(MessageType.Error, 1);
    const avatar = sim.resolveWireId(BigInt(client.welcome!.player_entity));
    Transform.px[avatar] = Transform.px[avatar]! - 2;
    tick();
    const err = decodeControl<ErrorMessage>((await stoppedP)[0]!);
    assert.match(err.message, /interrupted: you moved/);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(drops.length, 1, "no second open");
    await client.close();
  });

  it("refuses a bad shape (4003)", async () => {
    const { url } = await start();
    const { client } = await join(url, "user-b");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: "not a number" }));
    assert.equal(decodeControl<ErrorMessage>((await errP)[0]!).code, 4003);
    await client.close();
  });
});

describe("gateway: broken buildings", () => {
  it("a ruin is listed on joining; mending it needs the materials and a cast, and every player sees it stand again", async () => {
    now = 1_000_000;
    const sim = new SimWorld();
    const pouch = new Map<string, number>();
    const breaks = new BreakSystem(new Map(), {
      materials: { count: (_h, m) => pouch.get(m) ?? 0, spend: (_h, m, n) => ((pouch.get(m) ?? 0) >= n ? (pouch.set(m, pouch.get(m)! - n), true) : false) },
      repairReachM: 100,
    });
    const house = sim.spawn();
    addComponent(sim.ecs, Transform, house);
    Transform.px[house] = 3;
    Transform.pz[house] = 0;
    addComponent(sim.ecs, AssetRef, house);
    breaks.register(sim, house, "t/house", { health: 10, into: "variant", respawnS: null, repair: { material: "yew-log", count: 2, castSeconds: 0.1 } });
    Health.current[house] = 0;
    breaks.step(sim);
    gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world: sim, systems: [breaks], spawnPoint: { x: 0, z: 0 } });
    const port = await gw.listen();
    gw.frame(now);
    const { client, chests } = await join(`ws://127.0.0.1:${port}`, "alice");
    const bob = await join(`ws://127.0.0.1:${port}`, "user-a");
    const view = chests.chests[0]!;
    assert.deepEqual([view.kind, view.open, view.entity], ["ruin", false, sim.wireId(house).toString()]);

    let errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    assert.match(decodeControl<ErrorMessage>((await errP)[0]!).message, /takes 2 yew-log/);

    pouch.set("yew-log", 2);
    const startedP = client.waitFor(MessageType.Magic, 1);
    const seenP = bob.client.waitFor(MessageType.Interact, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    const started = decodeControl<SpellMessage>((await startedP)[0]!);
    assert.deepEqual([started.spell, started.state], ["repair", "started"]);
    await new Promise((r) => setTimeout(r, 250));
    tick();
    const seen = decodeControl<ChestsMessage>((await seenP)[0]!).chests[0]!;
    assert.deepEqual([seen.kind, seen.open], ["ruin", true]);
    assert.equal(pouch.get("yew-log"), 0, "spent");
    errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    assert.match(decodeControl<ErrorMessage>((await errP)[0]!).message, /nothing to use there|nothing to pick up/);
    await client.close();
    await bob.client.close();
  });
});
