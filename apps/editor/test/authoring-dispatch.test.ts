import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeDispatch,
  executePlan,
  fieldEditPlan,
  fieldEditTarget,
  inspectTargetForCall,
  makeVerbCall,
  planDispatch,
  removeComponentPlan,
  shelfComponentPlan,
  vendorStockPlan,
  type DispatchTransport,
  type Provenance,
  type VerbCall,
} from "../src/authoring/index.js";

const prov: Provenance = {
  who: { id: "joey", role: "designer" },
  what: "Blacksmith Mara",
  when: 1_800_000_000_000,
  where: "Haven / Market Square / Blacksmith Mara",
  why: "hand tweak",
};

const call = (verb: string, params: Record<string, unknown>): VerbCall => makeVerbCall(verb, params, prov);

describe("dispatch mapper — verbs with a real admin home", () => {
  it("giveItem with a def id for the console holder maps to admin give {def}", () => {
    assert.deepEqual(planDispatch(call("giveItem", { character: "me", def: "abc123" })), {
      kind: "admin", verb: "giveItem", command: "give", args: { def: "abc123" },
    });
  });

  it("giveItem with a base/rank pick maps to admin give {base, rank}", () => {
    assert.deepEqual(planDispatch(call("giveItem", { base: "sword", rank: "rare" })), {
      kind: "admin", verb: "giveItem", command: "give", args: { base: "sword", rank: "rare" },
    });
  });

  it("giveGold with a positive integer maps to admin gold", () => {
    assert.deepEqual(planDispatch(call("giveGold", { character: "me", amount: 250 })), {
      kind: "admin", verb: "giveGold", command: "gold", args: { amount: 250 },
    });
  });

  it("spawnCreature and its spawnPack alias map to admin spawn {asset, x, z}", () => {
    const want = { kind: "admin", command: "spawn", args: { asset: "goblin", x: 10, z: -4 } };
    assert.deepEqual(planDispatch(call("spawnCreature", { kind: "goblin", x: 10, z: -4 })), { ...want, verb: "spawnCreature" });
    assert.deepEqual(planDispatch(call("spawnPack", { kind: "goblin", x: 10, z: -4 })), { ...want, verb: "spawnPack" });
  });

  it("teleport maps to admin teleport; a missing entity leaves the gateway's own default (the caller)", () => {
    assert.deepEqual(planDispatch(call("teleport", { entity: "12345", x: 1, z: 2 })), {
      kind: "admin", verb: "teleport", command: "teleport", args: { x: 1, z: 2, entity: "12345" },
    });
    assert.deepEqual(planDispatch(call("teleport", { x: 1, z: 2 })), {
      kind: "admin", verb: "teleport", command: "teleport", args: { x: 1, z: 2 },
    });
  });

  it("attachVendor maps to vendor {sub: attach, id, target}; detachVendor alias to vendor {sub: detach, target}", () => {
    assert.deepEqual(planDispatch(call("attachVendor", { entity: "12345", templateId: "weapons-tier2" })), {
      kind: "admin", verb: "attachVendor", command: "vendor", args: { sub: "attach", id: "weapons-tier2", target: "12345" },
    });
    assert.deepEqual(planDispatch(call("detachVendor", { entity: "12345" })), {
      kind: "admin", verb: "detachVendor", command: "vendor", args: { sub: "detach", target: "12345" },
    });
  });

  it("resolveBase is a READ routed to the items command (the read that answers it)", () => {
    assert.deepEqual(planDispatch(call("resolveBase", { base: "sword" })), {
      kind: "read", verb: "resolveBase", command: "items", args: { base: "sword" },
    });
    assert.deepEqual(planDispatch(call("resolveBase", { base: "sword", rank: "rare" })), {
      kind: "read", verb: "resolveBase", command: "items", args: { base: "sword", rank: "rare" },
    });
  });

  it("grantQuestReward for the console holder is a composite of give + gold steps, in order", () => {
    const plan = planDispatch(call("grantQuestReward", { character: "me", rewards: [{ base: "sword", count: 2 }, { gold: 50 }] }));
    assert.equal(plan.kind, "composite");
    if (plan.kind !== "composite") return;
    assert.deepEqual(plan.steps, [
      { command: "give", args: { base: "sword" } },
      { command: "give", args: { base: "sword" } },
      { command: "gold", args: { amount: 50 } },
    ]);
  });
});

