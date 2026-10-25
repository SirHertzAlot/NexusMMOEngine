import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWidgets,
  inputValue,
  makeFacts,
  makeVerbCall,
  parseInputNumber,
  parseVendorTemplateList,
  planDispatch,
  shelfActionParams,
  visibleShelf,
  type SelectionFacts,
  type WidgetAction,
} from "../src/authoring/index.js";

const opts = {
  actor: { id: "joey", role: "designer" as const },
  why: "input fields",
  where: "Haven / Market Square",
  when: 1_800_000_000_000,
};

const blacksmith: SelectionFacts = makeFacts({
  id: "npc-mara",
  label: "Blacksmith Mara",
  kind: "npc",
  components: ["Transform", "CharacterRef", "Health"],
  isVendor: true,
  vendorTemplateId: "weapons-tier2",
  isQuestGiver: true,
  questIds: ["q-forge-1"],
  hasCollider: true,
  position: { x: 12, z: -4 },
});

const action = (facts: SelectionFacts, widgetId: string, actionId: string): WidgetAction => {
  const w = buildWidgets(facts, opts).find((x) => x.widgetId === widgetId);
  const a = w?.actions.find((x) => x.id === actionId);
  assert.ok(a, `${widgetId}/${actionId} should exist`);
  return a;
};

describe("input descriptors — actions declare their fields as data", () => {
  it("give-item declares an item-bases picker; give-gold a number amount", () => {
    const giveItem = action(blacksmith, "character", "give-item");
    assert.deepEqual(
      giveItem.inputs.map((i) => [i.id, i.kind, i.source]),
      [["base", "picker", "item-bases"]],
    );
    const giveGold = action(blacksmith, "character", "give-gold");
    assert.deepEqual(
      giveGold.inputs.map((i) => [i.id, i.kind]),
      [["amount", "number"]],
    );
  });

  it("grant-reward reuses the give inputs: an item-base picker plus a gold number", () => {
    const grant = action(blacksmith, "quests", "grant-reward");
    assert.deepEqual(
      grant.inputs.map((i) => [i.id, i.kind, i.source]),
      [
        ["base", "picker", "item-bases"],
        ["gold", "number", undefined],
      ],
    );
  });

  it("change-template declares a vendor-templates picker prefilled with the current template", () => {
    const change = action(blacksmith, "vendor", "change-template");
    assert.equal(change.inputs[0].source, "vendor-templates");
    assert.equal(change.inputs[0].initial, "weapons-tier2");
  });

  it("spawn-pack declares a creature-kinds picker prefilled with the creature's kind", () => {
    const goblin = makeFacts({ id: "mob-1", label: "Goblin", kind: "creature", components: ["Transform"], creatureKind: "goblin" });
    const spawn = action(goblin, "creature", "spawn-pack");
    assert.equal(spawn.inputs[0].source, "creature-kinds");
    assert.equal(spawn.inputs[0].initial, "goblin");
  });

  it("teleport declares x/z numbers prefilled from the selection's Transform position", () => {
    const tp = action(blacksmith, "physics", "teleport");
    assert.deepEqual(
      tp.inputs.map((i) => [i.id, i.kind, i.initial]),
      [
        ["x", "number", "12"],
        ["z", "number", "-4"],
      ],
    );
  });

  it("actions with nothing to fill declare no inputs (detach fires as-is)", () => {
    assert.deepEqual(action(blacksmith, "vendor", "detach").inputs, []);
  });
});

