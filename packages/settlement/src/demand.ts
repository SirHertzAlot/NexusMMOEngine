/**
 * The economic demand solver (spec §15): what a population of this size must
 * be fed, housed and staffed with, and how many of each kind of structure it
 * needs. The structure solve turns these into hard counts and budgets.
 */

import type { Demographics } from "./demographics.js";
import { NO_MASTERY, type TownMastery } from "./mastery.js";
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

export function solveDemand(d: Demographics, rules: SettlementRules, mastery: TownMastery = NO_MASTERY): Demand {
  const required: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const [id, r] of Object.entries(requiredCounts(d.population, rules, mastery))) {
    required[id] = r.required;
    if (r.max !== Infinity) max[id] = r.max;
  }
  return { foodDemand: d.population, housingDemand: d.households, laborPool: d.laborPool, required, max };
}

/**
 * How many of each required archetype a settlement of `population` must have, and at most may have. With its
 * masters (`mastery`): a master workplace stands for each master and does the work of `yield` ordinary ones, so
 * the ordinary archetype's count drops by that much (to none, if the masters cover it); and a kind that serves
 * visitors (`visitors`) is counted on the residents plus the visitors the masters draw.
 */
export function requiredCounts(population: number, rules: SettlementRules, mastery: TownMastery = NO_MASTERY): Record<string, { required: number; max: number }> {
  const out: Record<string, { required: number; max: number }> = {};
  const m = rules.mastery;
  // The work the masters do, in ordinary workplaces, per ordinary archetype.
  const covered = new Map<string, number>();
  for (const [name, p] of Object.entries(m?.professions ?? {})) covered.set(p.archetype, (covered.get(p.archetype) ?? 0) + (mastery.masters[name] ?? 0) * m!.yield);
  for (const [id, r] of Object.entries(rules.required)) {
    const people = r.visitors ? population + mastery.visitors : population;
    if (r.minPopulation && people < r.minPopulation) {
      out[id] = { required: 0, max: 0 };
      continue;
    }
    const scaled = r.perPopulation ? Math.ceil(people / r.perPopulation) : 0;
    const cover = covered.get(id) ?? 0;
    const min = cover > 0 ? 0 : (r.min ?? 0);
    const want = Math.max(min, scaled - cover);
    const ceiling = Math.min(r.max ?? Infinity, r.maxPerPopulation ? Math.max(r.min ?? 0, Math.ceil(people / r.maxPerPopulation)) : Infinity);
    // The masters' work also lowers the ceiling: a town of master smiths has fewer smithies, not as many.
    const capped = cover > 0 ? Math.max(Math.min(want, ceiling), ceiling - cover) : ceiling;
    out[id] = { required: Math.min(want, ceiling), max: capped };
  }
  // Each master has their workplace: exactly as many as there are masters.
  for (const [name, p] of Object.entries(m?.professions ?? {})) out[p.master] = { required: mastery.masters[name] ?? 0, max: mastery.masters[name] ?? 0 };
  return out;
}