describe("dispatch mapper — the bag verbs and fixture (admin homes added in the server slice)", () => {
  it("takeItem by instance id maps to items {sub: take, item}", () => {
    assert.deepEqual(planDispatch(call("takeItem", { character: "me", item: 9 })), {
      kind: "admin", verb: "takeItem", command: "items", args: { sub: "take", item: 9 },
    });
  });

  it("takeItem by base maps to items {sub: take, base}", () => {
    assert.deepEqual(planDispatch(call("takeItem", { character: "me", base: "sword" })), {
      kind: "admin", verb: "takeItem", command: "items", args: { sub: "take", base: "sword" },
    });
  });

  it("moveItem maps to items {sub: move, item, to} — from rides only when the call names it", () => {
    assert.deepEqual(planDispatch(call("moveItem", { item: 9, to: 77 })), {
      kind: "admin", verb: "moveItem", command: "items", args: { sub: "move", item: 9, to: 77 },
    });
    assert.deepEqual(planDispatch(call("moveItem", { item: 9, from: 55, to: 77 })), {
      kind: "admin", verb: "moveItem", command: "items", args: { sub: "move", item: 9, to: 77, from: 55 },
    });
  });

  it("defOf and countBase are reads on the items command", () => {
    assert.deepEqual(planDispatch(call("defOf", { item: 9 })), {
      kind: "read", verb: "defOf", command: "items", args: { sub: "defof", item: 9 },
    });
    assert.deepEqual(planDispatch(call("countBase", { character: "me", base: "sword" })), {
      kind: "read", verb: "countBase", command: "items", args: { sub: "countbase", base: "sword" },
    });
  });

  it("placeItemFixture maps to drop with the exact position and the fixture flag", () => {
    assert.deepEqual(planDispatch(call("placeItemFixture", { base: "sword", rank: "rare", x: 10, z: -4 })), {
      kind: "admin", verb: "placeItemFixture", command: "drop", args: { base: "sword", rank: "rare", x: 10, z: -4, fixture: true },
    });
  });
});

