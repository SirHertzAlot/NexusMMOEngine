/**
 * Loot gold (EC1): a dying creature pays gold straight into its killer's
 * wallet, rolled from the creature's `drops.gold` range.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { engineDefaults } from "@mmo-engine/rules";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import type { LifeEvent } from "../../src/death.js";
import { ItemDefs, ItemService, LootDropper, type PoolItemLike } from "../../src/items/index.js";
import { WalletSystem } from "../../src/economy/wallet.js";

const RULES = engineDefaults();
const POOL: PoolItemLike[] = [
  { id: "a", rank: "common", source: "mob", item: "ring", seed: 0, bundle: { Identity: { id: "a", name: "a", base: "ring" }, Rank: { id: "common", color: "#fff" }, Stats: {} } },
];

function setup(gold?: [number, number]) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  sim.beginTick(1);
  const defs = new ItemDefs(POOL, RULES);
  const items = new ItemService({ defs, loot: { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 24, maxGroundItems: 100 }, tickHz: 30 });
  const wallet = new WalletSystem();
  const killer = sim.spawn();
  addComponent(sim.ecs, C.Transform, killer);
  addComponent(sim.ecs, C.CharacterRef, killer);
  C.CharacterRef.idHi[killer] = 0;
  C.CharacterRef.idLo[killer] = 42;
  const mob = sim.spawn();
  addComponent(sim.ecs, C.Transform, mob);
  const dropper = new LootDropper({
    items, defs, wallet, seed: 7,
    kindOf: (e) => (e === mob ? "goblin" : undefined),
    creatures: { goblin: { drops: { rolls: [0, 0], chance: 0, ...(gold ? { gold } : {}) } } } as never,
  });
  const ev: LifeEvent = { tick: 1, target: mob, state: "dead", killer, x: 0, z: 0 };
  return { sim, dropper, ev, wallet };
}

describe("loot gold", () => {
  it("the killer pockets gold from the creature's gold range", () => {
    const { sim, dropper, ev, wallet } = setup([10, 20]);
    dropper.onDeath(sim, ev);
    const balance = wallet.balanceOf(42);
    assert.ok(balance >= 10 && balance <= 20, `gold in range, got ${balance}`);
  });

  it("no gold when the creature has no gold range", () => {
    const { sim, dropper, ev, wallet } = setup();
    dropper.onDeath(sim, ev);
    assert.equal(wallet.balanceOf(42), 0);
  });

  it("no gold without a killer", () => {
    const { sim, dropper, wallet } = setup([10, 20]);
    const ev: LifeEvent = { tick: 1, target: 999, state: "dead", x: 0, z: 0 };
    dropper.onDeath(sim, ev);
    assert.equal(wallet.balanceOf(42), 0);
  });

  it("a fixed gold amount pays exactly", () => {
    const { sim, dropper, ev, wallet } = setup([25, 25]);
    dropper.onDeath(sim, ev);
    assert.equal(wallet.balanceOf(42), 25);
  });
});
