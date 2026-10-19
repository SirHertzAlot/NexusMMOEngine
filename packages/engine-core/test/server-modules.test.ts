import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assembleServerSystems } from "../src/modules.js";
import type { SimSystem } from "../src/systems.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const MODULES = join(REPO, "modules");

/** server.ts's systems array before EA9, by manifest id. */
const LEGACY_ORDER = [
  "reloader", "stats", "streamer", "bots", "creatures", "crowd", "intent", "combat", "magic", "body", "death",
  "abilities", "status", "telegraphs", "duels", "stamina", "needs", "mastery", "integrate", "character",
  "collider", "obstacles", "physics", "navigation", "items", "quests",
];

const fake = (name: string): SimSystem => ({ name, step() {} });
const coreProvided = (skip: string[] = []): Record<string, SimSystem | undefined> =>
  Object.fromEntries(LEGACY_ORDER.map((n) => [n, skip.includes(n) ? undefined : fake(n)]));
const ctx = { sim: {} as never, log: () => {} };
const setFile = (modules: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-set-"));
  const f = join(dir, "modules.json");
  writeFileSync(f, JSON.stringify({ modules }));
  return f;
};

describe("server modules: the core module", () => {
  it("reproduces server.ts's systems order exactly", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: coreProvided() }, ctx });
    assert.deepEqual(r.systems.map((s) => s.name), LEGACY_ORDER);
    assert.deepEqual(r.order.map((s) => s.name), LEGACY_ORDER);
  });
  it("skips core systems the host did not build (no bots, no crowd), keeping the rest in order", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: coreProvided(["bots", "crowd"]) }, ctx });
    assert.deepEqual(r.systems.map((s) => s.name), LEGACY_ORDER.filter((n) => n !== "bots" && n !== "crowd"));
  });
  it("refuses an instance the manifest does not list", async () => {
    await assert.rejects(
      assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: { ...coreProvided(), rogue: fake("rogue") } }, ctx }),
      /rogue/,
    );
  });
});

describe("server modules: the sample module", () => {
  it("adds its system between crowd and intent, leaving the core order intact", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core", "sample-heartbeat"]), provided: { core: coreProvided() }, ctx });
    const names = r.systems.map((s) => s.name);
    assert.deepEqual(names.filter((n) => n !== "sample-heartbeat"), LEGACY_ORDER);
    assert.equal(names.indexOf("sample-heartbeat"), LEGACY_ORDER.indexOf("intent"));
    assert.deepEqual(r.modules, ["core", "sample-heartbeat"]);
  });
  it("is gone when disabled", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core", "characters"]), provided: { core: coreProvided() }, ctx });
    assert.ok(!r.systems.some((s) => s.name === "sample-heartbeat"));
  });
  it("its system actually runs", async () => {
    const logs: string[] = [];
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["sample-heartbeat"]), provided: { core: coreProvided() }, ctx: { sim: {} as never, log: (m) => logs.push(m) } });
    const hb = r.systems.find((s) => s.name === "sample-heartbeat")!;
    for (let i = 0; i < 1200; i++) hb.step({} as never, 1 / 30);
    assert.equal(logs.length, 2);
  });
});

describe("server modules: refusals", () => {
  const temp = (mods: Record<string, unknown>, entries: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-mods-"));
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: LEGACY_ORDER.map((name) => ({ name })) } })), ...mods })) {
      mkdirSync(join(root, n, "server"), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
      if (entries[n]) writeFileSync(join(root, n, "server", "index.js"), entries[n]);
    }
    return root;
  };
  const sys = `export function createSystems(){ return { x: { name: "x", step(){} } }; }`;
  const mod = (extra: object) => ({ name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x", ...extra }] } });

  it("a cycle stops the boot and names it", async () => {
    const root = temp({ m: mod({ after: "quests", before: "reloader" }) }, { m: sys });
    await assert.rejects(assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }), /cycle/);
  });
  it("an unknown id stops the boot and names it", async () => {
    const root = temp({ m: mod({ after: "ghost" }) }, { m: sys });
    await assert.rejects(assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }), /ghost/);
  });
  it("an entry that does not provide its declared system is refused", async () => {
    const root = temp({ m: mod({}) }, { m: `export function createSystems(){ return {}; }` });
    await assert.rejects(assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }), /does not provide "x"/);
  });
  it("an enabled module that is not installed is refused", async () => {
    await assert.rejects(assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["nope"]), provided: { core: coreProvided() }, ctx }), /nope/);
  });
  it("a bad set file is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-set-"));
    writeFileSync(join(dir, "modules.json"), "{");
    await assert.rejects(assembleServerSystems({ modulesDir: MODULES, setFile: join(dir, "modules.json"), provided: { core: coreProvided() }, ctx }), /not valid JSON/);
  });
});

