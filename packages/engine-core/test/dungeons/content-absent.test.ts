/**
 * Dungeon content tolerates absence: a missing dungeon dir is "no dungeons",
 * not a boot failure. A half-present dir fails loud; a present but invalid
 * file still fails loud.
 *
 * Fixtures are pre-created under /tmp (see /tmp/make-fixtures.sh); this test
 * performs no writes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_INSTANCE_RULES,
  EMPTY_DUNGEON_CONTENT,
  loadDungeonContent,
} from "../../src/dungeons/content.js";

// The sample pack, resolved from this test file (see the quests test note
// about DEFAULT_DUNGEON_CONTENT assuming the dist/ layout).
const SAMPLE_DUNGEON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "content", "dungeons");

describe("loadDungeonContent tolerates absence", () => {
  it("a missing dir loads as no dungeons", () => {
    const c = loadDungeonContent("/tmp/fix-dungeons-missing");
    assert.deepEqual(c.entrances, {});
    assert.deepEqual(c.rules, DEFAULT_INSTANCE_RULES);
    assert.deepEqual(c, EMPTY_DUNGEON_CONTENT);
  });

  it("an empty dir loads as no dungeons", () => {
    const c = loadDungeonContent("/tmp/fix-dungeons-empty");
    assert.deepEqual(c.entrances, {});
  });

  it("a half-present dir fails loud naming the missing file", () => {
    assert.throws(() => loadDungeonContent("/tmp/fix-dungeons-half"), /entrances\.json/);
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadDungeonContent("/tmp/fix-dungeons-bad"), SyntaxError);
  });

  it("the sample pack still loads when present", () => {
    const c = loadDungeonContent(SAMPLE_DUNGEON_DIR);
    assert.ok(Object.keys(c.entrances).length > 0, "the sample content/dungeons has entrances");
  });
});