describe("param building — filled inputs produce dispatchable plans via the real mapper", () => {
  it("giveItem: a chosen base → admin give {base}; the call targets the console holder, stated on the action", () => {
    const giveItem = action(blacksmith, "character", "give-item");
    const call = giveItem.callWith({ base: "sword" });
    assert.equal(call.params.character, "me");
    assert.match(giveItem.note ?? "", /console holder/);
    assert.deepEqual(planDispatch(call), { kind: "admin", verb: "giveItem", command: "give", args: { base: "sword" } });
  });

  it("giveGold: a typed amount → admin gold; junk and negatives are the mapper's refusal, not the parser's", () => {
    const giveGold = action(blacksmith, "character", "give-gold");
    assert.deepEqual(planDispatch(giveGold.callWith({ amount: "250" })), { kind: "admin", verb: "giveGold", command: "gold", args: { amount: 250 } });
    for (const raw of ["abc", "-5", "2.5"]) {
      const plan = planDispatch(giveGold.callWith({ amount: raw }));
      assert.equal(plan.kind, "unsupported", `amount ${raw}`);
      if (plan.kind === "unsupported") assert.match(plan.reason, /positive integer/);
    }
  });

  it("grantQuestReward: item + gold inputs compose into the mapper's give + gold steps, in order", () => {
    const grant = action(blacksmith, "quests", "grant-reward");
    const plan = planDispatch(grant.callWith({ base: "sword", gold: "50" }));
    assert.equal(plan.kind, "composite");
    if (plan.kind === "composite") {
      assert.deepEqual(plan.steps, [
        { command: "give", args: { base: "sword" } },
        { command: "gold", args: { amount: 50 } },
      ]);
    }
    // Gold alone is a valid reward too.
    const goldOnly = planDispatch(grant.callWith({ gold: "25" }));
    assert.equal(goldOnly.kind, "composite");
    if (goldOnly.kind === "composite") assert.deepEqual(goldOnly.steps, [{ command: "gold", args: { amount: 25 } }]);
  });

  it("attachVendor: the prefill alone dispatches (re-attach current); a chosen template replaces it", () => {
    const change = action(blacksmith, "vendor", "change-template");
    assert.deepEqual(planDispatch(change.call), {
      kind: "admin",
      verb: "attachVendor",
      command: "vendor",
      args: { sub: "attach", id: "weapons-tier2", target: "npc-mara" },
    });
    const plan = planDispatch(change.callWith({ templateId: "general-store" }));
    assert.deepEqual(plan, { kind: "admin", verb: "attachVendor", command: "vendor", args: { sub: "attach", id: "general-store", target: "npc-mara" } });
  });

  it("spawnPack: a chosen kind → admin spawn {asset} with no invented 0,0 position", () => {
    const goblin = makeFacts({ id: "mob-1", label: "Goblin", kind: "creature", components: ["Transform"], creatureKind: "goblin" });
    const spawn = action(goblin, "creature", "spawn-pack");
    assert.deepEqual(planDispatch(spawn.callWith({ kind: "wolf" })), { kind: "admin", verb: "spawnPack", command: "spawn", args: { asset: "wolf" } });
    // The prefill (the creature's own kind) dispatches untouched.
    assert.deepEqual(planDispatch(spawn.call), { kind: "admin", verb: "spawnPack", command: "spawn", args: { asset: "goblin" } });
  });

  it("teleport: prefilled from Transform, editable — typed values win", () => {
    const tp = action(blacksmith, "physics", "teleport");
    assert.deepEqual(planDispatch(tp.call), { kind: "admin", verb: "teleport", command: "teleport", args: { x: 12, z: -4, entity: "npc-mara" } });
    assert.deepEqual(planDispatch(tp.callWith({ x: "100", z: "200" })), { kind: "admin", verb: "teleport", command: "teleport", args: { x: 100, z: 200, entity: "npc-mara" } });
  });

  it("the dungeon entrance's give-item reward takes the same item picker", () => {
    const entrance = makeFacts({ id: "gate-1", label: "Sunken Gate", kind: "dungeon-entrance", components: ["Transform"], isDungeonEntrance: true });
    const give = action(entrance, "dungeons", "grant-reward");
    assert.equal(give.inputs[0].source, "item-bases");
    assert.deepEqual(planDispatch(give.callWith({ base: "key" })), { kind: "admin", verb: "giveItem", command: "give", args: { base: "key" } });
  });
});

describe("param building — empty inputs keep the mapper's refusal (the gate does not move)", () => {
  const unsupportedReason = (a: WidgetAction, values: Record<string, string> = {}): string => {
    const plan = planDispatch(a.callWith(values));
    assert.equal(plan.kind, "unsupported");
    return plan.kind === "unsupported" ? plan.reason : "";
  };

  it("giveItem with no base chosen: no item chosen", () => {
    assert.match(unsupportedReason(action(blacksmith, "character", "give-item")), /no item chosen/);
  });

  it("giveGold with no amount: positive integer", () => {
    assert.match(unsupportedReason(action(blacksmith, "character", "give-gold")), /positive integer/);
  });

  it("grantQuestReward with neither item nor gold: non-empty rewards", () => {
    assert.match(unsupportedReason(action(blacksmith, "quests", "grant-reward")), /non-empty rewards/);
  });

  it("attachVendor on a vendor with no current template and none chosen: template", () => {
    const bare = makeFacts({ id: "npc-2", label: "Stall keeper", kind: "npc", components: ["Transform"], isVendor: true });
    assert.match(unsupportedReason(action(bare, "vendor", "change-template")), /template/i);
  });

  it("spawnPack with the kind cleared: no spawn kind (never a silent 0,0 spawn)", () => {
    const goblin = makeFacts({ id: "mob-1", label: "Goblin", kind: "creature", components: ["Transform"], creatureKind: "goblin" });
    assert.match(unsupportedReason(action(goblin, "creature", "spawn-pack"), { kind: "" }), /no spawn kind/);
  });

  it("teleport with no position known and none typed: explicit x and z (never origin)", () => {
    const rock = makeFacts({ id: "rock-1", label: "Rock", kind: "prop", components: ["Transform"], hasCollider: true });
    const tp = action(rock, "physics", "teleport");
    assert.deepEqual(tp.call.params, { entity: "rock-1" });
    assert.match(unsupportedReason(tp), /explicit x and z/);
    assert.match(unsupportedReason(tp, { x: "", z: "" }), /explicit x and z/);
  });
});

