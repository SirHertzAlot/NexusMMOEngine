/**
 * Structure placement by WFC: one structure on every parcel, each allowed in
 * its district, with the counts, capacities and separations the demand and
 * the rules call for.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, bakeDemographics, layOut, placeStructures, solveDemand, streams, type SettlementRules } from "../src/index.js";

function town(population = 600, seed = 1, rules: SettlementRules = BUILTIN_RULES) {
  const demo = bakeDemographics(population, rules.demographics);
  const demand = solveDemand(demo, rules);
  const rng = streams(seed);
  const layout = layOut("0182", demo.households, rules, rng);
  return { demo, demand, layout, structures: placeStructures(layout, demand, rules, rng) };
}

describe("placeStructures", () => {
  const { demand, layout, structures } = town();
  const kindOf = new Map(layout.parcels.map((p) => [p.id, p]));
  const count = (id: string): number => structures.filter((s) => s.archetype === id).length;

  it("puts exactly one structure on every parcel, of a kind its district allows", () => {
    assert.equal(structures.length, layout.parcels.length);
    assert.equal(new Set(structures.map((s) => s.parcel)).size, structures.length);
    for (const s of structures) assert.ok(BUILTIN_RULES.archetypes[s.archetype]!.kinds.includes(kindOf.get(s.parcel)!.kind), `${s.archetype} in ${kindOf.get(s.parcel)!.kind}`);
  });

  it("meets the required counts and keeps to the ceilings", () => {
    for (const [id, n] of Object.entries(demand.required)) assert.ok(count(id) >= n, `${id}: ${count(id)} < ${n}`);
    for (const [id, n] of Object.entries(demand.max)) assert.ok(count(id) <= n, `${id}: ${count(id)} > ${n}`);
  });

  it("houses and feeds everyone without needing more workers than there are", () => {
    const sum = (f: (id: string) => number): number => structures.reduce((a, s) => a + f(s.archetype), 0);
    assert.ok(sum((id) => BUILTIN_RULES.archetypes[id]!.households) >= demand.housingDemand);
    assert.ok(sum((id) => BUILTIN_RULES.archetypes[id]!.feeds) >= demand.foodDemand);
    assert.ok(sum((id) => BUILTIN_RULES.archetypes[id]!.workers) <= demand.laborPool);
  });

  it("never puts a forbidden pair on neighbouring parcels", () => {
    const at = new Map(layout.parcels.map((p, i) => [`${p.gx},${p.gz}`, structures[i]!.archetype]));
    const forbidden = new Set(BUILTIN_RULES.forbiddenAdjacent.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    for (const p of layout.parcels) {
      const here = at.get(`${p.gx},${p.gz}`)!;
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const there = at.get(`${p.gx + dx},${p.gz + dz}`);
        if (there) assert.ok(!forbidden.has(`${here}|${there}`), `${here} beside ${there}`);
      }
    }
  });

  it("is deterministic per seed, and the seed changes what stands where", () => {
    assert.deepEqual(town(600, 3).structures, town(600, 3).structures);
    assert.notDeepEqual(town(600, 3).structures.map((s) => s.archetype), town(600, 4).structures.map((s) => s.archetype));
  });

  it("fails with the solver's reason when the demand cannot be met", () => {
    const greedy = structuredClone(BUILTIN_RULES);
    greedy.required.market = { min: 9999 };
    assert.throws(() => town(600, 1, greedy));
  });
});
