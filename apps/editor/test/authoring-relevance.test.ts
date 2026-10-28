import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRelevance, makeFacts, sceneLevelWidgets } from "../src/authoring/index.js";

/** The blacksmith: vendor NPC with a character record, a body, a creature kind and quests. */
const blacksmith = makeFacts({
  id: "npc-mara",
  label: "Blacksmith Mara",
  kind: "npc",
  components: ["Transform", "CharacterRef", "Health", "Stamina", "NavAgent"],
  isVendor: true,
  vendorTemplateId: "weapons-tier2",
  creatureKind: "human",
  isQuestGiver: true,
  questIds: ["q-forge-1"],
  hasCollider: true,
});

describe("relevance (audit §5)", () => {
  it("summons vendor + character + combat + creature + quest widgets for the blacksmith", () => {
    const ids = evaluateRelevance(blacksmith).applied.map((w) => w.widgetId);
    for (const want of ["vendor", "character", "combat", "creature", "quests"]) {
      assert.ok(ids.includes(want), `expected widget ${want}, got ${ids.join(",")}`);
    }
  });

  it("merges the character/characters pair into one widget with Sheet + Records tabs", () => {
    const applied = evaluateRelevance(blacksmith).applied;
    const chars = applied.filter((w) => w.widgetId === "character");
    assert.equal(chars.length, 1);
    assert.deepEqual(chars[0].tabs, ["Sheet", "Records"]);
    assert.deepEqual(chars[0].rules, [2, 12]);
  });

  it("merges the quests/story pair into one widget with Quests + Dialogue tabs", () => {
    const applied = evaluateRelevance(blacksmith).applied;
    const quests = applied.filter((w) => w.widgetId === "quests");
    assert.equal(quests.length, 1);
    assert.deepEqual(quests[0].tabs, ["Quests", "Dialogue"]);
    assert.deepEqual(quests[0].rules, [7, 16]);
  });

  it("a rock summons only transform + physics", () => {
    const rock = makeFacts({ id: "rock-1", label: "Boulder", kind: "rock", components: ["Transform"], hasCollider: true });
    assert.deepEqual(
      evaluateRelevance(rock).applied.map((w) => w.widgetId),
      ["transform", "physics"],
    );
  });

  it("a world-item prop summons the items widget; a character summons bag instead", () => {
    const coin = makeFacts({ id: "item-1", label: "Gold coin", kind: "prop", components: ["Transform", "WorldItem"] });
    const items = evaluateRelevance(coin).applied.find((w) => w.widgetId === "items");
    assert.equal(items?.title, "Item");
    const bag = evaluateRelevance(blacksmith).applied.find((w) => w.widgetId === "items");
    assert.equal(bag?.title, "Bag");
  });

  it("markers make flow, vfx and audio widgets appear (rules 13, 17, 11)", () => {
    const fountain = makeFacts({
      id: "fountain-1",
      label: "Fountain",
      kind: "structure",
      components: ["Transform", "FlowRef", "VfxEmitter", "AudioEmitter"],
      flowRef: "fountain-loop",
      vfxEmitter: "splash",
      audioEmitter: "water-loop",
    });
    const ids = evaluateRelevance(fountain).applied.map((w) => w.widgetId);
    assert.ok(ids.includes("flow") && ids.includes("vfx") && ids.includes("audio"), ids.join(","));
  });

  it("intent and dungeons fire on their own facts (rules 9, 8)", () => {
    const player = makeFacts({ id: "p1", label: "Player", kind: "player", components: ["Transform", "PlayerIntent"] });
    assert.ok(evaluateRelevance(player).applied.some((w) => w.widgetId === "intent"));
    const gate = makeFacts({ id: "gate-1", label: "Old Gate", kind: "dungeon-entrance", components: ["Transform"], isDungeonEntrance: true });
    assert.ok(evaluateRelevance(gate).applied.some((w) => w.widgetId === "dungeons"));
  });

  it("chat, hud and scenes are scene-level only — never on an object selection", () => {
    const result = evaluateRelevance(blacksmith);
    const modules = result.applied.flatMap((w) => w.modules);
    for (const m of ["chat", "hud", "scenes", "sample-heartbeat"] as const) assert.ok(!modules.includes(m), m);
    assert.deepEqual(result.sceneLevelOnly, ["chat", "hud", "scenes"]);
    assert.deepEqual(
      sceneLevelWidgets().map((w) => w.widgetId),
      ["scenes", "chat", "hud", "audio"],
    );
  });
});
