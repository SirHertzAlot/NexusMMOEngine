/**
 * Universal Measurement System (UMS)
 *
 * Implements an authoritative physical and perceptual measurement foundation:
 * - Canonical human reference proportions and ergonomic anchors.
 * - Architectural scale tiers (Micro, Handheld, Human, Ogre, Monumental, Colossal).
 * - Optical visual angles, apparent perspective foreshortening, and spatial perception profiles.
 * - Controlled size variance generation preserving critical gameplay invariants.
 * - Interactivity bindings: dynamic interaction reach, obstacle traversal categorization,
 *   cubic kinetic mass scaling, and acoustic resonance / pitch attenuation.
 */

import type { Vec3 } from "./index.js";

// ------------------------------------------------------------------ Human Reference Metrics

export interface HumanReferenceMetrics {
  /** Standard adult standing height (metres). Default 1.80m. */
  height: number;
  /** Standing eye level horizon for first-person cameras. Default 1.62m. */
  eyeLevel: number;
  /** Crouched eye level horizon. Default 1.05m. */
  crouchEyeLevel: number;
  /** Shoulder breadth (biacromial breadth). Default 0.50m. */
  shoulderWidth: number;
  /** Navigation capsule radius. Default 0.35m. */
  capsuleRadius: number;
  /** Maximum curb / step height traversable smoothly without jumping. Default 0.30m. */
  stepOverHeight: number;
  /** Maximum obstacle height climbable / vaultable. Default 1.20m. */
  maxVaultHeight: number;
  /** Functional manual interaction reach. Default 2.20m. */
  reachDistance: number;
  /** Close-up inspection / puzzle dial manipulation reach. Default 0.80m. */
  inspectDistance: number;
}

export const HUMAN_REFERENCE_METRICS: Readonly<HumanReferenceMetrics> = {
  height: 1.80,
  eyeLevel: 1.62,
  crouchEyeLevel: 1.05,
  shoulderWidth: 0.50,
  capsuleRadius: 0.35,
  stepOverHeight: 0.30,
  maxVaultHeight: 1.20,
  reachDistance: 2.20,
  inspectDistance: 0.80,
};

// ------------------------------------------------------------------ Ergonomic Anchors

export interface ErgonomicReferenceAnchors {
  doorwayClearWidth: number;
  doorwayClearHeight: number;
  stairRiserHeight: number;
  stairTreadDepth: number;
  tableSurfaceHeight: number;
  chairSeatHeight: number;
  chestHeight: number;
  railingHeight: number;
  wallTorchHeight: number;
  chamberCeilingHeight: number;
  arenaCeilingHeight: number;
}

export const ERGONOMIC_REFERENCE_ANCHORS: Readonly<ErgonomicReferenceAnchors> = {
  doorwayClearWidth: 1.10,
  doorwayClearHeight: 2.20,
  stairRiserHeight: 0.18,
  stairTreadDepth: 0.28,
  tableSurfaceHeight: 0.75,
  chairSeatHeight: 0.45,
  chestHeight: 0.70,
  railingHeight: 1.05,
  wallTorchHeight: 1.85,
  chamberCeilingHeight: 4.00,
  arenaCeilingHeight: 8.00,
};

// ------------------------------------------------------------------ Scale Tiers

export type ScaleTier =
  | "micro"        // < 0.25m: gems, coins, rings, runes, keys
  | "handheld"     // 0.25m - 0.75m: weapons, potions, books, skulls, torches
  | "human"        // 0.75m - 2.20m: players, chests, chairs, doorways, levers
  | "ogre"         // 2.20m - 5.00m: corridors, stair rises, ogres, pillars
  | "monumental"   // 5.00m - 15.00m: double-height walls, giant statues, vault ceilings
  | "colossal";    // > 15.00m: cathedral arches, fortress towers, titans

export function classifyScaleTier(dimensionM: number): ScaleTier {
  if (dimensionM < 0.25) return "micro";
  if (dimensionM < 0.75) return "handheld";
  if (dimensionM < 2.20) return "human";
  if (dimensionM < 5.00) return "ogre";
  if (dimensionM < 15.00) return "monumental";
  return "colossal";
}

