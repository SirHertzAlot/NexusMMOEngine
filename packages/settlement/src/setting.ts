/**
 * A town's setting (rules.settings): how it is reached, and what that allows. Access caps the people a town can
 * keep and sets how densely they live, a draw per town from the access's range (the "setting" stream); the
 * density then shapes the layout (`withDensity`). Without a setting a town is laid out as the rules say, uncapped.
 * Homelessness (rules.homeless) is drawn here too: it rises with density.
 */

import type { Streams } from "./rng.js";
import type { Access, SettlementRules } from "./rules.js";
import type { Site } from "./sites.js";

export interface TownSetting {
  access: Access | null;
  /** How densely the town lives, permille (1000: the rules' layout). */
  densityPermille: number;
  /** The people its access keeps at most (null: uncapped). */
  capacity: number | null;
  /** The people asked for, before the cap. */
  requestedPopulation: number;
  /** The people it settles: the request, capped. */
  population: number;
}

/** How a site is reached: a port by the sea, a river town by a river or lake, remote when it is a long walk or poor land, else by road. */
export function siteAccess(site: Pick<Site, "waterKind" | "waterDistanceM" | "walkM" | "pressurePermille">, rules: SettlementRules): Access {
  const s = rules.settings;
  if (site.waterKind === "sea" && site.waterDistanceM <= rules.sites.waterRangeM[1]) return "port";
  if ((site.waterKind === "river" || site.waterKind === "lake") && site.waterDistanceM <= rules.sites.waterRangeM[1]) return "river";
  if (site.walkM > s.remoteWalkM || site.pressurePermille < s.remotePressurePermille) return "remote";
  return "road";
}

export function townSetting(population: number, access: Access | undefined, rules: SettlementRules, rng: Streams): TownSetting {
  if (!access) return { access: null, densityPermille: 1000, capacity: null, requestedPopulation: population, population };
  const a = rules.settings.access[access];
  const [lo, hi] = a.densityPermille;
  const densityPermille = lo + Math.floor(rng.get("setting").raw() * (Math.max(lo, hi) - lo + 1));
  return { access, densityPermille, capacity: a.maxPopulation, requestedPopulation: population, population: Math.min(population, a.maxPopulation) };
}

/**
 * The rules a town of this density is laid out by: families share homes in proportion (2 a home at 1000, more
 * when dense, fewer when sparse, never under 1), and the housing quarter is that much bigger or smaller, the
 * spare ground gardens and yards, so a sparse town covers more ground for the same people. The poor streets
 * (tenements) grow and shrink with it.
 */
export function withDensity(rules: SettlementRules, densityPermille: number): SettlementRules {
  if (densityPermille === 1000) return rules;
  const l = rules.layout;
  const w = rules.watch;
  // Crowding is the poor streets': more of a dense town is tenements, fewer of a sparse one.
  return {
    ...rules,
    // A sparse town also keeps more room in its homes than it needs (homeSpacePermille): fewer families crowd in.
    layout: {
      ...l,
      familiesPerHomeX10: Math.max(10, Math.round((l.familiesPerHomeX10 * densityPermille) / 1000)),
      densityPermille,
      ...(l.homeSpacePermille && densityPermille < 1000 ? { homeSpacePermille: Math.round((l.homeSpacePermille * 1000) / densityPermille) } : {}),
    },
    ...(w ? { watch: { ...w, lowIncomePermille: Math.min(1000 - w.highIncomePermille, Math.round((w.lowIncomePermille * densityPermille) / 1000)) } } : {}),
  };
}

/** The town's homeless: none under `minPopulation`; otherwise a share drawn from the range, times the density. */
export function drawHomeless(population: number, densityPermille: number, rules: SettlementRules, rng: Streams): number {
  const h = rules.homeless;
  if (!h || population < h.minPopulation) return 0;
  const [lo, hi] = h.permille;
  const permille = lo + Math.floor(rng.get("homeless").raw() * (Math.max(lo, hi) - lo + 1));
  return Math.round((population * permille * densityPermille) / 1_000_000);
}
