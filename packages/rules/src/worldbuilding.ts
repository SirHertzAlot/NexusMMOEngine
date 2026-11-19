/**
 * Worldbuilding metaphysics schemas & pure evaluators
 * (KR-HOUSE-WORLDBUILDING-GENERICS.md Systems 1 & 5 + Particle Bridge §3.1-§3.4).
 *
 * System 1 — Magic Source as world data: life / beings / worship / blend.
 * System 5 — Power declarations (limits, verbs, costType), Cost Ledgers, and
 *            expring Ward protections.
 * Particle Bridge — Maps server state (`fabricHealth`, `costLedger`, `devotion`)
 *                   to visible ambient VFX cues (`life-motes`, `corruption-bleed`).
 */
import { z } from "zod";

export const MAGIC_MODELS = ["life", "beings", "worship", "blend"] as const;
export type MagicModel = (typeof MAGIC_MODELS)[number];

export const COST_TYPES = [
  "corruption",
  "life-debt",
  "service-owed",
  "devotion-owed",
] as const;
export type CostType = (typeof COST_TYPES)[number];

export const GIFTED_ROLES = ["ruler", "outcast", "worker", "legend"] as const;
export type GiftedRole = (typeof GIFTED_ROLES)[number];

export const DEVOTION_STATES = ["kept", "neglected", "contested", "desecrated"] as const;
export type DevotionState = (typeof DEVOTION_STATES)[number];

const nonEmptyId = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");

/** System 1: regional / cultural Magic Source declaration. */
export const MagicSourceSchema = z
  .strictObject({
    id: nonEmptyId,
    model: z.enum(MAGIC_MODELS),
    /** Which substrate feeds it: the fabric, which spiritual beings, or which rite-economy. */
    sourceDetail: z.string().min(1).max(200),
    /** Who may draw power, and through what mediation (clinic, shrine, pact-broker, raw gift). */
    access: z.string().min(1).max(200),
    /** Primary cost exacted by this source (System 5). */
    price: z.enum(COST_TYPES),
    /** Constituent models when `model === "blend"`. */
    blendModels: z.array(z.enum(["life", "beings", "worship"])).min(2).optional(),
    /** System 4 social address of power users in this culture. */
    giftedRole: z.enum(GIFTED_ROLES).default("worker"),
  })
  .superRefine((src, ctx) => {
    if (src.model === "blend" && (!src.blendModels || src.blendModels.length < 2)) {
      ctx.addIssue({
        code: "custom",
        path: ["blendModels"],
        message: 'blend model requires at least 2 constituent models in blendModels',
      });
    }
  });
export type MagicSource = z.infer<typeof MagicSourceSchema>;

export interface SourceConsequences {
  primaryGeneric: "sick-places" | "pact-ledger" | "devotion-circuit";
  ambientEffectId: "life-motes" | "corruption-bleed";
  primaryTaboo: string;
  institutionFocus: string;
}

/** Derive downstream societal & quest defaults from a region's magicSource block. */
export function deriveSourceConsequences(source: MagicSource): SourceConsequences {
  const effectiveModel = source.model === "blend" ? source.blendModels![0] : source.model;
  switch (effectiveModel) {
    case "life":
      return {
        primaryGeneric: "sick-places",
        ambientEffectId: "life-motes",
        primaryTaboo: "Overdrawing living substrate without rest or replanting",
        institutionFocus: "Stewards, ward-wrights, and grove-keepers",
      };
    case "beings":
      return {
        primaryGeneric: "pact-ledger",
        ambientEffectId: "corruption-bleed",
        primaryTaboo: "Breaching sworn terms or hiding patron allegiance",
        institutionFocus: "Brokers, binders, and debt courts",
      };
    case "worship":
      return {
        primaryGeneric: "devotion-circuit",
        ambientEffectId: "life-motes",
        primaryTaboo: "Letting calendar rites lapse or desecrating shrines",
        institutionFocus: "Priests, calendar-keepers, and procession guards",
      };
  }
}