describe("dispatch mapper — unsupported, with the real reason (never an invented target)", () => {
  const reason = (verb: string, params: Record<string, unknown>): string => {
    const plan = planDispatch(call(verb, params));
    assert.equal(plan.kind, "unsupported", `${verb} should be unsupported`);
    return plan.kind === "unsupported" ? plan.reason : "";
  };

  it("give/gold naming another character: admin give/gold act on the console holder only", () => {
    assert.match(reason("giveItem", { character: "npc-mara", def: "abc" }), /console holder/);
    assert.match(reason("giveGold", { character: "npc-mara", amount: 10 }), /console holder/);
    assert.match(reason("grantQuestReward", { character: "npc-mara", rewards: [{ gold: 5 }] }), /console holder/);
  });

  it("giveItem with a numeric def index, no pick, or nothing chosen", () => {
    assert.match(reason("giveItem", { character: "me", def: 7 }), /numeric def index/);
    assert.match(reason("giveItem", { character: "me", def: "" }), /no item chosen/);
  });

  it("giveGold with no usable amount (the widget's 0 placeholder)", () => {
    assert.match(reason("giveGold", { character: "me", amount: 0 }), /positive integer amount/);
  });

  it("attachVendor with an empty templateId (the widget's placeholder)", () => {
    assert.match(reason("attachVendor", { entity: "12345", templateId: "" }), /template/i);
  });

  it("spawnCreature with no kind; teleport with no destination; resolveBase with no base", () => {
    assert.match(reason("spawnCreature", { kind: "", x: 0, z: 0 }), /no spawn kind/);
    assert.match(reason("teleport", { entity: "1" }), /explicit x and z/);
    assert.match(reason("resolveBase", { base: "" }), /base name/);
  });

  it("grantQuestReward with no rewards", () => {
    assert.match(reason("grantQuestReward", { character: "me", rewards: [] }), /non-empty rewards/);
  });

  it("takeItem with another character named: the bag sub-actions act on the console holder only", () => {
    assert.match(reason("takeItem", { character: "someone-else", item: 9 }), /console holder/);
    assert.match(reason("countBase", { character: "someone-else", base: "sword" }), /console holder/);
  });

  it("takeItem with neither an item id nor a base; defOf with no item id; countBase with no base", () => {
    assert.match(reason("takeItem", { character: "me" }), /no item chosen/);
    assert.match(reason("takeItem", { character: "me", item: "9" }), /no item chosen/); // a string id is not an instance id
    assert.match(reason("defOf", {}), /positive integer item id/);
    assert.match(reason("countBase", { character: "me" }), /base name/);
  });

  it("moveItem with no destination character id", () => {
    assert.match(reason("moveItem", { item: 9 }), /destination character \(holder\) id/);
  });

  it("startDialogue: no admin command starts a dialogue", () => {
    assert.match(reason("startDialogue", { npc: "1", player: "2" }), /no admin command starts a dialogue/);
  });

  it("placeItemFixture with no position: drop places the fixture at an exact x/z, so the call must name one", () => {
    assert.match(reason("placeItemFixture", { base: "sword" }), /exact x and z/);
  });

  it("an unknown verb is unsupported, not dispatched", () => {
    const plan = planDispatch({ verb: "explodeEverything", params: {}, provenance: prov });
    assert.equal(plan.kind, "unsupported");
  });
});

describe("dispatch mapper — component-shaped shelf actions", () => {
  it("Health + Stamina maps to a composite of addcomponent steps against the selected entity", () => {
    const plan = shelfComponentPlan({ label: "Add combat", addComponents: ["Health", "Stamina"] }, "12345");
    assert.deepEqual(plan, {
      kind: "composite",
      verb: "addComponents",
      steps: [
        { command: "addcomponent", args: { entity: "12345", component: "Health" } },
        { command: "addcomponent", args: { entity: "12345", component: "Stamina" } },
      ],
    });
  });

  it("a single marker addition maps to one addcomponent step", () => {
    assert.deepEqual(shelfComponentPlan({ label: "Bind flow graph", addComponents: ["FlowRef"] }, "12345"), {
      kind: "admin", verb: "addComponents", command: "addcomponent", args: { entity: "12345", component: "FlowRef" },
    });
  });

  it("the shelf's Collider is the scene name for BodyConfig and maps to it", () => {
    assert.deepEqual(shelfComponentPlan({ label: "Add collider", addComponents: ["Collider"] }, "12345"), {
      kind: "admin", verb: "addComponents", command: "addcomponent", args: { entity: "12345", component: "BodyConfig" },
    });
  });

  it("QuestGiver and DungeonEntrance name no ECS component and stay unsupported, with the reason", () => {
    const quest = shelfComponentPlan({ label: "Make quest giver", addComponents: ["QuestGiver"] }, "12345");
    assert.equal(quest?.kind, "unsupported");
    if (quest?.kind === "unsupported") assert.match(quest.reason, /scene-document role, not an ECS component/);
    const dungeon = shelfComponentPlan({ label: "Make dungeon entrance", addComponents: ["DungeonEntrance"] }, "12345");
    assert.equal(dungeon?.kind, "unsupported");
    if (dungeon?.kind === "unsupported") assert.match(dungeon.reason, /no component by that name exists/);
  });

  it("with no target entity the plan is unsupported, never a guessed target", () => {
    const plan = shelfComponentPlan({ label: "Add combat", addComponents: ["Health", "Stamina"] }, undefined);
    assert.equal(plan?.kind, "unsupported");
    if (plan?.kind === "unsupported") assert.match(plan.reason, /needs the selected entity/);
  });

  it("verb-shaped shelf actions return null (they route through planDispatch)", () => {
    assert.equal(shelfComponentPlan({ label: "Add vendor", verb: "attachVendor", params: { entity: "1", templateId: "t" } }, "12345"), null);
  });
});

