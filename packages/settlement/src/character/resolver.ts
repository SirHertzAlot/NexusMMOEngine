/**
 * Pure profile resolver (Section 10 of CHARACTER-FOUNDATION-SPEC.md).
 *
 * Same composition + same catalogs -> same profile on any platform.
 * Readers get numbers; zero system code branches on character names.
 */

import {
  TRAIT_AXES,
  type TraitAxis,
  type TraitWeights,
  type ResolvedProfile,
  type CharacterCatalogs,
} from "./types.js";

/** Quantize to 3 decimal places (matching needs-intensity determinism). */
export function quantize3(val: number): number {
  return Math.round(val * 1000) / 1000 + 0;
}

/** Clamp a value between min and max. */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * 32-bit integer hash for jitter determinism.
 */
function hashInt(seed: number, index: number): number {
  let h = (seed ^ (index * 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Derives a deterministic jitter multiplier in [0.90, 1.10] for an axis.
 * Passing jitterSeed === 0 produces exact 1.0 (no jitter) for fixtures and tests.
 */
function axisJitter(jitterSeed: number, axisIndex: number): number {
  if (jitterSeed === 0) return 1.0;
  const h = hashInt(jitterSeed, axisIndex);
  // Normalized to [-0.10, +0.10]
  const delta = ((h % 20001) - 10000) / 100000;
  return 1.0 + delta;
}

export interface ProfileInputComposition {
  archetypeId: string;
  temperamentId: string;
  alignment: { benevolence: number; order: number };
  descriptorIds: string[];
}

/**
 * Resolves a character's composition into a numeric profile.
 */
export function resolveProfile(
  composition: ProfileInputComposition,
  catalogs: CharacterCatalogs,
  baseWeights: TraitWeights = catalogs.defaults,
  jitterSeed = 0,
): ResolvedProfile {
  const arch = catalogs.archetypes[composition.archetypeId];
  const temp = catalogs.temperaments[composition.temperamentId];
  if (!arch) throw new Error(`Unknown archetype "${composition.archetypeId}"`);
  if (!temp) throw new Error(`Unknown temperament "${composition.temperamentId}"`);

  // 1. Start from baseWeights
  const currentWeights: TraitWeights = { ...baseWeights };

  // 2. Archetype & Temperament trait mods
  for (let i = 0; i < TRAIT_AXES.length; i++) {
    const axis = TRAIT_AXES[i];
    let w = currentWeights[axis];
    if (arch.traitMods[axis] !== undefined) w *= arch.traitMods[axis]!;
    if (temp.traitMods[axis] !== undefined) w *= temp.traitMods[axis]!;

    // 3. Descriptor trait mods
    for (const did of composition.descriptorIds) {
      const desc = catalogs.descriptors[did];
      if (desc?.traitMods[axis] !== undefined) {
        w *= desc.traitMods[axis]!;
      }
    }

    // 4. Per-character jitter
    const j = axisJitter(jitterSeed, i);
    w *= j;

    // 5. Clamp to [0.25, 2.5] and quantize to 3 decimals
    currentWeights[axis] = quantize3(clamp(w, 0.25, 2.5));
  }

  // 6. Reader biases: fleeBias, trustBias, gossipBias
  let fleeModSum = temp.reactionMods.fleeMod;
  let trustModSum = temp.reactionMods.trustMod;
  let gossipModSum = temp.reactionMods.gossipMod;

  let demeanorTone: string | null = null;

  for (const did of composition.descriptorIds) {
    const desc = catalogs.descriptors[did];
    if (desc) {
      fleeModSum += desc.reactionMods.fleeMod;
      trustModSum += desc.reactionMods.trustMod;
      gossipModSum += desc.reactionMods.gossipMod;
      if (desc.slot === "demeanor") {
        demeanorTone = desc.id;
      }
    }
  }

  const tuning = catalogs.tuning;
  const fleeBias = quantize3(
    clamp(
      fleeModSum +
        tuning.fleeAggressionCoeff * (currentWeights.aggression - 1.0) +
        tuning.fleeCautionCoeff * (currentWeights.caution - 1.0),
      -0.5,
      0.5,
    ),
  );

  const trustBias = quantize3(
    clamp(
      trustModSum + tuning.trustEmpathyCoeff * (currentWeights.empathy - 1.0),
      -0.5,
      0.5,
    ),
  );

  const gossipBias = quantize3(
    clamp(
      gossipModSum + tuning.gossipSociabilityCoeff * (currentWeights.sociability - 1.0),
      -0.5,
      0.5,
    ),
  );

  // Tone pool: temperament's, overridden by demeanor descriptor when present
  const barkTone = demeanorTone ?? temp.barkTone;

  return {
    weights: currentWeights,
    fleeBias,
    trustBias,
    gossipBias,
    barkTone,
  };
}
