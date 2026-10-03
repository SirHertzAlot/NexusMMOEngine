/** Mastery gain, anti-farming, related skills, decay (roadmap M1). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRules } from "@mmo-engine/rules";
import { SkillIndex, SkillSheet } from "../src/stats/mastery.js";

const rules = parseRules({
  skills: {
    skills: [
      { id: "a", name: "A", family: "f", related: { b: 0.5 } },
      { id: "b", name: "B", family: "f" },
    ],
    families: ["f"],
    decay: { ratePerWeek: 0.1 },
  },
}).skills;
const mk = (): SkillSheet => new SkillSheet(new SkillIndex(rules));
const DAY = 86_400_000;

describe("mastery", () => {
  it("a use at the skill's level gains the base, and shares with related", () => {
    const s = mk();
    const g = s.train(0, 0, -1, 1000);
    assert.equal(g, rules.gain.base);
    assert.equal(s.get("a"), rules.gain.base);
    assert.equal(s.get("b"), rules.gain.base * 0.5);
  });

  it("a use far below the skill teaches nothing", () => {
    const s = mk();
    s.value[0] = 80;
    assert.equal(s.train(0, 0.1, -1, 1000), 0);
    assert.equal(s.value[0], 80);
  });

  it("gain slows toward the top", () => {
    const lo = mk();
    const hi = mk();
    hi.value[0] = 90;
    assert.ok(hi.train(0, 1, -1, 0) < lo.train(0, 1, -1, 0) / 10);
  });

  it("the same target falls off, and recovers when left alone", () => {
    const s = mk();
    const first = s.train(0, 1, 7, 0);
    const second = s.train(0, 1, 7, 0);
    assert.ok(second < first);
    const later = s.train(0, 1, 7, 2 * rules.gain.repeatRecoverMinutes * 60_000);
    assert.ok(later > second);
    const other = mk();
    other.train(0, 1, 7, 0);
    assert.ok(Math.abs(other.train(0, 1, 8, 0) - first) < 0.01 * first, "a new target is (nearly) full gain");
  });

  it("never passes max", () => {
    const s = mk();
    s.value[0] = rules.max - 0.01;
    s.train(0, 1, -1, 0);
    assert.ok(s.value[0] <= rules.max);
  });

  it("decay waits out the grace, stops at the floor of the peak, and relearning is quicker", () => {
    const s = mk();
    s.value[0] = 50;
    s.peak[0] = 50;
    s.lastUse[0] = 1;
    s.applyDecay(1 + rules.decay.graceDays * DAY);
    assert.equal(s.value[0], 50, "inside the grace");
    s.applyDecay(1 + 400 * DAY);
    assert.equal(s.value[0], 50 * rules.decay.floorOfPeak);
    const before = s.value[0];
    const g = s.train(0, 1, -1, 500 * DAY);
    assert.ok(g > rules.gain.base * (1 - before / 100) ** 2, "below peak gains relearn-multiplied");
  });

  it("saves and loads in tenths", () => {
    const s = mk();
    s.train(0, 0, -1, 5000);
    const t = mk();
    t.load(s.save());
    assert.ok(Math.abs(t.get("a") - s.get("a")) < 0.05);
    assert.equal(t.lastUse[0], 5000);
  });
});