// ---------------------------------------------------------------- executor

function fakeTransport(handler: (command: string) => { ok: boolean; message: string }, inspectDump = "entity 1 (slot 1)\nHealth: 10/10"): DispatchTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async admin(command) {
      calls.push(command);
      return handler(command);
    },
    async inspect() {
      calls.push("inspect");
      return { ok: true, message: inspectDump };
    },
  };
}

describe("dispatch executor — fake transport", () => {
  it("a dispatched mutation reports the server's message and carries the inspect read-back", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "vendor \"t\" attached to 12345" }));
    const out = await executeDispatch(call("attachVendor", { entity: "12345", templateId: "t" }), t);
    assert.equal(out.status, "dispatched");
    assert.match(out.message, /attached/);
    assert.equal(out.readResult, "entity 1 (slot 1)\nHealth: 10/10");
    assert.deepEqual(t.calls, ["vendor", "inspect"]);
  });

  it("a server refusal is refused with its message — never dispatched", async () => {
    const t = fakeTransport(() => ({ ok: false, message: "unknown vendor template" }));
    const out = await executeDispatch(call("attachVendor", { entity: "12345", templateId: "nope" }), t);
    assert.equal(out.status, "refused");
    assert.equal(out.message, "unknown vendor template");
    assert.equal(out.readResult, undefined);
  });

  it("a composite stops at the first refused step and says which step", async () => {
    let n = 0;
    const t = fakeTransport(() => (++n === 2 ? { ok: false, message: "bag is full" } : { ok: true, message: "ok" }));
    const out = await executeDispatch(call("grantQuestReward", { character: "me", rewards: [{ base: "sword", count: 2 }, { gold: 50 }] }), t);
    assert.equal(out.status, "refused");
    assert.match(out.message, /step 2\/3 \(give\) refused: bag is full/);
    assert.equal(out.stepsRun, 1);
    assert.equal(out.stepsTotal, 3);
    assert.deepEqual(t.calls, ["give", "give"]); // the gold step never ran
  });

  it("no transport at all is offline — nothing runs, nothing is claimed dispatched", async () => {
    const out = await executeDispatch(call("teleport", { entity: "1", x: 1, z: 2 }), null);
    assert.equal(out.status, "offline");
    assert.equal(out.stepsRun, 0);
  });

  it("a transport answering 'server not running' reads as offline, not refused", async () => {
    const t = fakeTransport(() => ({ ok: false, message: "server not running" }));
    const out = await executeDispatch(call("teleport", { entity: "1", x: 1, z: 2 }), t);
    assert.equal(out.status, "offline");
  });

  it("an unsupported plan passes through without touching the transport", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "ok" }));
    const out = await executeDispatch(call("takeItem", { character: "me", item: "9" }), t);
    assert.equal(out.status, "unsupported");
    assert.deepEqual(t.calls, []);
  });

  it("an unsupported plan outranks offline (the reason is the useful answer)", async () => {
    const out = await executeDispatch(call("startDialogue", { npc: "1", player: "2" }), null);
    assert.equal(out.status, "unsupported");
  });

  it("a read plan returns its answer as readResult", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "3 items: Sword [common sword] s1" }));
    const out = await executeDispatch(call("resolveBase", { base: "sword" }), t);
    assert.equal(out.status, "dispatched");
    assert.equal(out.readResult, "3 items: Sword [common sword] s1");
    assert.deepEqual(t.calls, ["items"]); // no inspect after a read
  });

  it("a failed read-back never rewrites a landed mutation's outcome", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "teleported 1 to 1 2" }));
    t.inspect = async () => ({ ok: false, message: "unknown entity 1" });
    const out = await executeDispatch(call("teleport", { entity: "1", x: 1, z: 2 }), t);
    assert.equal(out.status, "dispatched");
    assert.equal(out.readResult, undefined);
  });
});

