/**
 * Crafting gateway extension: Zod-validated execution of crafting actions.
 *
 * Fail closed — a malformed message is answered with a notice and never
 * reaches the crafting systems. Execution is check-then-act inside one
 * synchronous block: recipe, mastery, materials, bag room, then consume
 * and grant. Nothing is consumed unless the whole craft can complete.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CraftingService, CraftMessageSchema } from "../src/crafting/crafting-service.js";
import type { ExtensionPlayer } from "../src/net/extension.js";
import type { EntityBundle } from "@mmo-engine/compose";
import type { CraftingRules, Recipe } from "@mmo-engine/crafting";

const BUNDLE = {
  Identity: { id: "sword", name: "Sword", base: "sword", kind: "item" },
} as unknown as EntityBundle;
const RECIPE: Recipe = {
  item: "sword",
  skill: "Smithing",
  mastery: 0.2,
  inputs: { "iron-ore": 3, coal: 1 },
  tier: 1,
};
/** Minimal rules: unused when deriveRecipe is faked, but required by the options type. */
const RULES: CraftingRules = {
  version: 1,
  refining: {},
  reagents: {},
  fallbackReagent: "arcane-dust",
  runeStone: "rune-stone",
  fittings: [],
  units: [],
  defaultUnits: 1,
  skills: [],
  defaultSkill: "Smithing",
};

interface Calls {
  taken: [string, number][];
  granted: [string, string][];
  sent: object[];
}

interface Overrides {
  composeItem?: (item: string, rank: string) => EntityBundle;
  deriveRecipe?: (bundle: EntityBundle) => Recipe;
  masteryOf?: (entity: number, skill: string) => number;
  countMaterial?: (character: number, material: string) => number;
  takeMaterial?: (character: number, material: string, qty: number) => boolean;
  hasBagRoom?: (character: number) => boolean;
  grantItem?: (character: number, item: string, rank: string) => boolean;
}

function harness(over: Overrides = {}): { svc: CraftingService; calls: Calls } {
  const calls: Calls = { taken: [], granted: [], sent: [] };
  const svc = new CraftingService({
    rules: RULES,
    composeItem: () => BUNDLE,
    deriveRecipe: () => RECIPE,
    masteryOf: () => 1,
    countMaterial: () => 99,
    takeMaterial: (c, m, q) => {
      calls.taken.push([m, q]);
      return true;
    },
    hasBagRoom: () => true,
    grantItem: (c, item, rank) => {
      calls.granted.push([item, rank]);
      return true;
    },
    ...over,
  });
  return { svc, calls };
}

function player(sent: object[], characterId: number | null = 7): ExtensionPlayer {
  return {
    characterId,
    username: "tester",
    name: "Tester",
    entity: () => 42,
    send: (msg) => {
      sent.push(msg);
    },
    refreshInventory: () => {},
  };
}

const craft = { kind: "craft", op: "craft", item: "sword", rank: "common" };
const recipe = { kind: "craft", op: "recipe", item: "sword", rank: "common" };

describe("CraftMessageSchema", () => {
  it("accepts craft and recipe requests", () => {
    assert.ok(CraftMessageSchema.safeParse(craft).success);
    assert.ok(CraftMessageSchema.safeParse(recipe).success);
  });

  it("rejects malformed wire messages", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "craft",
      {},
      { kind: "craft" },
      { kind: "craft", op: "dance", item: "sword", rank: "common" },
      { kind: "craft", op: "craft", rank: "common" },
      { kind: "craft", op: "craft", item: "sword" },
      { kind: "craft", op: "craft", item: "SWORD", rank: "common" },
      { kind: "craft", op: "craft", item: "sword;drop", rank: "common" },
      { kind: "craft", op: "craft", item: "x".repeat(65), rank: "common" },
      { kind: "quest", op: "craft", item: "sword", rank: "common" },
    ];
    for (const m of bad) assert.equal(CraftMessageSchema.safeParse(m).success, false, JSON.stringify(m));
  });
});

