/**
 * EA22: particle tier budgets as data (`content/vfx/budgets.json`).
 *
 * Per-quality-tier caps (max live particles, max concurrent emitters).
 * The client scales emission to the active tier; tuning a budget is a
 * JSON edit, never code. Budgets must be monotonic: a higher tier never
 * gets fewer particles than a lower one.
 */
import { z } from "zod";

export const QUALITY_TIERS = ["low", "medium", "high", "ultra"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

const TierBudget = z.object({
  /** Max live particles across all emitters. */
  maxParticles: z.number().int().positive("maxParticles must be positive"),
  /** Max concurrent emitters. */
  maxEmitters: z.number().int().positive("maxEmitters must be positive"),
});
export type TierBudget = z.infer<typeof TierBudget>;

export const ParticleBudgets = z
  .object({
    version: z.literal(1),
    tiers: z
      .object({
        low: TierBudget,
        medium: TierBudget,
        high: TierBudget,
        ultra: TierBudget,
      })
      .strict(),
  })
  .strict()
  .refine(
    (b) => {
      const counts = QUALITY_TIERS.map((t) => b.tiers[t].maxParticles);
      return counts.every((c, i) => i === 0 || c >= counts[i - 1]);
    },
    { message: "budgets must be monotonic: higher tiers get at least as many particles" },
  );
export type ParticleBudgets = z.infer<typeof ParticleBudgets>;

/** Parse and validate a particle budget file (throws on invalid). */
export function loadParticleBudgets(json: unknown): ParticleBudgets {
  return ParticleBudgets.parse(json);
}

/** The budget for one tier. */
export function budgetForTier(budgets: ParticleBudgets, tier: QualityTier): TierBudget {
  return budgets.tiers[tier];
}

/**
 * The shipped default budgets (mirrors content/vfx/budgets.json).
 * The client imports this (browser-safe); the JSON file is the
 * validated source of truth for tooling. A test asserts they match.
 */
export const DEFAULT_PARTICLE_BUDGETS: ParticleBudgets = loadParticleBudgets({
  version: 1,
  tiers: {
    low: { maxParticles: 1000, maxEmitters: 8 },
    medium: { maxParticles: 2500, maxEmitters: 16 },
    high: { maxParticles: 5000, maxEmitters: 32 },
    ultra: { maxParticles: 8000, maxEmitters: 48 },
  },
});
