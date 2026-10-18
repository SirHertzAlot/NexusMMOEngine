/**
 * The demographic baker (spec §13): a population target becomes households,
 * age cohorts, social classes and a labour pool. Integer counts that add up
 * exactly (apportion), so every later stage can rely on the totals.
 */

import { apportion } from "./apportion.js";
import type { SettlementRules } from "./rules.js";

export interface Demographics {
  population: number;
  /** People with no home (rules.homeless): part of the population, in no household. */
  homeless: number;
  /** Households of the housed people (the population less the homeless). */
  households: number;
  ageCohorts: Record<string, number>;
  socialClasses: Record<string, number>;
  laborPool: number;
  dependencyRatioPermille: number;
}

export function bakeDemographics(population: number, rules: SettlementRules["demographics"], homeless = 0): Demographics {
  const ageCohorts = apportion(population, rules.ageShares);
  const socialClasses = apportion(population, rules.classShares);
  const working = ageCohorts.adult! + ageCohorts.adolescent!;
  return {
    population,
    homeless,
    households: Math.round(((population - homeless) * 10) / rules.householdSizeX10),
    ageCohorts,
    socialClasses,
    laborPool: Math.round((working * rules.laborParticipationPermille) / 1000),
    dependencyRatioPermille: working > 0 ? Math.round(((ageCohorts.child! + ageCohorts.elder!) * 1000) / working) : 0,
  };
}
