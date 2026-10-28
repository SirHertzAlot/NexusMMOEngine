import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORING_TEMPLATE_ID,
  LEGACY_TEMPLATE_ID,
  PresentationPins,
  PresentationResolver,
  TemplateRegistry,
  createBuiltinRegistry,
  retireTemplate,
  type Provenance,
  type ViewTemplateDefinition,
} from "../src/authoring/index.js";

const prov = (why: string): Provenance => ({
  who: { id: "joey", role: "designer" },
  what: "authoring slot presentation",
  when: 1_800_000_000_000,
  where: "Design / Authoring",
  why,
});

const defA: ViewTemplateDefinition = { layout: "authoring-three-pane", panes: ["hierarchy", "stage", "widgets"], widgets: ["vendor"], filters: ["vendors"] };
const defB: ViewTemplateDefinition = { layout: "authoring-three-pane", panes: ["hierarchy", "widgets"], widgets: ["vendor", "combat"], filters: ["vendors"] };

function freshRegistry(): TemplateRegistry {
  const registry = new TemplateRegistry();
  registry.register({ id: "my-view", slot: "authoring", version: 1, status: "published", definition: defA }, prov("register v1"));
  return registry;
}

describe("template registry — pseudo version control", () => {
  it("built-ins register the legacy and the new authoring presentation, both published v1 for the authoring slot", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const legacy = registry.get(LEGACY_TEMPLATE_ID, 1);
    const authoring = registry.get(AUTHORING_TEMPLATE_ID, 1);
    assert.equal(legacy?.status, "published");
    assert.equal(legacy?.slot, "authoring");
    assert.equal(authoring?.status, "published");
    assert.ok((authoring?.definition.widgets.length ?? 0) > 0);
  });

  it("published versions are immutable: an edit creates a new draft version and never touches v1", () => {
    const registry = freshRegistry();
    const v2 = registry.edit("my-view", defB, prov("try a two-pane layout"));
    assert.equal(v2.version, 2);
    assert.equal(v2.status, "draft");
    assert.deepEqual(v2.definition, defB);
    const v1 = registry.get("my-view", 1);
    assert.equal(v1?.status, "published");
    assert.deepEqual(v1?.definition, defA);
  });

  it("editing again creates the next draft version", () => {
    const registry = freshRegistry();
    registry.edit("my-view", defB, prov("first edit"));
    const v3 = registry.edit("my-view", defA, prov("second edit"));
    assert.equal(v3.version, 3);
    assert.equal(v3.status, "draft");
    assert.equal(registry.versionsOf("my-view").length, 3);
  });

  it("status moves one step along draft → published → deprecated → retired, with provenance recorded", () => {
    const registry = freshRegistry();
    const v2 = registry.edit("my-view", defB, prov("edit"));
    assert.throws(() => registry.transition("my-view", 2, "retired", prov("skip the chain")), /illegal template transition/);
    const published = registry.transition("my-view", v2.version, "published", prov("ship it"));
    assert.equal(published.status, "published");
    assert.ok(published.history.some((h) => h.action === "publish" && h.provenance.why === "ship it"));
    registry.transition("my-view", 2, "deprecated", prov("superseded"));
    const retired = registry.transition("my-view", 2, "retired", prov("grace period over"));
    assert.equal(retired.status, "retired");
  });

  it("anonymous transitions are rejected — no provenance, no status change", () => {
    const registry = freshRegistry();
    registry.edit("my-view", defB, prov("edit"));
    assert.throws(() => registry.transition("my-view", 2, "published", { ...prov("x"), who: { id: "", role: "designer" } }), /anonymous/);
    assert.equal(registry.get("my-view", 2)?.status, "draft");
  });
});