describe("dispatch executor — shelf component plans (executePlan)", () => {
  it("a composite add runs its steps in order and re-inspects the entity", async () => {
    const plan = shelfComponentPlan({ label: "Add combat", addComponents: ["Health", "Stamina"] }, "12345");
    assert.ok(plan);
    const t = fakeTransport((command) => ({ ok: true, message: `${command} ok` }), "entity 12345 (slot 7)\nHealth: 100/100\nStamina: 100/100");
    const out = await executePlan(plan, t, "12345");
    assert.equal(out.status, "dispatched");
    assert.deepEqual(t.calls, ["addcomponent", "addcomponent", "inspect"]);
    assert.match(out.readResult ?? "", /Health: 100\/100/);
  });

  it("a refused second step stops the composite and names the step", async () => {
    const plan = shelfComponentPlan({ label: "Add combat", addComponents: ["Health", "Stamina"] }, "12345");
    assert.ok(plan);
    let n = 0;
    const t = fakeTransport(() => (++n === 2 ? { ok: false, message: "entity 12345 already has Stamina" } : { ok: true, message: "ok" }));
    const out = await executePlan(plan, t, "12345");
    assert.equal(out.status, "refused");
    assert.equal(out.stepsRun, 1);
    assert.match(out.message, /step 2\/2 \(addcomponent\) refused/);
  });

  it("a takeItem call dispatches through the items command and reflects on the holder", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "took Helm h (item 9) from your bag" }));
    const out = await executeDispatch(call("takeItem", { character: "me", item: 9 }), t);
    assert.equal(out.status, "dispatched");
    assert.deepEqual(t.calls, ["items", "inspect"]);
  });
});

describe("inspect target selection", () => {
  it("entity/target params win; caller-acting verbs read back the console holder", () => {
    assert.equal(inspectTargetForCall(call("teleport", { entity: "77", x: 0, z: 0 })), "77");
    assert.equal(inspectTargetForCall(call("giveGold", { character: "me", amount: 5 })), "me");
    assert.equal(inspectTargetForCall(call("spawnCreature", { kind: "goblin", x: 0, z: 0 })), null);
  });
});

// ---------------------------------------------------- component removal

describe("dispatch mapper — component removal (the unbind)", () => {
  it("maps to one removecomponent admin step against the entity", () => {
    assert.deepEqual(removeComponentPlan("12345", "FlowRef"), {
      kind: "admin", verb: "removeComponent", command: "removecomponent", args: { entity: "12345", component: "FlowRef" },
    });
  });

  it("no entity is unsupported with the reason — never an invented target", () => {
    const plan = removeComponentPlan("", "FlowRef");
    assert.equal(plan.kind, "unsupported");
    assert.match(plan.kind === "unsupported" ? plan.reason : "", /needs the selected entity/);
  });

  it("the executor dispatches the removal and re-inspects the target", async () => {
    const t = fakeTransport(() => ({ ok: true, message: "FlowRef removed from 12345" }), "entity 12345 (slot 7)\nHealth: 100/100");
    const out = await executePlan(removeComponentPlan("12345", "FlowRef"), t, "12345");
    assert.equal(out.status, "dispatched");
    assert.match(out.message, /FlowRef removed/);
    assert.deepEqual(t.calls, ["removecomponent", "inspect"]);
    assert.equal(out.readResult, "entity 12345 (slot 7)\nHealth: 100/100");
  });

  it("a removal the server refuses is refused, never dispatched", async () => {
    const t = fakeTransport(() => ({ ok: false, message: "entity 12345 has no FlowRef" }));
    const out = await executePlan(removeComponentPlan("12345", "FlowRef"), t, "12345");
    assert.equal(out.status, "refused");
    assert.equal(out.message, "entity 12345 has no FlowRef");
  });
});