describe("CraftingService.onMessage", () => {
  it("kind is craft", () => {
    const { svc } = harness();
    assert.equal(svc.kind, "craft");
  });

  it("fail closed: malformed messages are noticed and never reach the crafting systems", () => {
    const bad: unknown[] = [null, {}, { kind: "craft", op: "craft", item: "SWORD", rank: "common" }];
    for (const m of bad) {
      let composed = false;
      const { svc, calls } = harness({
        composeItem: () => {
          composed = true;
          return BUNDLE;
        },
      });
      svc.onMessage(player(calls.sent), m);
      assert.equal(composed, false);
      assert.equal(calls.taken.length, 0);
      assert.equal(calls.granted.length, 0);
      assert.equal(calls.sent.length, 1);
      assert.match((calls.sent[0] as { text: string }).text, /malformed|character/);
    }
  });

  it("needs a character: account-only players are turned away", () => {
    const { svc, calls } = harness();
    svc.onMessage(player(calls.sent, null), craft);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.match((calls.sent[0] as { text: string }).text, /character/);
  });

  it("recipe op answers the recipe without touching the world", () => {
    const { svc, calls } = harness();
    svc.onMessage(player(calls.sent), recipe);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.deepEqual(calls.sent[0], {
      kind: "craft",
      op: "recipe",
      item: "sword",
      rank: "common",
      skill: "Smithing",
      mastery: 0.2,
      inputs: { "iron-ore": 3, coal: 1 },
      tier: 1,
    });
  });

  it("craft consumes materials and grants the item on success", () => {
    const { svc, calls } = harness();
    svc.onMessage(player(calls.sent), craft);
    assert.deepEqual(calls.taken, [
      ["iron-ore", 3],
      ["coal", 1],
    ]);
    assert.deepEqual(calls.granted, [["sword", "common"]]);
    assert.deepEqual(calls.sent[0], { kind: "craft", op: "crafted", item: "sword", rank: "common" });
  });

  it("craft refuses below the recipe's mastery: nothing consumed, nothing granted", () => {
    const { svc, calls } = harness({ masteryOf: () => 0.05 });
    svc.onMessage(player(calls.sent), craft);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.match((calls.sent[0] as { text: string }).text, /Smithing/);
  });

  it("craft refuses when a material is short: nothing consumed, nothing granted", () => {
    const { svc, calls } = harness({ countMaterial: (c, m) => (m === "coal" ? 0 : 99) });
    svc.onMessage(player(calls.sent), craft);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.match((calls.sent[0] as { text: string }).text, /coal/);
  });

  it("craft refuses on a full bag before consuming anything", () => {
    const { svc, calls } = harness({ hasBagRoom: () => false });
    svc.onMessage(player(calls.sent), craft);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.match((calls.sent[0] as { text: string }).text, /bag/);
  });

  it("craft fails closed on an unknown item", () => {
    const { svc, calls } = harness({
      composeItem: () => {
        throw new Error('no item "frobnicate"');
      },
    });
    svc.onMessage(player(calls.sent), { kind: "craft", op: "craft", item: "frobnicate", rank: "common" });
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.equal(calls.sent.length, 1);
  });

  it("craft fails closed when the recipe cannot be derived", () => {
    const { svc, calls } = harness({
      deriveRecipe: () => {
        throw new Error("no refining recipe");
      },
    });
    svc.onMessage(player(calls.sent), craft);
    assert.equal(calls.taken.length, 0);
    assert.equal(calls.granted.length, 0);
    assert.equal(calls.sent.length, 1);
  });

  it("craft aborts without granting when a take fails mid-flight", () => {
    const { svc, calls } = harness({
      takeMaterial: (c, m, q) => {
        calls.taken.push([m, q]);
        return m !== "coal";
      },
    });
    svc.onMessage(player(calls.sent), craft);
    assert.equal(calls.granted.length, 0);
    assert.equal(calls.sent.length, 1);
  });
});

describe("CraftingService defaults", () => {
  it("derives a real recipe through the compose + crafting packages", async () => {
    const { loadCraftingRules } = await import("@mmo-engine/crafting");
    const svc = new CraftingService({
      rules: loadCraftingRules(),
      masteryOf: () => 1,
      countMaterial: () => 99,
      takeMaterial: () => true,
      hasBagRoom: () => true,
      grantItem: () => true,
    });
    const sent: object[] = [];
    svc.onMessage(player(sent), recipe);
    const r = sent[0] as { op: string; skill: string; mastery: number; inputs: Record<string, number> };
    assert.equal(r.op, "recipe");
    assert.equal(typeof r.skill, "string");
    assert.ok(r.mastery >= 0 && r.mastery <= 1);
    assert.ok(Object.keys(r.inputs).length > 0);
  });
});
