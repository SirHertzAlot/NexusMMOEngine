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
import Database from "better-sqlite3";
import { GatheringSystem, SqliteGatheringStore } from "../src/gathering/index.js";

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
    const { loadCraftingRules, EMPTY_CRAFTING_RULES } = await import("@mmo-engine/crafting");
    const svc = new CraftingService({
      rules: loadCraftingRules() ?? EMPTY_CRAFTING_RULES,
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

describe("CraftingService on the gathering pouch", () => {
  /** Wired as server.ts wires it: the gathering pouch is the craft's material source, written through to gathering.db. */
  function onPouch(pouch: Record<string, number>, atomicCraft?: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    const store = new SqliteGatheringStore(new Database(":memory:"));
    for (const [m, n] of Object.entries(pouch)) store.savePouch(7, m, n);
    const gathering = new GatheringSystem({ store });
    const granted: string[] = [];
    const svc = new CraftingService({
      rules: RULES,
      composeItem: () => BUNDLE,
      deriveRecipe: () => RECIPE,
      masteryOf: () => 1,
      countMaterial: (c, m) => gathering.countOf(c, m),
      takeMaterial: (c, m, q) => gathering.take(c, m, q),
      hasBagRoom: () => true,
      grantItem: (_c, item) => (granted.push(item), true),
      ...(atomicCraft
        ? {
            atomicCraft: { craft: atomicCraft },
            defOfItem: () => 1,
            allocateItem: () => 5,
            discardItem: () => {},
            itemInBag: () => true,
          }
        : {}),
    });
    return { svc, store, gathering, granted };
  }

  it("a craft takes the inputs from the pouch (and gathering.db) and delivers the item", () => {
    const { svc, store, gathering, granted } = onPouch({ "iron-ore": 5, coal: 1 });
    const sent: object[] = [];
    svc.onMessage(player(sent), craft);
    assert.deepEqual(sent, [{ kind: "craft", op: "crafted", item: "sword", rank: "common" }]);
    assert.deepEqual(granted, ["sword"]);
    assert.equal(gathering.countOf(7, "iron-ore"), 2);
    assert.deepEqual(store.loadPouch(7), { "iron-ore": 2, coal: 0 }, "written through for PL3b's world sync");
    assert.deepEqual(gathering.pouchMessage(7).materials.map((m) => [m.material, m.count]), [["iron-ore", 2]]);
  });

  it("a craft short of materials fails and changes nothing", () => {
    const { svc, store, granted } = onPouch({ "iron-ore": 2, coal: 1 });
    const sent: object[] = [];
    svc.onMessage(player(sent), craft);
    assert.equal((sent[0] as { text: string }).text, "you need 3x iron-ore");
    assert.deepEqual(granted, []);
    assert.deepEqual(store.loadPouch(7), { "iron-ore": 2, coal: 1 });
  });

  it("fleet: the pouch is debited only once the world commits", async () => {
    const ok = onPouch({ "iron-ore": 3, coal: 1 }, async () => ({ ok: true }));
    const sent: object[] = [];
    ok.svc.onMessage(player(sent), craft);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [{ kind: "craft", op: "crafted", item: "sword", rank: "common" }]);
    assert.deepEqual(ok.store.loadPouch(7), { "iron-ore": 0, coal: 0 });

    const refused = onPouch({ "iron-ore": 3, coal: 1 }, async () => ({ ok: false, message: "no" }));
    refused.svc.onMessage(player(sent), craft);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(refused.store.loadPouch(7), { "iron-ore": 3, coal: 1 });
  });
});

describe("GatheringSystem.take", () => {
  it("refuses more than the pouch holds, and bad quantities, without changing it", () => {
    const g = new GatheringSystem();
    assert.equal(g.take(7, "iron-ore", 1), false);
    assert.equal(g.take(7, "iron-ore", -1), false);
    assert.equal(g.take(7, "iron-ore", 0.5), false);
    assert.equal(g.countOf(7, "iron-ore"), 0);
  });
});
