import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateAddShelf, makeFacts, visibleShelf } from "../src/authoring/index.js";

describe("add shelf (establishability)", () => {
  it("a rock's shelf hides the character sheet — never for this kind", () => {
    const rock = makeFacts({ id: "rock-1", label: "Boulder", kind: "rock", components: ["Transform"], hasCollider: true });
    const shelf = evaluateAddShelf(rock);
    const character = shelf.find((e) => e.moduleId === "character");
    assert.equal(character?.verdict, "never");
    assert.equal(character?.action, undefined);
    assert.ok(!visibleShelf(rock).some((e) => e.moduleId === "character"));
    assert.ok(!visibleShelf(rock).some((e) => e.moduleId === "vendor"));
    assert.ok(!visibleShelf(rock).some((e) => e.moduleId === "quests"));
  });

  it("a rock can still gain markers and a collider-free item fixture path", () => {
    const rock = makeFacts({ id: "rock-1", label: "Boulder", kind: "rock", components: ["Transform"] });
    const visible = visibleShelf(rock).map((e) => e.moduleId);
    for (const want of ["flow", "vfx", "audio", "physics", "items"]) assert.ok(visible.includes(want as never), want);
  });

  it("an NPC without combat gets an establishable combat entry whose action adds Health+Stamina", () => {
    const npc = makeFacts({ id: "npc-1", label: "Fisher", kind: "npc", components: ["Transform", "CharacterRef"] });
    const combat = evaluateAddShelf(npc).find((e) => e.moduleId === "combat");
    assert.equal(combat?.verdict, "establishable");
    assert.deepEqual(combat?.action?.addComponents, ["Health", "Stamina"]);
  });

  it("an NPC without a vendor gets a one-click attachVendor verb action", () => {
    const npc = makeFacts({ id: "npc-1", label: "Fisher", kind: "npc", components: ["Transform", "CharacterRef"] });
    const vendor = evaluateAddShelf(npc).find((e) => e.moduleId === "vendor");
    assert.equal(vendor?.verdict, "establishable");
    assert.equal(vendor?.action?.verb, "attachVendor");
    assert.equal(vendor?.action?.params?.entity, "npc-1");
  });

  it("applied modules never appear on the shelf", () => {
    const blacksmith = makeFacts({
      id: "npc-mara",
      label: "Blacksmith Mara",
      kind: "npc",
      components: ["Transform", "CharacterRef", "Health", "Stamina"],
      isVendor: true,
      creatureKind: "human",
      isQuestGiver: true,
    });
    const ids = evaluateAddShelf(blacksmith).map((e) => e.moduleId);
    for (const applied of ["vendor", "character", "combat", "creatures", "quests"]) assert.ok(!ids.includes(applied as never), applied);
  });
});
