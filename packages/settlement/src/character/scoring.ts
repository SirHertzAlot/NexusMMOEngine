/**
 * Profession scoring (Section 11 of CHARACTER-FOUNDATION-SPEC.md).
 *
 * Demand and self-sufficiency outrank personality absolutely.
 * Personality determines WHO fills each role, not whether the town feeds itself.
 */

import type { CharacterCatalogs, CharacterInstance } from "./types.js";

export function professionScore(
  character: CharacterInstance,
  profession: string,
  catalogs: CharacterCatalogs,
  options: {
    demandGated?: boolean; // false if 0, true/default if profession is open
    masteryBonus?: number;
  } = {},
): number {
  if (options.demandGated === false) return 0;

  const arch = catalogs.archetypes[character.archetypeId];
  const archAffinity = arch?.professionAffinity[profession] !== undefined
    ? arch.professionAffinity[profession] - 1.0
    : 0.0;

  // Interest match: Σ professionLinks over the npc's ranked interests, rank-discounted
  let interestMatch = 0;
  const discounts = [1.0, 0.67, 0.33];
  for (let rank = 0; rank < character.interests.length && rank < 3; rank++) {
    const intId = character.interests[rank].id;
    const def = catalogs.interests[intId];
    if (def?.professionLinks[profession]) {
      interestMatch += def.professionLinks[profession] * discounts[rank];
    }
  }

  const masteryBonus = options.masteryBonus ?? 0;

  const score = 1.0 + interestMatch + archAffinity + masteryBonus;
  return Math.max(0.01, Math.round(score * 1000) / 1000);
}
