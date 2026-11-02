import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORING_TEMPLATE_ID,
  LEGACY_TEMPLATE_ID,
  PresentationPins,
  PresentationResolver,
  TemplateRegistry,
  createBuiltinRegistry,
  interfaceComponentById,
  retireTemplate,
  validateTemplateDefinition,
  type Provenance,
  type ViewTemplate,
  type ViewTemplateDefinition,
} from "../src/authoring/index.js";

const prov = (why: string): Provenance => ({
  who: { id: "joey", role: "designer" },
  what: "authoring slot presentation",
  when: 1_800_000_000_000,
  where: "Design / Authoring",
  why,
});

const defA: ViewTemplateDefinition = {
  regions: [
    {
      id: "main",
      direction: "row",
      panes: [
        { id: "hierarchy", component: "hierarchy" },
        { id: "stage", component: "stage" },
        { id: "widgets", component: "widgets" },
      ],
    },
  ],
  widgets: ["vendor"],
  filters: ["vendors"],
};
const defB: ViewTemplateDefinition = {
  regions: [
    {
      id: "main",
      direction: "row",
      panes: [
        { id: "hierarchy", component: "hierarchy" },
        { id: "widgets", component: "widgets" },
      ],
    },
  ],
  widgets: ["vendor", "combat"],
  filters: ["vendors"],
};

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
      { id: "broken-view", slot: "authoring", version: 1, status: "published", definition: { regions: [], widgets: ["no-such-widget"], filters: [] } },
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
      { id: "broken-view", slot: "authoring", version: 1, status: "published", definition: { regions: [], widgets: [], filters: ["no-such-filter"] } },
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
    empty.register({ id: LEGACY_TEMPLATE_ID, slot: "authoring", version: 1, status: "published", definition: { regions: [], widgets: [], filters: [] } }, prov("legacy only"));
    const resolved = new PresentationResolver().resolve("authoring", pins, empty);
    assert.equal(resolved.template.id, LEGACY_TEMPLATE_ID);
    assert.ok(resolved.fallbackReason?.includes("unknown template"), resolved.fallbackReason);
  });
});

