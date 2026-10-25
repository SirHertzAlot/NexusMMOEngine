import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeDispatch,
  inspectTargetForCall,
  makeVerbCall,
  planDispatch,
  shelfComponentPlan,
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

  it("takeItem / moveItem: no admin home exists", () => {
    assert.match(reason("takeItem", { character: "me", item: "9" }), /no admin command takes/);
    assert.match(reason("moveItem", { item: "9", from: "1", to: "2" }), /no admin command moves/);
  });

  it("defOf / countBase: no admin read honestly answers them", () => {
    assert.match(reason("defOf", { item: "9" }), /no admin read/);
    assert.match(reason("countBase", { character: "me", base: "sword" }), /no admin read/);
  });

  it("startDialogue: no admin command starts a dialogue", () => {
    assert.match(reason("startDialogue", { npc: "1", player: "2" }), /no admin command starts a dialogue/);
  });

  it("placeItemFixture: drop is at the caller's feet and takes no x/z; spawn plants archetypes", () => {
    assert.match(reason("placeItemFixture", { base: "sword", rank: "", x: 1, z: 2 }), /no admin command places/);
  });

  it("an unknown verb is unsupported, not dispatched", () => {
    const plan = planDispatch({ verb: "explodeEverything", params: {}, provenance: prov });
    assert.equal(plan.kind, "unsupported");
  });
});

describe("dispatch mapper — component-shaped shelf actions", () => {
  it("addComponents actions are unsupported: admin set cannot add a component (it only writes fields of one already present)", () => {
    const plan = shelfComponentPlan({ label: "Add combat", addComponents: ["Health", "Stamina"] });
    assert.ok(plan);
    assert.equal(plan.kind, "unsupported");
    if (plan.kind === "unsupported") assert.match(plan.reason, /cannot add Health \+ Stamina/);
  });

  it("marker additions (FlowRef etc.) are unsupported for the same reason", () => {
    const plan = shelfComponentPlan({ label: "Bind flow graph", addComponents: ["FlowRef"] });
    assert.equal(plan?.kind, "unsupported");
  });

  it("verb-shaped shelf actions return null (they route through planDispatch)", () => {
    assert.equal(shelfComponentPlan({ label: "Add vendor", verb: "attachVendor", params: { entity: "1", templateId: "t" } }), null);
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

describe("inspect target selection", () => {
  it("entity/target params win; caller-acting verbs read back the console holder", () => {
    assert.equal(inspectTargetForCall(call("teleport", { entity: "77", x: 0, z: 0 })), "77");
    assert.equal(inspectTargetForCall(call("giveGold", { character: "me", amount: 5 })), "me");
    assert.equal(inspectTargetForCall(call("spawnCreature", { kind: "goblin", x: 0, z: 0 })), null);
  });
});
