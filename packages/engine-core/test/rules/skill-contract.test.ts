/**
 * The engine's skill contract: systems name specific skill and technique ids
 * ("medicine", "swimming", "parrying", "disarm", …). A content pack that
 * declares skills must declare all of them — fail loud at boot, never silent
 * 0s. A rules dir with no skills.json / disciplines.json at all is skill-less
 * mode: the contract is skipped and systems keep their graceful fallbacks.
 *
 * Rules objects are built in memory; the dirs only need the files to exist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fixtureDir, repoContentDir } from "../support/fixture-dir.js";
import { engineDefaults, loadRules, type Rules } from "@mmo-engine/rules";
import {
  ENGINE_REQUIRED_SKILLS,
  ENGINE_REQUIRED_TECHNIQUES,
  EngineSkillContractError,
  assertEngineSkillContract,
  checkEngineSkillContract,
} from "../../src/rules/skill-contract.js";

const FULL = fixtureDir({ "skills.json": "{}", "disciplines.json": "{}" });
const SAMPLE_SKILLS = ["medicine", "swimming", "athletics", "evading", "parrying", "blocking", "cutting"];

function rulesWith(skillIds: string[], unlocks: string[]): Rules {
  const r = engineDefaults();
  r.skills.skills = skillIds.map((id) => ({
    id, name: id, family: "test", related: {},
  })) as Rules["skills"]["skills"];
  r.disciplines.disciplines = [{ id: "testdisc", name: "Test", requires: {}, unlocks }] as Rules["disciplines"]["disciplines"];
  return r;
}

describe("engine skill contract", () => {
  it("passes when every required id is declared", () => {
    const r = rulesWith(SAMPLE_SKILLS, ["disarm"]);
    assert.deepEqual(checkEngineSkillContract(r, FULL), []);
    assert.doesNotThrow(() => assertEngineSkillContract(r, FULL));
  });

  it("fails loud naming a missing skill id", () => {
    const r = rulesWith(SAMPLE_SKILLS.filter((s) => s !== "medicine"), ["disarm"]);
    assert.throws(() => assertEngineSkillContract(r, FULL), (e: unknown) => {
      assert.ok(e instanceof EngineSkillContractError);
      assert.match(e.message, /skill "medicine"/);
      assert.deepEqual(e.missing, [`skill "medicine"`]);
      return true;
    });
  });

  it("fails loud naming every missing id at once", () => {
    const r = rulesWith(["cutting"], []);
    assert.throws(() => assertEngineSkillContract(r, FULL), (e: unknown) => {
      assert.ok(e instanceof EngineSkillContractError);
      for (const id of ENGINE_REQUIRED_SKILLS) assert.match(e.message, new RegExp(`skill "${id}"`));
      for (const t of ENGINE_REQUIRED_TECHNIQUES) assert.match(e.message, new RegExp(`technique "${t}"`));
      return true;
    });
  });

  it("fails loud naming a missing technique id", () => {
    const r = rulesWith(SAMPLE_SKILLS, ["riposte"]);
    assert.throws(() => assertEngineSkillContract(r, FULL), /technique "disarm"/);
  });

  it("checks techniques only when disciplines.json exists", () => {
    // skills.json present but disciplines.json absent: technique check skipped.
    const r = rulesWith(SAMPLE_SKILLS, []);
    assert.deepEqual(checkEngineSkillContract(r, fixtureDir({ "skills.json": "{}" })), []);
  });

  it("skips the contract when no skills/disciplines files exist (skill-less mode)", () => {
    const r = engineDefaults();
    assert.deepEqual(checkEngineSkillContract(r, fixtureDir()), []);
  });

  it("the sample pack satisfies the contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rulesDir = repoContentDir(here, "rules");
    const r = loadRules(rulesDir);
    assert.deepEqual(checkEngineSkillContract(r, rulesDir), []);
  });
});