describe("server modules: native entries (EA10)", () => {
  const nativeTemp = (manifest: Record<string, unknown>, createNodeFile: boolean): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-nmod-"));
    const coreManifest = { name: "core", version: "0.1.0", server: { systems: LEGACY_ORDER.map((name) => ({ name })) } };
    mkdirSync(join(root, "core", "server"), { recursive: true });
    writeFileSync(join(root, "core", "module.json"), JSON.stringify(coreManifest));
    mkdirSync(join(root, "n", "build", "Release"), { recursive: true });
    writeFileSync(join(root, "n", "module.json"), JSON.stringify({ name: "n", version: "0.1.0", ...manifest }));
    if (createNodeFile) writeFileSync(join(root, "n", "build", "Release", "fake.node"), "stub");
    return root;
  };
  const nativeManifest = { native: { entry: "build/Release/fake.node", systems: ["nat1"] } };
  const stubRequire = (systems: Record<string, SimSystem>) => (_p: string) => ({ createSystems: () => systems });

  it("loads native systems into the tick order via injected require", async () => {
    const root = nativeTemp(nativeManifest, true);
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["n"]),
      provided: { core: coreProvided() },
      ctx,
      nativeRequire: stubRequire({ nat1: fake("nat1") }),
    });
    const names = r.systems.map((s) => s.name);
    assert.deepEqual(names, [...LEGACY_ORDER, "nat1"]);
    assert.deepEqual(r.modules, ["core", "n"]);
  });
  it("a missing .node file disables the module with a clear error, boot continues", async () => {
    const root = nativeTemp(nativeManifest, false);
    const logs: string[] = [];
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["n"]),
      provided: { core: coreProvided() },
      ctx: { sim: {} as never, log: (m: string) => logs.push(m) },
      nativeRequire: stubRequire({ nat1: fake("nat1") }),
    });
    assert.deepEqual(r.systems.map((s) => s.name), LEGACY_ORDER);
    assert.ok(!r.modules.includes("n"));
    assert.ok(logs.some((m) => /not found.*build:native/.test(m)), JSON.stringify(logs));
  });
  it("a native entry without createSystems is refused", async () => {
    const root = nativeTemp(nativeManifest, true);
    await assert.rejects(
      assembleServerSystems({
        modulesDir: root,
        setFile: setFile(["n"]),
        provided: { core: coreProvided() },
        ctx,
        nativeRequire: (_p: string) => ({}),
      }),
      /must export createSystems/,
    );
  });
  it("a native entry that does not provide its declared system is refused", async () => {
    const root = nativeTemp(nativeManifest, true);
    await assert.rejects(
      assembleServerSystems({
        modulesDir: root,
        setFile: setFile(["n"]),
        provided: { core: coreProvided() },
        ctx,
        nativeRequire: stubRequire({}),
      }),
      /does not provide "nat1"/,
    );
  });
});

describe("server modules: gateway extensions (slice 3/4 contract)", () => {
  const temp = (mods: Record<string, unknown>, entries: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-mods-"));
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: LEGACY_ORDER.map((name) => ({ name })) } })), ...mods })) {
      mkdirSync(join(root, n, "server"), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
      if (entries[n]) writeFileSync(join(root, n, "server", "index.js"), entries[n]);
    }
    return root;
  };

  it("a declared extension lands in extensions, never in the tick systems or byName", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [], extensions: ["ext1"] } } },
      { m: `export function createSystems(){ return { ext1: { hello: "world" } }; }` },
    );
    const r = await assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx });
    assert.deepEqual(r.extensions["ext1"], { hello: "world" });
    assert.ok(!r.systems.some((s) => s.name === "ext1"));
    assert.equal(r.byName["ext1"], undefined);
  });

  it("an entry that does not provide its declared extension is refused", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [], extensions: ["ext1"] } } },
      { m: `export function createSystems(){ return {}; }` },
    );
    await assert.rejects(
      assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }),
      /does not provide extension "ext1"/,
    );
  });

  it("a returned key in neither systems nor extensions is still refused", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [], extensions: ["ext1"] } } },
      { m: `export function createSystems(){ return { ext1: {}, rogue: {} }; }` },
    );
    await assert.rejects(
      assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }),
      /provides "rogue"/,
    );
  });
});