// ------------------------------------------------------------- field edits

describe("field edits — what an applied-state line exposes", () => {
  it("a Component.field: number line exposes that field, canonicalised to the server's spelling", () => {
    assert.deepEqual(fieldEditTarget("Health.current: 37"), { component: "Health", field: "current", value: 37 });
    assert.deepEqual(fieldEditTarget("health.max: 100"), { component: "Health", field: "max", value: 100 });
    assert.deepEqual(fieldEditTarget("FlowRef.graph: 3"), { component: "FlowRef", field: "graph", value: 3 });
    assert.deepEqual(fieldEditTarget("Velocity.lx: -2.5"), { component: "Velocity", field: "lx", value: -2.5 });
    assert.deepEqual(fieldEditTarget("VfxEmitter.intensity: 0.5"), { component: "VfxEmitter", field: "intensity", value: 0.5 });
  });

  it("lines that expose no single numeric field expose nothing", () => {
    assert.equal(fieldEditTarget("Transform.position: 0, 0, 0"), null); // a vector, not one field
    assert.equal(fieldEditTarget("Health.current: abc"), null); // non-numeric value
    assert.equal(fieldEditTarget("Health: 100/100"), null); // inspect shape — no named field
    assert.equal(fieldEditTarget("live · FlowRef: graph 0 enabled 1"), null); // read-back lines are reflections, not editors
    assert.equal(fieldEditTarget("intent.mx: 1"), null); // "intent" merely resembles PlayerIntent — no invented mapping
    assert.equal(fieldEditTarget("Spawn count: 3"), null); // no component.field shape at all
    assert.equal(fieldEditTarget(""), null);
  });

  it("the helper is syntactic about FIELDS: a named field it cannot verify still plans — and the server's whitelist refuses it", () => {
    // "character" is not one of CharacterRef's set fields (idHi/idLo
    // are); the editor does not duplicate the server's field table, so
    // the line exposes a target and the refusal arrives as the outcome.
    assert.deepEqual(fieldEditTarget("CharacterRef.character: 51"), { component: "CharacterRef", field: "character", value: 51 });
    assert.deepEqual(fieldEditTarget("CharacterRef.idLo: 51"), { component: "CharacterRef", field: "idLo", value: 51 });
  });

  it("fieldEditPlan builds the admin set step for the exposed field", () => {
    assert.deepEqual(fieldEditPlan("12345", "Health.current: 37", 55), {
      kind: "admin", verb: "setField", command: "set", args: { entity: "12345", component: "Health", field: "current", value: 55 },
    });
  });

  it("fieldEditPlan is null when the line exposes nothing, the entity is missing, or the value is not finite", () => {
    assert.equal(fieldEditPlan("12345", "Transform.position: 0, 0, 0", 1), null);
    assert.equal(fieldEditPlan("", "Health.current: 37", 55), null);
    assert.equal(fieldEditPlan("12345", "Health.current: 37", Number.NaN), null);
  });

  it("the executor dispatches a field edit as admin set and reflects the read-back", async () => {
    const seen: { command: string; args?: Record<string, unknown> }[] = [];
    const t: DispatchTransport = {
      async admin(command, args) {
        seen.push({ command, ...(args ? { args } : {}) });
        return { ok: true, message: "Health.current = 55 on 12345" };
      },
      async inspect() {
        return { ok: true, message: "entity 12345 (slot 7)\nHealth: 55/100" };
      },
    };
    const plan = fieldEditPlan("12345", "Health.current: 37", 55);
    assert.ok(plan);
    const out = await executePlan(plan, t, "12345");
    assert.equal(out.status, "dispatched");
    assert.deepEqual(seen, [{ command: "set", args: { entity: "12345", component: "Health", field: "current", value: 55 } }]);
    assert.equal(out.readResult, "entity 12345 (slot 7)\nHealth: 55/100");
  });

  it("a field the server's whitelist refuses stays a refusal — the executor never pre-approves", async () => {
    const t = fakeTransport(() => ({ ok: false, message: "unknown field \"bogus\" on Health" }));
    const plan = fieldEditPlan("12345", "Health.bogus: 1", 2);
    assert.ok(plan);
    const out = await executePlan(plan, t, "12345");
    assert.equal(out.status, "refused");
    assert.match(out.message, /unknown field/);
  });
});

