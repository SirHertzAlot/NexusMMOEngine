/**
 * Crafting, backwards from top gear: every material reachable, every vein
 * useful, recipes that follow what the composer put in an item, and costs
 * rising with rank.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KINDS } from "@mmo-engine/species";
import { BUILTIN_DRESSING } from "@mmo-engine/dungeon";
import { bakeLootPool, BUILTIN_CATALOG, composeItem, composeCreature } from "@mmo-engine/compose";
import {
  BUILTIN_MATERIALS, craftReport, gatherHours, isTradable, materialProblems, recipeFor, REFINING, topGearNeeds, TRADABILITY,
} from "../src/index.js";

const WORLD = {
  veins: Object.keys(BUILTIN_DRESSING.veins),
  creatureKinds: [...KINDS],
  biomes: ["volcanic", "glacier", "snow", "mountains", "tundra", "swamp", "desert", "rainforest", "forest", "plains"],
};

describe("materials", () => {
  it("are all reachable, and every dungeon vein yields something", () => {
    assert.deepEqual(materialProblems(WORLD), []);
    const broken = { ...BUILTIN_MATERIALS, "star-metal": { name: "Star metal", tier: 5, kind: "ore" as const, skill: "Mining", sources: [{ kind: "vein" as const, vein: "meteor" }] } };
    assert.match(materialProblems(WORLD, broken).join("\n"), /star-metal: no reachable source/);
    assert.match(materialProblems({ ...WORLD, veins: [...WORLD.veins, "salt-flat"] }).join("\n"), /vein salt-flat: yields no material/);
  });

  it("refine every composer material from known raw materials", () => {
    for (const [id, comp] of Object.entries(BUILTIN_CATALOG.components)) {
      if (comp.slot !== "material") continue;
      assert.ok(REFINING[id], `${id} has a refining recipe`);
      for (const raw of Object.keys(REFINING[id])) assert.ok(BUILTIN_MATERIALS[raw], `${id}: ${raw} is a material`);
    }
  });

  it("trade up to tier 3, bind above (the proposal)", () => {
    assert.equal(isTradable(BUILTIN_MATERIALS["iron-ore"]), true);
    assert.equal(isTradable(BUILTIN_MATERIALS["rune-stone"]), false);
    assert.equal(TRADABILITY.itemBinding(0), "none");
    assert.equal(TRADABILITY.itemBinding(0.75), "equip");
    assert.equal(TRADABILITY.itemBinding(1), "pickup");
  });
});

describe("recipes", () => {
  it("follow the item: material by base size, reagents by element, runes and uniques", () => {
    const x = composeItem("greatsword", "legendary", { seed: 3 }).bundle;
    const r = recipeFor(x);
    const refine = REFINING[x.Material!];
    for (const [raw, n] of Object.entries(refine)) assert.ok(r.inputs[raw] >= n * 6, `${raw}: a two-handed item takes six units`);
    assert.ok(r.inputs["rune-stone"] >= 4, "runes and a unique ability take rune stone");
    assert.equal(r.skill, "Smithing");
    assert.equal(r.mastery, 0.9);
    assert.equal(r.tier, 5);
    const ring = recipeFor(composeItem("ring", "common", { seed: 1 }).bundle);
    assert.equal(ring.skill, "Jewelcrafting");
    assert.equal(ring.inputs["gold-ore"], 1, "a gold setting");
    assert.equal(ring.mastery, 0);
    assert.ok(recipeFor(composeItem("cuirass", "common", { seed: 1 }).bundle).inputs["beast-hide"] === 2, "leather straps");
    assert.throws(() => recipeFor(composeCreature({ id: "troll", name: "Troll", tags: ["organic"] }, "rare").bundle), /creatures aren't crafted/);
  });

  it("from top gear back: the best gear's needs, all reachable", () => {
    const top = topGearNeeds({ seeds: 3 });
    assert.ok(top.needs["rune-stone"] > 0, "top gear needs the deepest veins' rune stone");
    for (const raw of Object.keys(top.needs)) assert.ok(BUILTIN_MATERIALS[raw]);
    assert.deepEqual(materialProblems(WORLD, BUILTIN_MATERIALS, new Set(Object.keys(top.needs))).filter((p) => !/no recipe uses it/.test(p)), []);
  });
});

describe("the pool, crafted", () => {
  it("costs more to gather at each rank, and binds the top", () => {
    const pool = bakeLootPool({ size: 300, seed: 5 });
    const r = craftReport(pool.items);
    assert.deepEqual(r.problems, []);
    const hours = ["common", "uncommon", "rare", "epic", "legendary"].map((k) => r.byRank[k].meanHours);
    for (let i = 1; i < hours.length; i++) assert.ok(hours[i] > hours[i - 1], `rising: ${hours}`);
    assert.equal(r.byRank.common.tradableShare, 1, "commons from commodities");
    assert.equal(r.byRank.legendary.tradableShare, 0, "legendaries need bound materials");
    const one = recipeFor(pool.items[0].bundle);
    assert.ok(gatherHours(one) > 0);
  });
});
