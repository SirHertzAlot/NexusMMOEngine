/**
 * A town's craft guild (rules.industry.guild): the guild of its industry's profession, meeting in its hall by the square
 * and led by its best master (a grand master if it has one). A player earns reputation with it; each rank lets them buy
 * the guild's recipes for its industry's products up to the rank's tier. The town's signature product (what it is known
 * for) is taught only from the first rank that needs a master to take the player on as a pupil. Reputation itself is the
 * game server's to keep; this is what each town's guild offers.
 */

import type { TownIndustry } from "./industry.js";
import type { Occupancy } from "./occupancy.js";
import type { SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

export interface GuildRank {
  title: string;
  /** The reputation with this guild a player needs for the rank. */
  reputation: number;
  /** The highest tier of recipe the rank may buy. */
  tier: number;
  /** Whether the rank needs a master of the guild to take the player on as their pupil. */
  pupil: boolean;
  /** The recipes (the products the guild makes) the rank adds to what the ranks below it sell. */
  recipes: string[];
}

export interface Guild {
  /** The profession it is the guild of (crafting, smithing, fishing, farming). */
  profession: string;
  /** Its hall (a structure id; null: the town is too small to have one). */
  hall: string | null;
  /** Who leads it: an NPC id, the town's grand master of the profession if any, else its first master (null: none). */
  master: string | null;
  /** The product the town is known for, taught only to a master's pupil. */
  signature: string;
  ranks: GuildRank[];
}

/** The town's guild: null without an industry or guild rules. */
export function townGuild(industry: TownIndustry | null, structures: readonly Structure[], occupancy: Occupancy, rules: SettlementRules): Guild | null {
  const g = rules.industry?.guild;
  if (!g || !industry?.primary || !industry.product) return null;
  const ind = rules.industry!.industries[industry.primary];
  const profession = ind.profession.name;
  const hall = structures.filter((s) => s.archetype === g.archetype).map((s) => s.id).sort()[0] ?? null;
  const masters = occupancy.npcs.filter((n) => n.mastery === profession).sort((a, b) => Number(!!b.grandMaster) - Number(!!a.grandMaster) || (a.id < b.id ? -1 : 1));
  const signature = industry.product.export;
  const firstPupil = g.ranks.findIndex((r) => r.pupil);
  // Each product is taught from the first rank whose tier covers it; the guild knows its industry's products up to the
  // signature's tier, and the signature waits for the pupils' rank.
  const taughtAt = (p: (typeof ind.products)[number]): number => {
    const at = g.ranks.findIndex((r) => r.tier >= p.tier);
    return p.export === signature && firstPupil >= 0 ? Math.max(at, firstPupil) : at;
  };
  const known = ind.products.filter((p) => p.tier <= industry.product!.tier);
  const ranks = g.ranks.map((r, i) => ({ title: r.title, reputation: r.reputation, tier: r.tier, pupil: r.pupil, recipes: [...new Set(known.filter((p) => taughtAt(p) === i).map((p) => p.export))].sort() }));
  return { profession, hall, master: masters[0]?.id ?? null, signature, ranks };
}
