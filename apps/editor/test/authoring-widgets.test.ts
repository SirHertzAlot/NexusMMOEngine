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
