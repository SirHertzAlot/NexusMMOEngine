/**
 * A town's setting (rules.settings): how it is reached, and what that allows. Access caps the people a town can
 * keep and sets how densely they live, a draw per town from the access's range (the "setting" stream); the
 * density then shapes the layout (`withDensity`). Without a setting a town is laid out as the rules say, uncapped.
 * Homelessness (rules.homeless) is drawn here too: it rises with density.
 */

import type { Streams } from "./rng.js";
import type { Access, SettlementRules, Trend } from "./rules.js";
import type { Site } from "./sites.js";
import { industryCap, type TownIndustry } from "./industry.js";

export interface TownSetting {
  access: Access | null;
  /** How densely the town lives, permille (1000: the rules' layout). */
  densityPermille: number;
  /** Whether it is growing, stable or shrinking: where its empty lots are, and how many (rules.openGround). */
  trend: Trend;
  /** The people its access keeps at most (null: uncapped). */
  capacity: number | null;
  /** The people asked for, before the cap. */
  requestedPopulation: number;
  /** The people it settles: the request, capped. */
  population: number;
}

/**
 * How a site is reached: a port when its footprint sits against the sea, a lake or a river (within the near
 * water range of its edge: a port must lie on the water), a river town when a river or lake is within the far
 * range, remote when it is a long walk or poor land, else by road.
 */
export function siteAccess(site: Pick<Site, "waterKind" | "shoreM" | "walkM" | "pressurePermille">, rules: SettlementRules): Access {
  const s = rules.settings;
  const [near, far] = rules.sites.waterRangeM;
  const wet = site.waterKind !== "none" && site.shoreM >= 0;
  if (wet && site.shoreM <= near) return "port";
  if (wet && (site.waterKind === "river" || site.waterKind === "lake") && site.shoreM <= far) return "river";
  if (site.walkM > s.remoteWalkM || site.pressurePermille < s.remotePressurePermille) return "remote";
  return "road";
}

/** With the town's industry (`townIndustry`), the access's cap is scaled by how rich the land is (`industryCap`). */
export function townSetting(population: number, access: Access | undefined, rules: SettlementRules, rng: Streams, industry: TownIndustry | null = null): TownSetting {
  if (!access) return { access: null, densityPermille: 1000, trend: "stable", capacity: null, requestedPopulation: population, population };
  const a = rules.settings.access[access];
  const r = rng.get("setting");
  const [lo, hi] = a.densityPermille;
  const densityPermille = lo + Math.floor(r.raw() * (Math.max(lo, hi) - lo + 1));
  const roll = r.raw() * 1000;
  const [grow, shrink] = a.trendPermille;
  const trend: Trend = roll < grow ? "growing" : roll < grow + shrink ? "shrinking" : "stable";
  const capacity = industryCap(a.maxPopulation, industry, rules);
  return { access, densityPermille, trend, capacity, requestedPopulation: population, population: Math.min(population, capacity) };
}

/**
 * The rules a town of this density is laid out by: families share homes in proportion (2 a home at 1000, more
 * when dense, fewer when sparse, never under 1), and the housing quarter is that much bigger or smaller, the
 * spare ground gardens and yards, so a sparse town covers more ground for the same people. The poor streets
 * (tenements) grow and shrink with it. The town's trend goes with them (where its empty lots are).
 */
export function withDensity(rules: SettlementRules, densityPermille: number, trend: Trend = "stable"): SettlementRules {
  if (densityPermille === 1000 && trend === "stable") return rules;
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
      trend,
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
