/**
 * Items (roadmap M3a): the instance store, the definitions table, and the
 * ItemService's rules — where drops land, who may take them and when
 * (decision D2), pickup range and bag space, despawning, the ground cap,
 * and clearing ground items a restart left behind.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import { GROUND_ITEM_VARIANT } from "@mmo-engine/protocol";
import { engineDefaults, type LootRules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { ItemDefs, ItemService, ItemStore, ItemWhere, type PoolItemLike } from "../../src/items/index.js";

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = {
    ...r.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01", "pack/SM_Wep_Sword_02"],
  };
  return r;
})();

function poolItem(id: string, base: string, rank: string, source: string, seed: number, stats: Record<string, number> = {}): PoolItemLike {
  return {
    id, rank, source, item: base, seed,
    bundle: { Identity: { id, name: `${rank} ${base} ${id}`, base }, Rank: { id: rank, color: "#ffffff" }, Stats: stats },
  };
}

const POOL: PoolItemLike[] = [
  poolItem("a", "sword", "common", "mob", 0, { power: 10 }),
  poolItem("b", "sword", "rare", "boss", 1, { power: 20 }),
  poolItem("c", "ring", "common", "mob", 2, { spell: 3 }),
];

function loot(over: Partial<LootRules> = {}): LootRules {
  return { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 3, maxGroundItems: 100, ...over };
}

function world(): { sim: SimWorld; avatar(x: number, z: number): number } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  sim.beginTick(1);
  return {
    sim,
    avatar(x, z) {
      const e = sim.spawn();
      addComponent(sim.ecs, C.Transform, e);
      C.Transform.px[e] = x; C.Transform.py[e] = 0; C.Transform.pz[e] = z;
      C.Transform.qx[e] = 0; C.Transform.qy[e] = 0; C.Transform.qz[e] = 0; C.Transform.qw[e] = 1;
      return e;
    },
  };
}

describe("ItemStore", () => {
  it("never reuses ids, reuses slots, and grows past its capacity", () => {
    const s = new ItemStore(4, 2);
    const a = s.create(0, 10);
    const b = s.create(1, 10);
    const c = s.create(2, 10); // grows
    assert.deepEqual([a, b, c], [1, 2, 3]);
    assert.equal(s.size, 3);
    const slotB = s.slot(b);
    s.destroy(b);
    assert.equal(s.exists(b), false);
    const d = s.create(3, 10);
    assert.equal(d, 4, "a new id, never b's");
    assert.equal(s.slot(d), slotB, "b's slot is reused");
    assert.equal(s.defs[s.slot(c)], 2);
  });

  it("fills bags slot by slot, refuses when full, and empties on destroy", () => {
    const s = new ItemStore(2);
    const [a, b, c] = [s.create(0, 1), s.create(0, 1), s.create(0, 1)];
    assert.equal(s.putInBag(7, a), 0);
    assert.equal(s.putInBag(7, b), 1);
    assert.equal(s.hasRoom(7), false);
    assert.equal(s.putInBag(7, c), -1);
    assert.equal(s.inBagOf(7, a), true);
    assert.equal(s.inBagOf(8, a), false);
    s.destroy(a);
    assert.deepEqual([...s.bag(7)], [0, b]);
    s.placeOnGround(b, 0);
    assert.deepEqual([...s.bag(7)], [0, 0]);
    assert.equal(s.where[s.slot(b)], ItemWhere.Ground);
  });
});

describe("ItemDefs", () => {
  it("joins pool items with the rules' physics, picks a model by seed, and indexes by source and base", () => {
    const d = new ItemDefs(POOL, RULES);
    assert.equal(d.count, 3);
    assert.equal(d.models[0], "pack/SM_Wep_Sword_01");
    assert.equal(d.models[1], "pack/SM_Wep_Sword_02");
    assert.equal(d.assetHash[0], fnv1a32("pack/SM_Wep_Sword_01"));
    assert.ok(Math.abs(d.mass[0] - 1.3) < 1e-6);
    assert.equal(d.power[1], 20);
    assert.equal(d.models[2], "", "a base with no rules falls back, with no model");
    assert.equal(d.technique[2], RULES.items.fallback.technique);
    assert.deepEqual([...d.ofSource("mob")], [0, 2]);
    assert.deepEqual([...d.ofBase("sword")], [0, 1]);
    assert.equal(d.indexOf("b"), 1);
    assert.equal(d.starter("sword", ["common", "rare"]), 0);
  });
});

describe("ItemService", () => {
  const defs = new ItemDefs(POOL, RULES);

  it("drops lie flat on the ground as a ground-item AssetRef with a server-only WorldItem", () => {
    const { sim } = world();
    const items = new ItemService({ defs, loot: loot(), tickHz: 30, groundHeightAt: () => 4 });
    const { item, eid } = items.spawnDrop(sim, 0, 10, 20, 7);
    assert.equal(C.AssetRef.variant[eid], GROUND_ITEM_VARIANT);
    assert.equal(C.AssetRef.assetHash[eid], defs.assetHash[0]);
    assert.ok(Math.abs(C.Transform.py[eid] - 4.06) < 1e-5);
    const q = [C.Transform.qx[eid], C.Transform.qy[eid], C.Transform.qz[eid], C.Transform.qw[eid]];
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5, "a unit quaternion");
    // The model's +Y (its length) ends up level: rotate (0,1,0) by q.
    const [x, , z] = q;
    const upY = 1 - 2 * (x * x + z * z);
    assert.ok(Math.abs(upY) < 1e-5, `lying flat (y of its long axis ${upY})`);
    assert.equal(C.WorldItem.item[eid], item);
    assert.equal(C.WorldItem.owner[eid], 7);
    assert.equal(C.WorldItem.ownedUntil[eid], 1 + 900);
    assert.equal(C.WorldItem.despawnAt[eid], 1 + 9000);
    assert.equal(items.groundCount, 1);
    assert.deepEqual(items.dropsFor(sim, null)?.drops, [[sim.wireId(eid).toString(), defs.names[0], "common", "#ffffff"]]);
  });

  it("only the owner picks up within the ownership time; then anyone in range with room", () => {
    const { sim, avatar } = world();
    const items = new ItemService({ defs, loot: loot(), tickHz: 30 });
    const mine = avatar(0, 0);
    const theirs = avatar(1, 0);
    const far = avatar(10, 0);
    const { item, eid } = items.spawnDrop(sim, 0, 0.5, 0, 1);
    const wid = sim.wireId(eid);
    assert.deepEqual(items.pickup(sim, 2, theirs, wid), { ok: false, error: "that belongs to someone else for now" });
    assert.deepEqual(items.pickup(sim, 3, far, wid), { ok: false, error: "too far away" });
    sim.beginTick(1 + 900); // ownership over
    const r = items.pickup(sim, 2, theirs, wid);
    assert.equal(r.ok, true);
    assert.equal(items.store.inBagOf(2, item), true);
    assert.equal(hasComponent(sim.ecs, C.WorldItem, eid), false, "the ground entity is gone");
    assert.equal(items.groundCount, 0);
    assert.deepEqual(items.pickup(sim, 1, mine, wid), { ok: false, error: "nothing to pick up there" });
  });

  it("refuses a pickup into a full bag, leaving the item where it lies", () => {
    const { sim, avatar } = world();
    const items = new ItemService({ defs, loot: loot({ bagSlots: 1 }), tickHz: 30 });
    const me = avatar(0, 0);
    items.give(1, 0);
    const { eid } = items.spawnDrop(sim, 1, 0, 1, 1);
    assert.deepEqual(items.pickup(sim, 1, me, sim.wireId(eid)), { ok: false, error: "your bag is full" });
    assert.equal(items.groundCount, 1);
  });

  it("drops from the bag at the avatar's feet, for anyone", () => {
    const { sim, avatar } = world();
    const items = new ItemService({ defs, loot: loot(), tickHz: 30 });
    const me = avatar(5, 5);
    items.give(1, 2);
    const id = items.store.bag(1)[0];
    assert.deepEqual(items.dropFromBag(sim, 2, me, id), { ok: false, error: "you don't have that" });
    assert.equal(items.dropFromBag(sim, 1, me, id).ok, true);
    const eid = items.groundEntity(id);
    assert.ok(eid >= 0);
    assert.equal(C.WorldItem.owner[eid], 0);
    assert.ok(Math.hypot(C.Transform.px[eid] - 5, C.Transform.pz[eid] - 5) < 1);
    assert.deepEqual([...items.store.bag(1)], [0, 0, 0]);
  });

  it("despawns ground items when their time is up, and destroys the item", () => {
    const { sim } = world();
    const items = new ItemService({ defs, loot: loot({ despawnSeconds: 1 }), tickHz: 30 });
    const { item, eid } = items.spawnDrop(sim, 0, 0, 0, 0);
    sim.beginTick(30);
    items.step(sim);
    assert.equal(items.store.exists(item), true);
    sim.beginTick(31);
    items.step(sim);
    assert.equal(items.store.exists(item), false);
    assert.equal(hasComponent(sim.ecs, C.WorldItem, eid), false);
  });

  it("past the ground cap, the oldest drop goes", () => {
    const { sim } = world();
    const items = new ItemService({ defs, loot: loot({ maxGroundItems: 2 }), tickHz: 30 });
    const a = items.spawnDrop(sim, 0, 0, 0, 0).item;
    const b = items.spawnDrop(sim, 1, 0, 0, 0).item;
    const c = items.spawnDrop(sim, 2, 0, 0, 0).item;
    assert.equal(items.groundCount, 2);
    assert.equal(items.store.exists(a), false);
    assert.equal(items.store.exists(b) && items.store.exists(c), true);
  });

  it("clears ground-item entities with nothing behind them (a restored snapshot's)", () => {
    const { sim } = world();
    const items = new ItemService({ defs, loot: loot(), tickHz: 30 });
    const live = items.spawnDrop(sim, 0, 0, 0, 0).eid;
    const stray = sim.spawn();
    addComponent(sim.ecs, C.Transform, stray);
    addComponent(sim.ecs, C.AssetRef, stray);
    C.AssetRef.variant[stray] = GROUND_ITEM_VARIANT;
    const scenery = sim.spawn();
    addComponent(sim.ecs, C.AssetRef, scenery);
    C.AssetRef.variant[scenery] = 0;
    assert.equal(items.clearStrayGroundItems(sim), 1);
    assert.equal(hasComponent(sim.ecs, C.WorldItem, live), true);
    assert.equal(hasComponent(sim.ecs, C.AssetRef, stray), false);
    assert.equal(hasComponent(sim.ecs, C.AssetRef, scenery), true);
  });

  it("shows a bag slot by slot, with each item's view", () => {
    const items = new ItemService({ defs, loot: loot(), tickHz: 30 });
    items.give(1, 1);
    const inv = items.inventoryOf(1);
    assert.equal(inv.bag.length, 3);
    assert.equal(inv.bag[1], null);
    assert.equal(inv.bag[0]?.def, "b");
    assert.equal(inv.bag[0]?.hand, "main");
    assert.equal(inv.bag[0]?.stats.power, 20);
    assert.equal(inv.bag[0]?.model, "pack/SM_Wep_Sword_02");
  });
});
