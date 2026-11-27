/**
 * The game manifest and its module settings (roadmap EB10).
 *
 * Two things are worth holding here. A manifest is never written as a
 * side effect — only POST writes one, and only when there is none — and
 * what counts as a valid manifest is the SDK's own schema, not a copy of
 * it in the editor, so the editor cannot write a file the server would
 * refuse at boot.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@mmo-engine/modules";
import { handleGameRoute, manifestPath, moduleSettings, newManifest, readManifest } from "../src/game-host.js";
import { settingsOf, withSetting, type ModuleSettingsInfo } from "../src/game-client.js";
import { moduleSummary, parseSetting, settingText } from "../src/ui/game-panel.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** A throwaway game project with one module of its own, and this repo's packages. */
function project(moduleManifest?: Record<string, unknown>, enabled: string[] = ["core", "demo"]): string {
  const dir = mkdtempSync(join(tmpdir(), "mmo-game-"));
  mkdirSync(join(dir, "content"), { recursive: true });
  mkdirSync(join(dir, "modules", "demo"), { recursive: true });
  writeFileSync(
    join(dir, "modules", "demo", "module.json"),
    JSON.stringify(
      moduleManifest ?? {
        name: "demo",
        version: "1.0.0",
        settings: [
          { key: "spawnRate", type: "number", default: 4, min: 1, int: true, label: "Spawns a minute" },
          { key: "mode", type: "enum", options: ["calm", "busy"], default: "calm" },
        ],
      },
    ),
    "utf8",
  );
  writeFileSync(join(dir, "content", "modules.json"), JSON.stringify({ modules: enabled }), "utf8");
  symlinkSync(join(REPO, "packages"), join(dir, "packages"), "dir");
  return dir;
}

const call = (root: string, method: string, body?: unknown): ReturnType<typeof handleGameRoute> =>
  handleGameRoute(root, method, "/api/editor/game", body === undefined ? undefined : JSON.stringify(body));

describe("a project with no manifest", () => {
  it("says there is none rather than inventing one", async () => {
    const root = project();
    const reply = await call(root, "GET");
    const body = reply?.body as { exists: boolean; manifest: unknown; file: string };
    assert.equal(body.exists, false);
    assert.equal(body.manifest, null);
    assert.equal(body.file, manifestPath(root));
    assert.equal(existsSync(manifestPath(root)), false, "reading must not write");
  });

  it("still lists what each module would read", async () => {
    const reply = await call(project(), "GET");
    const { modules } = reply?.body as { modules: ModuleSettingsInfo[] };
    const demo = modules.find((m) => m.module === "demo");
    assert.ok(demo);
    assert.deepEqual(demo.settings.map((s) => s.key), ["spawnRate", "mode"]);
    assert.deepEqual(demo.undeclared, []);
  });

  it("writes one when asked, and only then", async () => {
    const root = project();
    const reply = await call(root, "POST", { name: "Test Game", description: "  a test  " });
    assert.equal(reply?.status, 200, JSON.stringify(reply?.body));
    assert.equal((reply?.body as { exists: boolean }).exists, true, "the panel switches to the editor on this answer alone");
    assert.deepEqual(JSON.parse(readFileSync(manifestPath(root), "utf8")) as unknown, { name: "Test Game", description: "a test" });
  });

  it("puts nothing in a new manifest but what it was given", () => {
    assert.deepEqual(newManifest("A Game"), { name: "A Game" });
    assert.deepEqual(newManifest("A Game", "   "), { name: "A Game" }, "an empty description is no description");
  });

  it("refuses a nameless game", async () => {
    const root = project();
    const reply = await call(root, "POST", { name: "  " });
    assert.equal(reply?.status, 400);
    assert.equal(existsSync(manifestPath(root)), false);
  });
});

describe("a project with a manifest", () => {
  const withManifest = (manifest: Record<string, unknown>): string => {
    const root = project();
    writeFileSync(manifestPath(root), JSON.stringify(manifest), "utf8");
    return root;
  };

  it("never writes over it", async () => {
    const root = withManifest({ name: "Mine" });
    const reply = await call(root, "POST", { name: "Yours" });
    assert.equal(reply?.status, 409);
    assert.match((reply?.body as { error: string }).error, /already there/);
    assert.deepEqual(readManifest(root), { name: "Mine" });
  });

  it("saves module settings through the SDK's schema", async () => {
    const root = withManifest({ name: "Mine" });
    const reply = await call(root, "PUT", { manifest: { name: "Mine", modules: { demo: { spawnRate: 9 } } } });
    assert.equal(reply?.status, 200, JSON.stringify(reply?.body));
    assert.equal((reply?.body as { exists: boolean }).exists, true, "a write answers with the state a read would give");
    assert.deepEqual(readManifest(root), { name: "Mine", modules: { demo: { spawnRate: 9 } } });
  });

  it("refuses what the engine would refuse, and writes nothing", async () => {
    const root = withManifest({ name: "Mine" });
    for (const manifest of [{ modules: {} }, { name: "Mine", nonsense: 1 }, { name: "Mine", paths: { notASeam: "x" } }]) {
      const reply = await call(root, "PUT", { manifest });
      assert.equal(reply?.status, 400, JSON.stringify(manifest));
      assert.ok((reply?.body as { issues: unknown[] }).issues.length > 0);
    }
    assert.deepEqual(readManifest(root), { name: "Mine" }, "the file is untouched");
  });

  it("shows a key the module never declared, and one for a module that is gone", async () => {
    const root = withManifest({ name: "Mine", modules: { demo: { spawnRate: 2, secret: true }, ghost: { x: 1 } } });
    const { modules } = (await call(root, "GET"))?.body as { modules: ModuleSettingsInfo[] };
    assert.deepEqual(modules.find((m) => m.module === "demo")?.undeclared, ["secret"]);
    const ghost = modules.find((m) => m.module === "ghost");
    assert.ok(ghost, "a module the manifest configures but that is not installed is worth seeing");
    assert.equal(ghost.enabled, false);
    assert.deepEqual(ghost.undeclared, ["x"]);
  });

  it("says when the file cannot be read instead of offering to create one", async () => {
    const root = project();
    writeFileSync(manifestPath(root), "{nope", "utf8");
    const body = (await call(root, "GET"))?.body as { exists: boolean; error: string };
    assert.equal(body.exists, true);
    assert.match(body.error, /not valid JSON/);
  });

  it("marks a module that is installed but switched off", async () => {
    const root = project(undefined, ["core"]);
    const rows = moduleSettings(root, undefined);
    assert.equal(rows.find((m) => m.module === "demo")?.enabled, false);
  });
});

