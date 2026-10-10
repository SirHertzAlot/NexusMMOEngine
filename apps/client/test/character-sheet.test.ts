/**
 * CharacterSheet: modifier-delta math (pure, no DOM needed).
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupSkills, statDelta } from "../src/ui/character-sheet.js";

const line = (value: number, base: number) => ({ id: "x", name: "X", value, base });

describe("statDelta", () => {
  it("shows nothing when unmodified", () => {
    assert.equal(statDelta(line(10, 10)), "");
  });

  it("signs buffs and debuffs", () => {
    assert.equal(statDelta(line(12, 10)), "+2");
    assert.equal(statDelta(line(8.5, 10)), "-1.5");
  });
});

describe("groupSkills", () => {
  const k = (id: string, family: string, value: number, peak = value) => ({ id, name: id, family, value, peak });
  it("groups by family in rules order, trained first by value, untrained apart", () => {
    const groups = groupSkills([k("cutting", "weapon", 0), k("evading", "defence", 2), k("thrusting", "weapon", 5), k("striking", "weapon", 9), k("blocking", "defence", 0, 3)]);
    assert.deepEqual(groups.map((g) => g.family), ["weapon", "defence"]);
    assert.deepEqual(groups[0]!.trained.map((s) => s.id), ["striking", "thrusting"]);
    assert.deepEqual(groups[0]!.untrained.map((s) => s.id), ["cutting"]);
    // A skill that decayed to nothing but has a peak still counts as trained.
    assert.deepEqual(groups[1]!.trained.map((s) => s.id), ["evading", "blocking"]);
  });
});
