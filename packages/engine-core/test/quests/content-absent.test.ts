/**
 * Quest content tolerates absence: a missing quest dir (or a dir with none
 * of the files) is a valid empty quest set, not a boot failure. A
 * half-present dir (some files, not all) is an authoring error and still
 * fails loud; a present but invalid file still fails loud.
 *
 * Fixtures are pre-created under /tmp (see /tmp/make-fixtures.sh); this test
 * performs no writes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EMPTY_QUEST_CONTENT,
  isQuestContentEmpty,
  loadQuestContent,
  QuestContentError,
} from "../../src/quests/content.js";

// The sample pack, resolved from this test file (the DEFAULT_QUEST_DIR
// constant assumes the dist/ layout, so it is off by one when bun runs
// the .ts directly).
const SAMPLE_QUEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "content", "quests");

describe("loadQuestContent tolerates absence", () => {
  it("a missing dir loads as empty quest content", () => {
    const c = loadQuestContent("/tmp/fix-quests-missing");
    assert.deepEqual(c, EMPTY_QUEST_CONTENT);
    assert.ok(isQuestContentEmpty(c));
  });

  it("an empty dir loads as empty quest content", () => {
    const c = loadQuestContent("/tmp/fix-quests-empty");
    assert.deepEqual(c, EMPTY_QUEST_CONTENT);
  });

  it("a half-present dir fails loud naming the missing files", () => {
    assert.throws(() => loadQuestContent("/tmp/fix-quests-half"), (e: unknown) => {
      assert.ok(e instanceof QuestContentError);
      assert.match(e.message, /quests\.json/);
      assert.match(e.message, /npcs\.json/);
      assert.match(e.message, /dialogs\.json/);
      return true;
    });
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadQuestContent("/tmp/fix-quests-bad"), SyntaxError);
  });

  it("the sample pack still loads when present", () => {
    const c = loadQuestContent(SAMPLE_QUEST_DIR);
    assert.ok(!isQuestContentEmpty(c), "the sample content/quests has quests");
    assert.ok(Object.keys(c.quests).length > 0);
  });
});
