/**
 * Vitals readout (CF2): drain, ghost, bands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VITALS as R, bandColor, newVitals, observeVitals, stepVitals } from "../src/ui/vitals.js";

describe("vitals readout", () => {
  it("a hit drains the fill fast while the ghost holds, then catches up", () => {
    const s = newVitals(1);
    const d = observeVitals(s, 0.6, R);
    assert.ok(Math.abs(d + 0.4) < 1e-9);
    for (let i = 0; i < 12; i++) stepVitals(s, 1 / 60, R); // 200 ms: inside the hold
    assert.ok(s.shown < 0.7, `fill drained ${s.shown}`);
    assert.equal(s.ghost, 1, "ghost still holds the old value");
    for (let i = 0; i < 600; i++) stepVitals(s, 1 / 60, R);
    assert.equal(s.shown, 0.6);
    assert.equal(s.ghost, 0.6);
    assert.equal(stepVitals(s, 1 / 60, R), false, "settled: the frame loop can stop");
  });

  it("a heal fills up with no ghost", () => {
    const s = newVitals(0.4);
    assert.ok(observeVitals(s, 0.9, R) > 0);
    for (let i = 0; i < 600; i++) stepVitals(s, 1 / 60, R);
    assert.equal(s.shown, 0.9);
    assert.equal(s.ghost, 0.9);
  });

  it("a second hit during the ghost keeps the older, higher ghost and restarts the hold", () => {
    const s = newVitals(1);
    observeVitals(s, 0.8, R);
    for (let i = 0; i < 15; i++) stepVitals(s, 1 / 60, R);
    observeVitals(s, 0.5, R);
    assert.equal(s.ghost, 1);
    assert.equal(s.hold, R.ghostHoldMs);
  });

  it("colour bands follow the fraction", () => {
    assert.equal(bandColor(0.9, R.bands), "#22c55e");
    assert.equal(bandColor(0.4, R.bands), "#f59e0b");
    assert.equal(bandColor(0.1, R.bands), "#ef4444");
  });
});
