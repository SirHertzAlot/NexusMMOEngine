import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverModules,
  readEnabledSet,
  resolveModuleSet,
  validateManifest,
  type DiscoveredModule,
} from "../src/index.js";

const mod = (name: string, extra: Record<string, unknown> = {}): DiscoveredModule => ({
  dir: `/m/${name}`,
  manifest: validateManifest({ name, version: "0.1.0", ...extra }, name).manifest!,
});

describe("validateManifest", () => {
  it("accepts a minimal and a full manifest", () => {
    assert.deepEqual(validateManifest({ name: "a", version: "1.0.0" }, "a").problems, []);
    const full = validateManifest(
      {
        name: "a", version: "1.0.0", description: "d", engine: ">=0.1.0", dependsOn: ["core"],
        editor: { entry: "editor/index.tsx" },
        server: { entry: "server/index.js", systems: [{ name: "s", after: "x", before: ["y", "z"] }] },
      },
      "a",
    );
    assert.deepEqual(full.problems, []);
    assert.deepEqual(full.manifest!.server!.systems[0], { name: "s", after: ["x"], before: ["y", "z"] });
  });
  it("lists every problem at once", () => {
    const { manifest, problems } = validateManifest(
      { name: "Bad Name", version: "x", wat: 1, dependsOn: "core", editor: { entry: "../x.js" }, server: { systems: [{ name: "", nope: 1 }, { name: "d" }, { name: "d" }] } },
      "other",
    );
    assert.equal(manifest, undefined);
    const paths = problems.map((p) => p.path);
    for (const p of ["name", "version", "wat", "dependsOn", "editor.entry", "server.systems[0].name", "server.systems[0].nope", "server.systems[2].name"]) {
      assert.ok(paths.includes(p), `missing problem at ${p}: ${JSON.stringify(paths)}`);
    }
  });
  it("name must match the folder", () => {
    assert.ok(validateManifest({ name: "a", version: "1.0.0" }, "b").problems.some((p) => p.path === "name"));
  });
  it("refuses an engine range the engine does not satisfy", () => {
    assert.deepEqual(validateManifest({ name: "a", version: "1.0.0", engine: ">=0.1.0" }, "a", "0.1.0").problems, []);
    assert.ok(validateManifest({ name: "a", version: "1.0.0", engine: ">=2.0.0" }, "a", "0.1.0").problems.some((p) => p.path === "engine"));
    assert.ok(validateManifest({ name: "a", version: "1.0.0", engine: "~1" }, "a", "0.1.0").problems.some((p) => p.path === "engine"));
  });
});

describe("discoverModules / readEnabledSet", () => {
  it("lists valid and invalid modules, ignoring folders without a manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "mods-"));
    mkdirSync(join(root, "ok"));
    writeFileSync(join(root, "ok", "module.json"), JSON.stringify({ name: "ok", version: "1.0.0" }));
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "module.json"), "{nope");
    mkdirSync(join(root, "wrong"));
    writeFileSync(join(root, "wrong", "module.json"), JSON.stringify({ name: "wrong", version: "1.0.0", extra: 1 }));
    mkdirSync(join(root, "empty"));
    const d = discoverModules(root);
    assert.deepEqual(d.valid.map((m) => m.manifest.name), ["ok"]);
    assert.deepEqual(d.invalid.map((m) => m.name).sort(), ["bad", "wrong"]);
    assert.ok(d.problems.some((p) => p.module === "bad" && /JSON/.test(p.message)));
    assert.deepEqual(discoverModules(join(root, "none")).valid, []);
  });
  it("reads the enabled set; missing file means core only; bad file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "set-"));
    assert.deepEqual(readEnabledSet(join(root, "modules.json")), { modules: ["core"], problems: [] });
    writeFileSync(join(root, "modules.json"), JSON.stringify({ modules: ["core", "a"] }));
    assert.deepEqual(readEnabledSet(join(root, "modules.json")).modules, ["core", "a"]);
    writeFileSync(join(root, "modules.json"), JSON.stringify({ modules: "a", x: 1 }));
    assert.ok(readEnabledSet(join(root, "modules.json")).problems.length >= 2);
  });
});

