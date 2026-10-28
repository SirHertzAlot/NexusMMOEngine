/**
 * Unit tests for Universal Measurement System (UMS):
 * - Human reference proportions & ergonomic anchors
 * - Scale tier classification
 * - Perspective optics & spatial perception analysis
 * - Size variance with invariant preservation
 * - Gameplay interactivity bindings (reach, obstacles, mass, acoustics)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HUMAN_REFERENCE_METRICS,
  ERGONOMIC_REFERENCE_ANCHORS,
  classifyScaleTier,
  computeVisualAngleDeg,
  computePerceivedSize,
  analyzeSpatialPerception,
  generateScaleVariance,
  classifyTraversalObstacle,
  computeDynamicInteractionRadius,
  computeKineticMass,
  computeAcousticResonance,
  evaluateInteractivity,
} from "../src/index.js";

describe("Universal Measurement System (UMS)", () => {
  it("authoritative human reference metrics match ergonomic standards", () => {
    assert.equal(HUMAN_REFERENCE_METRICS.height, 1.80, "standing height 1.80m");
    assert.equal(HUMAN_REFERENCE_METRICS.eyeLevel, 1.62, "eye level horizon 1.62m");
    assert.equal(HUMAN_REFERENCE_METRICS.crouchEyeLevel, 1.05, "crouched eye level 1.05m");
    assert.equal(HUMAN_REFERENCE_METRICS.stepOverHeight, 0.30, "step-over clearance 0.30m");
    assert.equal(HUMAN_REFERENCE_METRICS.maxVaultHeight, 1.20, "vault limit 1.20m");
    assert.equal(HUMAN_REFERENCE_METRICS.reachDistance, 2.20, "interaction reach 2.20m");
  });

  it("classifies physical dimensions into appropriate scale tiers", () => {
    assert.equal(classifyScaleTier(0.05), "micro", "key / coin");
    assert.equal(classifyScaleTier(0.40), "handheld", "dagger / torch");
    assert.equal(classifyScaleTier(1.80), "human", "player / chest");
    assert.equal(classifyScaleTier(3.50), "ogre", "ramp rise / corridor");
    assert.equal(classifyScaleTier(8.00), "monumental", "arena walls");
    assert.equal(classifyScaleTier(24.00), "colossal", "great fortress gate");
  });

  it("calculates optical visual angles and perspective foreshortening", () => {
    // 2m tall door at 2m distance
    // theta = 2 * atan(2 / (2 * 2)) = 2 * atan(0.5) = 2 * 26.565 deg = 53.13 deg
    const angleAt2m = computeVisualAngleDeg(2.0, 2.0);
    assert.ok(Math.abs(angleAt2m - 53.13) < 0.1, `expected ~53.13 deg, got ${angleAt2m}`);

    // Doubling distance to 4m foreshortens angular size
    const angleAt4m = computeVisualAngleDeg(2.0, 4.0);
    assert.ok(angleAt4m < angleAt2m, "visual angle must decrease with distance");
    assert.ok(Math.abs(angleAt4m - 28.07) < 0.1, `expected ~28.07 deg, got ${angleAt4m}`);

    const perceivedClose = computePerceivedSize(2.0, 2.0, 60);
    assert.equal(perceivedClose.perceivedCategory, "focal-center");

    const perceivedFar = computePerceivedSize(2.0, 30.0, 60);
    assert.equal(perceivedFar.perceivedCategory, "background-detail");
  });

  it("analyzes room proportions to classify spatial immersion tiers", () => {
    // 1. Constricted tunnel
    const tunnel = analyzeSpatialPerception(1.5, 10.0, 2.0);
    assert.equal(tunnel.tier, "claustrophobic");

    // 2. Crypt alcove / domestic room
    const alcove = analyzeSpatialPerception(4.0, 4.0, 2.8);
    assert.equal(alcove.tier, "intimate");

    // 3. Crypt hall nave
    const nave = analyzeSpatialPerception(15.0, 30.0, 4.5);
    assert.equal(nave.tier, "expansive");

    // 4. Boss Arena court
    const arena = analyzeSpatialPerception(25.0, 25.0, 8.0);
    assert.equal(arena.tier, "monumental");

    // 5. Abyssal subterranean cavern
    const cavern = analyzeSpatialPerception(50.0, 80.0, 25.0);
    assert.equal(cavern.tier, "abyssal");
  });

  it("generates deterministic size variance while enforcing gameplay invariants", () => {
    // Flora with anisotropic jitter
    const v1 = generateScaleVariance({ category: "flora" }, 12345);
    const v2 = generateScaleVariance({ category: "flora" }, 12345);
    assert.deepEqual(v1.scale, v2.scale, "seeded repeatability");
    assert.ok(v1.scale[0] >= 0.70 && v1.scale[0] <= 1.35);

    // Invariant protection: Doorway width must not shrink below 1.0m
    const doorResult = generateScaleVariance(
      { category: "custom", minScale: 0.5, maxScale: 0.6 },
      42,
      { minClearWidthM: 1.0 }
    );
    assert.equal(doorResult.invariantPass, false);
    assert.ok(doorResult.adjustments.length > 0);
    const adjustedClearWidth = ERGONOMIC_REFERENCE_ANCHORS.doorwayClearWidth * doorResult.scale[0];
    assert.ok(adjustedClearWidth >= 0.999, "width scaled up to protect doorway clearance");
  });

  it("classifies traversal obstacles based on player step and vault thresholds", () => {
    assert.equal(classifyTraversalObstacle(0.15), "step-over", "curb/rubble");
    assert.equal(classifyTraversalObstacle(0.75), "low-cover", "chest/table/tomb");
    assert.equal(classifyTraversalObstacle(1.50), "high-cover", "shoulder wall");
    assert.equal(classifyTraversalObstacle(2.50), "full-obstacle", "perimeter wall");
  });

  it("scales kinetic mass cubically with volume", () => {
    const baseChestKg = 40.0;
    // Scale 1.0x -> 40kg
    assert.equal(computeKineticMass(baseChestKg, [1.0, 1.0, 1.0]), 40.0);
    // Scale 1.5x on all axes -> 1.5^3 = 3.375 -> 135kg
    assert.equal(computeKineticMass(baseChestKg, [1.5, 1.5, 1.5]), 135.0);
    // Scale 0.8x -> 0.8^3 = 0.512 -> 20.48kg
    assert.equal(computeKineticMass(baseChestKg, [0.8, 0.8, 0.8]), 20.48);
  });

  it("computes acoustic resonance and pitch shift inversely proportional to scale", () => {
    // Normal 1.0 scale
    const res1 = computeAcousticResonance(1.0);
    assert.equal(res1.pitchMultiplier, 1.0);
    assert.equal(res1.lowFrequencyGainDb, 0.0);

    // Giant chest / bell 2.0x scale -> pitch drops (~0.79x) and bass gains (+6dB)
    const res2 = computeAcousticResonance(2.0);
    assert.ok(res2.pitchMultiplier < 1.0, "pitch drops for larger objects");
    assert.ok(res2.lowFrequencyGainDb > 0, "bass boost for larger objects");

    // Small trinket 0.5x scale -> pitch rises (~1.26x) and bass drops
    const resSmall = computeAcousticResonance(0.5);
    assert.ok(resSmall.pitchMultiplier > 1.0, "pitch rises for smaller objects");
  });

  it("evaluates player interactivity and reach against scaled objects", () => {
    const chestBounds = {
      min: [0, 0, 4] as [number, number, number],
      max: [1.2, 0.8, 5] as [number, number, number],
    };

    // Player standing 1.5m away (within reach)
    const evalClose = evaluateInteractivity(chestBounds, [0.6, 0, 2.5], 1.0);
    assert.equal(evalClose.canInteract, true);
    assert.equal(evalClose.obstacleTier, "low-cover");
    assert.ok(evalClose.reachRemainingM > 0);

    // Player standing 6m away (out of reach)
    const evalFar = evaluateInteractivity(chestBounds, [0.6, 0, 11.0], 1.0);
    assert.equal(evalFar.canInteract, false);
    assert.equal(evalFar.reachRemainingM, 0);
  });
});