// ------------------------------------------------------------------ Perspective & Optics

export interface VisualPerspective {
  visualAngleDeg: number;
  screenFraction: number;
  perceivedCategory: "focal-center" | "prominent" | "midground-feature" | "background-detail";
}

/**
 * Calculates visual angle (theta in degrees) subtended on the viewer's retina / camera sensor.
 * theta = 2 * atan(height / (2 * distance))
 */
export function computeVisualAngleDeg(physicalHeightM: number, distanceM: number): number {
  if (distanceM <= 0.001) return 180;
  return (2 * Math.atan(physicalHeightM / (2 * Math.max(0.001, distanceM))) * 180) / Math.PI;
}

/**
 * Evaluates how large an object appears relative to camera field of view.
 */
export function computePerceivedSize(
  physicalHeightM: number,
  distanceM: number,
  cameraVerticalFovDeg = 60
): VisualPerspective {
  const angleDeg = computeVisualAngleDeg(physicalHeightM, distanceM);
  const fraction = Math.min(1.0, angleDeg / Math.max(1, cameraVerticalFovDeg));
  let perceivedCategory: VisualPerspective["perceivedCategory"] = "background-detail";
  if (fraction > 0.6) perceivedCategory = "focal-center";
  else if (fraction > 0.25) perceivedCategory = "prominent";
  else if (fraction > 0.08) perceivedCategory = "midground-feature";

  return {
    visualAngleDeg: Math.round(angleDeg * 100) / 100,
    screenFraction: Math.round(fraction * 1000) / 1000,
    perceivedCategory,
  };
}

// ------------------------------------------------------------------ Spatial Perception Analyzer

export type SpatialPerceptionTier =
  | "claustrophobic"
  | "intimate"
  | "expansive"
  | "monumental"
  | "abyssal";

export interface SpatialPerception {
  tier: SpatialPerceptionTier;
  eyeClearanceM: number;
  widthToHeightRatio: number;
  apparentVolumeM3: number;
  immersionDescription: string;
}

/**
 * Analyzes room proportions and clearance against human eye level to determine spatial feeling.
 */
export function analyzeSpatialPerception(
  roomWidthM: number,
  roomLengthM: number,
  roomHeightM: number,
  eyeLevelM = HUMAN_REFERENCE_METRICS.eyeLevel
): SpatialPerception {
  const eyeClearance = Math.max(0, roomHeightM - eyeLevelM);
  const minHorizontalSpan = Math.min(roomWidthM, roomLengthM);
  const widthToHeightRatio = minHorizontalSpan / Math.max(0.1, roomHeightM);
  const volume = roomWidthM * roomLengthM * roomHeightM;

  let tier: SpatialPerceptionTier = "expansive";
  let desc = "";

  if (roomHeightM < 2.2 || eyeClearance < 0.6 || minHorizontalSpan < 1.8) {
    tier = "claustrophobic";
    desc = "Constricted chokepoint inducing high tension, stealth focus, and defensive tunnel vision.";
  } else if (roomHeightM <= 3.2 && minHorizontalSpan <= 5.5) {
    tier = "intimate";
    desc = "Human-scaled domestic or crypt alcove providing grounded spatial familiarity.";
  } else if (roomHeightM > 18.0 || volume > 50000) {
    tier = "abyssal";
    desc = "Subterranean chasm or colossal vault dwarfing human reference scale.";
  } else if (roomHeightM > 6.0 || minHorizontalSpan > 15.0) {
    tier = "monumental";
    desc = "Imposing cathedral nave or boss court eliciting awe, dominance, and grandeur.";
  } else {
    tier = "expansive";
    desc = "Rhythmic hall or colonnade balancing comfortable clearance with open sightlines.";
  }

  return {
    tier,
    eyeClearanceM: Math.round(eyeClearance * 100) / 100,
    widthToHeightRatio: Math.round(widthToHeightRatio * 100) / 100,
    apparentVolumeM3: Math.round(volume * 10) / 10,
    immersionDescription: desc,
  };
}

// ------------------------------------------------------------------ Size Variance & Invariants

