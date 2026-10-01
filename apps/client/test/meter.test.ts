/**
 * Meter: the shared bar's fill math (pure, no DOM needed).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { barFraction } from "../src/ui/meter.js";

describe("barFraction", () => {
  it("fills proportionally", () => {
    assert.equal(barFraction(25, 100), 0.25);
    assert.equal(barFraction(100, 100), 1);
    assert.equal(barFraction(0, 100), 0);
  });

  it("clamps out-of-range values", () => {
    assert.equal(barFraction(150, 100), 1);
    assert.equal(barFraction(-10, 100), 0);
  });

  it("fills nothing for non-positive or non-finite maxima", () => {
    assert.equal(barFraction(50, 0), 0);
    assert.equal(barFraction(50, -100), 0);
    assert.equal(barFraction(50, Number.NaN), 0);
    assert.equal(barFraction(Number.NaN, 100), 0);
  });
});
