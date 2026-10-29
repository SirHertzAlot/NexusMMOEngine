/**
 * Zod schemas and validation for character catalogs (Phase 0).
 */

import { z } from "zod";
import {
  TRAIT_AXES,
  DESCRIPTOR_SLOTS,
  ALIGNMENT_BANDS,
  type CharacterCatalogs,
} from "./types.js";

export const ProvenanceSchema = z.strictObject({
  script: z.string().min(1),
  author: z.string().min(1),
});

export const TraitWeightsSchema = z.strictObject({
  aggression: z.number().min(0.25).max(2.5),
  caution: z.number().min(0.25).max(2.5),
  sociability: z.number().min(0.25).max(2.5),
  diligence: z.number().min(0.25).max(2.5),
  curiosity: z.number().min(0.25).max(2.5),
  empathy: z.number().min(0.25).max(2.5),
  ambition: z.number().min(0.25).max(2.5),
  composure: z.number().min(0.25).max(2.5),
});

export const TraitModsSchema = z
  .record(z.string(), z.number().min(0.4).max(2.5))
  .refine(
    (record) => Object.keys(record).every((k) => (TRAIT_AXES as readonly string[]).includes(k)),
    { message: `Keys must be one of trait axes: ${TRAIT_AXES.join(", ")}` },
  );

export const ReactionModsSchema = z.strictObject({
  fleeMod: z.number().min(-0.35).max(0.35),
  trustMod: z.number().min(-0.35).max(0.35),
  gossipMod: z.number().min(-0.35).max(0.35),
});

export const AlignmentBiasSchema = z.strictObject({
  benevolence: z.strictObject({
    mean: z.number().min(-100).max(100),
    spread: z.number().min(0).max(100),
  }),
  order: z.strictObject({
    mean: z.number().min(-100).max(100),
    spread: z.number().min(0).max(100),
  }),
});

export const ArchetypeDefSchema = z.strictObject({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  weight: z.number().positive(),
  classAffinity: z.record(z.string(), z.number().int().min(0)),
  traitMods: TraitModsSchema,
  interestWeights: z.record(z.string(), z.number().positive()),
  alignmentBias: AlignmentBiasSchema,
  temperamentPool: z.record(z.string(), z.number().positive()),
  professionAffinity: z.record(z.string(), z.number().positive()),
  fragmentPools: z.strictObject({
    origin: z.array(z.string()),
    event: z.array(z.string()),
    want: z.array(z.string()),
    flaw: z.array(z.string()),
  }),
  provenance: ProvenanceSchema,
});

export const TemperamentDefSchema = z.strictObject({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  weight: z.number().positive(),
  traitMods: TraitModsSchema,
  reactionMods: ReactionModsSchema,
  barkTone: z.string().min(1),
  provenance: ProvenanceSchema,
});

export const InterestDefSchema = z.strictObject({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  professionLinks: z.record(z.string(), z.number().min(0).max(2)),
  activityTags: z.array(z.string()),
  provenance: ProvenanceSchema,
});

export const DescriptorDefSchema = z.strictObject({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  slot: z.enum(DESCRIPTOR_SLOTS),
  traitMods: TraitModsSchema,
  reactionMods: ReactionModsSchema,
  barkPools: z.array(z.string()),
  conflicts: z.array(z.string()),
  provenance: ProvenanceSchema,
});

export const DescriptorRuleConditionSchema = z.strictObject({
  benevolenceBand: z.enum(ALIGNMENT_BANDS).optional(),
  orderBand: z.enum(ALIGNMENT_BANDS).optional(),
  temperament: z.string().optional(),
  archetype: z.union([z.string(), z.array(z.string())]).optional(),
  topInterest: z.string().optional(),
  role: z.string().optional(),
  minTrait: z
    .strictObject({
      axis: z.enum(TRAIT_AXES),
      threshold: z.number(),
    })
    .optional(),
  maxTrait: z
    .strictObject({
      axis: z.enum(TRAIT_AXES),
      threshold: z.number(),
    })
    .optional(),
});

export const DescriptorRuleSchema = z.strictObject({
  when: DescriptorRuleConditionSchema,
  gives: z.string().min(1),
});

export const FragmentDefSchema = z.strictObject({
  id: z.string().min(1),
  pool: z.enum(["origin", "event", "want", "flaw"]),
  schemaVersion: z.literal(1),
  text: z.string().min(1),
  conditions: z
    .strictObject({
      archetypes: z.array(z.string()).optional(),
      benevolenceBands: z.array(z.enum(ALIGNMENT_BANDS)).optional(),
      orderBands: z.array(z.enum(ALIGNMENT_BANDS)).optional(),
      professions: z.array(z.string()).optional(),
      interests: z.array(z.string()).optional(),
    })
    .optional(),
  weight: z.number().positive(),
  provenance: ProvenanceSchema,
});

export const TuningParamsSchema = z.strictObject({
  fleeAggressionCoeff: z.number(),
  fleeCautionCoeff: z.number(),
  trustEmpathyCoeff: z.number(),
  gossipSociabilityCoeff: z.number(),
});

