/**
 * Ingress rules (roadmap T1): content/rules/ingress.json loads, an absent
 * file takes the engine defaults, and bad values are reported by file and
 * field like every other rules file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  engineDefaults,
  loadRules,
  parseRules,
  RulesError,
} from "../src/index.js";

/** The repo's content/rules (this file runs from packages/rules/dist/test). */
const OUR_RULES = fileURLToPath(new URL("../../../../content/rules", import.meta.url));

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulesError) return e.issues.map((i) => `${i.file}${i.path ? `: ${i.path}` : ""}: ${i.message}`);
    throw e;
  }
  assert.fail("expected a RulesError");
}

describe("ingress rules (content/rules/ingress.json)", () => {
  it("loads our game's table", () => {
    const rules = loadRules(OUR_RULES);
    assert.deepEqual(rules.ingress, {
      maxClientPayloadBytes: 65536,
      intentsPerSecond: 40,
      intentBurst: 60,
      pickupsPerSecond: 5,
      pickupBurst: 10,
      abuseWindowSeconds: 10,
      maxViolations: 100,
    });
  });

  it("an absent file is the engine default", () => {
    assert.deepEqual(parseRules({}).ingress, engineDefaults().ingress);
    assert.deepEqual(engineDefaults().ingress, {
      maxClientPayloadBytes: 65536,
      intentsPerSecond: 40,
      intentBurst: 60,
      pickupsPerSecond: 5,
      pickupBurst: 10,
      abuseWindowSeconds: 10,
      maxViolations: 100,
    });
  });

  it("a partial file fills the rest with defaults", () => {
    const rules = parseRules({ ingress: { intentsPerSecond: 20 } });
    assert.equal(rules.ingress.intentsPerSecond, 20);
    assert.equal(rules.ingress.intentBurst, 60);
  });

  it("bad values are reported by file and field", () => {
    const issues = issuesOf(() =>
      parseRules({
        ingress: {
          maxClientPayloadBytes: 0,
          intentsPerSecond: 0,
          intentBurst: 1.5,
          pickupsPerSecond: -1,
          pickupBurst: 0,
          abuseWindowSeconds: 0,
          maxViolations: 0,
        },
      }),
    );
    for (const field of [
      "maxClientPayloadBytes",
      "intentsPerSecond",
      "intentBurst",
      "pickupsPerSecond",
      "pickupBurst",
      "abuseWindowSeconds",
      "maxViolations",
    ]) {
      assert.ok(issues.some((i) => i.startsWith(`ingress.json: ${field}`)), `reports ${field}: ${issues.join("; ")}`);
    }
  });

  it("a misspelt field is refused, not ignored", () => {
    const issues = issuesOf(() => parseRules({ ingress: { intentRate: 40 } }));
    assert.ok(issues.some((i) => i.startsWith("ingress.json")), issues.join("; "));
  });
});
