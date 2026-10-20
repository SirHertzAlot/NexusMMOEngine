/**
 * Crafting rules tolerate absence: a missing recipes file means "no
 * crafting" (null, matching loadCombatContent's null-on-missing pattern) —
 * the engine boots game-less. A present but invalid file still fails loud.
 *
 * Fixtures are pre-created under /tmp (see /tmp/make-fixtures.sh); this test
 * performs no writes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_CRAFTING_RULES,
  loadCraftingRules,
  CraftingRulesError,
} from "../src/rules.js";

describe("loadCraftingRules tolerates absence", () => {
  it("a missing file returns null (no crafting)", () => {
    assert.equal(loadCraftingRules("/tmp/fix-crafting/no-such-file.json"), null);
  });

  it("an empty rules object is valid and craft-free", () => {
    assert.deepEqual(EMPTY_CRAFTING_RULES.refining, {});
    assert.deepEqual(EMPTY_CRAFTING_RULES.reagents, {});
    assert.deepEqual(EMPTY_CRAFTING_RULES.fittings, []);
    assert.deepEqual(EMPTY_CRAFTING_RULES.units, []);
    assert.deepEqual(EMPTY_CRAFTING_RULES.skills, []);
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadCraftingRules("/tmp/fix-crafting/bad.json"), CraftingRulesError);
  });

  it("a present file with bad content still fails loud", () => {
    assert.throws(() => loadCraftingRules("/tmp/fix-crafting/invalid.json"), CraftingRulesError);
  });
});
