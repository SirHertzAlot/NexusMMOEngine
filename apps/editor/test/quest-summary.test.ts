/** Quests workspace: the summary of the real quests document, tolerant of a half-edited one. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { objectiveLabel, summarizeQuests } from "../src/quest-summary.js";

const QUESTS = {
  version: 1,
  quests: {
    a: { name: "A", giver: "warden", summary: "s", steps: [{ id: "x", text: "Do x", objective: { type: "kill", kind: "goblin", count: 3 } }], rewards: [{ base: "sword", count: 2 }], after: ["b"] },
    broken: { name: "no steps" },
  },
};

describe("quest summary", () => {
  it("labels objectives", () => {
    assert.equal(objectiveLabel({ type: "kill", kind: "goblin", count: 3 }), "kill goblin ×3");
    assert.equal(objectiveLabel({ type: "talk", npc: "warden" }), "talk warden");
    assert.equal(objectiveLabel({}), "?");
  });
  it("summarizes quests with the giver's name and skips rows it cannot read", () => {
    const rows = summarizeQuests(QUESTS, { npcs: { warden: { name: "Warden Hale" } } });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].giverName, rows[0].rewards, rows[0].after, rows[0].steps[0].objective], ["Warden Hale", "sword ×2", ["b"], "kill goblin ×3"]);
  });
  it("reads nothing from nonsense", () => {
    assert.deepEqual(summarizeQuests(null, 3), []);
  });
  it("reads the shipped content/quests files", () => {
    const read = (f: string): unknown => JSON.parse(readFileSync(new URL(`../../../../content/quests/${f}`, import.meta.url), "utf8")) as unknown;
    const rows = summarizeQuests(read("quests.json"), read("npcs.json"));
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.steps.length > 0));
  });
});
