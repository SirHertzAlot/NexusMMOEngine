/**
 * Eating over the wire (item action `use`): checked up front, a cast bar of `eatSeconds`, the
 * meter rises and the item goes when the bar fills; a full stomach is refused; a move cancels it.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type AdminResult, type ErrorMessage, type InventoryMessage, type SpellMessage } from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway } from "../../src/net/gateway.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { HeadlessClient } from "./headless-client.js";
import { SimWorld } from "../../src/world.js";
import * as C from "../../src/components.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

const POOL: PoolItemLike[] = [
  { id: "b", rank: "common", source: "chest", item: "bread", seed: 1, bundle: { Identity: { id: "b", name: "Bread", base: "bread" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { nourish: 25 } } },
];

async function start(): Promise<{ sim: SimWorld; alice: HeadlessClient; avatar: number }> {
  now = 1_000_000;
  const rules = engineDefaults();
  const items = new ItemService({ defs: new ItemDefs(POOL, rules), loot: rules.loot, tickHz: 30 });
  const sim = new SimWorld();
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world: sim, systems: [items], items, admins: ["alice"], needs: { eatSeconds: 0.15 }, spawnPoint: { x: 0, z: 0 } });
  const port = await gw.listen();
  gw.frame(now);
  const alice = new HeadlessClient();
  await alice.connect(`ws://127.0.0.1:${port}`);
  const snapP = alice.waitFor(MessageType.Snapshot, 1);
  await alice.hello("alice", { username: "alice", password: TEST_PASSWORD });
  await snapP;
  return { sim, alice, avatar: sim.resolveWireId(BigInt(alice.welcome!.player_entity)) };
}

async function give(alice: HeadlessClient): Promise<number> {
  const resP = alice.waitFor(MessageType.Admin, 1);
  const invP = alice.waitFor(MessageType.Inventory, 1);
  alice.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "give", args: { base: "bread" } }));
  assert.equal(decodeControl<AdminResult>((await resP)[0]!).ok, true);
  return decodeControl<InventoryMessage>((await invP)[0]!).bag.find((i) => i !== null)!.id;
}

describe("gateway: eating", () => {
  it("refuses a full stomach, then eats over a cast: the bar shows, the meter rises and the bread goes", async () => {
    const { alice, avatar } = await start();
    const bread = await give(alice);
    C.Needs.hunger[avatar] = C.Needs.hungerMax[avatar] = 100;
    const errP = alice.waitFor(MessageType.Error, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "use", item: bread }));
    assert.match(decodeControl<ErrorMessage>((await errP)[0]!).message, /not hungry/);

    C.Needs.hunger[avatar] = 40;
    const startedP = alice.waitFor(MessageType.Magic, 1);
    const invP = alice.waitFor(MessageType.Inventory, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "use", item: bread }));
    const started = decodeControl<SpellMessage>((await startedP)[0]!);
    assert.deepEqual([started.spell, started.state, started.seconds], ["eat", "started", 0.15]);
    assert.equal(C.Needs.hunger[avatar], 40, "nothing until the bar fills");
    const bag = decodeControl<InventoryMessage>((await invP)[0]!).bag;
    assert.equal(bag.every((i) => i === null), true, "the bread is gone");
    assert.equal(C.Needs.hunger[avatar], 65);
    await alice.close();
  });

  it("a move cancels the cast and the bread stays", async () => {
    const { alice, avatar } = await start();
    const bread = await give(alice);
    C.Needs.hunger[avatar] = 40;
    const startedP = alice.waitFor(MessageType.Magic, 1);
    alice.sendRaw(MessageType.Item, encodeControl({ kind: "item", action: "use", item: bread }));
    await startedP;
    const errP = alice.waitFor(MessageType.Error, 1);
    C.Transform.px[avatar] = C.Transform.px[avatar]! + 2;
    now += 1000 / 30;
    gw!.frame(now);
    assert.match(decodeControl<ErrorMessage>((await errP)[0]!).message, /interrupted: you moved/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(C.Needs.hunger[avatar], 40, "still hungry");
    await alice.close();
  });
});
