/** Damage states and the dust pool (DE1). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DamageWatch, damageStage, stageBrightness } from "../src/render/damage-stage.js";
import { DUST_LIFE_S, DustSim, puffsFor } from "../src/render/dust-sim.js";

describe("damageStage", () => {
  it("is whole at full health and worse as health falls", () => {
    assert.equal(damageStage(10, 10), 0);
    assert.equal(damageStage(7, 10), 0);
    assert.equal(damageStage(6, 10), 1);
    assert.equal(damageStage(3, 10), 2);
    assert.equal(damageStage(0, 10), 2);
  });
  it("is whole with no max, and takes its own thresholds", () => {
    assert.equal(damageStage(0, 0), 0);
    assert.equal(damageStage(3, 10, [0.9, 0.6, 0.4]), 3);
  });
  it("darkens each stage and holds the last", () => {
    assert.ok(stageBrightness(1) < stageBrightness(0));
    assert.ok(stageBrightness(2) < stageBrightness(1));
    assert.equal(stageBrightness(9), stageBrightness(2));
  });
});

describe("DamageWatch", () => {
  it("says nothing for a whole prop, then reports each change once with the share lost", () => {
    const w = new DamageWatch();
    assert.equal(w.observe(1n, 10, 10), null);
    assert.equal(w.observe(1n, 10, 10), null);
    assert.deepEqual(w.observe(1n, 6, 10), { stage: 1, lost: 0.4 });
    assert.equal(w.observe(1n, 6, 10), null);
  });
  it("reports a prop first seen already worn, without a blow", () => {
    assert.deepEqual(new DamageWatch().observe(2n, 2, 10), { stage: 2, lost: 0 });
  });
  it("reports mending as a stage change with nothing lost", () => {
    const w = new DamageWatch();
    w.observe(1n, 2, 10);
    assert.deepEqual(w.observe(1n, 10, 10), { stage: 0, lost: 0 });
  });
  it("forgets pruned entities", () => {
    const w = new DamageWatch();
    w.observe(1n, 2, 10);
    w.prune(() => false);
    assert.deepEqual(w.observe(1n, 2, 10), { stage: 2, lost: 0 });
  });
});

describe("DustSim", () => {
  it("rises, then dies after its life", () => {
    const d = new DustSim(8, 7);
    d.emit(1, 0, 2, 3);
    assert.equal(d.alive(), 3);
    d.step(0.1);
    assert.ok(d.py[0]! > 0);
    d.step(DUST_LIFE_S);
    assert.equal(d.alive(), 0);
  });
  it("overwrites the oldest when full, never growing", () => {
    const d = new DustSim(4, 7);
    d.emit(0, 0, 0, 10);
    assert.equal(d.alive(), 4);
  });
  it("is the same for the same seed", () => {
    const a = new DustSim(4, 5);
    const b = new DustSim(4, 5);
    a.emit(0, 0, 0, 4);
    b.emit(0, 0, 0, 4);
    assert.deepEqual([...a.px], [...b.px]);
  });
  it("gives more puffs for a heavier blow, within bounds", () => {
    assert.ok(puffsFor(0.5) > puffsFor(0.05));
    assert.equal(puffsFor(0), 3);
    assert.equal(puffsFor(5), 12);
  });
});
