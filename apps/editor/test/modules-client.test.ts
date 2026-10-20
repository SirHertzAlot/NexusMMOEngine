import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModuleRegistry, loadersFromGlob, type ModulesState } from "../src/modules-client.js";

const state = (enabled: string[], extra: Partial<ModulesState> = {}): ModulesState => ({
  modules: ["core", "chars", "other"].map((name) => ({
    name, version: "0.1.0", description: "", dependsOn: [], enabled: enabled.includes(name), locked: name === "core", editor: name !== "core", systems: [],
  })),
  invalid: [], enabled, problems: [], tickOrder: [], running: null, ...extra,
});
const panel = (id: string, workspace: string) => ({ id, workspace, title: id, icon: "x", render: () => id });

describe("ModuleRegistry", () => {
  it("contributes the panels of enabled editor modules only", async () => {
    let enabled = ["core", "chars", "other"];
    const loads: string[] = [];
    const reg = new ModuleRegistry(
      {
        chars: async () => { loads.push("chars"); return { panels: [panel("chars.records", "characters")] }; },
        other: async () => { loads.push("other"); return { panels: [panel("other.p", "scene")] }; },
      },
      async () => state(enabled),
    );
    await reg.refresh();
    assert.deepEqual(reg.panels("characters").map((p) => p.id), ["chars.records"]);
    assert.deepEqual(reg.panels("scene").map((p) => p.id), ["other.p"]);
    assert.deepEqual(reg.panels("world"), []);
    enabled = ["core", "other"];
    await reg.refresh();
    assert.deepEqual(reg.panels("characters"), [], "disabling removes the panel without a restart");
    enabled = ["core", "chars", "other"];
    await reg.refresh();
    assert.equal(reg.panels("characters").length, 1);
    assert.deepEqual(loads, ["chars", "other"], "each entry is imported once");
  });
  it("notifies subscribers on refresh and stops after unsubscribe", async () => {
    const reg = new ModuleRegistry({}, async () => state(["core"]));
    let n = 0;
    const off = reg.subscribe(() => n++);
    await reg.refresh();
    off();
    await reg.refresh();
    assert.equal(n, 1);
  });
  it("a failing entry is reported and does not take the others down", async () => {
    const reg = new ModuleRegistry(
      { chars: async () => { throw new Error("syntax error"); }, other: async () => ({ panels: [panel("o", "scene")] }) },
      async () => state(["core", "chars", "other"]),
    );
    await reg.refresh();
    assert.deepEqual(reg.panels("scene").map((p) => p.id), ["o"]);
    assert.match(reg.errors.chars, /syntax error/);
  });
  it("keeps the last state when the host cannot be reached", async () => {
    let fail = false;
    const reg = new ModuleRegistry({}, async () => { if (fail) throw new Error("down"); return state(["core"]); });
    await reg.refresh();
    fail = true;
    await reg.refresh();
    assert.equal(reg.state?.enabled.length, 1);
    assert.match(reg.errors["(host)"], /down/);
  });
});

describe("loadersFromGlob", () => {
  it("maps modules/<name>/editor/ paths to module names", () => {
    const l = loadersFromGlob({
      "../../../../modules/characters/editor/index.tsx": async () => ({ panels: [] }),
      "/x/modules/foo-bar/editor/index.ts": async () => ({ panels: [] }),
      "/x/other/index.ts": async () => ({}),
    });
    assert.deepEqual(Object.keys(l).sort(), ["characters", "foo-bar"]);
  });
});