describe("presentation pins", () => {
  it("pin + rollback round-trips, and history carries who/when/why for every change", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const pins = new PresentationPins();
    pins.pin("authoring", { templateId: LEGACY_TEMPLATE_ID, version: 1 }, prov("start on legacy"), registry);
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("move to the new authoring view"), registry);
    assert.deepEqual(pins.get("authoring"), { templateId: AUTHORING_TEMPLATE_ID, version: 1 });
    const back = pins.rollback("authoring", prov("new view not ready"), registry);
    assert.deepEqual(back, { templateId: LEGACY_TEMPLATE_ID, version: 1 });
    assert.deepEqual(pins.get("authoring"), { templateId: LEGACY_TEMPLATE_ID, version: 1 });
    const history = pins.pinHistory();
    assert.equal(history.length, 3);
    assert.ok(history.every((h) => h.provenance.who.id === "joey"));
    assert.equal(history[1].provenance.why, "move to the new authoring view");
    assert.deepEqual(history[1].from, { templateId: LEGACY_TEMPLATE_ID, version: 1 });
  });

  it("pinning an unknown or draft template is refused", () => {
    const registry = freshRegistry();
    const pins = new PresentationPins();
    assert.throws(() => pins.pin("authoring", { templateId: "nope", version: 1 }, prov("x"), registry), /unknown template/);
    registry.edit("my-view", defB, prov("edit"));
    assert.throws(() => pins.pin("authoring", { templateId: "my-view", version: 2 }, prov("x"), registry), /draft/);
  });

  it("a retired version cannot be newly pinned", () => {
    const registry = freshRegistry();
    const pins = new PresentationPins();
    registry.transition("my-view", 1, "deprecated", prov("old"));
    registry.transition("my-view", 1, "retired", prov("gone"));
    assert.throws(() => pins.pin("authoring", { templateId: "my-view", version: 1 }, prov("try to pin retired"), registry), /retired/);
  });

  it("retire-while-pinned is refused until the pin moves — then retirement succeeds", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const pins = new PresentationPins();
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("pin new view"), registry);
    assert.throws(() => retireTemplate(registry, pins, AUTHORING_TEMPLATE_ID, 1, prov("retire it")), /currently pins/);
    assert.equal(registry.get(AUTHORING_TEMPLATE_ID, 1)?.status, "published");
    pins.pin("authoring", { templateId: LEGACY_TEMPLATE_ID, version: 1 }, prov("pin moved — retirement can proceed"), registry);
    const retired = retireTemplate(registry, pins, AUTHORING_TEMPLATE_ID, 1, prov("retire it now"));
    assert.equal(retired.status, "retired");
  });
});

describe("presentation resolver", () => {
  it("resolves the pinned template; a deprecated-but-pinned version still resolves, flagged", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const pins = new PresentationPins();
    const resolver = new PresentationResolver();
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("pin"), registry);
    const first = resolver.resolve("authoring", pins, registry);
    assert.equal(first.template.id, AUTHORING_TEMPLATE_ID);
    assert.equal(first.deprecated, false);
    assert.equal(first.fallbackReason, undefined);
    registry.transition(AUTHORING_TEMPLATE_ID, 1, "deprecated", prov("a newer view is coming"));
    const second = resolver.resolve("authoring", pins, registry);
    assert.equal(second.template.id, AUTHORING_TEMPLATE_ID);
    assert.equal(second.deprecated, true);
  });

  it("falls back to the last known-good when the pinned template references an unknown widget, reporting the reason", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    registry.register(
      { id: "broken-view", slot: "authoring", version: 1, status: "published", definition: { layout: "x", panes: [], widgets: ["no-such-widget"], filters: [] } },
      prov("register broken"),
    );
    const pins = new PresentationPins();
    const resolver = new PresentationResolver();
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("known good first"), registry);
    assert.equal(resolver.resolve("authoring", pins, registry).template.id, AUTHORING_TEMPLATE_ID);
    pins.pin("authoring", { templateId: "broken-view", version: 1 }, prov("pin the broken one"), registry);
    const resolved = resolver.resolve("authoring", pins, registry);
    assert.equal(resolved.template.id, AUTHORING_TEMPLATE_ID);
    assert.ok(resolved.fallbackReason?.includes("unknown widget \"no-such-widget\""), resolved.fallbackReason);
    assert.ok(resolved.fallbackReason?.includes("last known-good"), resolved.fallbackReason);
  });

  it("with no known-good, a broken pin falls back to the built-in legacy template, with the reason", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    registry.register(
      { id: "broken-view", slot: "authoring", version: 1, status: "published", definition: { layout: "x", panes: [], widgets: [], filters: ["no-such-filter"] } },
      prov("register broken"),
    );
    const pins = new PresentationPins();
    pins.pin("authoring", { templateId: "broken-view", version: 1 }, prov("pin broken first"), registry);
    const resolved = new PresentationResolver().resolve("authoring", pins, registry);
    assert.equal(resolved.template.id, LEGACY_TEMPLATE_ID);
    assert.ok(resolved.fallbackReason?.includes("unknown filter"), resolved.fallbackReason);
    assert.ok(resolved.fallbackReason?.includes("legacy"), resolved.fallbackReason);
  });

  it("an unknown pinned version (pin made against another registry) falls back instead of rendering blank", () => {
    const registryA = createBuiltinRegistry(prov("builtins A"));
    const pins = new PresentationPins();
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("pin"), registryA);
    const registryB = createBuiltinRegistry(prov("builtins B"));
    registryB.transition(LEGACY_TEMPLATE_ID, 1, "deprecated", prov("legacy is old here"));
    // Resolve against a registry that lacks the pinned template entirely:
    const empty = new TemplateRegistry();
    empty.register({ id: LEGACY_TEMPLATE_ID, slot: "authoring", version: 1, status: "published", definition: { layout: "workspace-tabs", panes: [], widgets: [], filters: [] } }, prov("legacy only"));
    const resolved = new PresentationResolver().resolve("authoring", pins, empty);
    assert.equal(resolved.template.id, LEGACY_TEMPLATE_ID);
    assert.ok(resolved.fallbackReason?.includes("unknown template"), resolved.fallbackReason);
  });
});