/** System 5: power specification declaring hard limits, creative verbs, and cost type. */
export const PowerDeclarationSchema = z.strictObject({
  id: nonEmptyId,
  name: z.string().min(1).max(80),
  costType: z.enum(COST_TYPES),
  /** Base cost accrued per invocation before ward attenuation. */
  costPerUse: z.number().min(0),
  /** Hard constraints the power cannot cross ("must plant first", "only in line of sight"). */
  limits: z.array(z.string().min(1).max(160)).min(1),
  /** Creative applications mastered via play, not extra spell slots. */
  verbs: z.array(z.string().min(1).max(80)).min(1),
});
export type PowerDeclaration = z.infer<typeof PowerDeclarationSchema>;

/** Expiring protection rune / ward item or buff suppressing cost bleed & accrual. */
export const WardSchema = z.strictObject({
  id: nonEmptyId,
  name: z.string().min(1).max(80),
  absorbs: z.enum(COST_TYPES),
  /** Fraction in [0,1] of incoming accrual absorbed by the ward (1 = clean outline in dirty air). */
  attenuation: z.number().min(0).max(1).default(0.85),
  /** Remaining shield capacity before shattering early. */
  capacity: z.number().min(0),
  /** Unix timestamp (ms) when the ward expires. */
  expiresAt: z.number().nonnegative(),
});
export type Ward = z.infer<typeof WardSchema>;

export const PaymentOptionSchema = z.strictObject({
  id: nonEmptyId,
  label: z.string().min(1).max(160),
  /** Amount removed from `accrued` if chosen. */
  relief: z.number().positive(),
  /** Side-effect key for downstream world/faction consequences. */
  consequence: z.string().min(1).max(120),
});
export type PaymentOption = z.infer<typeof PaymentOptionSchema>;

/** System 5 / Quest Generic 4: per-holder cost ledger tracking accruing consequences. */
export const CostLedgerSchema = z.strictObject({
  holder: z.string().min(1).max(80),
  costType: z.enum(COST_TYPES),
  accrued: z.number().min(0).default(0),
  threshold: z.number().positive().default(100),
  wards: z.array(WardSchema).default([]),
  paymentOptions: z.array(PaymentOptionSchema).default([]),
});
export type CostLedger = z.infer<typeof CostLedgerSchema>;

export interface CostAccrualResult {
  ledger: CostLedger;
  appliedCost: number;
  absorbedCost: number;
  /** Normalized bleed intensity in [0,1] for `corruption-bleed` (§3.2). Zero while fully warded. */
  bleedIntensity: number;
  /** True when `accrued >= threshold` ("The Price Comes Due"). */
  matured: boolean;
  /** True if an active ward absorbed part or all of this cost. */
  wardProtected: boolean;
}

/**
 * Compute visible `corruption-bleed` intensity in [0,1] from ledger state + timestamp.
 * Active wards suppress external bleed (§3.2: "a ward's protection shows as the bleed not happening").
 */
export function computeBleedIntensity(ledger: CostLedger, nowMs: number): number {
  const activeWards = ledger.wards.filter((w) => w.expiresAt > nowMs && w.capacity > 0 && w.absorbs === ledger.costType);
  const raw = Math.min(1, ledger.accrued / ledger.threshold);
  if (activeWards.length === 0) return raw;
  const maxAtten = activeWards.reduce((m, w) => Math.max(m, w.attenuation), 0);
  return Math.max(0, raw * (1 - maxAtten));
}

