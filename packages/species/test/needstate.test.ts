/**
 * NeedState evaluation: per-entity runtime state, evaluated in batches off
 * the tick. Cadence per the draft: instinct 1Hz, social 0.2Hz, strategic
 * on-demand. Levels decay per NeedDef.decayPerHour and recover where the
 * location satisfies the need. Nothing here runs in the 30Hz tick.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MapNeedStateStore,
  NEED_EVAL_CADENCE_HZ,
  NeedBatchRunner,
  toNeedCatalog,
  updateNeedLevels,
  type ConditionFields,
  type NeedCatalog,
  type NeedEvalContext,
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
  ],
});

const newt: SpeciesNeeds = {
  speciesId: "mire-newt",
  schemaVersion: 1,
  needs: { "need:hydration.fresh": { weight: 3.0, tolerance: 0.15 } },
  variantAxes: [],
  provenance: { script: "species/wetlands.scm", author: "design" },
};

const lush: ConditionFields = { "water.fresh": 0.9, "water.salinity": 0 };
// Salt flat with no fresh water: both hydration aspects score ~0.
const dry: ConditionFields = { "water.fresh": 0, "water.salinity": 1 };

describe("updateNeedLevels", () => {
  it("decays an unsatisfied need by decayPerHour per sim-hour", () => {
    const state = { entityId: 1, levels: { "need:hydration.fresh": 1 }, updatedTick: 0 };
    const next = updateNeedLevels(catalog, newt, state, dry, 1, 60);
    assert.ok(Math.abs(next.levels["need:hydration.fresh"] - 0.92) < 1e-9, JSON.stringify(next.levels));
    assert.equal(next.updatedTick, 60);
    assert.equal(next.entityId, 1);
  });

  it("recovers a satisfied need toward 1 and never exceeds it", () => {
    const state = { entityId: 1, levels: { "need:hydration.fresh": 0.2 }, updatedTick: 0 };
    const next = updateNeedLevels(catalog, newt, state, lush, 1, 60);
    assert.ok(next.levels["need:hydration.fresh"] > 0.2 && next.levels["need:hydration.fresh"] <= 1);
    const full = updateNeedLevels(catalog, newt, { entityId: 1, levels: { "need:hydration.fresh": 1 }, updatedTick: 0 }, lush, 10, 60);
    assert.equal(full.levels["need:hydration.fresh"], 1);
  });

  it("never drops below 0", () => {
    const state = { entityId: 1, levels: { "need:hydration.fresh": 0.01 }, updatedTick: 0 };
    const next = updateNeedLevels(catalog, newt, state, dry, 100, 60);
    assert.equal(next.levels["need:hydration.fresh"], 0);
  });

  it("does not mutate the input state", () => {
    const state = { entityId: 1, levels: { "need:hydration.fresh": 1 }, updatedTick: 0 };
    updateNeedLevels(catalog, newt, state, dry, 1, 60);
    assert.equal(state.levels["need:hydration.fresh"], 1);
    assert.equal(state.updatedTick, 0);
  });

  it("initializes levels for needs the state has never seen", () => {
    const state = { entityId: 1, levels: {}, updatedTick: 0 };
    const next = updateNeedLevels(catalog, newt, state, lush, 1, 60);
    assert.ok("need:hydration.fresh" in next.levels);
  });
});

describe("NeedBatchRunner", () => {
  const ctxFor = (nowMs: number): NeedEvalContext & { store: MapNeedStateStore } => {
    const store = new MapNeedStateStore();
    return {
      store,
      catalog,
      speciesOf: () => newt,
      tierOf: () => "instinct",
      posOf: () => ({ x: 0, z: 0 }),
      fieldsAt: () => lush,
      nowMs: () => nowMs,
      tick: () => 100,
    };
  };

  it("evaluates entities whose cadence has elapsed and skips the rest", () => {
    const runner = new NeedBatchRunner();
    const ctx = ctxFor(0);
    const r1 = runner.run(ctx, [1, 2]);
    assert.deepEqual([r1.evaluated, r1.skipped], [2, 0]);
    // 100ms later: instinct cadence (1Hz) has not elapsed.
    const r2 = runner.run({ ...ctx, nowMs: () => 100 }, [1, 2]);
    assert.deepEqual([r2.evaluated, r2.skipped], [0, 2]);
    // 1100ms: elapsed again.
    const r3 = runner.run({ ...ctx, nowMs: () => 1100 }, [1, 2]);
    assert.deepEqual([r3.evaluated, r3.skipped], [2, 0]);
  });

  it("runs strategic-tier entities only on demand", () => {
    const runner = new NeedBatchRunner();
    const ctx = { ...ctxFor(0), tierOf: () => "social" as const };
    const r1 = runner.run(ctx, [1]);
    assert.equal(r1.evaluated, 1);
    const r2 = runner.run({ ...ctx, nowMs: () => 1000 }, [1]); // 1s < 5s social cadence
    assert.equal(r2.evaluated, 0);
    const strategic = { ...ctx, tierOf: () => "strategic" as const, nowMs: () => 1e9 };
    const r3 = runner.run(strategic, [1]);
    assert.equal(r3.evaluated, 0);
    const r4 = runner.run(strategic, [1], { force: true });
    assert.equal(r4.evaluated, 1);
  });

  it("seeds a fresh NeedState for entities the store has never seen", () => {
    const runner = new NeedBatchRunner();
    const ctx = ctxFor(0);
    runner.run(ctx, [9]);
    const st = ctx.store.get(9);
    assert.ok(st);
    assert.equal(st!.entityId, 9);
    assert.ok("need:hydration.fresh" in st!.levels);
  });

  it("writes state through the store interface (swappable)", () => {
    const runner = new NeedBatchRunner();
    const seen: number[] = [];
    const store = {
      get: () => undefined,
      set: (s: { entityId: number }) => { seen.push(s.entityId); },
    };
    runner.run({ ...ctxFor(0), store }, [4]);
    assert.deepEqual(seen, [4]);
  });

  it("cadence table matches the draft", () => {
    assert.deepEqual(NEED_EVAL_CADENCE_HZ, { instinct: 1, social: 0.2, strategic: 0 });
  });
});
