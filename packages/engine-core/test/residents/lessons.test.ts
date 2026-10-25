/** Lessons (RS5 learn): an S curve of the pupil's level, hard toward the top. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lessonCost, lessonPoints, type Lessons } from "../../src/residents/lessons.js";

const L: Lessons = { version: 1, peak: 6, floor: 0.05, grandFactor: 1.5, cost: 10, costSlope: 4, professions: { smithing: "mining" } };

describe("lessons", () => {
  it("rise to a peak a third of the way up, then fall away toward the top", () => {
    const at = (lv: number): number => lessonPoints(L, lv, 100, false);
    assert.ok(at(10) > at(0), "better than a beginner's");
    assert.ok(Math.abs(at(100 / 3) - 6) < 0.01, "the peak is a third up");
    assert.ok(at(60) < at(33) && at(90) < at(60), "harder as the skill climbs");
    assert.ok(at(99) > 0 && at(99) < at(90), "a little left to the end");
    assert.equal(at(100), 0, "nothing at the top");
  });

  it("a grand master teaches more, and a lesson costs more as the pupil climbs", () => {
    assert.ok(lessonPoints(L, 30, 100, true) > lessonPoints(L, 30, 100, false));
    assert.equal(lessonCost(L, 0, 100), 10);
    assert.equal(lessonCost(L, 100, 100), 50);
  });
});
