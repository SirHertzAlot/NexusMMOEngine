/**
 * Settlement fortification as a world-bake stage (engine-core side).
 *
 * Consumes the terrain survey the world bake already produced: find
 * pond-side sites, adapt each window into the fortify sim, run the
 * threat-driven fortify loop, and emit decorated structure placements
 * in world coordinates (a `SettlementBake` per site). bake-world
 * persists the results into world.db meta (`fortified_settlements`),
 * next to spawn_point and world_biomes — a bake product the server and
 * editor can read, and the town spawner's future input.
 *
 * Fortify itself never imports engine-core; this module is the adapter
 * that knows the survey's constants (LAND/SEA/LAKE) and spec.
 */

import {
  DEFAULT_PROFILES,
  decorateBake,
  emitSettlementBake,
  findSite,
  fortify,
  makeTransform,
  settlementFromSurvey,
  DOCTRINES,
  type SettlementBake,
  type Site,
} from "@mmo-engine/fortify";
import { LAND, type Survey } from "./survey.js";

export interface FortifySettlementsOptions {
  /** Defence budget per settlement, fortify points. */
  budget?: number;
  seed?: number;
  /** Era the settlements are built in (material tier + counter gate). */
  era?: number;
  /** Style profile id for decoration (see @mmo-engine/fortify profiles). */
  profile?: string;
  /** Doctrine to stamp at generation, if any (e.g. "roman"). */
  doctrine?: string;
  maxSettlements?: number;
  /** Settlement footprint in survey cells (square). */
  siteSize?: number;
  log?: (line: string) => void;
}

export function bakeSettlementFortifications(survey: Survey, opts: FortifySettlementsOptions = {}): SettlementBake[] {
  const log = opts.log ?? (() => {});
  const size = opts.siteSize ?? 25;
  const profile = DEFAULT_PROFILES[opts.profile ?? "pondlands"] ?? DEFAULT_PROFILES.pondlands;
  const surveyLike = {
    grid: survey.grid,
    height: survey.height,
    water: survey.water,
    moisture: survey.moisture,
    roughness: survey.roughness,
    river: survey.river,
    landCode: LAND,
  };
  const claimed: Site[] = [];
  const bakes: SettlementBake[] = [];
  const max = opts.maxSettlements ?? 1;
  for (let n = 0; n < max; n++) {
    const site = findSite(surveyLike, size, claimed);
    if (!site) break;
    claimed.push(site);
    const name = `${survey.spec.name}-settlement-${n + 1}`;
    const settlement = settlementFromSurvey(surveyLike, site, name);
    const result = fortify(settlement, {
      budget: opts.budget ?? 40,
      seed: (opts.seed ?? survey.spec.seed) + n,
      era: opts.era,
      doctrine: opts.doctrine ? DOCTRINES[opts.doctrine] : undefined,
    });
    const bake = emitSettlementBake(result.settlement, result, makeTransform(surveyLike, site));
    decorateBake(bake, profile, opts.era ?? 2);
    bakes.push(bake);
    log(
      `[bake] settlement ${name} at survey cell ${site.u0},${site.v0}: ` +
        `${bake.placements.length} placements, spent ${bake.spent}, stop ${bake.stopReason}, ` +
        `exposure ${Object.entries(bake.exposures).map(([k, v]) => `${k} ${(Number(v)).toFixed(2)}`).join(" / ")}`,
    );
  }
  return bakes;
}
