/**
 * Integration: settlement fortification on a REAL world survey.
 * The whole chain — surveyWorld → site → adapt → fortify → emit →
 * decorate — must produce world-coordinate placements inside the world.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { surveyWorld } from "../../src/terrain/survey.js";
import { parseWorldSpec, worldBounds } from "../../src/terrain/world-spec.js";
import { bakeSettlementFortifications } from "../../src/terrain/fortify-settlements.js";

const SMALL_WORLD = {
  name: "small",
  seed: 77,
  sizeChunks: 32,
  regionsPerSide: 2,
  land: { coast: { wander: 40, wanderScale: 150 }, rise: 15, riseDistance: 200, relief: 6, reliefScale: 300, shelfWidth: 60, minIslandArea: 2000 },
  ranges: { count: 1, spurs: 0, height: 120, width: 140, length: 300, ridgeScale: 120, coastClearance: 60 },
  climate: { dryDistance: 800, orographic: 0.01 },
  erosion: { droplets: 3000, thermalPasses: 10, fluvialPasses: 4 },
  rivers: { minCatchment: 20_000, maxDepth: 3 },
  lakes: { minArea: 2000 },
  minBiomeArea: 1000,
  biomes: [
    { id: "sea", when: { water: "sea" }, roughness: 0.2 },
    { id: "lake", when: { water: "lake" }, roughness: 0.1 },
    { id: "mountains", when: { height: { min: 60 } }, surface: { shape: "ridged", relief: 4, scale: 60 }, roughness: 1 },
    { id: "desert", when: { rainMm: { max: 400 } }, surface: { shape: "dunes", relief: 3, scale: 30 }, roughness: 0.3 },
    { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
  ],
};

describe("settlement fortification bake", () => {
  test("a real survey yields a decorated, world-coordinate settlement bake", () => {
    const spec = parseWorldSpec(SMALL_WORLD);
    const survey = surveyWorld(spec);
    const bakes = bakeSettlementFortifications(survey, { budget: 40 });
    assert.ok(bakes.length >= 1, "at least one settlement sited");
    const bake = bakes[0];
    const bounds = worldBounds(spec);
    const inWorld = (x: number, z: number): boolean =>
      x >= bounds.min && x < bounds.max && z >= bounds.min && z < bounds.max;

    assert.equal(bake.version, 1);
    assert.ok(bake.placements.length >= 8, `placements: ${bake.placements.length}`);
    assert.ok(bake.buildLog.length > 0, "the fortify loop actually built things");
    for (const p of bake.placements) {
      assert.ok(p.decoration, `${p.kind} is decorated`);
      if (p.world) assert.ok(inWorld(p.world[0], p.world[1]), `${p.kind} inside the world`);
      for (const pt of p.polyline ?? []) assert.ok(inWorld(pt[0], pt[1]), "polyline inside the world");
    }
    const runs = bake.placements.filter((p: { kind: string }) => p.kind === "wall-run");
    assert.equal(runs.length, 4);
    // Round-trips through JSON — it persists as world meta.
    const roundTripped = JSON.parse(JSON.stringify(bake)) as typeof bake;
    assert.equal(roundTripped.placements.length, bake.placements.length);
  });

  test("the roman doctrine stamps step-0 builds on a real survey", () => {
    const spec = parseWorldSpec(SMALL_WORLD);
    const survey = surveyWorld(spec);
    const bakes = bakeSettlementFortifications(survey, { budget: 40, doctrine: "roman", era: 1, profile: "roman" });
    assert.ok(bakes.length >= 1);
    const log = bakes[0].buildLog;
    assert.ok(log.some((l: { step: number }) => l.step === 0), "doctrine steps present");
    assert.equal(bakes[0].exposures.siege, 0);
  });
});