// ------------------------------------------------------------ vendor stock

describe("dispatch mapper — vendor stock (plan, not a verb)", () => {
  it("maps to vendor {sub: stock, id, name, price} — qty omitted when not chosen (the gateway's infinite default)", () => {
    assert.deepEqual(vendorStockPlan({ templateId: "smoke-shop", itemName: "Flaming Mithril Sword", price: 250 }), {
      kind: "admin", verb: "vendorStock", command: "vendor", args: { sub: "stock", id: "smoke-shop", name: "Flaming Mithril Sword", price: 250 },
    });
  });

  it("carries an explicit qty, and -1 (infinite) is a real choice", () => {
    assert.deepEqual(vendorStockPlan({ templateId: "t", itemName: "Sword", price: 10, qty: 5 }), {
      kind: "admin", verb: "vendorStock", command: "vendor", args: { sub: "stock", id: "t", name: "Sword", price: 10, qty: 5 },
    });
    const inf = vendorStockPlan({ templateId: "t", itemName: "Sword", price: 10, qty: -1 });
    assert.equal(inf.kind, "admin");
    assert.equal(inf.kind === "admin" ? inf.args.qty : undefined, -1);
  });

  it("missing template, missing def name, bad price and bad qty are unsupported with reasons", () => {
    const cases: [Parameters<typeof vendorStockPlan>[0], RegExp][] = [
      [{ itemName: "Sword", price: 10 }, /needs a vendor template/],
      [{ templateId: "t", price: 10 }, /exact def name/],
      [{ templateId: "t", itemName: "Sword", price: 0 }, /positive integer price/],
      [{ templateId: "t", itemName: "Sword", price: 2.5 }, /positive integer price/],
      [{ templateId: "t", itemName: "Sword", price: 10, qty: 0 }, /positive integer, or -1/],
    ];
    for (const [params, reason] of cases) {
      const plan = vendorStockPlan(params);
      assert.equal(plan.kind, "unsupported", JSON.stringify(params));
      assert.match(plan.kind === "unsupported" ? plan.reason : "", reason);
    }
  });

  it("the executor dispatches stock through the vendor command; an undefined template's refusal is carried", async () => {
    const ok = fakeTransport(() => ({ ok: true, message: "stocked Flaming Mithril Sword at 250g" }));
    const out = await executePlan(vendorStockPlan({ templateId: "smoke-shop", itemName: "Flaming Mithril Sword", price: 250 }), ok, null);
    assert.equal(out.status, "dispatched");
    assert.match(out.message, /stocked/);
    assert.deepEqual(ok.calls, ["vendor"]);

    const refused = fakeTransport(() => ({ ok: false, message: "unknown vendor or bad price" }));
    const out2 = await executePlan(vendorStockPlan({ templateId: "nope", itemName: "Sword", price: 10 }), refused, null);
    assert.equal(out2.status, "refused");
    assert.equal(out2.message, "unknown vendor or bad price");
  });
});
