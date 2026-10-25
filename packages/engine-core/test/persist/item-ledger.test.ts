/**
 * ItemLedger (roadmap P2a): events recorded, flushed and loaded as the latest
 * state per item; tombstones; id reservation; the store/service restoring
 * bags, hands and ground items from it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ItemLedger, LedgerKind } from "../../src/persist/item-ledger.js";
import { ItemDefs, ItemService, ItemStore, ItemWhere, type PoolItemLike } from "../../src/items/index.js";
import { engineDefaults } from "@mmo-engine/rules";
import { SimWorld } from "../../src/world.js";
import { WorldItem } from "../../src/components.js";

function ledger(): ItemLedger {
  return new ItemLedger(new Database(":memory:"));
}

describe("ItemLedger", () => {
  it("holds events until flushed, then loads the latest row per item", () => {
    const l = ledger();
    l.tick = 5;
    l.record(LedgerKind.Create, 1, 3, 0, 0, 10);
    l.record(LedgerKind.Ground, 1, 3, 0, 0, 10, 4, 6);
    l.record(LedgerKind.Bag, 1, 3, 77, 2, 9);
    l.record(LedgerKind.Create, 2, 4, 0, 0, 1);
    assert.equal(l.pending, 4);
    assert.equal(l.load().length, 0, "nothing written yet");
    assert.equal(l.flush(), 4);
    assert.equal(l.pending, 0);
    assert.equal(l.count(), 4);
    const rows = l.load();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: 1, kind: LedgerKind.Bag, def: 3, owner: 77, slot: 2, durability: 9, x: 0, z: 0 });
    assert.equal(rows[1].kind, LedgerKind.Create);
    assert.equal(l.flush(), 0);
  });

  it("a destroy row tombstones the item but its id stays reserved", () => {
    const l = ledger();
    l.record(LedgerKind.Create, 1, 0, 0, 0, 1);
    l.record(LedgerKind.Create, 9, 0, 0, 0, 1);
    l.record(LedgerKind.Destroy, 9, 0, 0, 0, 1);
    l.flush();
    assert.deepEqual(l.load().map((r) => r.id), [1]);
    assert.equal(l.maxItemId(), 9);
  });

  it("grows past its initial buffers without losing events", () => {
    const l = ledger();
    for (let i = 1; i <= 1000; i++) l.record(LedgerKind.Ground, i, i % 5, 0, 0, i, i, -i);
    assert.equal(l.flush(), 1000);
    const rows = l.load();
    assert.equal(rows.length, 1000);
    assert.equal(rows[999].x, 1000);
    assert.equal(rows[999].z, -1000);
  });
});

describe("ItemStore with a ledger", () => {
  it("restores bags, hands and ground items, and never reuses ids", () => {
    const db = new Database(":memory:");
    const l = new ItemLedger(db);
    const s = new ItemStore(8, 3);
    s.ledger = l;
    const bagged = s.create(1, 10);
    const held = s.create(2, 20);
    const dropped = s.create(3, 30);
    const gone = s.create(4, 40);
    s.putInBag(50, bagged);
    s.hold(50, held, 1);
    s.placeOnGround(dropped, 0, 12, -3);
    s.destroy(gone);
    l.flush();

    const s2 = new ItemStore(8, 3);
    for (const row of new ItemLedger(db).load()) s2.restore(row);
    s2.reserveIds(l.maxItemId());
    assert.equal(s2.size, 3);
    assert.equal(s2.bag(50)[0], bagged);
    assert.equal(s2.hands(50)[1], held);
    assert.equal(s2.where[s2.slot(dropped)], ItemWhere.Ground);
    assert.equal(s2.defs[s2.slot(held)], 2);
    assert.equal(s2.durability[s2.slot(dropped)], 30);
    assert.equal(s2.exists(gone), false);
    assert.equal(s2.create(0, 1), gone + 1, "ids continue past the destroyed one");
  });
});

describe("ItemService with a ledger", () => {
  it("restores bag, hands and ground into a new service without a second starter weapon", () => {
    const rules = engineDefaults();
    rules.items.bases.sword = { ...rules.items.fallback, hand: "main", technique: "cut", models: ["pack/SM_Wep_Sword_01"] };
    const pool: PoolItemLike[] = ["a", "b", "c"].map((id, i) => ({
      id, rank: "common", source: "mob", item: "sword", seed: i,
      bundle: { Identity: { id, name: id, base: "sword" }, Rank: { id: "common", color: "#ffffff" }, Stats: {} },
    }));
    const defs = new ItemDefs(pool, rules);
    const loot = { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 4, maxGroundItems: 100 };
    const make = (): ItemService => new ItemService({ defs, loot, tickHz: 30, starterBase: "sword" });

    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    sim.beginTick(1);
    const db = new Database(":memory:");
    const ledger = new ItemLedger(db);
    const a = make();
    a.attachLedger(ledger);
    assert.equal(a.outfit(7), true);
    const gift = a.give(7, 1);
    assert.equal(gift.ok, true);
    const drop = a.spawnDrop(sim, 2, 5, 6, 0);
    const doomed = a.spawnDrop(sim, 0, 1, 1, 0);
    a.store.destroy(doomed.item);
    ledger.flush();

    SimWorld.resetEntityCursorForTesting();
    const sim2 = new SimWorld();
    sim2.beginTick(500);
    const b = make();
    const rows = new ItemLedger(db).load();
    assert.equal(b.restore(sim2, rows), rows.length);
    b.attachLedger(new ItemLedger(db));
    assert.equal(b.outfit(7), false, "restored owner is not outfitted again");
    assert.deepEqual([...b.store.bag(7)].sort(), [...a.store.bag(7)].sort());
    assert.equal(b.store.hands(7)[0], a.store.hands(7)[0]);
    assert.equal(b.groundCount, 1);
    const eid = b.groundEntity(drop.item);
    assert.equal(WorldItem.despawnAt[eid], 500 + 300 * 30, "fresh despawn timer");
    assert.equal(WorldItem.owner[eid], 0);
  });
});