describe("resolveModuleSet", () => {
  const core = mod("core", { server: { systems: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
  it("keeps the core order exactly and always includes core first", () => {
    const r = resolveModuleSet([core], []);
    assert.ok(r.ok);
    assert.deepEqual(r.systems.map((s) => s.name), ["a", "b", "c"]);
    assert.deepEqual(r.modules.map((m) => m.manifest.name), ["core"]);
  });
  it("places a module system between two core systems", () => {
    const x = mod("x", { dependsOn: ["core"], server: { systems: [{ name: "x1", after: "a", before: "b" }] } });
    const r = resolveModuleSet([core, x], ["x"]);
    assert.ok(r.ok);
    assert.deepEqual(r.systems.map((s) => `${s.module}:${s.name}`), ["core:a", "x:x1", "core:b", "core:c"]);
  });
  it("unconstrained systems keep declaration order after core (stable)", () => {
    const x = mod("x", { server: { systems: [{ name: "x1" }, { name: "x2" }] } });
    const r = resolveModuleSet([core, x], ["x"]);
    assert.ok(r.ok);
    assert.deepEqual(r.systems.map((s) => s.name), ["a", "b", "c", "x1", "x2"]);
  });
  it("disabled modules contribute nothing", () => {
    const x = mod("x", { server: { systems: [{ name: "x1" }] } });
    const r = resolveModuleSet([core, x], ["core"]);
    assert.ok(r.ok);
    assert.deepEqual(r.systems.map((s) => s.name), ["a", "b", "c"]);
  });
  it("refuses unknown ids, with every problem listed", () => {
    const x = mod("x", { server: { systems: [{ name: "x1", after: "ghost", before: "phantom" }] } });
    const r = resolveModuleSet([core, x], ["x"]);
    assert.ok(!r.ok);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0].message, /ghost/);
    assert.match(r.problems[1].message, /phantom/);
  });
  it("refuses a cycle and names it", () => {
    const x = mod("x", { server: { systems: [{ name: "x1", after: "c", before: "a" }] } });
    const r = resolveModuleSet([core, x], ["x"]);
    assert.ok(!r.ok);
    assert.match(r.problems[0].message, /cycle/);
    assert.match(r.problems[0].message, /x1/);
  });
  it("refuses duplicate system ids, unknown modules and missing dependencies", () => {
    const dup = mod("dup", { server: { systems: [{ name: "a" }] } });
    assert.ok(!resolveModuleSet([core, dup], ["dup"]).ok);
    const r1 = resolveModuleSet([core], ["nope"]);
    assert.ok(!r1.ok && /nope/.test(r1.problems[0].message));
    const dep = mod("dep", { dependsOn: ["other"] });
    const other = mod("other");
    const r2 = resolveModuleSet([core, dep, other], ["dep"]);
    assert.ok(!r2.ok && /other/.test(r2.problems[0].message));
    const ok = resolveModuleSet([core, dep, other], ["dep", "other"]);
    assert.ok(ok.ok);
    assert.deepEqual(ok.modules.map((m) => m.manifest.name), ["core", "other", "dep"]);
  });
  it("refuses a dependency cycle", () => {
    const p = mod("p", { dependsOn: ["q"] });
    const q = mod("q", { dependsOn: ["p"] });
    const r = resolveModuleSet([core, p, q], ["p", "q"]);
    assert.ok(!r.ok && /cycle/.test(r.problems[0].message));
  });
});

describe("validateManifest edge (EA12)", () => {
  const good = {
    name: "voice-us-east",
    version: "1.0.0",
    edge: { regions: ["us-east"], endpoint: "wss://voice-us-east.example.com", capabilities: ["voice", "video"] },
  };
  it("accepts a valid edge declaration", () => {
    const r = validateManifest(good, "voice-us-east");
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.manifest!.edge, good.edge);
  });
  it("accepts http/https endpoints too", () => {
    for (const endpoint of ["http://cdn.example.com/assets", "https://lobby.example.com:8443/match"]) {
      const r = validateManifest({ name: "e", version: "1.0.0", edge: { regions: ["eu"], endpoint, capabilities: ["cdn"] } }, "e");
      assert.deepEqual(r.problems, [], endpoint);
    }
  });
  it("rejects bad regions", () => {
    const badRegions: unknown[] = [[], ["US-EAST"], ["us east"], [42], "us-east", undefined];
    for (const regions of badRegions) {
      const raw: Record<string, unknown> = { name: "e", version: "1.0.0", edge: { regions, endpoint: "wss://x.example.com", capabilities: ["voice"] } };
      const r = validateManifest(raw, "e");
      assert.ok(r.problems.some((p) => p.path === "edge.regions"), `regions=${JSON.stringify(regions)}`);
    }
  });
  it("rejects bad endpoints", () => {
    for (const endpoint of ["voice-us-east.example.com", "ftp://x.example.com", "", 42, "wss://"]) {
      const r = validateManifest({ name: "e", version: "1.0.0", edge: { regions: ["us-east"], endpoint, capabilities: ["voice"] } }, "e");
      assert.ok(r.problems.some((p) => p.path === "edge.endpoint"), `endpoint=${JSON.stringify(endpoint)}`);
    }
  });
  it("rejects bad capabilities and unknown edge keys", () => {
    const r1 = validateManifest({ name: "e", version: "1.0.0", edge: { regions: ["us-east"], endpoint: "wss://x.example.com", capabilities: ["voice", ""] } }, "e");
    assert.ok(r1.problems.some((p) => p.path === "edge.capabilities"));
    const r2 = validateManifest({ name: "e", version: "1.0.0", edge: { regions: ["us-east"], endpoint: "wss://x.example.com", capabilities: [], bogus: 1 } }, "e");
    assert.ok(r2.problems.some((p) => p.path === "edge.bogus"));
    // empty capabilities list is fine (a module may declare regions first)
    const r3 = validateManifest({ name: "e", version: "1.0.0", edge: { regions: ["us-east"], endpoint: "wss://x.example.com", capabilities: [] } }, "e");
    assert.deepEqual(r3.problems, []);
  });
  it("lists every edge problem at once", () => {
    const r = validateManifest({ name: "e", version: "1.0.0", edge: { regions: [], endpoint: "nope", capabilities: [7] } }, "e");
    assert.equal(r.manifest, undefined);
    const paths = r.problems.map((p) => p.path);
    assert.deepEqual(paths.sort(), ["edge.capabilities", "edge.endpoint", "edge.regions"]);
  });
});