export interface ScaleVarianceConfig {
  category: "flora" | "rock" | "prop" | "humanoid" | "boss" | "architecture" | "custom";
  minScale?: number;
  maxScale?: number;
  allowAnisotropic?: boolean;
  maxAnisotropicSkew?: number;
  preserveInvariants?: boolean;
}

export interface InvariantValidationRules {
  minClearWidthM?: number;
  minClearHeightM?: number;
  maxStepRiserHeightM?: number;
  minInteractReachM?: number;
  maxInteractReachM?: number;
}

export interface ScaleVarianceResult {
  scale: Vec3;
  effectiveFactor: number;
  invariantPass: boolean;
  adjustments: string[];
}

/** Mulberry32 PRNG helper */
function seededRandom(seed: number): number {
  let s = (seed | 0) + 0x6d2b79f5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

const DEFAULT_VARIANCE_TABLE: Record<ScaleVarianceConfig["category"], { min: number; max: number; aniso: boolean }> = {
  flora: { min: 0.80, max: 1.25, aniso: true },
  rock: { min: 0.70, max: 1.35, aniso: true },
  prop: { min: 0.90, max: 1.10, aniso: false },
  humanoid: { min: 0.95, max: 1.05, aniso: false },
  boss: { min: 1.20, max: 1.80, aniso: false },
  architecture: { min: 1.00, max: 1.00, aniso: false }, // Strict isotropic 1.0 for modular grid alignment
  custom: { min: 0.85, max: 1.15, aniso: false },
};

/**
 * Generates controlled size variance from a deterministic seed while protecting
 * critical gameplay invariants (e.g. door clearances, step-over limits).
 */
export function generateScaleVariance(
  config: ScaleVarianceConfig,
  seed: number,
  rules: InvariantValidationRules = {}
): ScaleVarianceResult {
  const table = DEFAULT_VARIANCE_TABLE[config.category] || DEFAULT_VARIANCE_TABLE.prop;
  const min = config.minScale ?? table.min;
  const max = config.maxScale ?? table.max;
  const allowAniso = config.allowAnisotropic ?? table.aniso;
  const skew = config.maxAnisotropicSkew ?? 0.08;

  const r0 = seededRandom(seed);
  const r1 = seededRandom(seed + 101);
  const r2 = seededRandom(seed + 203);

  const baseFactor = min + r0 * (max - min);
  let sx = baseFactor;
  let sy = baseFactor;
  let sz = baseFactor;

  if (allowAniso) {
    sx *= 1.0 + (r1 - 0.5) * 2 * skew;
    sz *= 1.0 + (r2 - 0.5) * 2 * skew;
  }

  const adjustments: string[] = [];
  let invariantPass = true;

  if (config.preserveInvariants ?? true) {
    if (rules.minClearWidthM !== undefined && sx < 1.0) {
      const clearW = ERGONOMIC_REFERENCE_ANCHORS.doorwayClearWidth * sx;
      if (clearW < rules.minClearWidthM) {
        sx = rules.minClearWidthM / ERGONOMIC_REFERENCE_ANCHORS.doorwayClearWidth;
        adjustments.push(`Clamped width scale to ${sx.toFixed(3)} to preserve ${rules.minClearWidthM}m clear width.`);
        invariantPass = false;
      }
    }

    if (rules.maxStepRiserHeightM !== undefined && sy > 1.0) {
      const riser = ERGONOMIC_REFERENCE_ANCHORS.stairRiserHeight * sy;
      if (riser > rules.maxStepRiserHeightM) {
        sy = rules.maxStepRiserHeightM / ERGONOMIC_REFERENCE_ANCHORS.stairRiserHeight;
        adjustments.push(`Clamped vertical scale to ${sy.toFixed(3)} to preserve ${rules.maxStepRiserHeightM}m max step riser.`);
        invariantPass = false;
      }
    }
  }

  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    scale: [round(sx), round(sy), round(sz)],
    effectiveFactor: round((sx + sy + sz) / 3),
    invariantPass,
    adjustments,
  };
}

// ------------------------------------------------------------------ Interactivity & Gameplay Bindings

