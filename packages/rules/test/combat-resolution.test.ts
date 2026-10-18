/**
 * Combat resolution (EG6): combat.json's `resolution` defaults to the values
 * that were code, an absent key keeps its default, and bad values are
 * refused by field. The fist is items.json's `unarmed`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRules, RulesError } from "../src/index.js";

describe("combat resolution rules", () => {
  it("defaults to the values that were code, the fist included", () => {
    const r = parseRules({});
    assert.deepEqual(r.combat.resolution, { guardLetsThrough: 0.25, armReachM: 0.6, coneDegrees: 60, maxHeightDifferenceM: 2, fightDifficulty: 0.5 });
    assert.equal(r.items.unarmed.mass, 0.5);
    assert.equal(r.items.unarmed.length, 0.8);
    assert.equal(parseRules({ combat: { resolution: { coneDegrees: 90 } } }).combat.resolution.armReachM, 0.6);
    // Setting one fist value keeps the fist's other defaults, not a generic item's.
    const fist = parseRules({ items: { unarmed: { mass: 0.7 } } }).items.unarmed;
    assert.deepEqual([fist.mass, fist.length, fist.edge, fist.point, fist.hardness, fist.technique], [0.7, 0.8, 0, 0, 0.3, "bludgeon"]);
  });

  it("refuses bad values by field", () => {
    assert.throws(
      () => parseRules({ combat: { resolution: { coneDegrees: 0, guardLetsThrough: 2 } } }),
      (e: unknown) =>
        e instanceof RulesError &&
        e.issues.some((i) => i.file === "combat.json" && i.path === "resolution.coneDegrees") &&
        e.issues.some((i) => i.file === "combat.json" && i.path === "resolution.guardLetsThrough"),
    );
  });
});
