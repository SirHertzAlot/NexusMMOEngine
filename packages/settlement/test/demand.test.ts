/**
 * Demographics and the economic demand they create: integer counts that
 * add up exactly, and the structure counts a settlement of that size needs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, BUILTIN_RULES, bakeDemographics, solveDemand, SettlementRulesSchema } from "../src/index.js";

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

describe("apportion", () => {
  it("splits a total by share into whole numbers that add up, remainders to the largest first", () => {
    assert.deepEqual(apportion(10, { a: 1, b: 1, c: 1 }), { a: 4, b: 3, c: 3 });
    assert.deepEqual(apportion(0, { a: 1, b: 2 }), { a: 0, b: 0 });
    assert.equal(sum(apportion(601, { x: 280, y: 170, z: 410, w: 140 })), 601);
  });
});

describe("bakeDemographics", () => {
  const d = bakeDemographics(600, BUILTIN_RULES.demographics);
  it("makes households, cohorts and classes that all add up to the population", () => {
    assert.equal(d.population, 600);
    assert.equal(d.households, 136);
    assert.equal(sum(d.ageCohorts), 600);
    assert.equal(sum(d.socialClasses), 600);
  });
  it("derives the labour pool and dependency ratio from the cohorts", () => {
    const working = d.ageCohorts.adult + d.ageCohorts.adolescent;
    assert.equal(d.laborPool, Math.round((working * BUILTIN_RULES.demographics.laborParticipationPermille) / 1000));
    assert.equal(d.dependencyRatioPermille, Math.round(((d.ageCohorts.child + d.ageCohorts.elder) * 1000) / working));
  });
});

describe("solveDemand", () => {
  const d = bakeDemographics(600, BUILTIN_RULES.demographics);
  const demand = solveDemand(d, BUILTIN_RULES);
  it("needs the housing and food the population implies", () => {
    assert.equal(demand.housingDemand, d.households);
    assert.equal(demand.foodDemand, 600);
  });
  it("scales the required structures with population, within each kind's bounds", () => {
    assert.ok(demand.required.chapel! >= 1);
    assert.ok(demand.required.market! >= 1);
    const big = solveDemand(bakeDemographics(2400, BUILTIN_RULES.demographics), BUILTIN_RULES);
    assert.ok(big.required.bakery! > demand.required.bakery!);
    assert.ok(big.required.chapel! <= (BUILTIN_RULES.required.chapel?.max ?? Infinity));
  });
});

describe("SettlementRulesSchema", () => {
  it("accepts the built-in rules and refuses shares that do not add up", () => {
    assert.doesNotThrow(() => SettlementRulesSchema.parse(BUILTIN_RULES));
    const bad = structuredClone(BUILTIN_RULES);
    bad.demographics.ageShares.child = 999;
    assert.throws(() => SettlementRulesSchema.parse(bad), /1000/);
  });
});
