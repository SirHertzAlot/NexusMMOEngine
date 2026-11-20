/**
 * Civic logistics rules & pure evaluator tests: schema strictness, cross-reference checks,
 * distance-bucketed survey bearings, anti-whale marginal weights, and safe-integer contract math.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CIVIC_RULES,
  computeContractTotals,
  computeSurveyBearing,
  effectiveContributionWeight,
  loadCivicRules,
  parseCivicRules,
} from "../src/index.js";

describe("civic rules schema & cross-checks", () => {
  it("parses DEFAULT_CIVIC_RULES cleanly and rejects unknown keys or bad cross-references", () => {
    const ok = parseCivicRules(DEFAULT_CIVIC_RULES);
    assert.equal(ok.sites[0]!.id, "redwater-bridge");
    assert.equal(ok.foundries.length, 2);

    // Unknown trait ref in vein template
    const badTrait = structuredClone(DEFAULT_CIVIC_RULES) as unknown as {
      veins: Array<{ traitPool: string[] }>;
    };
    badTrait.veins[0]!.traitPool = ["nonexistent-trait"];
    assert.throws(() => parseCivicRules(badTrait), /unknown trait/);

    // Non-sequential stage numbering
    const badStage = structuredClone(DEFAULT_CIVIC_RULES) as unknown as {
      sites: Array<{ stages: Array<{ stage: number }> }>;
    };
    badStage.sites[0]!.stages[1]!.stage = 3;
    assert.throws(() => parseCivicRules(badStage), /sequentially indexed/);

    // Strict extra property rejected
    const badStrict = { ...DEFAULT_CIVIC_RULES, extraGarbage: true };
    assert.throws(() => parseCivicRules(badStrict));
  });

  it("loadCivicRules falls back to DEFAULT_CIVIC_RULES when file is absent", () => {
    const loaded = loadCivicRules("/definitely/absent/civic.json");
    assert.deepEqual(loaded, DEFAULT_CIVIC_RULES);
  });
});

describe("survey bearing & distance bucketing", () => {
  it("returns pinpoint inside pinpointRadiusM and bucketed 10m steps outside", () => {
    const pin = computeSurveyBearing(10, 10, 15, 16, 180, 14);
    assert.equal(pin.band, "pinpoint");
    assert.equal(pin.direction, "here");
    assert.equal(pin.distanceBucketM, 0);

    const north = computeSurveyBearing(0, 100, 0, 0, 180, 14);
    assert.equal(north.band, "warm");
    assert.equal(north.direction, "N");
    assert.equal(north.distanceBucketM, 100);

    const eastHot = computeSurveyBearing(0, 0, 24, 0, 180, 14);
    assert.equal(eastHot.band, "hot");
    assert.equal(eastHot.direction, "E");
    assert.equal(eastHot.distanceBucketM, 20);

    const far = computeSurveyBearing(0, 0, 500, 500, 180, 14);
    assert.equal(far.band, "none");
  });
});

describe("anti-whale diminishing contribution weight", () => {
  it("applies 1.0x up to cap, 0.5x up to 2*cap, and 0.2x above 2*cap without blocking material dumps", () => {
    assert.equal(effectiveContributionWeight(0, 100, 200), 100);
    assert.equal(effectiveContributionWeight(150, 100, 200), 75); // 50*1 + 50*0.5
    assert.equal(effectiveContributionWeight(200, 200, 200), 100); // 200*0.5
    assert.equal(effectiveContributionWeight(400, 100, 200), 20); // 100*0.2
    assert.equal(effectiveContributionWeight(0, -10, 200), 0);
  });
});

describe("safe escrow contract totals", () => {
  it("computes integer subtotal + floored fee and blocks overflows/invalid inputs", () => {
    assert.deepEqual(computeContractTotals(50, 10, 0.02), {
      ok: true,
      subtotal: 500,
      fee: 10,
      totalLock: 510,
    });
    assert.equal(computeContractTotals(0, 10, 0.02).ok, false);
    assert.equal(computeContractTotals(10, 0, 0.02).ok, false);
    assert.equal(computeContractTotals(1.5, 10, 0.02).ok, false);
    assert.equal(computeContractTotals(1_000_000_000, 10_000_000_000, 0.02).ok, false);
  });
});
