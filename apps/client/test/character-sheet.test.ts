/**
 * CharacterSheet: modifier-delta math (pure, no DOM needed).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statDelta } from "../src/ui/character-sheet.js";

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
