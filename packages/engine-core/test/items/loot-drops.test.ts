/**
 * Creature drops (roadmap L2): a dying creature leaves mob-pool items where it
 * fell, owned by its killer for the ownership window, free after it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, defineQuery } from "bitecs";
import { engineDefaults } from "@mmo-engine/rules";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import type { LifeEvent } from "../../src/death.js";
import { ItemDefs, ItemService, LootDropper, type PoolItemLike } from "../../src/items/index.js";

const RULES = engineDefaults();
const POOL: PoolItemLike[] = [
  { id: "a", rank: "common", source: "mob", item: "ring", seed: 0, bundle: { Identity: { id: "a", name: "a", base: "ring" }, Rank: { id: "common", color: "#fff" }, Stats: {} } },
  { id: "b", rank: "rare", source: "boss", item: "ring", seed: 1, bundle: { Identity: { id: "b", name: "b", base: "ring" }, Rank: { id: "rare", color: "#fff" }, Stats: {} } },
  { id: "c", rank: "common", source: "mob", item: "ring", seed: 2, bundle: { Identity: { id: "c", name: "c", base: "ring" }, Rank: { id: "common", color: "#fff" }, Stats: {} } },
];
const ground = defineQuery([C.WorldItem]);

function setup(chance: number, rolls: [number, number], seed = 1) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  sim.beginTick(1);
  const defs = new ItemDefs(POOL, RULES);
  const items = new ItemService({ defs, loot: { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 24, maxGroundItems: 100 }, tickHz: 30 });
  const avatar = (): number => {
    const e = sim.spawn();
    addComponent(sim.ecs, C.Transform, e);
    C.Transform.qw[e] = 1;
    return e;
  };
  const killer = avatar();
  addComponent(sim.ecs, C.CharacterRef, killer);
  C.CharacterRef.idHi[killer] = 1;
  C.CharacterRef.idLo[killer] = 7;
  const mob = avatar();
  const dropper = new LootDropper({
    items, defs, seed,
    kindOf: (e) => (e === mob ? "goblin" : undefined),
    creatures: { goblin: { drops: { rolls, chance } } } as never,
  });
  const ev = (target: number): LifeEvent => ({ tick: 1, target, state: "dead", killer, x: 50, z: 20 });
  return { sim, items, dropper, killer, mob, ev };
}

describe("LootDropper", () => {
  it("drops mob-pool items near the corpse, the killer's first, then anyone's", () => {
    const { sim, items, dropper, killer, mob, ev } = setup(1, [3, 3]);
    assert.equal(dropper.onDeath(sim, ev(mob)), 3);
    assert.equal(items.groundCount, 3);
    const drops = [...ground(sim.ecs)];
    for (const e of drops) {
      assert.ok(Math.hypot(C.Transform.px[e] - 50, C.Transform.pz[e] - 20) <= 1.21);
      assert.equal(C.WorldItem.owner[e], 1 * 4294967296 + 7);
    }
    C.Transform.px[killer] = 50;
    C.Transform.pz[killer] = 20;
    const wire = (e: number): bigint => sim.wireId(e);
    assert.equal(items.pickup(sim, 99, killer, wire(drops[0])).ok, false, "held off during the window");
    assert.equal(items.pickup(sim, 1 * 4294967296 + 7, killer, wire(drops[0])).ok, true, "the killer takes it");
    sim.beginTick(1 + 31 * 30);
    assert.equal(items.pickup(sim, 99, killer, wire(drops[1])).ok, true, "free after 30 s");
  });

  it("drops the named items of a loot table, even with the random rolls off", () => {
    const pool: PoolItemLike[] = [
      ...POOL,
      { id: "d1", rank: "common", source: "chest", item: "dagger", seed: 3, bundle: { Identity: { id: "d1", name: "Plain dagger", base: "dagger" }, Rank: { id: "common", color: "#fff" }, Stats: {} } },
      { id: "d2", rank: "rare", source: "chest", item: "dagger", seed: 4, bundle: { Identity: { id: "d2", name: "Fine dagger", base: "dagger" }, Rank: { id: "rare", color: "#fff" }, Stats: {} } },
    ];
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    sim.beginTick(1);
    const defs = new ItemDefs(pool, RULES);
    const items = new ItemService({ defs, loot: { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 24, maxGroundItems: 100 }, tickHz: 30 });
    const mob = sim.spawn();
    addComponent(sim.ecs, C.Transform, mob);
    const dropper = new LootDropper({
      items, defs,
      kindOf: (e) => (e === mob ? "goblin" : undefined),
      creatures: { goblin: { drops: { rolls: [0, 0], chance: 1, table: "spoils" } } } as never,
      tables: { spoils: { entries: [{ base: "dagger", chance: 1, count: [2, 2] }, { base: "dagger", rank: "rare", chance: 1, count: [1, 1] }, { base: "axe", chance: 1, count: [1, 1] }, { base: "dagger", chance: 0, count: [1, 1] }] } },
    });
    assert.equal(dropper.onDeath(sim, { tick: 1, target: mob, state: "dead", x: 5, z: 5 }), 3, "axe is not in the pool: nothing; 2 plain + 1 rare dagger");
    const names = [...ground(sim.ecs)].map((e) => defs.names[items.store.defs[items.store.slot(C.WorldItem.item[e])]]).sort();
    assert.deepEqual(names, ["Fine dagger", "Plain dagger", "Plain dagger"]);
    assert.equal(items.groundCount, 3);
  });

  it("is deterministic by seed", () => {
    const run = (seed: number): number[] => {
      const { sim, dropper, mob, ev } = setup(1, [2, 2], seed);
      dropper.onDeath(sim, ev(mob));
      return [...ground(sim.ecs)].map((e) => Math.round(C.Transform.px[e] * 1000));
    };
    assert.deepEqual(run(5), run(5));
    assert.notDeepEqual(run(5), run(6));
  });

  it("drops nothing at zero chance, zero rolls, or for a non-creature", () => {
    for (const [chance, rolls] of [[0, [3, 3]], [1, [0, 0]]] as const) {
      const { sim, items, dropper, mob, ev } = setup(chance, [...rolls]);
      assert.equal(dropper.onDeath(sim, ev(mob)), 0);
      assert.equal(items.groundCount, 0);
    }
    const { sim, items, dropper, killer, ev } = setup(1, [3, 3]);
    assert.equal(dropper.onDeath(sim, ev(killer)), 0);
    assert.equal(items.groundCount, 0);
  });
});
