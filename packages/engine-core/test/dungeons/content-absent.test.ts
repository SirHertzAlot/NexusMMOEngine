/**
 * Dungeon content tolerates absence: a missing dungeon dir is "no dungeons",
 * not a boot failure. A half-present dir fails loud; a present but invalid
 * file still fails loud.
 *
 * Fixtures are made in temp dirs by the tests themselves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fixtureDir, missingDir, repoContentDir } from "../support/fixture-dir.js";
import {
  DEFAULT_INSTANCE_RULES,
  EMPTY_DUNGEON_CONTENT,
  loadDungeonContent,
} from "../../src/dungeons/content.js";

// The sample pack, found from this test file whether it runs from src/ or dist/.
const SAMPLE_DUNGEON_DIR = repoContentDir(dirname(fileURLToPath(import.meta.url)), "dungeons");

describe("loadDungeonContent tolerates absence", () => {
  it("a missing dir loads as no dungeons", () => {
    const c = loadDungeonContent(missingDir());
    assert.deepEqual(c.entrances, {});
    assert.deepEqual(c.rules, DEFAULT_INSTANCE_RULES);
    assert.deepEqual(c, EMPTY_DUNGEON_CONTENT);
  });

  it("an empty dir loads as no dungeons", () => {
    const c = loadDungeonContent(fixtureDir());
    assert.deepEqual(c.entrances, {});
  });

  it("a half-present dir fails loud naming the missing file", () => {
    assert.throws(() => loadDungeonContent(fixtureDir({ "instances.json": "{}" })), /entrances\.json/);
  });

  it("a present but invalid file still fails loud", () => {
    assert.throws(() => loadDungeonContent(fixtureDir({ "instances.json": "{}", "entrances.json": "{ not json" })), SyntaxError);
  });

  it("the sample pack still loads when present", () => {
    const c = loadDungeonContent(SAMPLE_DUNGEON_DIR);
    assert.ok(Object.keys(c.entrances).length > 0, "the sample content/dungeons has entrances");
  });
});