describe("a module's settings declaration", () => {
  const manifest = (settings: unknown): ReturnType<typeof validateManifest> =>
    validateManifest({ name: "demo", version: "1.0.0", settings }, "demo");

  it("is optional, and a declared one survives the round trip", () => {
    assert.deepEqual(validateManifest({ name: "demo", version: "1.0.0" }, "demo").manifest?.settings, undefined);
    const ok = manifest([{ key: "spawnRate", type: "number", default: 4, min: 1, max: 10, int: true, label: "Rate", help: "Per minute." }]);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.manifest?.settings, [{ key: "spawnRate", type: "number", default: 4, min: 1, max: 10, int: true, label: "Rate", help: "Per minute." }]);
  });

  it("names what is wrong with it", () => {
    const cases: Array<[unknown, string]> = [
      [[{ key: "1bad", type: "number" }], "settings[0].key"],
      [[{ key: "a", type: "colour" }], "settings[0].type"],
      [[{ key: "a", type: "enum" }], "settings[0].options"],
      [[{ key: "a", type: "number", options: ["x"] }], "settings[0].options"],
      [[{ key: "a", type: "number", default: "four" }], "settings[0].default"],
      [[{ key: "a", type: "enum", options: ["x"], default: "y" }], "settings[0].default"],
      [[{ key: "a", type: "string", min: 1 }], "settings[0].min"],
      [[{ key: "a", type: "number", min: 10, max: 1 }], "settings[0].min"],
      [[{ key: "a", type: "number" }, { key: "a", type: "string" }], "settings[1].key"],
      ["all of them", "settings"],
    ];
    for (const [settings, path] of cases) {
      const r = manifest(settings);
      assert.ok(r.manifest === undefined, `${JSON.stringify(settings)} should be refused`);
      assert.ok(r.problems.some((p) => p.path === path), `${JSON.stringify(settings)} → ${JSON.stringify(r.problems)}`);
    }
  });

  it("refuses a key nobody could write in JSON", () => {
    assert.ok(manifest([{ key: "a b", type: "string" }]).problems.some((p) => p.path === "settings[0].key"));
  });
});

describe("editing a setting", () => {
  const spec = { key: "spawnRate", type: "number" as const, min: 1, int: true };

  it("reads a value back as text, and an unset one as empty", () => {
    assert.equal(settingText(4), "4");
    assert.equal(settingText("calm"), "calm");
    assert.equal(settingText(true), "true");
    assert.equal(settingText(undefined), "");
  });

  it("turns an empty box back into the module's default", () => {
    assert.deepEqual(parseSetting(spec, "  "), { value: undefined });
  });

  it("holds a number to what the module declared", () => {
    assert.deepEqual(parseSetting(spec, "7"), { value: 7 });
    assert.deepEqual(parseSetting(spec, "7.5"), { error: "must be a whole number" });
    assert.deepEqual(parseSetting(spec, "0"), { error: "must be 1 or more" });
    assert.deepEqual(parseSetting(spec, "lots"), { error: "must be a number" });
    assert.deepEqual(parseSetting({ key: "k", type: "number", max: 3 }, "4"), { error: "must be 3 or less" });
  });

  it("reads booleans and enums", () => {
    assert.deepEqual(parseSetting({ key: "k", type: "boolean" }, "true"), { value: true });
    assert.deepEqual(parseSetting({ key: "k", type: "boolean" }, "yes"), { error: "must be true or false" });
    assert.deepEqual(parseSetting({ key: "k", type: "enum", options: ["calm", "busy"] }, "busy"), { value: "busy" });
    assert.deepEqual(parseSetting({ key: "k", type: "enum", options: ["calm"] }, "wild"), { error: "must be one of calm" });
  });

  it("leaves no empty blocks behind when settings go back to their defaults", () => {
    const one = withSetting({ name: "G" }, "demo", "spawnRate", 9);
    assert.deepEqual(one, { name: "G", modules: { demo: { spawnRate: 9 } } });
    const two = withSetting(one, "demo", "mode", "busy");
    assert.deepEqual(settingsOf(two, "demo"), { spawnRate: 9, mode: "busy" });
    const back = withSetting(withSetting(two, "demo", "mode", undefined), "demo", "spawnRate", undefined);
    assert.deepEqual(back, { name: "G" }, "the manifest ends as it started");
  });

  it("says what a module costs a game at a glance", () => {
    const row: ModuleSettingsInfo = { module: "demo", enabled: true, settings: [{ key: "a", type: "string" }, { key: "b", type: "string" }], undeclared: [] };
    assert.equal(moduleSummary(row, {}), "2 settings, none set by this game.");
    assert.equal(moduleSummary(row, { a: "x" }), "2 settings, 1 set here.");
    assert.equal(moduleSummary({ ...row, settings: [] }, {}), "Declares no settings.");
  });
});
