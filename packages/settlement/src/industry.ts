/**
 * A town's industry (rules.industry): what it lives off, read from the land around it. Each industry's abundance
 * is how much of its land (or water) is near; the most abundant is the town's industry, which sets how big the town
 * may grow, what it exports and is known for, and what most of its masters practise (`withIndustry`).
 */

import { INDUSTRIES, type IndustryId, type SettlementRules } from "./rules.js";
import type { Site } from "./sites.js";

/** The land around a town: the share of each biome within reach (permille), and the water it sits by. */
export type Land = Pick<Site, "biomes" | "waterKind" | "shoreM">;

export interface TownIndustry {
  /** The town's industry: the most abundant by priority (null: none rich enough, the town lives off what it has). */
  primary: IndustryId | null;
  /** Each industry's abundance near the town, 0 to 1000. */
  resources: Record<IndustryId, number>;
  /** The primary's abundance (0 with none). */
  abundancePermille: number;
  /** What its masters mostly practise, and the workplace its export comes from (null with no industry). */
  profession: string | null;
  workplace: string | null;
  /** Its signature product: the highest-tier material near, and what the town makes of it. */
  product: { material: string; tier: number; export: string } | null;
}

/** Each industry's abundance, the most abundant, and its best product. Null without industry rules. */
export function townIndustry(land: Land, rules: SettlementRules): TownIndustry | null {
  const ir = rules.industry;
  if (!ir) return null;
  const [near, far] = rules.sites.waterRangeM;
  const share = (b: string): number => land.biomes[b] ?? 0;
  const wet = land.waterKind !== "none" && land.shoreM >= 0;
  const resources = Object.fromEntries(
    INDUSTRIES.map((id) => {
      const ind = ir.industries[id];
      let weighted = 0;
      for (const [b, w] of Object.entries(ind.biomes)) weighted += share(b) * w;
      if (ind.fertility) for (const [b, f] of Object.entries(rules.sites.fertilityPermille)) weighted += share(b) * f;
      let a = Math.min(1000, Math.round(weighted / ir.fullSharePermille));
      // Water is fished by a town on it, half as well by one within easy reach.
      const w = wet ? (ind.water[land.waterKind as keyof typeof ind.water] ?? 0) : 0;
      if (w > 0 && land.shoreM <= far) a = Math.max(a, land.shoreM <= near ? w : Math.round(w / 2));
      return [id, a];
    }),
  ) as Record<IndustryId, number>;
  const score = (id: IndustryId): number => resources[id] * ir.industries[id].priorityPermille;
  const best = INDUSTRIES.reduce((b, id) => (score(id) > score(b) ? id : b));
  const primary = resources[best] >= ir.minAbundancePermille && resources[best] > 0 ? best : null;
  if (!primary) return { primary: null, resources, abundancePermille: 0, profession: null, workplace: null, product: null };
  const ind = ir.industries[primary];
  const near_ = (p: (typeof ind.products)[number]): boolean => (p.biomes.length > 0 && p.biomes.reduce((a, b) => a + share(b), 0) >= p.minSharePermille) || (wet && (p.water as string[]).includes(land.waterKind));
  // The rarest thing near is what the town is known for; the first listed of a tier wins a tie. A town fishing
  // or farming with none of its products' land listed still makes the first.
  const product = ind.products.reduce<(typeof ind.products)[number] | null>((b, p) => (near_(p) && (!b || p.tier > b.tier) ? p : b), null) ?? ind.products[0]!;
  return { primary, resources, abundancePermille: resources[primary], profession: ind.profession.name, workplace: ind.workplace, product: { material: product.material, tier: product.tier, export: product.export } };
}

/** The population an access's cap allows on this land: from `capFloorPermille` of it with no industry to all of it at full abundance. */
export function industryCap(cap: number, industry: TownIndustry | null, rules: SettlementRules): number {
  const ir = rules.industry;
  if (!ir || !industry) return cap;
  return Math.round((cap * (ir.capFloorPermille + ((1000 - ir.capFloorPermille) * industry.abundancePermille) / 1000)) / 1000);
}

/**
 * The rules a town of this industry is laid out by. Its industry's workplace is required, one per `exportPerPeople`
 * people at full abundance (fewer as it thins), at most twice that; its profession takes `specialtyPermille` of the
 * masters (added when the rules lack it). Every other industry's workplace, and the master workplace of a
 * profession the rules lack, is ruled out (none stands in the town). With no industry (null) only that.
 */
export function withIndustry(rules: SettlementRules, industry: TownIndustry | null): SettlementRules {
  const ir = rules.industry;
  if (!ir) return rules;
  const required = { ...rules.required };
  const professions = { ...(rules.mastery?.professions ?? {}) };
  const own = industry?.primary ? ir.industries[industry.primary] : null;
  for (const id of INDUSTRIES) {
    const ind = ir.industries[id];
    if (ind === own) continue;
    if (!rules.required[ind.workplace] && ind.workplace !== own?.workplace) required[ind.workplace] = { max: 0 };
    if (!professions[ind.profession.name] && ind.profession.master !== own?.profession.master) required[ind.profession.master] = { max: 0 };
  }
  if (own && industry) {
    const per = Math.max(1, Math.ceil((ir.exportPerPeople * 1000) / Math.max(1, industry.abundancePermille)));
    const was = rules.required[own.workplace];
    // An ordinary workplace (the mill) keeps its own count where that is more; the export lifts its ceiling to
    // twice the count it needs.
    const need = Math.min(per, was?.perPopulation ?? per);
    required[own.workplace] = { min: Math.max(1, was?.min ?? 0), perPopulation: need, maxPerPopulation: Math.max(1, Math.floor(need / 2)), export: true };
    if (rules.mastery) {
      const name = own.profession.name;
      const others = Object.entries(professions).filter(([n]) => n !== name).reduce((a, [, p]) => a + p.weight, 0);
      const weight = others > 0 ? (others * ir.specialtyPermille) / (1000 - ir.specialtyPermille) : 1;
      professions[name] = { ...(professions[name] ?? { archetype: own.profession.archetype, master: own.profession.master }), weight };
    }
  }
  return { ...rules, required, ...(rules.mastery ? { mastery: { ...rules.mastery, professions } } : {}) };
}