export const CharacterCatalogsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provenance: ProvenanceSchema,
  defaults: TraitWeightsSchema,
  tuning: TuningParamsSchema,
  archetypes: z.record(z.string(), ArchetypeDefSchema),
  temperaments: z.record(z.string(), TemperamentDefSchema),
  interests: z.record(z.string(), InterestDefSchema),
  descriptors: z.record(z.string(), DescriptorDefSchema),
  rules: z.array(DescriptorRuleSchema),
  fragments: z.record(z.string(), FragmentDefSchema),
});

export interface CatalogIssue {
  path: string;
  message: string;
}

const formatPath = (segments: readonly PropertyKey[]): string =>
  segments.reduce<string>(
    (s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)),
    "",
  );

/**
 * Validates a complete character catalogs dataset against schemas and cross-reference invariants.
 */
export function checkCharacterCatalogs(content: unknown): CatalogIssue[] {
  const parsed = CharacterCatalogsSchema.safeParse(content);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      path: formatPath(i.path),
      message: i.message,
    }));
  }

  const c = parsed.data;
  const issues: CatalogIssue[] = [];

  const known = (
    predicate: boolean,
    path: string,
    message: string,
  ): void => {
    if (!predicate) issues.push({ path, message });
  };

  // Cross-reference archetypes
  for (const [id, arch] of Object.entries(c.archetypes)) {
    if (arch.id !== id) {
      issues.push({ path: `archetypes.${id}.id`, message: `mismatched id key "${id}" vs id "${arch.id}"` });
    }
    for (const tempId of Object.keys(arch.temperamentPool)) {
      known(tempId in c.temperaments, `archetypes.${id}.temperamentPool.${tempId}`, `unknown temperament "${tempId}"`);
    }
    for (const intId of Object.keys(arch.interestWeights)) {
      known(intId in c.interests, `archetypes.${id}.interestWeights.${intId}`, `unknown interest "${intId}"`);
    }
    for (const [poolKey, fids] of Object.entries(arch.fragmentPools)) {
      for (const fid of fids) {
        known(
          fid in c.fragments && c.fragments[fid].pool === poolKey,
          `archetypes.${id}.fragmentPools.${poolKey}.${fid}`,
          `unknown or mismatched fragment "${fid}" in pool "${poolKey}"`,
        );
      }
    }
  }

  // Cross-reference temperaments
  for (const [id, temp] of Object.entries(c.temperaments)) {
    if (temp.id !== id) {
      issues.push({ path: `temperaments.${id}.id`, message: `mismatched id key "${id}" vs id "${temp.id}"` });
    }
  }

  // Cross-reference interests
  for (const [id, interest] of Object.entries(c.interests)) {
    if (interest.id !== id) {
      issues.push({ path: `interests.${id}.id`, message: `mismatched id key "${id}" vs id "${interest.id}"` });
    }
  }

  // Cross-reference descriptors
  for (const [id, desc] of Object.entries(c.descriptors)) {
    if (desc.id !== id) {
      issues.push({ path: `descriptors.${id}.id`, message: `mismatched id key "${id}" vs id "${desc.id}"` });
    }
    for (const conflictId of desc.conflicts) {
      known(conflictId in c.descriptors, `descriptors.${id}.conflicts.${conflictId}`, `unknown conflict descriptor "${conflictId}"`);
    }
  }

  // Cross-reference rules
  for (let i = 0; i < c.rules.length; i++) {
    const r = c.rules[i];
    known(r.gives in c.descriptors, `rules[${i}].gives`, `unknown descriptor "${r.gives}"`);
    if (r.when.temperament) {
      known(r.when.temperament in c.temperaments, `rules[${i}].when.temperament`, `unknown temperament "${r.when.temperament}"`);
    }
    if (r.when.topInterest) {
      known(r.when.topInterest in c.interests, `rules[${i}].when.topInterest`, `unknown interest "${r.when.topInterest}"`);
    }
    if (r.when.archetype) {
      const archs = Array.isArray(r.when.archetype) ? r.when.archetype : [r.when.archetype];
      for (const a of archs) {
        known(a in c.archetypes, `rules[${i}].when.archetype`, `unknown archetype "${a}"`);
      }
    }
  }

  // Cross-reference fragments
  for (const [id, frag] of Object.entries(c.fragments)) {
    if (frag.id !== id) {
      issues.push({ path: `fragments.${id}.id`, message: `mismatched id key "${id}" vs id "${frag.id}"` });
    }
    if (frag.conditions?.archetypes) {
      for (const a of frag.conditions.archetypes) {
        known(a in c.archetypes, `fragments.${id}.conditions.archetypes`, `unknown archetype "${a}"`);
      }
    }
    if (frag.conditions?.interests) {
      for (const intId of frag.conditions.interests) {
        known(intId in c.interests, `fragments.${id}.conditions.interests`, `unknown interest "${intId}"`);
      }
    }
  }

  return issues;
}
