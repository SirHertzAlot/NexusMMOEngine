/**
 * Civic logistics, dynamic surveying, settlement foundry specialization,
 * escrow contracts, and item provenance schemas + deterministic evaluators.
 *
 * Designed as standalone strict-Zod validated rules (following `worldbuilding.ts`)
 * with complete engine defaults for the Redwater Crossing vertical slice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { SurveyBand, SurveyDirection } from "@mmo-engine/protocol";

const slugId = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)").max(64);
const positiveInt = z.number().int().positive();
const nonNegInt = z.number().int().min(0);

export const VeinTraitDefSchema = z.strictObject({
  id: slugId,
  name: z.string().min(1).max(64),
  craftTag: z.string().min(1).max(32),
  powerBonusPct: z.number().min(-50).max(200).default(0),
  durabilityBonusPct: z.number().min(-50).max(200).default(0),
  staminaReductionPct: z.number().min(0).max(50).default(0),
  armourPenetrationPct: z.number().min(0).max(100).default(0),
});
export type VeinTraitDef = z.infer<typeof VeinTraitDefSchema>;

export const CivicStageDefSchema = z.strictObject({
  stage: nonNegInt,
  label: z.string().min(1).max(48),
  requirements: z.record(slugId, positiveInt).default({}),
  goldCost: nonNegInt.default(0),
});
export type CivicStageDef = z.infer<typeof CivicStageDefSchema>;

export const CivicSiteDefSchema = z.strictObject({
  id: slugId,
  name: z.string().min(1).max(64),
  kind: z.enum(["bridge", "crossing", "monument"]),
  x: z.number().finite(),
  z: z.number().finite(),
  interactRadiusM: z.number().positive().max(100).default(8),
  crossingHalfWidthM: z.number().positive().max(100).default(6),
  crossingCooldownMs: positiveInt.default(15_000),
  wearMax: positiveInt.default(1000),
  wearPerCrossing: nonNegInt.default(10),
  wearPerHeavyHaul: nonNegInt.default(35),
  damageThreshold: nonNegInt.default(300),
  repairCostPer100Wear: z.record(slugId, positiveInt).default({}),
  repairGoldPer100Wear: nonNegInt.default(0),
  heavyHaulMinStage: nonNegInt.default(2),
  bypassDetourMultiplier: z.number().min(1).max(20).default(4),
  antiWhaleDailyContribCap: positiveInt.default(200),
  stages: z.array(CivicStageDefSchema).min(1),
});
export type CivicSiteDef = z.infer<typeof CivicSiteDefSchema>;

export const CivicVeinTemplateSchema = z.strictObject({
  id: slugId,
  material: slugId,
  stock: positiveInt.default(60),
  isBaseline: z.boolean().default(false),
  respawnDelayMs: nonNegInt.default(30_000),
  traitPool: z.array(slugId).min(1),
  spawnAnchors: z.array(z.strictObject({ x: z.number().finite(), z: z.number().finite() })).min(1),
});
export type CivicVeinTemplate = z.infer<typeof CivicVeinTemplateSchema>;

export const CivicFoundryDefSchema = z.strictObject({
  id: slugId,
  name: z.string().min(1).max(64),
  x: z.number().finite(),
  z: z.number().finite(),
  interactRadiusM: z.number().positive().max(100).default(12),
  activationOreThreshold: positiveInt.default(40),
  batchesPerSpecialization: positiveInt.default(20),
  specializationTtlMs: positiveInt.default(72 * 3_600_000),
  antiMonopolyDailyWeightCap: positiveInt.default(80),
  depletedPermilleStep: nonNegInt.default(25),
  maxDepletedPermille: nonNegInt.max(900).default(650),
  requiresBridgeId: slugId.optional(),
});
export type CivicFoundryDef = z.infer<typeof CivicFoundryDefSchema>;

export const CivicSurveyingRulesSchema = z.strictObject({
  scanRangeM: z.number().positive().default(180),
  pinpointRadiusM: z.number().positive().default(14),
  extractReachM: z.number().positive().default(16),
  cooldownMs: nonNegInt.default(2500),
  minActivePerRegion: positiveInt.default(2),
  maxExtractQtyPerCall: positiveInt.default(5),
});

export const CivicContractsRulesSchema = z.strictObject({
  maxOpenPerCharacter: positiveInt.default(10),
  maxDurationHours: positiveInt.max(168).default(48),
  defaultDurationHours: positiveInt.default(24),
  maxLotSize: positiveInt.default(10_000),
  maxRewardPerUnit: positiveInt.default(1_000_000),
  escrowFeeRate: z.number().min(0).max(0.25).default(0.02),
});

export const CivicRulesSchema = z.strictObject({
  surveying: CivicSurveyingRulesSchema.prefault({}),
  contracts: CivicContractsRulesSchema.prefault({}),
  traits: z.array(VeinTraitDefSchema).min(1),
  sites: z.array(CivicSiteDefSchema).default([]),
  veins: z.array(CivicVeinTemplateSchema).default([]),
  foundries: z.array(CivicFoundryDefSchema).default([]),
});
export type CivicRules = z.infer<typeof CivicRulesSchema>;

export const DEFAULT_CIVIC_RULES: CivicRules = CivicRulesSchema.parse({
  surveying: {
    scanRangeM: 180,
    pinpointRadiusM: 14,
    extractReachM: 16,
    cooldownMs: 2500,
    minActivePerRegion: 2,
    maxExtractQtyPerCall: 5,
  },
  contracts: {
    maxOpenPerCharacter: 10,
    maxDurationHours: 48,
    defaultDurationHours: 24,
    maxLotSize: 10_000,
    maxRewardPerUnit: 1_000_000,
    escrowFeeRate: 0.02,
  },
  traits: [
    {
      id: "bog-standard",
      name: "Standard Iron",
      craftTag: "Standard",
      powerBonusPct: 0,
      durabilityBonusPct: 0,
      staminaReductionPct: 0,
      armourPenetrationPct: 0,
    },
    {
      id: "high-carbon",
      name: "High-Carbon Ore",
      craftTag: "Quenched",
      powerBonusPct: 15,
      durabilityBonusPct: 10,
      staminaReductionPct: 0,
      armourPenetrationPct: 0,
    },
    {
      id: "cold-short",
      name: "Cold-Short Seam",
      craftTag: "Tempered",
      powerBonusPct: 8,
      durabilityBonusPct: 0,
      staminaReductionPct: 10,
      armourPenetrationPct: 0,
    },
    {
      id: "deep-vein",
      name: "Deep-Vein Ferrite",
      craftTag: "Deep-Forged",
      powerBonusPct: 6,
      durabilityBonusPct: 20,
      staminaReductionPct: 0,
      armourPenetrationPct: 12,
    },
  ],
  sites: [
    {
      id: "redwater-bridge",
      name: "Redwater Gorge Bridge",
      kind: "bridge",
      x: 42,
      z: -18,
      interactRadiusM: 8,
      crossingHalfWidthM: 6,
      crossingCooldownMs: 15_000,
      wearMax: 1000,
      wearPerCrossing: 10,
      wearPerHeavyHaul: 35,
      damageThreshold: 300,
      repairCostPer100Wear: { wood: 4, iron: 2 },
      repairGoldPer100Wear: 5,
      heavyHaulMinStage: 2,
      bypassDetourMultiplier: 4,
      antiWhaleDailyContribCap: 200,
      stages: [
        { stage: 0, label: "Ruined Crossing", requirements: {}, goldCost: 0 },
        { stage: 1, label: "Timber Foot-Scaffold", requirements: { wood: 30, stone: 20 }, goldCost: 25 },
        { stage: 2, label: "Restored Cart Span", requirements: { wood: 40, iron: 25 }, goldCost: 75 },
      ],
    },
  ],
  veins: [
    {
      id: "oakhaven-surface",
      material: "iron",
      stock: 40,
      isBaseline: true,
      respawnDelayMs: 20_000,
      traitPool: ["bog-standard"],
      spawnAnchors: [
        { x: -12, z: 14 },
        { x: -18, z: 22 },
      ],
    },
    {
      id: "east-gorge-vein",
      material: "iron",
      stock: 80,
      isBaseline: false,
      respawnDelayMs: 45_000,
      traitPool: ["high-carbon", "cold-short"],
      spawnAnchors: [
        { x: 78, z: -26 },
        { x: 92, z: -12 },
        { x: 84, z: -42 },
      ],
    },
    {
      id: "highland-ridge-vein",
      material: "iron",
      stock: 60,
      isBaseline: false,
      respawnDelayMs: 60_000,
      traitPool: ["deep-vein", "high-carbon"],
      spawnAnchors: [
        { x: 115, z: 28 },
        { x: 128, z: 10 },
      ],
    },
  ],
  foundries: [
    {
      id: "oakhaven",
      name: "Oakhaven Hearth",
      x: -24,
      z: 6,
      interactRadiusM: 14,
      activationOreThreshold: 25,
      batchesPerSpecialization: 15,
      specializationTtlMs: 72 * 3_600_000,
      antiMonopolyDailyWeightCap: 80,
      depletedPermilleStep: 15,
      maxDepletedPermille: 450,
    },
    {
      id: "millhaven",
      name: "Millhaven Foundry",
      x: 58,
      z: -10,
      interactRadiusM: 14,
      activationOreThreshold: 40,
      batchesPerSpecialization: 20,
      specializationTtlMs: 72 * 3_600_000,
      antiMonopolyDailyWeightCap: 80,
      depletedPermilleStep: 25,
      maxDepletedPermille: 650,
      requiresBridgeId: "redwater-bridge",
    },
  ],
});

/** Parse civic rules with strict cross-reference checks (traitPool refs, stage monotonic order). */
export function parseCivicRules(raw: unknown): CivicRules {
  const parsed = CivicRulesSchema.parse(raw);
  const traitIds = new Set(parsed.traits.map((t) => t.id));
  const siteIds = new Set(parsed.sites.map((s) => s.id));

  for (const v of parsed.veins) {
    for (const tid of v.traitPool) {
      if (!traitIds.has(tid)) {
        throw new Error(`civic rules: vein "${v.id}" references unknown trait "${tid}"`);
      }
    }
  }
  for (const s of parsed.sites) {
    for (let i = 0; i < s.stages.length; i++) {
      if (s.stages[i]!.stage !== i) {
        throw new Error(`civic rules: site "${s.id}" stages must be sequentially indexed (expected ${i}, got ${s.stages[i]!.stage})`);
      }
    }
    if (s.damageThreshold > s.wearMax) {
      throw new Error(`civic rules: site "${s.id}" damageThreshold (${s.damageThreshold}) cannot exceed wearMax (${s.wearMax})`);
    }
  }
  for (const f of parsed.foundries) {
    if (f.requiresBridgeId && !siteIds.has(f.requiresBridgeId)) {
      throw new Error(`civic rules: foundry "${f.id}" references unknown requiresBridgeId "${f.requiresBridgeId}"`);
    }
  }
  return parsed;
}

