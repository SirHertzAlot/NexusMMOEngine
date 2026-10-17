/**
 * The economic demand solver (spec §15): what a population of this size must
 * be fed, housed and staffed with, and how many of each kind of structure it
 * needs. The structure solve turns these into hard counts and budgets.
 */

import type { Demographics } from "./demographics.js";
import type { SettlementRules } from "./rules.js";

export interface Demand {
  /** People to feed. */
  foodDemand: number;
  /** Households to house. */
  housingDemand: number;
  /** Workers available. */
  laborPool: number;
  /** Minimum structures per archetype id. */
  required: Record<string, number>;
  /** Ceiling per archetype id, where the rules set one. */
  max: Record<string, number>;
}

export function solveDemand(d: Demographics, rules: SettlementRules): Demand {
  const required: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const [id, r] of Object.entries(requiredCounts(d.population, rules))) {
    required[id] = r.required;
    if (r.max !== Infinity) max[id] = r.max;
  }
  return { foodDemand: d.population, housingDemand: d.households, laborPool: d.laborPool, required, max };
}

/** How many of each required archetype a settlement of `population` must have, and at most may have. */
export function requiredCounts(population: number, rules: SettlementRules): Record<string, { required: number; max: number }> {
  const out: Record<string, { required: number; max: number }> = {};
  for (const [id, r] of Object.entries(rules.required)) {
    if (r.minPopulation && population < r.minPopulation) {
      out[id] = { required: 0, max: 0 };
      continue;
    }
    const scaled = r.perPopulation ? Math.ceil(population / r.perPopulation) : 0;
    const want = Math.max(r.min ?? 0, scaled);
    const ceiling = Math.min(r.max ?? Infinity, r.maxPerPopulation ? Math.max(r.min ?? 0, Math.ceil(population / r.maxPerPopulation)) : Infinity);
    out[id] = { required: Math.min(want, ceiling), max: ceiling };
  }
  return out;
}
