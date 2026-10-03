/**
 * Items over the wire (roadmap M3a, protocol 0x13–0x15): a real Gateway
 * with an ItemService and WebSocket clients. Joining sends the (empty)
 * bag; a dropped item's name arrives before the delta that shows it;
 * picking it up answers with the bag and removes it from the world; the
 * ownership window, range, and malformed actions are refused.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  decodeDelta,
  encodeControl,
  MessageType,
  type AdminResult,
  type DropsMessage,
  type ErrorMessage,
  type InventoryMessage,
} from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { BodySystem } from "../../src/body.js";
import { SimWorld } from "../../src/world.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

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

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
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

const creds = (username: string): HelloAuth => ({ username, password: TEST_PASSWORD });

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const invP = client.waitFor(MessageType.Inventory, 1);
  await client.hello(username, creds(username));
  await snapP;
  const [inv] = await invP;
  assert.deepEqual(decodeControl<InventoryMessage>(inv).bag.every((s) => s === null), true, "an empty bag on joining");
  return client;
}

async function admin(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command, ...(args === undefined ? {} : { args }) }));
  return decodeControl<AdminResult>((await resP)[0]);
}

function tick(): void {
  now += 1000 / 30;
  gw!.frame(now);
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

describe("gateway: items", () => {
  it("a drop is named before the delta that shows it; picking it up fills the bag and removes it", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const alice = await join(url, "alice");
    const dropped = await admin(alice, "drop", { base: "sword" });
    assert.equal(dropped.ok, true, dropped.message);
    const wid = dropped.message.split(" ").at(-1)!;

    const dropsP = alice.waitFor(MessageType.Drops, 1);
    const deltaP = alice.waitFor(MessageType.Delta, 1);
    tick();
    const [drops] = await dropsP;
    const [delta] = await deltaP;
    const rows = decodeControl<DropsMessage>(drops).drops;
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], wid);
    assert.match(rows[0][1], /^Sword /);
    assert.ok(decodeDelta(delta).spawned.includes(BigInt(wid)), "the delta spawns it");

    const invP = alice.waitFor(MessageType.Inventory, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "pickup", entity: wid }));
    const bag = decodeControl<InventoryMessage>((await invP)[0]).bag;
    assert.equal(bag.filter((s) => s !== null).length, 1);
    assert.match(bag[0]!.name, /^Sword /);

    const goneP = alice.waitFor(MessageType.Delta, 1);
    tick();
    assert.ok(decodeDelta((await goneP)[0]).despawned.includes(BigInt(wid)), "the next delta despawns it");
    await alice.close();
  });

  it("someone else's drop is refused (4005) during its ownership time; malformed is 4003", async () => {
    const url = await startGateway({ admins: ["alice", "user-a"] });
    const alice = await join(url, "alice");
    const bob = await join(url, "user-a");
    // Both stand at the same spot, so only ownership stands in the way.
    assert.equal((await admin(alice, "teleport", { x: 50, z: 50 })).ok, true);
    assert.equal((await admin(bob, "teleport", { x: 50, z: 50 })).ok, true);
    const loot = await admin(alice, "loot", { count: 1 });
    assert.equal(loot.ok, true, loot.message);
    // Bob learns of the drop (alice earned it: it is hers for 30 s).
    const dropsP = bob.waitFor(MessageType.Drops, 1);
    tick();
    const wid = decodeControl<DropsMessage>((await dropsP)[0]).drops[0][0];
    const refused = await nextError(bob, () => bob.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "pickup", entity: wid })));
    assert.equal(refused.code, 4005);
    assert.match(refused.message, /someone else/);
    const malformed = await nextError(bob, () => bob.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "eat" })));
    assert.equal(malformed.code, 4003);
    await alice.close();
    await bob.close();
  });

  it("give puts an item straight in the bag; items describes the pool", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const alice = await join(url, "alice");
    const listed = await admin(alice, "items", { base: "sword" });
    assert.match(listed.message, /^3 items/);
    const invP = alice.waitFor(MessageType.Inventory, 1);
    const given = await admin(alice, "give", { def: "b" });
    assert.equal(given.ok, true, given.message);
    const bag = decodeControl<InventoryMessage>((await invP)[0]).bag;
    assert.equal(bag[0]?.def, "b");
    await alice.close();
  });

  it("entering the world outfits the starter sword and shows it; unequip/equip refresh it", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const alice = await join(url, "alice");
    const outfit = await admin(alice, "inspect", { entity: "me" });
    assert.match(outfit.message, /"held":\{"main":"[^"]+"\}/, "starter sword visible on join");
    const hands = await admin(alice, "set", { entity: "me", component: "Health", field: "current", value: 50 });
    assert.equal(hands.ok, true);
    // Unequip over the wire: the held model leaves the appearance...
    const invP = alice.waitFor(MessageType.Inventory, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "unequip", hand: "main" }));
    const bagged = decodeControl<InventoryMessage>((await invP)[0]).bag;
    const sword = bagged.find((i) => i !== null);
    assert.ok(sword, "sword is back in the bag");
    const bare = await admin(alice, "inspect", { entity: "me" });
    assert.doesNotMatch(bare.message, /"held"/);
    // ...and equipping the bagged sword back brings it back.
    const invP3 = alice.waitFor(MessageType.Inventory, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "equip", item: sword!.id }));
    await invP3;
    const dressed = await admin(alice, "inspect", { entity: "me" });
    assert.match(dressed.message, /"held":\{"main":"[^"]+"\}/);
    await alice.close();
  });

  it("a hand cut off drops its sword at the player's feet, and can't take hold again (M3)", async () => {
    const { rules, hooks } = loadGameRules();
    const world = new SimWorld();
    const body = new BodySystem(rules.body, hooks, rules.appearance);
    now = 1_000_000;
    const items = makeItems();
    gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world, systems: [items, body], items, body, admins: ["alice"] });
    const port = await gw.listen();
    gw.frame(now);
    const alice = await join(`ws://127.0.0.1:${port}`, "alice");
    tick();
    const avatar = world.resolveWireId(BigInt(alice.welcome!.player_entity));
    const dropsP = alice.waitFor(MessageType.Drops, 1);
    const invP = alice.waitFor(MessageType.Inventory, 1);
    body.applyBlow(world, avatar, "handRight", "cut", 100);
    tick();
    const inv = decodeControl<InventoryMessage>((await invP)[0]);
    assert.ok(!inv.main, "the hand let go");
    const drops = decodeControl<DropsMessage>((await dropsP)[0]).drops;
    assert.equal(drops.length, 1, "the sword is on the ground");
    const bare = await admin(alice, "inspect", { entity: "me" });
    assert.doesNotMatch(bare.message, /"held"/);
    assert.match(bare.message, /"lost":\[[^\]]*"handRight"/, "everyone's look hides the lost hand");
    // Picked up again, it can't be held in a hand that is gone.
    const pickP = alice.waitFor(MessageType.Inventory, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "pickup", entity: drops[0][0] }));
    const sword = decodeControl<InventoryMessage>((await pickP)[0]).bag.find((i) => i !== null)!;
    const refused = await nextError(alice, () => alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "equip", item: sword.id })));
    assert.equal(refused.code, 4005);
    assert.match(refused.message, /can't hold/);
    // The admin console injures too.
    const leg = await admin(alice, "injure", { part: "legLeft", kind: "blunt", amount: 6 });
    assert.equal(leg.ok, true, leg.message);
    assert.equal(leg.message, "legLeft maimed");
    const bad = await nextError(alice, () => alice.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "injure", args: { part: "tail" } })));
    assert.match(bad.message, /no body part "tail"/);
    await alice.close();
  });
});
