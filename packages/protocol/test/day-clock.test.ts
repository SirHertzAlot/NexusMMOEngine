/**
 * The day clock: every client derives the same time of day from the tick.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTimeOfDay, timeOfDayAt } from "../src/day-clock.js";

describe("timeOfDayAt", () => {
  const day = { seconds: 2400, offset: 0.25 };

  it("starts at the offset and advances one day per `seconds` of ticks", () => {
    assert.equal(timeOfDayAt(day, 0, 30), 0.25);
    assert.equal(timeOfDayAt(day, 30 * 600, 30), 0.5, "a quarter day (600 s) later: noon");
    assert.ok(Math.abs(timeOfDayAt(day, 30 * 2400, 30) - 0.25) < 1e-12, "a whole day later: dawn again");
  });

  it("wraps into 0..1", () => {
    const t = timeOfDayAt(day, 30 * 1800, 30);
    assert.ok(t >= 0 && t < 1);
    assert.ok(Math.abs(t - 0.0) < 1e-12, "three quarters of a day after dawn: midnight");
  });
});

describe("formatTimeOfDay", () => {
  it("reads as a 24 h clock", () => {
    assert.equal(formatTimeOfDay(0), "00:00");
    assert.equal(formatTimeOfDay(0.5), "12:00");
    assert.equal(formatTimeOfDay(0.6042), "14:30");
    assert.equal(formatTimeOfDay(1.25), "06:00");
  });
});