describe("interface template definition (T1) — regions, component registry, bindings, predicates, actions, Mustache content", () => {
  function customTemplate(definition: ViewTemplateDefinition): ViewTemplate {
    const registry = new TemplateRegistry();
    registry.register({ id: "custom-view", slot: "authoring", version: 1, status: "published", definition }, prov("register custom"));
    return registry.get("custom-view", 1)!;
  }

  it("built-ins are expressed as regions trees whose panes resolve in the component registry, and both validate clean", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const legacy = registry.get(LEGACY_TEMPLATE_ID, 1)!;
    const authoring = registry.get(AUTHORING_TEMPLATE_ID, 1)!;
    assert.deepEqual(validateTemplateDefinition(legacy), []);
    assert.deepEqual(validateTemplateDefinition(authoring), []);
    const root = authoring.definition.regions[0];
    assert.equal(root.children?.length, 3);
    const paneComponents = (root.children ?? []).flatMap((r) => (r.panes ?? []).map((p) => p.component));
    assert.deepEqual(paneComponents, ["hierarchy", "stage", "widgets"]);
    for (const c of paneComponents) assert.ok(interfaceComponentById(c), `component ${c} is registered`);
    assert.equal(legacy.definition.regions[0].panes?.length, 3);
  });

  it("a rich pane — bindings, a compound predicate, a verb action with bound/literal/template args, Mustache content — validates clean", () => {
    const rich: ViewTemplateDefinition = {
      regions: [
        {
          id: "main",
          direction: "row",
          panes: [
            {
              id: "summary",
              component: "content",
              bindings: [
                { name: "selection", source: "editor", path: "selection" },
                { name: "facts", source: "graph", path: "selection.facts" },
              ],
              visibleWhen: { kind: "all", predicates: [{ kind: "hasSelection" }, { kind: "bindingPresent", binding: "facts" }] },
              actions: [
                {
                  id: "spawn",
                  verb: "spawnCreature",
                  label: "Spawn {{selection.name}}",
                  args: { kind: { fromBinding: "selection" }, count: { literal: 1 }, note: { template: "for {{selection.name}}" } },
                },
              ],
              content: { title: "{{selection.name}}", body: "{{#facts.components}}{{name}} {{/facts.components}}", empty: "Nothing selected" },
            },
          ],
        },
      ],
      widgets: [],
      filters: [],
    };
    assert.deepEqual(validateTemplateDefinition(customTemplate(rich)), []);
  });

  it("the resolver refuses a template whose pane references an unknown component, falling back with the reason", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    registry.register(
      { id: "bad-component", slot: "authoring", version: 1, status: "published", definition: { regions: [{ id: "main", panes: [{ id: "x", component: "no-such-component" }] }], widgets: [], filters: [] } },
      prov("register bad component"),
    );
    const pins = new PresentationPins();
    const resolver = new PresentationResolver();
    pins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, prov("known good first"), registry);
    assert.equal(resolver.resolve("authoring", pins, registry).template.id, AUTHORING_TEMPLATE_ID);
    pins.pin("authoring", { templateId: "bad-component", version: 1 }, prov("pin the broken one"), registry);
    const resolved = resolver.resolve("authoring", pins, registry);
    assert.equal(resolved.template.id, AUTHORING_TEMPLATE_ID);
    assert.ok(resolved.fallbackReason?.includes('unknown component "no-such-component"'), resolved.fallbackReason);
  });

  it("duplicate region ids and duplicate pane instance ids are reported", () => {
    const dup: ViewTemplateDefinition = {
      regions: [
        { id: "main", panes: [{ id: "p", component: "content" }] },
        { id: "main", panes: [{ id: "p", component: "content" }] },
      ],
      widgets: [],
      filters: [],
    };
    const problems = validateTemplateDefinition(customTemplate(dup));
    assert.ok(problems.some((p) => p.includes('reuses region id "main"')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes('reuses pane instance id "p"')), problems.join("\n"));
  });

  it("a binding from a source the component does not accept is reported", () => {
    const bad: ViewTemplateDefinition = {
      regions: [{ id: "main", panes: [{ id: "mods", component: "modules-panel", bindings: [{ name: "liveMods", source: "live", path: "modules" }] }] }],
      widgets: [],
      filters: [],
    };
    const problems = validateTemplateDefinition(customTemplate(bad));
    assert.ok(problems.some((p) => p.includes('binding "liveMods"') && p.includes("does not accept")), problems.join("\n"));
  });

  it("predicate, action-verb, and action-arg references to things the pane does not have are reported", () => {
    const bad: ViewTemplateDefinition = {
      regions: [
        {
          id: "main",
          panes: [
            {
              id: "summary",
              component: "content",
              bindings: [{ name: "selection", source: "editor", path: "selection" }],
              visibleWhen: { kind: "bindingPresent", binding: "nope" },
              actions: [{ id: "act", verb: "noSuchVerb", args: { target: { fromBinding: "ghost" } } }],
            },
          ],
        },
      ],
      widgets: [],
      filters: [],
    };
    const problems = validateTemplateDefinition(customTemplate(bad));
    assert.ok(problems.some((p) => p.includes('unknown binding "nope"')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes('unknown verb "noSuchVerb"')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes('unknown binding "ghost"')), problems.join("\n"));
  });

  it("unbalanced Mustache content — an unclosed tag and a never-closed section — is reported", () => {
    const bad: ViewTemplateDefinition = {
      regions: [{ id: "main", panes: [{ id: "c", component: "content", content: { title: "{{selection.name", body: "{{#selection}}never closed" } }] }],
      widgets: [],
      filters: [],
    };
    const problems = validateTemplateDefinition(customTemplate(bad));
    assert.ok(problems.some((p) => p.includes("content.title") && p.includes("unclosed")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("content.body") && p.includes("never closed")), problems.join("\n"));
  });
});
