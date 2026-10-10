/** story-rename: a quest id changes everywhere it is named, and bad renames are refused. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renameQuestId } from "../src/story-rename.js";
import type { StoryFiles } from "../src/story-validate.js";

const files = (): StoryFiles =>
  ({
    quests: { version: 1, quests: { first: { name: "First" }, second: { name: "Second", after: ["first"] } } },
    dialogs: {
      version: 1,
      dialogs: {
        warden: {
          start: "hi",
          nodes: {
            hi: {
              text: "hi",
              replies: [
                { text: "take it", do: { accept: "first" } },
                { text: "done?", if: { quest: "first" }, do: { complete: "first" } },
                { text: "other", do: { accept: "second" } },
                { text: "board", if: { quest: "board" } },
              ],
            },
          },
        },
      },
    },
    npcs: {},
    steps: {},
  }) as unknown as StoryFiles;

describe("renameQuestId", () => {
  it("renames the key, prerequisites and dialog references, leaving the input alone", () => {
    const input = files();
    const out = renameQuestId(input, "first", "opening") as unknown as {
      quests: { quests: Record<string, { after?: string[] }> };
      dialogs: { dialogs: { warden: { nodes: { hi: { replies: Array<{ if?: { quest: string }; do?: Record<string, string> }> } } } } };
    };
    assert.deepEqual(Object.keys(out.quests.quests), ["opening", "second"]);
    assert.deepEqual(out.quests.quests.second.after, ["opening"]);
    const r = out.dialogs.dialogs.warden.nodes.hi.replies;
    assert.equal(r[0].do?.accept, "opening");
    assert.equal(r[1].if?.quest, "opening");
    assert.equal(r[1].do?.complete, "opening");
    assert.equal(r[2].do?.accept, "second");
    assert.equal(r[3].if?.quest, "board");
    assert.ok("first" in (input.quests as { quests: object }).quests);
  });

  it("refuses unknown, duplicate, same and malformed ids", () => {
    assert.throws(() => renameQuestId(files(), "nope", "x"), /No quest/);
    assert.throws(() => renameQuestId(files(), "first", "second"), /already exists/);
    assert.throws(() => renameQuestId(files(), "first", "first"), /same/);
    assert.throws(() => renameQuestId(files(), "first", "Bad Id"), /lowercase/);
    assert.throws(() => renameQuestId(files(), "first", ""), /lowercase/);
  });
});