describe("EA13: migrated tool modules", () => {
  // The six editor panels migrated from hardcoded WORKSPACES views to modules.
  const MIGRATED = [
    { name: "scenes", workspace: "scenes", panel: "scenes.document" },
    { name: "flow", workspace: "flow", panel: "flow.graph" },
    { name: "story", workspace: "story", panel: "story.editor" },
    { name: "vfx", workspace: "artaudio", panel: "vfx.editor" },
    { name: "audio", workspace: "artaudio", panel: "audio.panel" },
    { name: "hud", workspace: "release", panel: "hud.editor" },
  ] as const;
  // Complete-modularity: the remaining hardcoded WORKSPACES views migrated
  // to modules. Panel ids preserve the pre-module view ids so saved
  // layouts keep working.
  const MIGRATED2 = [
    { name: "terrain", workspace: "world", panels: ["terrain"] },
    { name: "ecs", workspace: "scene", panels: ["ecs"] },
    { name: "gameplay", workspace: "gameplay", panels: ["grids", "content", "tables", "rules"] },
    { name: "dungeons", workspace: "dungeons", panels: ["dungeons", "graphs"] },
    { name: "liveops", workspace: "liveops", panels: ["overview", "console", "telemetry"] },
    { name: "network", workspace: "network", panels: ["routes", "connections"] },
    { name: "debug", workspace: "debug", panels: ["play"] },
    { name: "changes", workspace: "changes", panels: ["changes"] },
    { name: "database", workspace: "database", panels: ["grid", "query", "audit"] },
    { name: "story", workspace: "story", panels: ["quests", "strings"] },
    { name: "art", workspace: "artaudio", panels: ["assets", "materials"] },
    { name: "characters", workspace: "artaudio", panels: ["animation"] },
    { name: "release", workspace: "release", panels: ["pipeline", "playtests"] },
    { name: "core", workspace: "modules", panels: ["modules"] },
  ] as const;
  const repo = new URL("../../../../", import.meta.url);
  const modDir = (n: string): string => fileURLToPath(new URL(`modules/${n}/`, repo));

  it("every migrated module has a valid manifest with an editor entry", async () => {
    const { validateManifest } = await import("@mmo-engine/modules");
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const m of MIGRATED) {
      const raw = JSON.parse(readFileSync(join(modDir(m.name), "module.json"), "utf8"));
      const { manifest, problems } = validateManifest(raw, m.name);
      assert.deepEqual(problems, [], `${m.name}: ${JSON.stringify(problems)}`);
      assert.ok(manifest!.editor, `${m.name} must contribute an editor entry`);
      assert.ok(existsSync(join(modDir(m.name), manifest!.editor!.entry)), `${m.name}: editor entry file must exist`);
    }
  });
  it("all six are enabled by default in content/modules.json", async () => {
    const { readEnabledSet } = await import("@mmo-engine/modules");
    const set = readEnabledSet(fileURLToPath(new URL("content/modules.json", repo)));
    assert.deepEqual(set.problems, []);
    for (const m of MIGRATED) assert.ok(set.modules.includes(m.name), `${m.name} must be enabled by default`);
  });
  it("the registry serves each migrated panel to its workspace", async () => {
    const names = ["core", ...MIGRATED.map((m) => m.name)];
    const st: ModulesState = {
      modules: names.map((name) => ({
        name, version: "0.1.0", description: "", dependsOn: [], enabled: true,
        locked: name === "core", editor: name !== "core", systems: [],
      })),
      invalid: [], enabled: names, problems: [], tickOrder: [], running: null,
    };
    const reg = new ModuleRegistry(
      Object.fromEntries(
        MIGRATED.map((m) => [m.name, async () => ({ panels: [panel(m.panel, m.workspace)] })]),
      ),
      async () => st,
    );
    await reg.refresh();
    for (const m of MIGRATED) {
      assert.ok(reg.panels(m.workspace).some((p) => p.id === m.panel), `${m.panel} must reach workspace ${m.workspace}`);
    }
  });

  it("every complete-modularity panel module has a valid manifest with an editor entry", async () => {
    const { validateManifest } = await import("@mmo-engine/modules");
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const m of MIGRATED2) {
      const raw = JSON.parse(readFileSync(join(modDir(m.name), "module.json"), "utf8"));
      const { manifest, problems } = validateManifest(raw, m.name);
      assert.deepEqual(problems, [], `${m.name}: ${JSON.stringify(problems)}`);
      assert.ok(manifest!.editor, `${m.name} must contribute an editor entry`);
      assert.ok(existsSync(join(modDir(m.name), manifest!.editor!.entry)), `${m.name}: editor entry file must exist`);
    }
  });
  it("all complete-modularity panel modules are enabled by default in content/modules.json", async () => {
    const { readEnabledSet } = await import("@mmo-engine/modules");
    const set = readEnabledSet(new URL("content/modules.json", repo).pathname);
    assert.deepEqual(set.problems, []);
    for (const m of MIGRATED2) assert.ok(set.modules.includes(m.name), `${m.name} must be enabled by default`);
  });
  it("no workspace keeps a hardcoded panel view in App.tsx", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/ui/App.tsx", import.meta.url).pathname, "utf8");
    // The WORKSPACES table must not construct panel elements inline anymore;
    // panels arrive through the module registry. (The tab bar below still
    // references panel components directly — that is navigation, not the
    // workspace view map.)
    const table = src.slice(src.indexOf("const WORKSPACES"), src.indexOf("const OWN_VIEWS"));
    assert.ok(!table.includes("kind: \"panel\""), "WORKSPACES must not hardcode panel views");
    assert.ok(!table.includes("<TerrainEditorPanel"), "terrain view must come from the terrain module");
    assert.ok(!table.includes("<DatabaseGridPanel"), "database views must come from the database module");
  });
});
