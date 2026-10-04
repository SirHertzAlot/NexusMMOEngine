/**
 * Quests (U11): log order, the current step, progress text, change notices,
 * and which npc the interact key talks to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NpcView, QuestStepView, QuestView } from "@mmo-engine/protocol";
import { currentStep, itemTitle, questNotices, sortQuests, stepProgress, stepText } from "../src/ui/quests.js";
import { markerGlyph, nearestNpc } from "../src/render/npc-markers.js";

const step = (text: string, done = false, progress = 0, target = 1): QuestStepView => ({ text, done, progress, target });
const quest = (id: string, state: QuestView["state"], steps: QuestStepView[]): QuestView => ({
  id,
  name: id,
  giver: "Warden Hale",
  giverId: "warden",
  summary: "",
  state,
  steps,
  rewards: [],
});

describe("sortQuests", () => {
  it("puts quests to hand in first and done ones last, keeping the server's order otherwise", () => {
    const qs = [quest("a", "done", []), quest("b", "active", []), quest("c", "ready", []), quest("d", "active", [])];
    assert.deepEqual(sortQuests(qs).map((q) => q.id), ["c", "b", "d", "a"]);
  });
});

describe("currentStep and stepProgress", () => {
  it("finds the step under way and counts only counted steps", () => {
    const q = quest("a", "active", [step("Speak.", true), step("Kill (3).", false, 1, 3)]);
    assert.equal(currentStep(q)?.text, "Kill (3).");
    assert.equal(stepProgress(currentStep(q)!), "1/3");
    assert.equal(stepProgress(step("Go there.")), "");
    assert.equal(currentStep(quest("b", "ready", [step("x", true)])), null);
    assert.equal(stepText(step("Kill the goblins (3).", false, 0, 3)), "Kill the goblins.");
    assert.equal(stepText(step("Speak (1).")), "Speak (1).");
  });
});

describe("itemTitle", () => {
  it("reads an item base as words", () => {
    assert.equal(itemTitle("iron-sword"), "Iron sword");
  });
});

describe("questNotices", () => {
  it("says nothing for the first log on entering", () => {
    assert.deepEqual(questNotices(null, [quest("a", "active", [step("x")])]), []);
  });

  it("announces accepted, next step, counted progress, ready, complete and abandoned", () => {
    const a0 = quest("Goblins", "active", [step("Speak.", true), step("Go to the tower.")]);
    assert.deepEqual(questNotices([], [a0]), ["Quest accepted: Goblins"]);
    const a1 = quest("Goblins", "active", [step("Speak.", true), step("Go to the tower.", true), step("Kill the goblins (3).", false, 0, 3)]);
    assert.deepEqual(questNotices([a0], [a1]), ["Goblins: Kill the goblins (3)."]);
    const a2 = quest("Goblins", "active", [step("Speak.", true), step("Go to the tower.", true), step("Kill the goblins (3).", false, 1, 3)]);
    assert.deepEqual(questNotices([a1], [a2]), ["Kill the goblins 1/3"]);
    const r = quest("Goblins", "ready", a2.steps);
    assert.deepEqual(questNotices([a2], [r]), ["Goblins: return to Warden Hale"]);
    assert.deepEqual(questNotices([r], [quest("Goblins", "done", r.steps)]), ["Quest complete: Goblins"]);
    assert.deepEqual(questNotices([a2], []), ["Quest abandoned: Goblins"]);
  });
});

describe("npc markers", () => {
  const npcs: NpcView[] = [
    { id: "a", name: "A", x: 0, z: 0, marker: "offer" },
    { id: "b", name: "B", x: 3, z: 0, marker: null },
  ];

  it("talks to the nearest npc in range only", () => {
    assert.equal(nearestNpc(npcs, 2.5, 0, 5)?.id, "b");
    assert.equal(nearestNpc(npcs, -1, 0, 5)?.id, "a");
    assert.equal(nearestNpc(npcs, 20, 0, 5), null);
  });

  it("shows ! for a quest to take, ? for one to hand in, nothing otherwise", () => {
    assert.equal(markerGlyph("offer")?.text, "!");
    assert.equal(markerGlyph("ready")?.text, "?");
    assert.equal(markerGlyph(null), null);
  });
});
