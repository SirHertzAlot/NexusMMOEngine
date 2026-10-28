/**
 * Quest content tolerates absence: a missing quest dir (or a dir with none
 * of the files) is a valid empty quest set, not a boot failure. A
 * half-present dir (some files, not all) is an authoring error and still
 * fails loud; a present but invalid file still fails loud.
 *
 * Fixtures are made in temp dirs by the tests themselves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fixtureDir, missingDir, repoContentDir } from "../support/fixture-dir.js";
import {
  EMPTY_QUEST_CONTENT,
  isQuestContentEmpty,
  loadQuestContent,
  QuestContentError,
} from "../../src/quests/content.js";

// The sample pack, found from this test file whether it runs from src/ or dist/.
const SAMPLE_QUEST_DIR = repoContentDir(dirname(fileURLToPath(import.meta.url)), "quests");

describe("loadQuestContent tolerates absence", () => {
  it("a missing dir loads as empty quest content", () => {
    const c = loadQuestContent(missingDir());
    assert.deepEqual(c, EMPTY_QUEST_CONTENT);
    assert.ok(isQuestContentEmpty(c));
  });

  it("an empty dir loads as empty quest content", () => {
    const c = loadQuestContent(fixtureDir());
    assert.deepEqual(c, EMPTY_QUEST_CONTENT);
  });

  it("a half-present dir fails loud naming the missing files", () => {
    assert.throws(() => loadQuestContent(fixtureDir({ "steps.json": "{}" })), (e: unknown) => {
      assert.ok(e instanceof QuestContentError);
      assert.match(e.message, /quests\.json/);
      assert.match(e.message, /npcs\.json/);
      assert.match(e.message, /dialogs\.json/);
      return true;
    });
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadQuestContent(fixtureDir({ "steps.json": "{ not json", "quests.json": "{}", "npcs.json": "{}", "dialogs.json": "{}" })), SyntaxError);
  });

  it("the sample pack still loads when present", () => {
    const c = loadQuestContent(SAMPLE_QUEST_DIR);
    assert.ok(!isQuestContentEmpty(c), "the sample content/quests has quests");
    assert.ok(Object.keys(c.quests).length > 0);
  });
});
