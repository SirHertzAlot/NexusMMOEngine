import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWidgets, makeFacts, validateVerbCall } from "../src/authoring/index.js";

const blacksmith = makeFacts({
  id: "npc-mara",
  label: "Blacksmith Mara",
  kind: "npc",
  components: ["Transform", "CharacterRef", "Health", "Stamina"],
  isVendor: true,
  vendorTemplateId: "weapons-tier2",
  isQuestGiver: true,
  questIds: ["q-forge-1"],
});

const opts = {
  actor: { id: "joey", role: "designer" as const },
  why: "vendor stock review",
  where: "Haven / Market Square / Blacksmith Mara",
  when: 1_800_000_000_000,
};

describe("widget view-models", () => {
  it("builds the three anatomy zones for the vendor widget", () => {
    const widgets = buildWidgets(blacksmith, {
      ...opts,
      state: { vendor: { identity: "Vendor · Blacksmith Mara · template `weapons-tier2`", lines: ["Longsword — 120g", "Shield — 80g"] } },
    });
    const vendor = widgets.find((w) => w.widgetId === "vendor");
    assert.equal(vendor?.identity, "Vendor · Blacksmith Mara · template `weapons-tier2`");
    assert.deepEqual(vendor?.applied, ["Longsword — 120g", "Shield — 80g"]);
    assert.ok((vendor?.actions.length ?? 0) > 0);
  });

  it("resolves every CRUD affordance to a verb call carrying the full envelope", () => {
    const widgets = buildWidgets(blacksmith, opts);
    for (const w of widgets) {
      for (const a of w.actions) {
        assert.deepEqual(validateVerbCall(a.call), [], `${w.widgetId}/${a.id}`);
        assert.equal(a.call.provenance.who.id, "joey");
        assert.equal(a.call.provenance.why, "vendor stock review");
        assert.equal(a.call.provenance.where, "Haven / Market Square / Blacksmith Mara");
      }
    }
    const vendor = widgets.find((w) => w.widgetId === "vendor");
    assert.ok(vendor?.actions.some((a) => a.call.verb === "detachVendor"));
    const quests = widgets.find((w) => w.widgetId === "quests");
    assert.ok(quests?.actions.some((a) => a.call.verb === "grantQuestReward"));
  });

  it("without caller state, applied lines are empty — never invented", () => {
    const widgets = buildWidgets(blacksmith, opts);
    for (const w of widgets) assert.deepEqual(w.applied, []);
  });

  it("merged widgets keep their tabs in the view-model", () => {
    const widgets = buildWidgets(blacksmith, opts);
    assert.deepEqual(widgets.find((w) => w.widgetId === "character")?.tabs, ["Sheet", "Records"]);
    assert.deepEqual(widgets.find((w) => w.widgetId === "quests")?.tabs, ["Quests", "Dialogue"]);
  });

  it("refuses to build widgets for an anonymous actor", () => {
    assert.throws(() => buildWidgets(blacksmith, { ...opts, actor: { id: "", role: "designer" } }), /anonymous/);
    assert.throws(() => buildWidgets(blacksmith, { ...opts, why: "" }), /why/);
  });
});

describe("widget removals + plan actions (authoring-depth slice)", () => {
  const automaton = makeFacts({
    id: "51",
    label: "Market Automaton",
    kind: "npc",
    components: ["Transform", "FlowRef"],
    flowRef: "graph-7",
  });

  it("the flow widget carries the unbind removal for its bound FlowRef — and only there", () => {
    const widgets = buildWidgets(automaton, opts);
    const flow = widgets.find((w) => w.widgetId === "flow");
    assert.ok(flow);
    assert.deepEqual(
      flow.removals.map((r) => ({ id: r.id, component: r.component })),
      [{ id: "unbind-flow", component: "FlowRef" }],
    );
    for (const w of widgets) {
      if (w.widgetId !== "flow") assert.deepEqual(w.removals, [], w.widgetId);
    }
  });

  it("no FlowRef bound, no flow widget and no unbind anywhere", () => {
    const widgets = buildWidgets(blacksmith, opts);
    assert.equal(widgets.find((w) => w.widgetId === "flow"), undefined);
    for (const w of widgets) assert.deepEqual(w.removals, [], w.widgetId);
  });

  it("the vendor widget carries the stock plan action with its four real inputs", () => {
    const vendor = buildWidgets(blacksmith, opts).find((w) => w.widgetId === "vendor");
    assert.ok(vendor);
    assert.equal(vendor.planActions.length, 1);
    const stock = vendor.planActions[0];
    assert.equal(stock.id, "stock-item");
    assert.deepEqual(
      stock.inputs.map((i) => i.id),
      ["templateId", "itemName", "price", "qty"],
    );
    // The template input prefills with the vendor's current template.
    assert.equal(stock.inputs[0].initial, "weapons-tier2");
  });

  it("the stock action's buildPlan routes values through the real plan builder (the gate)", () => {
    const vendor = buildWidgets(blacksmith, opts).find((w) => w.widgetId === "vendor");
    const stock = vendor?.planActions[0];
    assert.ok(stock);
    assert.deepEqual(stock.buildPlan({ templateId: "weapons-tier2", itemName: "Flaming Mithril Sword", price: "250", qty: "" }), {
      kind: "admin", verb: "vendorStock", command: "vendor", args: { sub: "stock", id: "weapons-tier2", name: "Flaming Mithril Sword", price: 250 },
    });
    assert.deepEqual(stock.buildPlan({ templateId: "weapons-tier2", itemName: "Sword", price: "10", qty: "5" }), {
      kind: "admin", verb: "vendorStock", command: "vendor", args: { sub: "stock", id: "weapons-tier2", name: "Sword", price: 10, qty: 5 },
    });
    const empty = stock.buildPlan({});
    assert.equal(empty.kind, "unsupported");
  });

  it("widgets without plan affordances carry none — never invented", () => {
    for (const w of buildWidgets(blacksmith, opts)) {
      if (w.widgetId !== "vendor") assert.deepEqual(w.planActions, [], w.widgetId);
    }
  });
});
