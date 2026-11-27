/**
 * Writing a new module (roadmap EB8).
 *
 * A module is four things in agreement, and the generator is only worth
 * having if what it writes boots: the manifest's system names and the
 * server entry's keys have to match, the manifest has to pass the
 * registry's own reader, and the route must refuse rather than half-write.
 * These assertions check the generated manifest against
 * `@mmo-engine/modules` itself, not against a copy of its rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModules } from "@mmo-engine/modules";
import { refuseScaffold, scaffoldModule, MODULE_NAME_RE } from "../src/module-scaffold.js";
import { parseList } from "../src/ui/new-module-dialog.js";
import { handleModulesRoute } from "../src/modules-host.js";

const EXISTING = ["core", "combat", "items"];
const REQ = { name: "weather", description: "Storms and seasons.", dependsOn: ["core"], systems: ["storms"], editor: true };

describe("refusals", () => {
  it("accepts a well-formed request", () => {
    assert.deepEqual(refuseScaffold(REQ, EXISTING), []);
  });
  it("refuses a name the registry would not take, and one already taken", () => {
    assert.match(refuseScaffold({ ...REQ, name: "Weather" }, EXISTING)[0].message, /lowercase/);
    assert.match(refuseScaffold({ ...REQ, name: "combat" }, EXISTING)[0].message, /already exists/);
  });
  it("refuses a dependency that is not installed", () => {
    assert.match(refuseScaffold({ ...REQ, dependsOn: ["core", "nope"] }, EXISTING)[0].message, /not installed/);
  });
  it("refuses an empty description, because the panel shows it", () => {
    assert.equal(refuseScaffold({ ...REQ, description: "  " }, EXISTING).length, 1);
  });
  it("refuses two systems with the same name", () => {
    assert.match(refuseScaffold({ ...REQ, systems: ["a", "a"] }, EXISTING)[0].message, /share a name/);
  });
  it("refuses a module that would do nothing at all", () => {
    assert.match(refuseScaffold({ ...REQ, systems: [], editor: false }, EXISTING)[0].message, /would do nothing/);
  });
  it("allows an editor-only module", () => {
    assert.deepEqual(refuseScaffold({ ...REQ, systems: [], editor: true }, EXISTING), []);
  });
});

describe("what it writes", () => {
  const plan = scaffoldModule(REQ);
  it("writes the manifest, the server entry and the editor entry, under the module's own folder", () => {
    assert.deepEqual(plan.files.map((f) => f.path), [
      "modules/weather/module.json",
      "modules/weather/server/index.js",
      "modules/weather/editor/index.tsx",
    ]);
  });
  it("declares exactly the systems the server entry returns", () => {
    const manifest = JSON.parse(plan.files[0].contents) as { server: { systems: Array<{ name: string }> } };
    assert.deepEqual(manifest.server.systems.map((s) => s.name), ["storms"]);
    assert.match(plan.files[1].contents, /"storms": \{/);
  });
  it("leaves out the server block entirely for an editor-only module", () => {
    const only = scaffoldModule({ ...REQ, systems: [], editor: true });
    assert.equal(JSON.parse(only.files[0].contents).server, undefined);
    assert.deepEqual(only.files.map((f) => f.path), ["modules/weather/module.json", "modules/weather/editor/index.tsx"]);
  });
  it("says what is left to do, starting with enabling it", () => {
    assert.match(plan.next[0], /Enable "weather"/);
  });
  it("holds to the same name rule as the registry", () => {
    assert.equal(MODULE_NAME_RE.test("weather-2"), true);
    assert.equal(MODULE_NAME_RE.test("2weather"), false);
  });
});

describe("the route", () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-scaffold-"));
    mkdirSync(join(dir, "modules", "core"), { recursive: true });
    writeFileSync(
      join(dir, "modules", "core", "module.json"),
      JSON.stringify({ name: "core", version: "0.1.0", description: "the engine's own" }),
    );
    return dir;
  };
  const post = (dir: string, body: unknown): Promise<{ status: number; body: any } | null> =>
    handleModulesRoute(dir, "POST", "/api/editor/modules/scaffold", JSON.stringify(body), {
      running: () => null,
      apply: async () => ({}),
    });

  it("writes a module the registry then discovers, with a manifest it accepts", async () => {
    const dir = repo();
    try {
      const reply = await post(dir, REQ);
      assert.equal(reply?.status, 200);
      assert.equal(existsSync(join(dir, "modules", "weather", "module.json")), true);
      const found = discoverModules(join(dir, "modules"));
      assert.deepEqual(found.invalid, [], "the generated manifest is valid by the registry's own reader");
      assert.equal(found.valid.some((m) => m.manifest.name === "weather"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an invalid request with every problem, and writes nothing", async () => {
    const dir = repo();
    try {
      const reply = await post(dir, { ...REQ, name: "Weather", description: "" });
      assert.equal(reply?.status, 400);
      assert.equal(reply?.body.issues.length, 2);
      assert.equal(existsSync(join(dir, "modules", "Weather")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write over a module that is already there", async () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, "modules", "weather"), { recursive: true });
      writeFileSync(join(dir, "modules", "weather", "module.json"), "{ not json");
      const reply = await post(dir, REQ);
      assert.equal(reply?.status, 409);
      assert.equal(readFileSync(join(dir, "modules", "weather", "module.json"), "utf8"), "{ not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers POST only", async () => {
    const dir = repo();
    try {
      const reply = await handleModulesRoute(dir, "GET", "/api/editor/modules/scaffold", undefined, {
        running: () => null,
        apply: async () => ({}),
      });
      assert.equal(reply?.status, 405);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the form's list fields", () => {
  it("takes commas or spaces, and drops the empties", () => {
    assert.deepEqual(parseList(" core, items  weather,"), ["core", "items", "weather"]);
    assert.deepEqual(parseList("   "), []);
  });
});
