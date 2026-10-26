/**
 * Crafting rules tolerate absence: a missing recipes file means "no
 * crafting" (null, matching loadCombatContent's null-on-missing pattern) —
 * the engine boots game-less. A present but invalid file still fails loud.
 *
 * Fixtures are written to a throwaway temp dir, so the test runs on a fresh checkout.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_CRAFTING_RULES,
  loadCraftingRules,
  CraftingRulesError,
} from "../src/rules.js";

const dir = mkdtempSync(join(tmpdir(), "fix-crafting-"));
writeFileSync(join(dir, "bad.json"), "{ not json");
writeFileSync(join(dir, "invalid.json"), JSON.stringify({ refining: "nope" }));

describe("loadCraftingRules tolerates absence", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing file returns null (no crafting)", () => {
    assert.equal(loadCraftingRules(join(dir, "no-such-file.json")), null);
  });

  it("an empty rules object is valid and craft-free", () => {
    assert.deepEqual(EMPTY_CRAFTING_RULES.refining, {});
    assert.deepEqual(EMPTY_CRAFTING_RULES.reagents, {});
    assert.deepEqual(EMPTY_CRAFTING_RULES.fittings, []);
    assert.deepEqual(EMPTY_CRAFTING_RULES.units, []);
    assert.deepEqual(EMPTY_CRAFTING_RULES.skills, []);
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadCraftingRules(join(dir, "bad.json")), CraftingRulesError);
  });

  it("a present file with bad content still fails loud", () => {
    assert.throws(() => loadCraftingRules(join(dir, "invalid.json")), CraftingRulesError);
  });
});
