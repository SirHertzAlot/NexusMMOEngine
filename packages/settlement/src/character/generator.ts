/**
 * Pure seeded character generator (Section 9 of CHARACTER-FOUNDATION-SPEC.md).
 *
 * Deterministic: same seed -> identical composition, profile, and backstory.
 * Supports authored pins for quest NPCs and villains without overwriting.
 */

import {
  alignmentBand,
  type AlignmentBand,
  type CharacterCatalogs,
  type CharacterGenerationContext,
  type CharacterInstance,
  type DescriptorSlot,
  type DescriptorRule,
} from "./types.js";
import { resolveProfile, clamp } from "./resolver.js";
import { assembleBackstory } from "./backstory.js";

/** Simple deterministic PRNG wrapper from seed / hash. */
export class DeterministicRng {
  private s: number;

  constructor(seed: number | string) {
    if (typeof seed === "string") {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
      }
      this.s = h >>> 0;
    } else {
      this.s = (seed >>> 0) || 1;
    }
  }

  next(): number {
    // Mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  weightedPick<T>(items: readonly T[], weightFn: (item: T) => number): T {
    return weightedPick(this, items, weightFn);
  }
}

export function weightedPick<T>(
  rng: { next(): number },
  items: readonly T[],
  weightFn: (item: T) => number,
): T {
  let total = 0;
  for (const it of items) total += weightFn(it);
  if (total <= 0) return items[0];
  let roll = rng.next() * total;
  for (const it of items) {
    const w = weightFn(it);
    if (roll <= w) return it;
    roll -= w;
  }
  return items[items.length - 1];
}

/** Check if a descriptor rule condition matches a character state. */
export function matchesRuleCondition(
  rule: DescriptorRule,
  state: {
    benevolenceBand: AlignmentBand;
    orderBand: AlignmentBand;
    temperamentId: string;
    archetypeId: string;
    topInterest?: string;
    role?: string;
  },
): boolean {
  const c = rule.when;
  if (c.benevolenceBand && c.benevolenceBand !== state.benevolenceBand) return false;
  if (c.orderBand && c.orderBand !== state.orderBand) return false;
  if (c.temperament && c.temperament !== state.temperamentId) return false;
  if (c.topInterest && c.topInterest !== state.topInterest) return false;
  if (c.role && c.role !== state.role) return false;
  if (c.archetype) {
    const list = Array.isArray(c.archetype) ? c.archetype : [c.archetype];
    if (!list.includes(state.archetypeId)) return false;
  }
  return true;
}

