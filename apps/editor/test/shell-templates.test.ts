import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_SHELL_TEMPLATE_ID,
  SHELL_TEMPLATE_ID,
  PresentationPins,
  PresentationResolver,
  createBuiltinRegistry,
  interfaceComponentById,
  validateTemplateDefinition,
  type Provenance,
  type ViewTemplateDefinition,
} from "../src/authoring/index.js";
import { composeShell } from "../src/ui/shell-composition.js";

const prov = (why: string): Provenance => ({
  who: { id: "joey", role: "designer" },
  what: "shell slot presentation",
  when: 1_800_000_000_000,
  where: "Editor shell",
  why,
});

const SHELL_COMPONENTS = [
  "shell-menu-bar",
  "shell-workspace-nav",
  "shell-tool-bar",
  "shell-view-tabs",
  "workspace-stage",
  "shell-dock",
  "shell-status-bar",
] as const;

describe("shell slot — T2: the shell renders from the pin", () => {
  it("registers the shell-chrome component types templates may instantiate", () => {
    for (const id of SHELL_COMPONENTS) {
      assert.ok(interfaceComponentById(id), `component "${id}" is registered`);
    }
  });

  it("built-ins register the current shell and the legacy shell, both published v1 for the shell slot and valid", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const current = registry.get(SHELL_TEMPLATE_ID, 1);
    const legacy = registry.get(LEGACY_SHELL_TEMPLATE_ID, 1);
    assert.equal(current?.slot, "shell");
    assert.equal(current?.status, "published");
    assert.equal(legacy?.slot, "shell");
    assert.equal(legacy?.status, "published");
    assert.deepEqual(validateTemplateDefinition(current!), []);
    assert.deepEqual(validateTemplateDefinition(legacy!), []);
  });

  it("with no pin, the shell slot resolves to the legacy shell frame — it never throws and never blanks", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const resolution = new PresentationResolver().resolve("shell", new PresentationPins(), registry);
    assert.equal(resolution.template.id, LEGACY_SHELL_TEMPLATE_ID);
    assert.match(resolution.fallbackReason ?? "", /no pin for slot "shell"/);
  });

  it("resolves the shell from the pin", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const pins = new PresentationPins();
    pins.pin("shell", { templateId: SHELL_TEMPLATE_ID, version: 1 }, prov("pin the current shell"), registry);
    const resolution = new PresentationResolver().resolve("shell", pins, registry);
    assert.equal(resolution.template.id, SHELL_TEMPLATE_ID);
    assert.equal(resolution.fallbackReason, undefined);
  });

  it("a pinned shell template that has since retired falls back to the legacy shell", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    registry.register(
      {
        id: "doomed-shell",
        slot: "shell",
        version: 1,
        status: "published",
        definition: registry.get(SHELL_TEMPLATE_ID, 1)!.definition,
      },
      prov("register doomed shell"),
    );
    const pins = new PresentationPins();
    pins.pin("shell", { templateId: "doomed-shell", version: 1 }, prov("pin doomed shell"), registry);
    registry.transition("doomed-shell", 1, "deprecated", prov("deprecate"));
    registry.transition("doomed-shell", 1, "retired", prov("retire"));
    const resolution = new PresentationResolver().resolve("shell", pins, registry);
    assert.equal(resolution.template.id, LEGACY_SHELL_TEMPLATE_ID);
    assert.match(resolution.fallbackReason ?? "", /retired/);
  });

  it("the current shell composes to exactly today's surfaces, in order", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const composition = composeShell(registry.get(SHELL_TEMPLATE_ID, 1)!.definition);
    assert.deepEqual(composition.regionIds, [
      "shell",
      "shell-top",
      "shell-main",
      "shell-left",
      "shell-center",
      "shell-right",
      "shell-status",
    ]);
    assert.deepEqual(
      composition.panes.map((p) => p.component),
      [
        "shell-menu-bar",
        "shell-workspace-nav",
        "shell-tool-bar",
        "shell-dock",
        "shell-view-tabs",
        "workspace-stage",
        "shell-dock",
        "shell-dock",
        "shell-status-bar",
      ],
    );
    assert.deepEqual(composition.dockSides(), ["left", "bottom", "right"]);
    assert.equal(composition.hasDock("left"), true);
    assert.equal(composition.hasDock("bottom"), true);
    assert.equal(composition.hasDock("right"), true);
    assert.equal(composition.has("shell-workspace-nav"), true);
  });

  it("the legacy shell is the minimal frame: menu bar, stage, status bar — no tool bar, no nav, no docks", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const composition = composeShell(registry.get(LEGACY_SHELL_TEMPLATE_ID, 1)!.definition);
    assert.deepEqual(
      composition.panes.map((p) => p.component),
      ["shell-menu-bar", "workspace-stage", "shell-status-bar"],
    );
    assert.equal(composition.has("shell-tool-bar"), false);
    assert.equal(composition.has("shell-workspace-nav"), false);
    assert.deepEqual(composition.dockSides(), []);
  });

  it("moving the pin changes the composition: a vision shell without the tab bar or docks composes without them", () => {
    const registry = createBuiltinRegistry(prov("builtins"));
    const vision: ViewTemplateDefinition = {
      regions: [
        {
          id: "shell",
          direction: "column",
          children: [
            { id: "shell-top", direction: "row", panes: [{ id: "menu-bar", component: "shell-menu-bar" }] },
            { id: "shell-main", direction: "row", panes: [{ id: "stage", component: "workspace-stage" }] },
            { id: "shell-status", direction: "row", panes: [{ id: "status-bar", component: "shell-status-bar" }] },
          ],
        },
      ],
      widgets: [],
      filters: [],
    };
    registry.register({ id: "vision-shell", slot: "shell", version: 1, status: "published", definition: vision }, prov("register vision shell"));
    const pins = new PresentationPins();
    pins.pin("shell", { templateId: "vision-shell", version: 1 }, prov("pin the vision shell"), registry);
    const resolution = new PresentationResolver().resolve("shell", pins, registry);
    const composition = composeShell(resolution.template.definition);
    assert.equal(composition.has("shell-workspace-nav"), false);
    assert.equal(composition.has("shell-tool-bar"), false);
    assert.deepEqual(composition.dockSides(), []);
    assert.equal(composition.has("workspace-stage"), true);
  });
});
