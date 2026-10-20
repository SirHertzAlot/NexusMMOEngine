/**
 * starterBase defaults to null (no content-defined item name as a default):
 * with no starterBase configured, outfit() gives nothing; the game pack opts
 * in by naming a base explicitly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineDefaults, type LootRules } from "@mmo-engine/rules";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = {
    ...r.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  return r;
})();

const POOL: PoolItemLike[] = [
  {
    id: "a", rank: "common", source: "mob", item: "sword", seed: 0,
    bundle: { Identity: { id: "a", name: "common sword a", base: "sword" }, Rank: { id: "common", color: "#ffffff" }, Stats: { power: 10 } },
  },
];

function loot(): LootRules {
  return { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 3, maxGroundItems: 100 };
}

describe("ItemService starterBase default", () => {
  it("defaults to null: outfit gives nothing", () => {
    const items = new ItemService({ defs: new ItemDefs(POOL, RULES), loot: loot(), tickHz: 30 });
    assert.equal(items.outfit(1), false);
  });

  it("an explicit starterBase still outfits the character", () => {
    const items = new ItemService({ defs: new ItemDefs(POOL, RULES), loot: loot(), tickHz: 30, starterBase: "sword" });
    assert.equal(items.outfit(1), true);
    assert.equal(items.outfit(1), false, "once per character per run");
  });

  it("an explicit null starterBase gives nothing", () => {
    const items = new ItemService({ defs: new ItemDefs(POOL, RULES), loot: loot(), tickHz: 30, starterBase: null });
    assert.equal(items.outfit(1), false);
  });
});