/** Load content/rules/civic.json when present; fall back to DEFAULT_CIVIC_RULES when absent. */
export function loadCivicRules(filePath?: string): CivicRules {
  if (!filePath || !fs.existsSync(filePath)) {
    return DEFAULT_CIVIC_RULES;
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  return parseCivicRules(raw);
}

/**
 * Compute server-side hot/cold survey bearing toward a deposit without leaking
 * raw exact coordinates prior to pinpoint discovery.
 */
export function computeSurveyBearing(
  px: number,
  pz: number,
  vx: number,
  vz: number,
  scanRangeM: number,
  pinpointRadiusM: number,
): { band: SurveyBand; direction: SurveyDirection; distanceBucketM: number; exactDistanceM: number } {
  const dx = vx - px;
  const dz = vz - pz;
  const dist = Math.hypot(dx, dz);

  if (!Number.isFinite(dist) || dist > scanRangeM) {
    return { band: "none", direction: "here", distanceBucketM: -1, exactDistanceM: Infinity };
  }
  if (dist <= pinpointRadiusM) {
    return { band: "pinpoint", direction: "here", distanceBucketM: 0, exactDistanceM: dist };
  }

  let band: SurveyBand;
  if (dist <= pinpointRadiusM * 2.5) band = "hot";
  else if (dist <= scanRangeM * 0.6) band = "warm";
  else band = "faint";

  // Bucket distances to 10 m steps to avoid sub-metre client triangulation spoofing.
  const distanceBucketM = Math.max(10, Math.round(dist / 10) * 10);

  // World convention: +Z = South, -Z = North, +X = East, -X = West.
  const angle = Math.atan2(dx, -dz); // 0 = N, +pi/2 = E
  const idx = Math.round(angle / (Math.PI / 4));
  const dirs: SurveyDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const direction = dirs[((idx % 8) + 8) % 8]!;

  return { band, direction, distanceBucketM, exactDistanceM: dist };
}

/**
 * Diminishing marginal prestige/specialization weight past `dailyCap` so wealthy
 * players still finish physical builds without erasing smaller contributors' plaques.
 */
export function effectiveContributionWeight(priorTodayWeight: number, rawDelta: number, dailyCap: number): number {
  if (!Number.isFinite(rawDelta) || rawDelta <= 0) return 0;
  const prior = Math.max(0, priorTodayWeight);
  const cap = Math.max(1, dailyCap);
  let remaining = rawDelta;
  let pos = prior;
  let gained = 0;

  // Tier 1: [0, cap) at 1.0x
  if (pos < cap) {
    const take = Math.min(remaining, cap - pos);
    gained += take * 1.0;
    remaining -= take;
    pos += take;
  }
  // Tier 2: [cap, 2 * cap) at 0.5x
  if (remaining > 0 && pos < 2 * cap) {
    const take = Math.min(remaining, 2 * cap - pos);
    gained += take * 0.5;
    remaining -= take;
    pos += take;
  }
  // Tier 3: >= 2 * cap at 0.2x
  if (remaining > 0) {
    gained += remaining * 0.2;
  }
  return Math.round(gained * 100) / 100;
}

/**
 * Safe integer escrow math for work-order posting: prevents Number overflow and
 * fractional-copper arbitrage exploits.
 */
export function computeContractTotals(
  qty: number,
  rewardPerUnit: number,
  feeRate: number,
): { ok: true; subtotal: number; fee: number; totalLock: number } | { ok: false; error: string } {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, error: "quantity must be a positive integer" };
  }
  if (!Number.isInteger(rewardPerUnit) || rewardPerUnit <= 0) {
    return { ok: false, error: "reward per unit must be a positive integer" };
  }
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.5) {
    return { ok: false, error: "invalid escrow fee rate" };
  }
  const subtotal = qty * rewardPerUnit;
  if (!Number.isSafeInteger(subtotal)) {
    return { ok: false, error: "contract reward exceeds safe integer bounds" };
  }
  const fee = Math.floor(subtotal * feeRate);
  const totalLock = subtotal + fee;
  if (!Number.isSafeInteger(totalLock)) {
    return { ok: false, error: "total locked gold exceeds safe integer bounds" };
  }
  return { ok: true, subtotal, fee, totalLock };
}