export function generateCharacter(
  ctx: CharacterGenerationContext,
  catalogs: CharacterCatalogs,
): CharacterInstance {
  const rawRng = ctx.seedStream ?? new DeterministicRng(`${ctx.characterId}|character`);
  const rng = {
    next: () => rawRng.next(),
    weightedPick: <T>(items: readonly T[], weightFn: (item: T) => number): T =>
      weightedPick(rawRng, items, weightFn),
  };
  const pins = ctx.pins ?? {};

  let isPinned = false;
  let isDrawn = false;

  // 1. Draw Archetype
  let archetypeId: string;
  if (pins.archetypeId) {
    archetypeId = pins.archetypeId;
    isPinned = true;
  } else {
    isDrawn = true;
    const archList = Object.values(catalogs.archetypes);
    const classId = ctx.classId ?? "peasant";
    const picked = rng.weightedPick(archList, (a) => {
      const affinity = a.classAffinity[classId] ?? 1000;
      return a.weight * (affinity / 1000);
    });
    archetypeId = picked.id;
  }

  const arch = catalogs.archetypes[archetypeId];
  if (!arch) throw new Error(`Unknown archetype "${archetypeId}"`);

  // 2. Draw Temperament
  let temperamentId: string;
  if (pins.temperamentId) {
    temperamentId = pins.temperamentId;
    isPinned = true;
  } else {
    isDrawn = true;
    const pool = Object.entries(arch.temperamentPool);
    if (pool.length === 0) {
      temperamentId = "calm";
    } else {
      const picked = rng.weightedPick(pool, ([, w]) => w);
      temperamentId = picked[0];
    }
  }

  // 3. Draw Alignment
  let benevolence: number;
  let order: number;
  if (pins.alignment) {
    benevolence = Math.round(pins.alignment.benevolence) + 0;
    order = Math.round(pins.alignment.order) + 0;
    isPinned = true;
  } else {
    isDrawn = true;
    const bBias = arch.alignmentBias.benevolence;
    const oBias = arch.alignmentBias.order;
    benevolence =
      Math.round(
        clamp(bBias.mean + (rng.next() * 2 - 1) * bBias.spread, -100, 100),
      ) + 0;
    order =
      Math.round(
        clamp(oBias.mean + (rng.next() * 2 - 1) * oBias.spread, -100, 100),
      ) + 0;
  }

  // 4. Draw Interests (top 3 without replacement)
  let interests: Array<{ id: string; score: number }>;
  if (pins.interests) {
    interests = pins.interests.slice(0, 3);
    isPinned = true;
  } else {
    isDrawn = true;
    const allInterests = Object.keys(catalogs.interests);
    const pool = [...allInterests];
    const picked: Array<{ id: string; score: number }> = [];

    for (let rank = 0; rank < 3 && pool.length > 0; rank++) {
      const chosen = rng.weightedPick(pool, (intId) => {
        return arch.interestWeights[intId] ?? 1.0;
      });
      const score = Math.round((3 - rank) * 10) / 10 + 0;
      picked.push({ id: chosen, score });
      const idx = pool.indexOf(chosen);
      if (idx >= 0) pool.splice(idx, 1);
    }
    interests = picked;
  }

  // Cohort check: child cohort leaves archetype and interests latent/unmanifested
  const isChild = ctx.cohort === "child";

  // 5. Evaluate Descriptors (top-down rule table)
  let descriptorIds: string[];
  if (pins.descriptorIds) {
    descriptorIds = pins.descriptorIds;
    isPinned = true;
  } else {
    isDrawn = true;
    const slotMap = new Map<DescriptorSlot, string>();
    const bBand = alignmentBand(benevolence);
    const oBand = alignmentBand(order);
    const topInterest = interests[0]?.id;

    for (const rule of catalogs.rules) {
      const desc = catalogs.descriptors[rule.gives];
      if (!desc) continue;
      // At most one per slot
      if (slotMap.has(desc.slot)) continue;

      if (
        matchesRuleCondition(rule, {
          benevolenceBand: bBand,
          orderBand: oBand,
          temperamentId,
          archetypeId,
          topInterest,
          role: ctx.role,
        })
      ) {
        // Check conflicts
        const conflicting = desc.conflicts.some((cId) =>
          [...slotMap.values()].includes(cId),
        );
        if (!conflicting) {
          slotMap.set(desc.slot, desc.id);
        }
      }
    }
    descriptorIds = [...slotMap.values()];
  }

  // 6. Resolve Profile
  const jitterSeed =
    rng instanceof DeterministicRng
      ? parseInt(ctx.characterId.replace(/\D/g, "").slice(0, 8), 10) || 12345
      : 0;

  const profile = resolveProfile(
    {
      archetypeId,
      temperamentId,
      alignment: { benevolence, order },
      descriptorIds,
    },
    catalogs,
    catalogs.defaults,
    jitterSeed,
  );

  // 7. Backstory
  const backstory = assembleBackstory(
    {
      characterId: ctx.characterId,
      archetypeId,
      temperamentId,
      alignment: { benevolence, order },
      interests,
      descriptorIds,
      profession: ctx.profession,
      townId: ctx.townId,
      tier: ctx.tier ?? "local",
      pins: pins.backstory,
    },
    catalogs,
    rng,
  );

  const origin: "generated" | "authored" | "mixed" =
    isPinned && !isDrawn ? "authored" : isPinned && isDrawn ? "mixed" : "generated";

  return {
    characterId: ctx.characterId,
    archetypeId: isChild ? "latent" : archetypeId,
    temperamentId,
    alignment: { benevolence, order },
    interests: isChild ? [] : interests,
    descriptorIds,
    profile,
    backstory,
    origin,
    schemaVersion: 1,
  };
}
