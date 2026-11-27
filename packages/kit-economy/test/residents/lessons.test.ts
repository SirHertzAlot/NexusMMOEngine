/** Lessons (RS5 learn): an S curve of the pupil's level, hard toward the top. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lessonCost, lessonPoints, lessonTerms, type Lessons } from "../../src/lessons.js";

const L: Lessons = { version: 1, peak: 6, floor: 0.05, startFloor: 0.35, grandFactor: 1.5, cost: 10, costSlope: 4, professions: { smithing: "mining" } };

describe("lessons", () => {
  it("rise to a peak a third of the way up, then fall away toward the top", () => {
    const at = (lv: number): number => lessonPoints(L, lv, 100, false);
    assert.ok(at(10) > at(0), "better than a beginner's");
    assert.ok(Math.abs(at(100 / 3) - 6) < 0.01, "the peak is a third up");
    assert.ok(at(60) < at(33) && at(90) < at(60), "harder as the skill climbs");
    assert.ok(at(99) > 0 && at(99) < at(90), "a little left to the end");
    assert.equal(at(100), 0, "nothing at the top");
    assert.ok(at(0) >= 6 * 0.35 - 1e-9, "a beginner's first lesson is worth taking");
  });

  it("a grand master teaches more, and a lesson costs more as the pupil climbs", () => {
    assert.ok(lessonPoints(L, 30, 100, true) > lessonPoints(L, 30, 100, false));
    assert.equal(lessonCost(L, 0, 100), 10);
    assert.equal(lessonCost(L, 100, 100), 50);
  });
});

describe("ES5i: what the host asks of a game's teaching", () => {
  // The gateway used to read `professions`, `lessonPoints` and `lessonCost`
  // itself, which made the `learn` message depend on this file. It asks a
  // `LessonTerms` now and takes whatever answers, so these are the guards that
  // our own answer still says what it said.
  const terms = lessonTerms(L);

  it("offers the skill, the points and the cost this game's curve gives", () => {
    const offer = terms.offer("smithing", 30, 100, false);
    assert.ok(offer, "a smith at 30 has something to teach");
    assert.equal(offer.skill, "mining");
    assert.equal(offer.points, lessonPoints(L, 30, 100, false));
    assert.equal(offer.cost, lessonCost(L, 30, 100));
    assert.equal(terms.skillOf("smithing"), "mining");
  });

  it("offers nothing where the gateway used to send the two refusals", () => {
    // Both of these were `points <= 0` and an unknown profession in the
    // gateway; they are the game's answers now, and a null offer is what the
    // host turns into "nothing left to learn".
    assert.equal(terms.offer("smithing", 100, 100, false), null, "nothing left at the top");
    assert.equal(terms.offer("cooking", 30, 100, false), null, "a profession that teaches nothing");
    assert.equal(terms.skillOf("cooking"), undefined);
  });

  it("a grand master's offer is worth more", () => {
    const plain = terms.offer("smithing", 30, 100, false);
    const grand = terms.offer("smithing", 30, 100, true);
    assert.ok(plain && grand);
    assert.ok(grand.points > plain.points, "a grand master teaches more");
    assert.equal(grand.cost, plain.cost, "but charges the same");
  });
});