describe("shelf actions — inputs on the verb-shaped entries", () => {
  const mara = makeFacts({ id: "npc-mara", label: "Mara", kind: "npc", components: ["Transform", "CharacterRef"] });

  it("Add vendor declares the vendor-templates picker; shelfActionParams fills templateId only when chosen", () => {
    const entry = visibleShelf(mara).find((e) => e.moduleId === "vendor");
    assert.ok(entry?.action);
    assert.equal(entry.action.inputs?.[0].source, "vendor-templates");
    const empty = shelfActionParams(entry.action, {});
    assert.equal(empty.templateId, "");
    const planEmpty = planDispatch(makeVerbCall("attachVendor", empty, { who: { id: "joey", role: "designer" }, what: "Mara", when: 1, where: "Haven", why: "shelf" }));
    assert.equal(planEmpty.kind, "unsupported");
    const filled = shelfActionParams(entry.action, { templateId: "general-store" });
    assert.deepEqual(filled, { entity: "npc-mara", templateId: "general-store" });
    const plan = planDispatch(makeVerbCall("attachVendor", filled, { who: { id: "joey", role: "designer" }, what: "Mara", when: 1, where: "Haven", why: "shelf" }));
    assert.deepEqual(plan, { kind: "admin", verb: "attachVendor", command: "vendor", args: { sub: "attach", id: "general-store", target: "npc-mara" } });
  });

  it("Spawn creature (spawner shelf) declares the creature-kinds picker and drops the 0,0 placeholder", () => {
    const spawner = makeFacts({ id: "sp-1", label: "Goblin spawner", kind: "prop", components: ["Transform", "Spawner"] });
    const entry = visibleShelf(spawner).find((e) => e.moduleId === "creatures");
    assert.ok(entry?.action);
    assert.equal(entry.action.inputs?.[0].source, "creature-kinds");
    assert.deepEqual(shelfActionParams(entry.action, {}), { kind: "" });
    assert.deepEqual(shelfActionParams(entry.action, { kind: "goblin" }), { kind: "goblin" });
  });
});

describe("input helpers", () => {
  it("parseInputNumber: blank and junk are undefined (the mapper decides), numbers parse", () => {
    assert.equal(parseInputNumber(""), undefined);
    assert.equal(parseInputNumber("  "), undefined);
    assert.equal(parseInputNumber("abc"), undefined);
    assert.equal(parseInputNumber(undefined), undefined);
    assert.equal(parseInputNumber(" 12 "), 12);
    assert.equal(parseInputNumber("-4"), -4);
    assert.equal(parseInputNumber("2.5"), 2.5);
  });

  it("inputValue: a typed value wins, then the descriptor prefill, then empty", () => {
    const input = { id: "x", label: "X", kind: "number" as const, initial: "12" };
    assert.equal(inputValue({ x: "99" }, input), "99");
    assert.equal(inputValue({ x: "" }, input), ""); // cleared on purpose — not the prefill
    assert.equal(inputValue({}, input), "12");
    assert.equal(inputValue({}, { id: "y", label: "Y", kind: "text" as const }), "");
  });

  it("parseVendorTemplateList reads the gateway's list answer; anything else is an empty list", () => {
    assert.deepEqual(parseVendorTemplateList("vendors: general-store, weapons-tier2"), ["general-store", "weapons-tier2"]);
    assert.deepEqual(parseVendorTemplateList("vendors: solo"), ["solo"]);
    assert.deepEqual(parseVendorTemplateList("no vendors defined"), []);
    assert.deepEqual(parseVendorTemplateList("unknown vendor template"), []);
    assert.deepEqual(parseVendorTemplateList(""), []);
  });
});