export type TraversalObstacleCategory =
  | "step-over"     // h <= 0.30m (no collision stop, player walks over seamlessly)
  | "low-cover"     // 0.30m < h <= 1.20m (vaultable / crouch cover)
  | "high-cover"    // 1.20m < h <= 1.80m (conceals standing eye level)
  | "full-obstacle"; // h > 1.80m (complete blocker)

export function classifyTraversalObstacle(heightM: number): TraversalObstacleCategory {
  if (heightM <= HUMAN_REFERENCE_METRICS.stepOverHeight) return "step-over";
  if (heightM <= HUMAN_REFERENCE_METRICS.maxVaultHeight) return "low-cover";
  if (heightM <= HUMAN_REFERENCE_METRICS.height) return "high-cover";
  return "full-obstacle";
}

/**
 * Dynamically computes interaction radius for objects scaled up or down.
 * R_eff = clamp(R_base * sqrt(scale), 1.0m, 4.0m)
 */
export function computeDynamicInteractionRadius(baseRadiusM: number, scaleFactor: number): number {
  const clampedScale = Math.max(0.1, scaleFactor);
  const effective = baseRadiusM * Math.sqrt(clampedScale);
  return Math.min(4.0, Math.max(1.0, Math.round(effective * 100) / 100));
}

/**
 * Calculates physical kinetic mass scaling cubically with object volume.
 * M(s) = M_base * (sx * sy * sz)
 */
export function computeKineticMass(baseMassKg: number, scale: Vec3): number {
  const volumeMultiplier = scale[0] * scale[1] * scale[2];
  return Math.round(baseMassKg * volumeMultiplier * 100) / 100;
}

/**
 * Computes acoustic resonance and pitch shift for an object based on its physical scale.
 * Pitch is inversely proportional to cbrt(scale).
 */
export function computeAcousticResonance(scaleFactor: number): {
  pitchMultiplier: number;
  lowFrequencyGainDb: number;
  resonanceDecaySec: number;
} {
  const s = Math.max(0.1, scaleFactor);
  const pitch = Math.round((1.0 / Math.cbrt(s)) * 1000) / 1000;
  const bassDb = Math.round(20 * Math.log10(s) * 10) / 10;
  const decaySec = Math.round(0.3 * Math.sqrt(s) * 100) / 100;
  return {
    pitchMultiplier: pitch,
    lowFrequencyGainDb: bassDb,
    resonanceDecaySec: decaySec,
  };
}

export interface InteractivityEvaluation {
  obstacleTier: TraversalObstacleCategory;
  interactionRadiusM: number;
  canInteract: boolean;
  distanceToPlayerM: number;
  reachRemainingM: number;
}

/**
 * Evaluates whether a player at playerPos can reach and interact with an object of objectBounds.
 */
export function evaluateInteractivity(
  objectBounds: { min: Vec3; max: Vec3 },
  playerPos: Vec3,
  scaleFactor = 1.0,
  baseReachM = HUMAN_REFERENCE_METRICS.reachDistance
): InteractivityEvaluation {
  const heightM = objectBounds.max[1] - objectBounds.min[1];
  const obstacleTier = classifyTraversalObstacle(heightM);
  const interactionRadiusM = computeDynamicInteractionRadius(baseReachM, scaleFactor);

  // Closest point on AABB to player point
  const cx = Math.max(objectBounds.min[0], Math.min(playerPos[0], objectBounds.max[0]));
  const cy = Math.max(objectBounds.min[1], Math.min(playerPos[1], objectBounds.max[1]));
  const cz = Math.max(objectBounds.min[2], Math.min(playerPos[2], objectBounds.max[2]));

  const dx = playerPos[0] - cx;
  const dy = playerPos[1] - cy;
  const dz = playerPos[2] - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const canInteract = dist <= interactionRadiusM;
  const reachRemaining = Math.max(0, interactionRadiusM - dist);

  return {
    obstacleTier,
    interactionRadiusM,
    canInteract,
    distanceToPlayerM: Math.round(dist * 100) / 100,
    reachRemainingM: Math.round(reachRemaining * 100) / 100,
  };
}
