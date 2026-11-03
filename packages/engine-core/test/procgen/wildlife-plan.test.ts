/** Wildlife layers from the catalog by name pattern, on synthetic entries (no licensed names). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpawnArchetypeSchema } from "@mmo-engine/scatter";
import { parseEcologyPlan, type EcologyPlan } from "../../src/procgen/ecology.js";
import { wildlifeArchetypes, wildlifeLayers, withWildlife, type CatalogModel } from "../../src/procgen/wildlife-plan.js";

const m = (n: string, skinned = false): CatalogModel => ({ id: `p/${n}`, name: n, skinned });
const models = [m("Coral"), m("Kelp"), m("Crab"), m("Crab_claw"), m("Shark"), m("Sheep"), m("Fox"), m("Frog"), m("Pelican"), m("Flying_seagull"), m("Cow", true), m("Beet")];

describe("wildlife layers", () => {
  const layers = wildlifeLayers(models);
  const ids = (id: string): string[] => layers.find((l) => l.id === id)?.assets.map((a) => a.asset).sort() ?? [];

  it("matches by whole name: sea floor in water, parts and swimmers left out", () => {
    assert.deepEqual(ids("seaFlora"), ["p/Coral", "p/Kelp"]);
    assert.deepEqual(ids("seaBed"), ["p/Crab"], "a claw is a part, not a crab");
    assert.deepEqual(ids("woodlandFauna"), ["p/Fox"]);
    assert.deepEqual(ids("critters"), ["p/Frog"]);
    assert.deepEqual(ids("shoreBirds"), ["p/Pelican"], "a flying pose does not stand");
    assert.deepEqual(ids("farmAnimals"), ["p/Sheep"], "a skinned model needs an agent, not a static prop");
    assert.deepEqual(ids("freeSwimmers"), ["p/Shark"], "a free swimmer is placed in the open water");
    assert.ok(!layers.some((l) => l.assets.some((a) => a.asset === "p/Beet")), "produce is placed by nothing here");
  });

  it("sea layers are water habitat with depths below the surface, and the plan accepts them", () => {
    const water = layers.filter((l) => l.habitat === "water");
    assert.deepEqual(water.map((l) => l.id), ["seaFlora", "seaBed", "freeSwimmers"]);
    for (const l of water) assert.ok(l.aboveWater && l.aboveWater[0] < 0 && (l.aboveWater[1] ?? 0) <= 0);
    const base: EcologyPlan = { version: 1, name: "t", fields: { forest: { scale: 100, seed: 1 }, meadow: { scale: 50, seed: 2 } }, biomes: { default: { open: 1 } }, layers: [] };
    const plan = withWildlife(base, models);
    assert.equal(plan.layers.length, layers.length);
    parseEcologyPlan(JSON.parse(JSON.stringify(plan)));
  });

  it("a plan without the noise field a layer reads drops that layer instead of failing", () => {
    const base: EcologyPlan = { version: 1, name: "t", fields: {}, biomes: { default: { open: 1 } }, layers: [] };
    assert.ok(!withWildlife(base, models).layers.some((l) => l.id === "woodlandFauna"));
  });

  it("spawn-table archetypes for the water kinds validate, with depths positive below the surface", () => {
    const a = wildlifeArchetypes(models);
    assert.deepEqual(Object.keys(a).sort(), ["p/Coral", "p/Crab", "p/Kelp", "p/Shark"]);
    for (const x of Object.values(a)) {
      SpawnArchetypeSchema.parse(x);
      assert.equal(x.habitat, "water");
      assert.deepEqual(x.depthM, x.asset === "p/Shark" ? [1, 30] : [1, 9], "sea floor to 9 m, free swimmers to 30 m");
    }
  });

  it("a kind with no models is left out", () => {
    assert.deepEqual(wildlifeLayers([m("Beet")]), []);
  });
});
