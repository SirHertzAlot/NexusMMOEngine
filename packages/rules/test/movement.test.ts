/**
 * Movement rules (EG5): content/rules/movement.json loads, an absent file or
 * key takes the engine defaults (the values that were code), and bad values
 * are reported by file and field.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { engineDefaults, loadRules, parseRules, RulesError } from "../src/index.js";

/** The repo's content/rules (this file runs from packages/rules/dist/test). */
const OUR_RULES = fileURLToPath(new URL("../../../../content/rules", import.meta.url));

describe("movement rules (content/rules/movement.json)", () => {
  it("our file says what the engine defaults say", () => {
    assert.deepEqual(loadRules(OUR_RULES).movement, engineDefaults().movement);
  });

  it("an absent key keeps its default, nested stamina included", () => {
    const m = parseRules({ movement: { walkSpeed: 7, stamina: { dodgeCost: 25 } } }).movement;
    assert.equal(m.walkSpeed, 7);
    assert.equal(m.gravity, 22);
    assert.equal(m.stamina.dodgeCost, 25);
    assert.equal(m.stamina.regenDelaySeconds, 1);
    assert.deepEqual(parseRules({}).movement.stamina, engineDefaults().movement.stamina);
  });

  it("refuses bad values by file and field", () => {
    assert.throws(
      () => parseRules({ movement: { walkSpeed: 0, stamina: { jumpCost: -1 }, sprint: 9 } }),
      (e: unknown) =>
        e instanceof RulesError &&
        e.issues.some((i) => i.file === "movement.json" && i.path === "walkSpeed") &&
        e.issues.some((i) => i.file === "movement.json" && i.path === "stamina.jumpCost") &&
        e.issues.some((i) => i.file === "movement.json" && /sprint/.test(i.message)),
    );
  });
});