describe("server modules: optional systems", () => {
  const temp = (mods: Record<string, unknown>, entries: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-mods-"));
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: LEGACY_ORDER.map((name) => ({ name })) } })), ...mods })) {
      mkdirSync(join(root, n, "server"), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
      if (entries[n]) writeFileSync(join(root, n, "server", "index.js"), entries[n]);
    }
    return root;
  };

  it("an omitted optional system assembles fine and stays out of the tick systems and byName", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x" }, { name: "opt", optional: true }] } } },
      { m: `export function createSystems(){ return { x: { name: "x", step(){} } }; }` },
    );
    const r = await assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx });
    const names = r.systems.map((s) => s.name);
    assert.ok(names.includes("x"));
    assert.ok(!names.includes("opt"));
    assert.deepEqual(names.filter((n) => n !== "x"), LEGACY_ORDER);
    assert.equal(r.byName["opt"], undefined);
  });

  it("an omitted required system is still refused", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x" }, { name: "opt", optional: true }] } } },
      { m: `export function createSystems(){ return { opt: { name: "opt", step(){} } }; }` },
    );
    await assert.rejects(
      assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: coreProvided() }, ctx }),
      /does not provide "x"/,
    );
  });
});

describe("server modules: edge routes (EA12)", () => {
  const temp = (mods: Record<string, unknown>): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-edge-"));
    for (const [n, m] of Object.entries(mods)) {
      mkdirSync(join(root, n), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
    }
    return root;
  };

  it("merges local:<module> routes for enabled modules with edge contributions", async () => {
    const root = temp({
      core: { name: "core", version: "0.1.0", server: { systems: [] } },
      chat: {
        name: "chat",
        version: "0.1.0",
        server: { systems: [] },
        edge: { regions: ["us-east"], endpoint: "http://localhost:9001", capabilities: ["chat-relay"] },
      },
      quests: {
        name: "quests",
        version: "0.1.0",
        server: { systems: [] },
        edge: { regions: ["us-east", "eu-west"], endpoint: "http://localhost:9002", capabilities: ["quest-sync", "dialog"] },
      },
      plain: { name: "plain", version: "0.1.0", server: { systems: [] } },
    });
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["core", "chat", "quests", "plain"]),
      provided: {},
      ctx,
    });
    assert.deepEqual(r.edgeRoutes, {
      "local:chat": { regions: ["us-east"], endpoint: "http://localhost:9001", capabilities: ["chat-relay"] },
      "local:quests": { regions: ["us-east", "eu-west"], endpoint: "http://localhost:9002", capabilities: ["quest-sync", "dialog"] },
    });
  });

  it("omits edge routes for disabled modules", async () => {
    const root = temp({
      core: { name: "core", version: "0.1.0", server: { systems: [] } },
      chat: {
        name: "chat",
        version: "0.1.0",
        server: { systems: [] },
        edge: { regions: ["us-east"], endpoint: "http://localhost:9001", capabilities: ["chat-relay"] },
      },
    });
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["core"]),
      provided: {},
      ctx,
    });
    assert.deepEqual(r.edgeRoutes, {});
  });

  it("returns empty edgeRoutes when no module has an edge contribution", async () => {
    const root = temp({
      core: { name: "core", version: "0.1.0", server: { systems: [] } },
      plain: { name: "plain", version: "0.1.0", server: { systems: [] } },
    });
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["core", "plain"]),
      provided: {},
      ctx,
    });
    assert.deepEqual(r.edgeRoutes, {});
  });
});
