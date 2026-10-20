/** The authored rules file (content/settlements/rules.json): it checks clean and builds a town, and checkRules names what is wrong by path. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_RULES, checkRules, defaultRules, generateSettlement, loadRules } from "../src/index.js";
import { settlementPaths } from "../src/paths.js";

const file = settlementPaths({}).rules;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("content/settlements/rules.json", () => {
  it("checks clean and builds a town", () => {
    assert.deepEqual(checkRules(JSON.parse(readFileSync(file, "utf8"))), []);
    const r = generateSettlement({ settlementId: "0001", seed: 1, population: 600, rules: loadRules(file) });
    assert.equal(r.ok, true, r.ok ? "" : r.error.message);
  });
  it("is what the CLIs use unless --rules says otherwise", () => {
    assert.deepEqual(defaultRules(file), loadRules(file));
    const dir = mkdtempSync(join(tmpdir(), "settlement-rules-"));
    try {
      assert.equal(defaultRules(join(dir, "missing.json")), BUILTIN_RULES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkRules", () => {
  it("passes the built-in rules", () => {
    assert.deepEqual(checkRules(BUILTIN_RULES), []);
  });
  it("reports schema problems by path", () => {
    const bad = clone(BUILTIN_RULES) as unknown as { demographics: { householdSizeX10: number }; districtShares: Record<string, number> };
    bad.demographics.householdSizeX10 = -1;
    bad.districtShares.housing = 1;
    const paths = checkRules(bad).map((i) => i.path);
    assert.ok(paths.includes("demographics.householdSizeX10"), paths.join());
    assert.ok(paths.includes("districtShares"), paths.join());
  });
  it("names every archetype reference that does not resolve", () => {
    const bad = clone(BUILTIN_RULES);
    bad.watch!.gaol = "goal";
    bad.industry!.guild!.archetype = "guildhall";
    bad.forbiddenAdjacent[0] = [Object.keys(bad.archetypes)[0]!, "nowhere"];
    assert.deepEqual(checkRules(bad), [
      { path: "forbiddenAdjacent[0][1]", message: 'no archetype "nowhere"' },
      { path: "watch.gaol", message: 'no archetype "goal"' },
      { path: "industry.guild.archetype", message: 'no archetype "guildhall"' },
    ]);
  });
});