/** Accrue power usage cost against a holder's ledger, letting active non-expired wards absorb first. */
export function accrueCost(ledger: CostLedger, rawCost: number, nowMs: number): CostAccrualResult {
  const amount = Math.max(0, rawCost);
  let remaining = amount;
  let absorbed = 0;
  const nextWards: Ward[] = [];

  for (const w of ledger.wards) {
    if (w.expiresAt <= nowMs || w.capacity <= 0) continue; // expired/spent wards drop cleanly
    if (w.absorbs === ledger.costType && remaining > 0) {
      const canAbsorb = Math.min(w.capacity, remaining * w.attenuation);
      absorbed += canAbsorb;
      remaining -= canAbsorb;
      const left = w.capacity - canAbsorb;
      if (left > 0) nextWards.push({ ...w, capacity: left });
    } else {
      nextWards.push(w);
    }
  }

  const nextAccrued = ledger.accrued + remaining;
  const nextLedger: CostLedger = {
    ...ledger,
    accrued: nextAccrued,
    wards: nextWards,
  };
  return {
    ledger: nextLedger,
    appliedCost: remaining,
    absorbedCost: absorbed,
    bleedIntensity: computeBleedIntensity(nextLedger, nowMs),
    matured: nextAccrued >= ledger.threshold,
    wardProtected: absorbed > 0,
  };
}

/** Install or refresh a ward on a ledger, pruning expired wards at `nowMs`. */
export function applyWard(ledger: CostLedger, ward: Ward, nowMs: number): CostLedger {
  const active = ledger.wards.filter((w) => w.id !== ward.id && w.expiresAt > nowMs && w.capacity > 0);
  return { ...ledger, wards: [...active, ward] };
}

/** Reduce accrued ledger debt by `amount` (clamped at 0). */
export function repayCost(ledger: CostLedger, amount: number): CostLedger {
  const nextAccrued = Math.max(0, ledger.accrued - Math.max(0, amount));
  return { ...ledger, accrued: nextAccrued };
}

/** Particle Bridge §3.1: regional `fabricHealth` (0..100) driving `life-motes` density and quest state. */
export const FabricHealthSchema = z.strictObject({
  regionId: nonEmptyId,
  health: z.number().min(0).max(100),
  cause: z.enum(["healthy", "overuse", "broken-taboo", "dead-grove-heart", "pact-drain", "lapsed-rite"]).default("healthy"),
});
export type FabricHealth = z.infer<typeof FabricHealthSchema>;

export interface FabricSignal {
  tier: "thriving" | "strained" | "sick" | "dying" | "dead";
  /** Intensity scalar [0..1] passed to `EmitterFx` for `life-motes`. */
  lifeMotesIntensity: number;
  sickPlaceTriggered: boolean;
}

/** Derive visual `life-motes` emitter intensity and diagnostic state from regional `fabricHealth`. */
export function evaluateFabricHealth(fabric: FabricHealth): FabricSignal {
  const h = fabric.health;
  if (h <= 0) return { tier: "dead", lifeMotesIntensity: 0, sickPlaceTriggered: true };
  if (h < 25) return { tier: "dying", lifeMotesIntensity: 0.15, sickPlaceTriggered: true };
  if (h < 55) return { tier: "sick", lifeMotesIntensity: 0.4, sickPlaceTriggered: true };
  if (h < 80) return { tier: "strained", lifeMotesIntensity: 0.72, sickPlaceTriggered: false };
  return { tier: "thriving", lifeMotesIntensity: 1, sickPlaceTriggered: false };
}

/** Quest Generic 2 / §3.4: shrine devotion state tracker. */
export const ShrineDevotionSchema = z.strictObject({
  shrineId: nonEmptyId,
  patronId: nonEmptyId,
  /** Devotion score [0..100]. */
  devotion: z.number().min(0).max(100),
  contestedBy: nonEmptyId.optional(),
});
export type ShrineDevotion = z.infer<typeof ShrineDevotionSchema>;

export function resolveShrineState(shrine: ShrineDevotion): DevotionState {
  if (shrine.contestedBy) return "contested";
  if (shrine.devotion <= 5) return "desecrated";
  if (shrine.devotion < 40) return "neglected";
  return "kept";
}

export function stepShrineDevotion(shrine: ShrineDevotion, delta: number): { shrine: ShrineDevotion; state: DevotionState } {
  const next: ShrineDevotion = {
    ...shrine,
    devotion: Math.max(0, Math.min(100, shrine.devotion + delta)),
  };
  return { shrine: next, state: resolveShrineState(next) };
}
