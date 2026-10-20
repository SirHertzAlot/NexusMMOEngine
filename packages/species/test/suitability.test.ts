/**
 * Suitability: the one generic function. Pure, off-tick. Exclusion is
 * absolute (proposal invariant 2); per-need satisfaction is the max across
 * requirements; the product is needSat ^ weight (multiplicative).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  candidateActions,
  needIntensity,
  sampleAnchors,
  suitability,
  suitabilityGradient,
  toNeedCatalog,
  wantsToMigrate,
  type ConditionFields,
  type NeedCatalog,
  type SpeciesNeeds,
} from "../src/index.js";

const catalog: NeedCatalog = toNeedCatalog({
  schemaVersion: 1,
  needs: [
    {
      id: "need:hydration.fresh",
      schemaVersion: 1,
      category: "water",
      decayPerHour: 0.08,
      thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
      conditionFields: ["water.fresh", "water.salinity"],
      requirement: [
        { field: "water.salinity", anchors: [[0, 1], [0.05, 0.9], [0.2, 0.2], [1, 0]], hardBounds: [0, 0.05] },
        { field: "water.fresh", anchors: [[0, 0], [0.3, 0.5], [0.7, 1]] },
      ],
      actions: ["drink", "seek-water", "migrate"],
      provenance: { script: "needs/water.scm", author: "design" },
    },
    {
      id: "need:thermal.arctic",
      schemaVersion: 1,
      category: "temperature",
      decayPerHour: 0.04,
      thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
      conditionFields: ["temperature"],
      requirement: [
        { field: "temperature", anchors: [[0, 1], [0.15, 1], [0.3, 0.4], [0.5, 0]], hardBounds: [0, 0.4] },
      ],
      actions: ["seek-cold", "migrate"],
      provenance: { script: "needs/thermal.scm", author: "design" },
    },
    {
      id: "need:essence.necromancy",
      schemaVersion: 1,
      category: "custom",
      decayPerHour: 0.02,
      thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
      conditionFields: ["dungeon.essence"],
      requirement: [{ field: "dungeon.essence", anchors: [[0, 0], [0.01, 1], [1, 1]] }],
      actions: ["haunt", "migrate"],
      provenance: { script: "needs/essence.scm", author: "design" },
    },
  ],
});

const newt: SpeciesNeeds = {
  speciesId: "mire-newt",
  schemaVersion: 1,
  needs: { "need:hydration.fresh": { weight: 3.0, tolerance: 0.15 } },
  variantAxes: ["biome", "size"],
  provenance: { script: "species/wetlands.scm", author: "design" },
};

const yak: SpeciesNeeds = {
  speciesId: "tundra-yak",
  schemaVersion: 1,
  needs: {
    "need:thermal.arctic": { weight: 3.0, tolerance: 0.2 },
    "need:hydration.fresh": { weight: 1.0, tolerance: 0.4 },
  },
  variantAxes: ["biome"],
  provenance: { script: "species/tundra.scm", author: "design" },
};

const freshShallows: ConditionFields = { "water.fresh": 0.8, "water.salinity": 0, temperature: 0.45, "dungeon.essence": 0 };
const ocean: ConditionFields = { "water.fresh": 0, "water.salinity": 1, temperature: 0.5, "dungeon.essence": 0 };
const desert: ConditionFields = { "water.fresh": 0.05, "water.salinity": 0, temperature: 0.8, "dungeon.essence": 0 };
const deepCold: ConditionFields = { "water.fresh": 0.6, "water.salinity": 0, temperature: 0.1, "dungeon.essence": 0 };
const openWorld: ConditionFields = { "water.fresh": 0.5, "water.salinity": 0, temperature: 0.4, "dungeon.essence": 0 };
const crypt: ConditionFields = { "water.fresh": 0, "water.salinity": 0, temperature: 0.2, "dungeon.essence": 0.9 };

const pos = { x: 0, z: 0 };

describe("sampleAnchors", () => {
  it("interpolates piecewise-linear and clamps past the ends", () => {
    const anchors: [number, number][] = [[0, 0], [0.3, 0.5], [0.7, 1]];
    assert.equal(sampleAnchors(anchors, -1), 0);
    assert.equal(sampleAnchors(anchors, 0), 0);
    assert.ok(Math.abs(sampleAnchors(anchors, 0.5) - 0.75) < 1e-9);
    assert.equal(sampleAnchors(anchors, 0.7), 1);
    assert.equal(sampleAnchors(anchors, 99), 1);
  });
});

describe("suitability", () => {
  it("is 1 where every need is fully satisfied", () => {
    assert.equal(suitability(catalog, newt, pos, freshShallows), 1);
  });

  it("exclusion is absolute: the freshwater obligate never spawns in the ocean (invariant 2)", () => {
    assert.equal(suitability(catalog, newt, pos, ocean), 0);
  });

  it("exclusion is absolute: heat kills the arctic species outright", () => {
    assert.equal(suitability(catalog, yak, pos, desert), 0);
  });

  it("the arctic species is the thing with high suitability in the deep cold", () => {
    const s = suitability(catalog, yak, pos, deepCold);
    assert.ok(s > 0.7, `yak in deep cold: ${s}`);
  });

  it("is multiplicative: needSat ^ weight, max across requirements", () => {
    // water.fresh 0.3 -> anchors give 0.5; salinity 0 -> 1. max = 1, so 1^3 = 1.
    const s1 = suitability(catalog, newt, pos, { "water.fresh": 0.3, "water.salinity": 0, temperature: 0.45 });
    assert.equal(s1, 1);
    // salinity 0.1 violates nothing (bound is 0.05)? 0.1 > 0.05 -> hard exclusion -> 0.
    assert.equal(suitability(catalog, newt, pos, { "water.fresh": 0.8, "water.salinity": 0.1, temperature: 0.45 }), 0);
    // salinity 0.03: anchors -> between [0.05? no: anchors [0,1],[0.05,0.9]] at 0.03 -> 1 - (0.03/0.05)*0.1 = 0.94; fresh 0.8 -> 1; max 1 -> 1.
    assert.equal(suitability(catalog, newt, pos, { "water.fresh": 0.8, "water.salinity": 0.03, temperature: 0.45 }), 1);
  });

  it("a requirement on a field the supplier does not provide contributes 0 (dungeon-scoped needs stay out of the open world)", () => {
    const wraith: SpeciesNeeds = {
      speciesId: "wraith",
      schemaVersion: 1,
      needs: { "need:essence.necromancy": { weight: 3.0, tolerance: 0.1 } },
      variantAxes: [],
      provenance: { script: "species/dungeons.scm", author: "design" },
    };
    assert.equal(suitability(catalog, wraith, pos, openWorld), 0);
    assert.equal(suitability(catalog, wraith, pos, crypt), 1);
  });

  it("throws on a species referencing an unknown need id (fail loud, never guess)", () => {
    const bad: SpeciesNeeds = {
      speciesId: "mire-newt",
      schemaVersion: 1,
      needs: { "need:nope.missing": { weight: 1, tolerance: 0.5 } },
      variantAxes: [],
      provenance: { script: "x", author: "y" },
    };
    assert.throws(() => suitability(catalog, bad, pos, freshShallows), /need:nope\.missing/);
  });
});

describe("suitabilityGradient", () => {
  it("points uphill on a linear field and is flat on a flat field", () => {
    const lin: NeedCatalog = toNeedCatalog({
      schemaVersion: 1,
      needs: [
        {
          id: "need:test.linear",
          schemaVersion: 1,
          category: "custom",
          decayPerHour: 0,
          thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
          conditionFields: ["f"],
          requirement: [{ field: "f", anchors: [[0, 0], [10, 1]] }],
          actions: [],
          provenance: { script: "t", author: "t" },
        },
      ],
    });
    const sp: SpeciesNeeds = {
      speciesId: "probe",
      schemaVersion: 1,
      needs: { "need:test.linear": { weight: 1, tolerance: 0.5 } },
      variantAxes: [],
      provenance: { script: "t", author: "t" },
    };
    const fieldsAt = (p: { x: number; z: number }): ConditionFields => ({ f: p.x });
    const g = suitabilityGradient(lin, sp, { x: 5, z: 0 }, fieldsAt, 1);
    assert.ok(Math.abs(g.dx - 0.1) < 1e-9, `dx=${g.dx}`);
    assert.ok(Math.abs(g.dz) < 1e-9, `dz=${g.dz}`);
    assert.ok(Math.abs(g.gain - 0.1) < 1e-9, `gain=${g.gain}`);
    const flat = suitabilityGradient(lin, sp, { x: 5, z: 0 }, () => ({ f: 3 }), 1);
    assert.equal(flat.gain, 0);
  });
});

describe("needIntensity", () => {
  it("is 1 - level, quantized to 3 decimals, clamped to 0..1", () => {
    const need = catalog.needs[0];
    assert.equal(needIntensity(need, 1), 0);
    assert.equal(needIntensity(need, 0), 1);
    assert.equal(needIntensity(need, 0.42), 0.58);
    assert.equal(needIntensity(need, 0.12345), 0.877);
  });
});

describe("candidateActions", () => {
  it("fans out actions for needs below their uneasy band, in priority order, deduplicated", () => {
    const state = { entityId: 1, levels: { "need:hydration.fresh": 0.5, "need:thermal.arctic": 0.9 }, updatedTick: 3 };
    assert.deepEqual(candidateActions(catalog, yak, state), ["drink", "seek-water", "migrate"]);
    const calm = { entityId: 1, levels: { "need:hydration.fresh": 0.9, "need:thermal.arctic": 0.9 }, updatedTick: 3 };
    assert.deepEqual(candidateActions(catalog, yak, calm), []);
  });
});

describe("wantsToMigrate", () => {
  it("tolerance is trigger-only: below 1 - maxTolerance the entity wants to move", () => {
    // yak max tolerance 0.4 -> migrates when suitability < 0.6.
    assert.equal(wantsToMigrate(catalog, yak, pos, desert), true); // 0 < 0.6
    assert.equal(wantsToMigrate(catalog, yak, pos, deepCold), false); // ~0.85 > 0.6
  });
});
