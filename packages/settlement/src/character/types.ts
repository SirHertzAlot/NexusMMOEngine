/**
 * Character Foundation Types (spec: CHARACTER-FOUNDATION-SPEC.md).
 *
 * Core inversion: Characters declare WHAT they are made of (data rows: archetype,
 * temperament, alignment, interests, descriptors). One generic resolver produces
 * a small numeric profile read by downstream systems. Zero system code branches
 * on character/archetype names.
 */

export const TRAIT_AXES = [
  "aggression",
  "caution",
  "sociability",
  "diligence",
  "curiosity",
  "empathy",
  "ambition",
  "composure",
] as const;

export type TraitAxis = (typeof TRAIT_AXES)[number];

export type TraitWeights = Record<TraitAxis, number>;

export const DESCRIPTOR_SLOTS = ["demeanor", "social", "moral", "drive"] as const;
export type DescriptorSlot = (typeof DESCRIPTOR_SLOTS)[number];

export const ALIGNMENT_BANDS = [
  "strong-positive",
  "leaning-positive",
  "neutral",
  "leaning-negative",
  "strong-negative",
] as const;
export type AlignmentBand = (typeof ALIGNMENT_BANDS)[number];

/** Maps an integer alignment value [-100..100] to its derived band. */
export function alignmentBand(val: number): AlignmentBand {
  if (val >= 60) return "strong-positive";
  if (val >= 25) return "leaning-positive";
  if (val >= -24) return "neutral";
  if (val >= -59) return "leaning-negative";
  return "strong-negative";
}

export interface Provenance {
  script: string;
  author: string;
}

export interface AlignmentBias {
  benevolence: { mean: number; spread: number };
  order: { mean: number; spread: number };
}

export interface ArchetypeDef {
  id: string;
  schemaVersion: number;
  weight: number;
  classAffinity: Record<string, number>; // permille, 1000 = neutral
  traitMods: Partial<Record<TraitAxis, number>>;
  interestWeights: Record<string, number>;
  alignmentBias: AlignmentBias;
  temperamentPool: Record<string, number>; // temperamentId -> draw weight
  professionAffinity: Record<string, number>; // professionId -> score mod
  fragmentPools: {
    origin: string[];
    event: string[];
    want: string[];
    flaw: string[];
  };
  provenance: Provenance;
}

export interface ReactionMods {
  fleeMod: number; // -0.3..+0.3
  trustMod: number;
  gossipMod: number;
}

export interface TemperamentDef {
  id: string;
  schemaVersion: number;
  weight: number;
  traitMods: Partial<Record<TraitAxis, number>>;
  reactionMods: ReactionMods;
  barkTone: string;
  provenance: Provenance;
}

export interface InterestDef {
  id: string;
  schemaVersion: number;
  professionLinks: Record<string, number>; // professionId -> contribution [0..2]
  activityTags: string[];
  provenance: Provenance;
}

export interface DescriptorDef {
  id: string;
  schemaVersion: number;
  slot: DescriptorSlot;
  traitMods: Partial<Record<TraitAxis, number>>;
  reactionMods: ReactionMods;
  barkPools: string[];
  conflicts: string[];
  provenance: Provenance;
}

export interface DescriptorRuleCondition {
  benevolenceBand?: AlignmentBand;
  orderBand?: AlignmentBand;
  temperament?: string;
  archetype?: string | string[];
  topInterest?: string;
  role?: string;
  minTrait?: { axis: TraitAxis; threshold: number };
  maxTrait?: { axis: TraitAxis; threshold: number };
}

export interface DescriptorRule {
  when: DescriptorRuleCondition;
  gives: string; // descriptor id
}

export interface FragmentDef {
  id: string;
  pool: "origin" | "event" | "want" | "flaw";
  schemaVersion: number;
  text: string;
  conditions?: {
    archetypes?: string[];
    benevolenceBands?: AlignmentBand[];
    orderBands?: AlignmentBand[];
    professions?: string[];
    interests?: string[];
  };
  weight: number;
  provenance: Provenance;
}

export interface TuningParams {
  fleeAggressionCoeff: number;
  fleeCautionCoeff: number;
  trustEmpathyCoeff: number;
  gossipSociabilityCoeff: number;
}

export interface CharacterCatalogs {
  schemaVersion: number;
  provenance: Provenance;
  defaults: TraitWeights;
  tuning: TuningParams;
  archetypes: Record<string, ArchetypeDef>;
  temperaments: Record<string, TemperamentDef>;
  interests: Record<string, InterestDef>;
  descriptors: Record<string, DescriptorDef>;
  rules: DescriptorRule[];
  fragments: Record<string, FragmentDef>;
}

export interface ResolvedProfile {
  weights: TraitWeights;
  fleeBias: number; // -0.5..+0.5
  trustBias: number; // -0.5..+0.5
  gossipBias: number; // -0.5..+0.5
  barkTone: string;
}

export interface CharacterBackstory {
  originId: string;
  eventId: string;
  wantId: string;
  flawId: string;
  text?: string;
}

export interface CharacterInstance {
  characterId: string;
  archetypeId: string;
  temperamentId: string;
  alignment: { benevolence: number; order: number };
  interests: Array<{ id: string; score: number }>; // top 3 ranked
  descriptorIds: string[]; // <= 4, at most 1 per slot
  profile: ResolvedProfile;
  backstory: CharacterBackstory;
  origin: "generated" | "authored" | "mixed";
  schemaVersion: number;
}

export interface CharacterGenerationContext {
  characterId: string;
  seedStream?: { next(): number };
  classId?: string;
  cohort?: string;
  townId?: string;
  speciesId?: string;
  role?: string;
  profession?: string;
  tier?: "background" | "local" | "major" | "villain";
  pins?: Partial<{
    archetypeId: string;
    temperamentId: string;
    alignment: { benevolence: number; order: number };
    interests: Array<{ id: string; score: number }>;
    descriptorIds: string[];
    backstory: Partial<CharacterBackstory>;
  }>;
}
