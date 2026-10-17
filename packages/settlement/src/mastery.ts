/**
 * Mastery (rules.mastery): who in the town is a master of their profession. About one person in
 * `oneInPeople` is, each drawn independently from the "mastery" stream, so one town has none and the next a
 * cluster; each master's profession is drawn by the professions' weights. Masters make the town busier: more
 * people live there (`residentsPerMaster`) and come through (`visitorsPerMaster`). A profession with
 * `communityMasters` or more masters makes the town a master community in it.
 */

import type { Streams } from "./rng.js";
import type { SettlementRules } from "./rules.js";

export interface TownMastery {
  /** Masters per profession (every profession listed, 0 when none). */
  masters: Record<string, number>;
  /** The professions the town is a master community in. */
  communities: string[];
  /** People living in the town because of its masters (already in the demographics' population). */
  residents: number;
  /** People passing through for its masters (traders, buyers, apprentices): taverns and inns serve them too. */
  visitors: number;
}

export const NO_MASTERY: TownMastery = { masters: {}, communities: [], residents: 0, visitors: 0 };

export function drawMastery(population: number, rules: SettlementRules, rng: Streams): TownMastery {
  const m = rules.mastery;
  if (!m) return NO_MASTERY;
  const r = rng.get("mastery");
  const names = Object.keys(m.professions).sort();
  const total = names.reduce((a, n) => a + m.professions[n]!.weight, 0);
  const masters: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  let count = 0;
  for (let i = 0; i < population; i++) {
    if (r.raw() * m.oneInPeople >= 1) continue;
    count++;
    let pick = r.raw() * total;
    const name = names.find((n) => (pick -= m.professions[n]!.weight) < 0) ?? names[names.length - 1]!;
    masters[name]!++;
  }
  return { masters, communities: names.filter((n) => masters[n]! >= m.communityMasters), residents: count * m.residentsPerMaster, visitors: count * m.visitorsPerMaster };
}
