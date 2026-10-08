/**
 * Quest gold rewards (EC1): the content schema accepts `gold` on rewards,
 * and it flows through to the concrete quest definition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkQuestContent, type QuestContent } from "../../src/quests/content.js";
import { authoredQuest } from "../../src/quests/quest-def.js";

const content = {
  npcs: {
    warden: { name: "Warden", x: 0, z: 0, places: [], dialog: "warden", board: [] },
  },
  places: {},
  steps: {
    s1: { stage: "hook", text: "Talk.", objective: { type: "talk", npc: "warden" }, weight: 1, gives: [], needs: [], excludes: [] },
  },
  stages: ["hook"],
  templates: {},
  quests: {
    "gold-job": {
      name: "Gold Job",
      giver: "warden",
      summary: "Do the thing.",
      steps: [{ id: "s1", text: "Talk.", objective: { type: "talk", npc: "warden" } }],
      rewards: [
        { base: "dagger", count: 1, gold: 150 },
        { base: "sword", count: 2 },
      ],
      repeatable: false,
      after: [],
    },
  },
  dialogs: {
    warden: {
      start: "hello",
      nodes: {
        hello: { text: "Hi.", replies: [{ text: "Bye.", next: "bye" }] },
        bye: { text: "Bye.", replies: [] },
      },
    },
  },
} as unknown as QuestContent;

describe("quest gold rewards", () => {
  it("content with gold rewards validates clean", () => {
    const problems = checkQuestContent(content);
    assert.deepEqual(problems, [], `expected no problems, got: ${problems.join(" | ")}`);
  });

  it("gold flows through to the concrete quest def", () => {
    const def = authoredQuest(content, "gold-job");
    assert.deepEqual(def.rewards, [
      { base: "dagger", count: 1, gold: 150 },
      { base: "sword", count: 2 },
    ]);
  });
});
