/**
 * Gathering rules: content/rules/gathering.json loads, an absent file takes
 * the engine defaults, and bad values are reported by file and field.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { engineDefaults, loadRules, parseRules, RulesError } from "../src/index.js";

/** The repo's content/rules (this file runs from packages/rules/dist/test). */
const OUR_RULES = fileURLToPath(new URL("../../../../content/rules", import.meta.url));

describe("gathering rules (content/rules/gathering.json)", () => {
  it("loads our file, and an absent one is the engine defaults", () => {
    assert.deepEqual(loadRules(OUR_RULES).gathering, { reachM: 2.5, cooldownSeconds: 1.2, pouchMax: 999, trainDifficultyPerTier: 0.2 });
    assert.deepEqual(parseRules({}).gathering, engineDefaults().gathering);
  });

  it("refuses bad values by file and field", () => {
    assert.throws(
      () => parseRules({ gathering: { pouchMax: 0, reach: 3 } }),
      (e: unknown) => e instanceof RulesError && e.issues.some((i) => i.file === "gathering.json" && i.path === "pouchMax") && e.issues.some((i) => i.file === "gathering.json" && /reach/.test(i.message)),
    );
  });
});
