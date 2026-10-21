/**
 * The occupancy baker (spec §19 to §20): who lives and works where. People
 * are dealt into households, households into homes, and working-age people
 * into jobs, so every total ties back to the demographics and no structure
 * holds more than it is built for.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, bakeDemographics, layOut, occupy, placeStructures, solveDemand, streams, type SettlementRules } from "../src/index.js";

function town(population = 600, seed = 1, rules: SettlementRules = BUILTIN_RULES) {
  const demographics = bakeDemographics(population, rules.demographics);
  const demand = solveDemand(demographics, rules);
  const rng = streams(seed);
  const layout = layOut("0182", demographics.households, rules, rng);
  const structures = placeStructures(layout, demand, rules, rng);
  return { demographics, structures, occupancy: occupy("0182", demographics, structures, rules, rng) };
}

const count = <T>(xs: T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

describe("occupy", () => {
  const { demographics, structures, occupancy } = town();
  const archetypeOf = new Map(structures.map((s) => [s.id, s.archetype]));

  it("makes exactly the population: one npc each, with the demographic cohorts and classes", () => {
    assert.equal(occupancy.npcs.length, demographics.population);
    assert.deepEqual(count(occupancy.npcs, (n) => n.cohort), Object.fromEntries(Object.entries(demographics.ageCohorts).filter(([, v]) => v > 0)));
    assert.deepEqual(count(occupancy.npcs, (n) => n.class), Object.fromEntries(Object.entries(demographics.socialClasses).filter(([, v]) => v > 0)));
  });

  it("homes every household in a structure built for it, within its capacity, with an adult in each", () => {
    assert.equal(occupancy.households.length, demographics.households);
    const perHome = count(occupancy.households, (h) => h.home);
    for (const [home, n] of Object.entries(perHome)) assert.ok(n <= BUILTIN_RULES.archetypes[archetypeOf.get(home)!]!.households, `${home} over capacity`);
    for (const h of occupancy.households) {
      const members = occupancy.npcs.filter((n) => n.household === h.id);
      assert.equal(members.length, h.size);
      assert.ok(members.some((m) => m.cohort === "adult"), `${h.id} has no adult`);
      for (const m of members) assert.equal(m.home, h.home);
    }
    assert.equal(occupancy.households.reduce((a, h) => a + h.size, 0), demographics.population);
  });

  it("employs working-age people only, never past a workplace's jobs, and fills the jobs the labour pool can", () => {
    const workers = occupancy.npcs.filter((n) => n.workplace);
    for (const w of workers) assert.ok(w.cohort === "adult" || w.cohort === "adolescent");
    const jobs = structures.reduce((a, s) => a + BUILTIN_RULES.archetypes[s.archetype]!.workers, 0);
    assert.equal(workers.length, Math.min(jobs, demographics.laborPool));
    for (const [id, n] of Object.entries(count(workers, (w) => w.workplace!))) assert.ok(n <= BUILTIN_RULES.archetypes[archetypeOf.get(id)!]!.workers, `${id} over its jobs`);
  });

  it("gives workers the role of their workplace, and everyone else a role by age", () => {
    for (const n of occupancy.npcs) {
      if (n.workplace) assert.equal(n.role, BUILTIN_RULES.archetypes[archetypeOf.get(n.workplace)!]!.role);
      else assert.ok(["child", "elder", "resident"].includes(n.role), n.role);
    }
  });

  it("runs a shop in every shop structure, owned by one of its workers", () => {
    const shopStructures = structures.filter((s) => BUILTIN_RULES.archetypes[s.archetype]!.shop);
    assert.deepEqual(occupancy.shops.map((s) => s.structure).sort(), shopStructures.map((s) => s.id).sort());
    for (const shop of occupancy.shops) {
      const owner = occupancy.npcs.find((n) => n.id === shop.owner);
      assert.ok(owner && owner.workplace === shop.structure, `${shop.id} owner works elsewhere`);
    }
  });

  it("is deterministic per seed", () => {
    assert.deepEqual(town(600, 7).occupancy, town(600, 7).occupancy);
    assert.notDeepEqual(town(600, 7).occupancy.npcs.map((n) => n.home), town(600, 8).occupancy.npcs.map((n) => n.home));
  });
});
