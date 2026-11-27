import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ENGINE_ROOT, openGameProject } from "@mmo-engine/sdk";
import { assembleServerSystems, mergeModuleConfig } from "../src/modules.js";
import { discoverModules, resolveModuleSet } from "@mmo-engine/modules";
import type { SimSystem } from "../src/systems.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const MODULES = join(REPO, "modules");

/**
 * The systems the core module itself declares (modules/core/module.json), in
 * tick order. The rest of the old server.ts list moved out into the modules
 * that own them (combat, creatures, physics, ...), each building its own
 * systems; core only holds what server.ts still builds for the whole host.
 *
 * `gathering` left for its own module at `ES5k`, and ticks back in its old
 * place through the `after`/`before` edges that module declares — which is
 * what the order test below pins.
 */
const CORE_ORDER = ["reloader", "streamer", "chests", "breaks", "collapse"];

/** content/rules/gathering.json, enough of it for the module to open. */
const GATHERING_RULES = { reachM: 2.5, cooldownSeconds: 1.2, castSeconds: 2, pouchMax: 999, trainDifficultyPerTier: 0.2 };

const fake = (name: string): SimSystem => ({ name, step() {} });
const coreProvided = (skip: string[] = []): Record<string, SimSystem | undefined> =>
  Object.fromEntries(CORE_ORDER.map((n) => [n, skip.includes(n) ? undefined : fake(n)]));
const ctx = { sim: {} as never, log: () => {} };
const setFile = (modules: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-set-"));
  const f = join(dir, "modules.json");
  writeFileSync(f, JSON.stringify({ modules }));
  return f;
};

describe("server modules: the core module", () => {
  it("reproduces the core module's systems order exactly", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: coreProvided() }, ctx });
    assert.deepEqual(r.systems.map((s) => s.name), CORE_ORDER);
    assert.deepEqual(r.order.map((s) => s.name), CORE_ORDER);
  });
  it("skips core systems the host did not build, keeping the rest in order", async () => {
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: coreProvided(["chests", "auction"]) }, ctx });
    assert.deepEqual(r.systems.map((s) => s.name), CORE_ORDER.filter((n) => n !== "chests" && n !== "auction"));
  });
  it("refuses an instance the manifest does not list", async () => {
    await assert.rejects(
      assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["core"]), provided: { core: { ...coreProvided(), rogue: fake("rogue") } }, ctx }),
      /rogue/,
    );
  });
  it("is enough to boot with the repo's own module set's core", async () => {
    // The real set also loads the modules that own combat, creatures, physics...
    // (their own tests cover those); here only that core's manifest and the host's
    // instances agree, which is what a drifting manifest breaks.
    const listed = JSON.parse(readFileSync(join(MODULES, "core", "module.json"), "utf8")).server.systems.map((s: { name: string }) => s.name);
    assert.deepEqual(listed, CORE_ORDER);
  });
});

/**
 * The whole tick, as the repo's own module set resolves it (`ES5k`).
 *
 * The order tests above each check one module's list. This one is the only
 * thing that catches the order *between* modules, and it is here because
 * `ES5k` broke it and nothing noticed: moving `gathering` out of `core`
 * dropped it — and, through its `before: chests` edge, `chests`, `breaks`
 * and `collapse` with it — from third in the tick to the far end, past
 * physics, combat and intent. Kahn's algorithm takes the lowest ready
 * declaration index, and a module declared late in `content/modules.json`
 * has late indices, so where a module *sits in the set* decides where a
 * freely-ordered system ticks. `gathering` is listed right after `core` for
 * exactly that reason.
 *
 * Update this list when a change is meant to move the tick, and read it
 * carefully when a change is not.
 */
const TICK_ORDER = [
  "reloader", "streamer", "gathering", "chests", "breaks", "collapse",
  "wallet", "trade", "vendor", "auction", "items",
  "character", "animation", "mastery", "stats",
  "stamina", "body", "magic", "abilities", "status", "telegraphs", "duels", "combat", "death",
  "physics", "navigation", "obstacles", "integrate", "character-bridge", "prop-collision", "collider",
  "creatures", "bots", "crowd", "needs", "residents", "intent", "civic",
];

describe("server modules: the repo's own set", () => {
  it("resolves the whole tick in the order the open world runs", () => {
    const found = discoverModules(MODULES);
    const enabled = (JSON.parse(readFileSync(join(REPO, "content", "modules.json"), "utf8")) as { modules: string[] }).modules;
    const r = resolveModuleSet(found.valid, enabled);
    assert.ok(r.ok, `the repo's own module set should resolve: ${JSON.stringify(r.ok ? [] : r.problems.slice(0, 3))}`);
    if (!r.ok) return;
    assert.deepEqual(r.systems.map((s) => s.name), TICK_ORDER);
  });
});

describe("server modules: the gathering module (ES5k)", () => {
  // `gathering` used to be one of core's six, built by server.ts. It is a
  // module now, which moves where it is *declared* but must not move where
  // it *ticks*: a node's regrow and a pouch write between the streamer and
  // the chests is the order the open world has always run. The module says
  // so with `after: streamer` / `before: chests`, and this is the pin.
  it("ticks back in its old place, between the streamer and the chests", async () => {
    const r = await assembleServerSystems({
      modulesDir: MODULES,
      setFile: setFile(["core", "gathering"]),
      provided: { core: coreProvided() },
      ctx: { ...ctx, config: { gathering: { dataDir: mkdtempSync(join(tmpdir(), "mmo-gathering-")), rules: GATHERING_RULES } } },
    });
    assert.deepEqual(r.systems.map((s) => s.name), ["reloader", "streamer", "gathering", "chests", "breaks", "collapse"]);
  });
  it("hands the host what the world record needs, and nothing else", async () => {
    // The pouch and the node stocks ride a character's record and the range
    // snapshot (PL3b, PL3a). The host carries them without reading inside,
    // so the module publishes the three calls and validates on its own side.
    const dataDir = mkdtempSync(join(tmpdir(), "mmo-gathering-"));
    const stores: Record<string, unknown> = {};
    const r = await assembleServerSystems({
      modulesDir: MODULES,
      setFile: setFile(["core", "gathering"]),
      provided: { core: coreProvided() },
      ctx: { ...ctx, stores, config: { gathering: { dataDir, rules: GATHERING_RULES, recalledNodes: () => [{ key: "vein-1", stock: 2, regrowAt: null }, { key: "bad" }] } } },
    });
    const records = stores["gatheringRecords"] as {
      loadPouch(id: number): Record<string, number>;
      replacePouch(id: number, pouch: unknown): void;
      allNodes(): readonly unknown[];
    };
    assert.deepEqual(Object.keys(records).sort(), ["allNodes", "loadPouch", "replacePouch"]);
    // The recalled rows were seeded as the store opened, and the row that is
    // not a node stock was dropped rather than stored or thrown over.
    assert.deepEqual(records.allNodes(), [{ key: "vein-1", stock: 2, regrowAt: null }]);
    // A recalled pouch comes in as whatever the record held; the module keeps
    // the whole counts and drops the rest.
    records.replacePouch(7, { oak: 3, nonsense: -1, fractional: 0.5 });
    assert.deepEqual(records.loadPouch(7), { oak: 3 });
    await r.disposeModules();
  });
});

describe("server modules: the sample module", () => {
  // The real sample module, slotted between two stand-in modules that declare
  // "crowd" and "intent" (the creatures and intent modules need a booted sim).
  const sampleRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-sample-"));
    const put = (name: string, manifest: unknown, entry?: string): void => {
      mkdirSync(join(root, name, "server"), { recursive: true });
      writeFileSync(join(root, name, "module.json"), JSON.stringify(manifest));
      if (entry) writeFileSync(join(root, name, "server", "index.js"), entry);
    };
    put("core", JSON.parse(readFileSync(join(MODULES, "core", "module.json"), "utf8")));
    const stub = (id: string): string => `export function createSystems(){ return { ${id}: { name: "${id}", step(){} } }; }`;
    put("crowd-stub", { name: "crowd-stub", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "crowd" }] } }, stub("crowd"));
    put("intent-stub", { name: "intent-stub", version: "0.1.0", dependsOn: ["crowd-stub"], server: { entry: "server/index.js", systems: [{ name: "intent", after: "crowd" }] } }, stub("intent"));
    const real = join(MODULES, "sample-heartbeat");
    put("sample-heartbeat", JSON.parse(readFileSync(join(real, "module.json"), "utf8")), readFileSync(join(real, "server", "index.js"), "utf8"));
    return root;
  };
  const SET = ["core", "crowd-stub", "intent-stub", "sample-heartbeat"];
  it("adds its system between crowd and intent, leaving the core order intact", async () => {
    const r = await assembleServerSystems({ modulesDir: sampleRoot(), setFile: setFile(SET), provided: { core: coreProvided() }, ctx });
    const names = r.systems.map((s) => s.name);
    assert.deepEqual(names.filter((n) => !["sample-heartbeat", "crowd", "intent"].includes(n)), CORE_ORDER);
    assert.equal(names.indexOf("sample-heartbeat"), names.indexOf("crowd") + 1);
    assert.equal(names.indexOf("sample-heartbeat"), names.indexOf("intent") - 1);
    assert.deepEqual(r.modules.sort(), [...SET].sort());
  });
  it("is gone when disabled", async () => {
    const r = await assembleServerSystems({ modulesDir: sampleRoot(), setFile: setFile(SET.filter((n) => n !== "sample-heartbeat")), provided: { core: coreProvided() }, ctx });
    assert.ok(!r.systems.some((s) => s.name === "sample-heartbeat"));
  });
  it("its system actually runs", async () => {
    const logs: string[] = [];
    const r = await assembleServerSystems({ modulesDir: sampleRoot(), setFile: setFile(SET), provided: { core: coreProvided() }, ctx: { sim: {} as never, log: (m) => logs.push(m) } });
    const hb = r.systems.find((s) => s.name === "sample-heartbeat")!;
    for (let i = 0; i < 1200; i++) hb.step({} as never, 1 / 30);
    // Its interval at boot, then one line per 600 ticks.
    assert.deepEqual(logs, ["[sample-heartbeat] every 600 ticks", "[sample-heartbeat] 600 ticks", "[sample-heartbeat] 1200 ticks"]);
  });

  it("takes its interval from a game's settings (ES4)", async () => {
    const logs: string[] = [];
    const r = await assembleServerSystems({
      modulesDir: sampleRoot(),
      setFile: setFile(SET),
      provided: { core: coreProvided() },
      ctx: { sim: {} as never, log: (m) => logs.push(m), config: { "sample-heartbeat": { everyTicks: 45 } } },
    });
    const hb = r.systems.find((s) => s.name === "sample-heartbeat")!;
    for (let i = 0; i < 135; i++) hb.step({} as never, 1 / 30);
    assert.deepEqual(logs, [
      "[sample-heartbeat] every 45 ticks",
      "[sample-heartbeat] 45 ticks",
      "[sample-heartbeat] 90 ticks",
      "[sample-heartbeat] 135 ticks",
    ]);
  });
});

/**
 * ES4: a game's `game.json` `modules` block reaches a module through
 * `ctx.config`, end to end — the resolver reads the manifest, the merge
 * layers it under the host's own wiring, and the module's entry sees the
 * result.
 */
describe("server modules: settings from game.json", () => {
  const readsConfig = `export function createSystems(ctx){
  const c = ctx.config?.m ?? {};
  return { x: { name: "x", seen: { ...c }, step(){} } };
}`;
  const temp = (): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-cfg-"));
    for (const [n, m] of [
      ["core", { name: "core", version: "0.1.0", server: { systems: CORE_ORDER.map((name) => ({ name })) } }],
      ["m", { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x" }] } }],
    ] as [string, object][]) {
      mkdirSync(join(root, n, "server"), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
    }
    writeFileSync(join(root, "m", "server", "index.js"), readsConfig);
    return root;
  };
  /** A project folder with a manifest that configures module `m`. */
  const game = (modules: object): string => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-game-"));
    writeFileSync(join(dir, "game.json"), JSON.stringify({ name: "cfg-game", modules }));
    return dir;
  };
  const assemble = async (root: string, config: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const r = await assembleServerSystems({
      modulesDir: root,
      setFile: setFile(["m"]),
      provided: { core: coreProvided() },
      ctx: { ...ctx, config },
    });
    return (r.byName["x"] as unknown as { seen: Record<string, unknown> }).seen;
  };

  it("hands the module what the manifest sets", async () => {
    const dir = game({ m: { pace: 7, label: "from the file" } });
    const project = openGameProject({ dir, env: {}, cwd: dir });
    const seen = await assemble(temp(), mergeModuleConfig({}, project.moduleConfig));
    assert.deepEqual(seen, { pace: 7, label: "from the file" });
  });

  it("keeps what the host sets and fills only what it leaves unset", async () => {
    const dir = game({ m: { pace: 7, label: "from the file" } });
    const project = openGameProject({ dir, env: {}, cwd: dir });
    const host = { m: { pace: 99, label: undefined, live: () => 1 } };
    const seen = await assemble(temp(), mergeModuleConfig(host, project.moduleConfig));
    assert.equal(seen.pace, 99, "the host's value, as a MMO_* variable would give");
    assert.equal(seen.label, "from the file");
    assert.equal(typeof seen.live, "function", "the host's own wiring survives the merge");
  });

  it("changes nothing for a game with no manifest", async () => {
    const project = openGameProject({ env: {}, cwd: ENGINE_ROOT, exists: () => false });
    assert.deepEqual(project.moduleConfig, {});
    const seen = await assemble(temp(), mergeModuleConfig({ m: { pace: 1 } }, project.moduleConfig));
    assert.deepEqual(seen, { pace: 1 });
  });
});

describe("server modules: refusals", () => {
  const temp = (mods: Record<string, unknown>, entries: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-mods-"));
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: CORE_ORDER.map((name) => ({ name })) } })), ...mods })) {
      mkdirSync(join(root, n, "server"), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
      if (entries[n]) writeFileSync(join(root, n, "server", "index.js"), entries[n]);
    }
    return root;
  };
  const sys = `export function createSystems(){ return { x: { name: "x", step(){} } }; }`;
  const mod = (extra: object) => ({ name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x", ...extra }] } });

  it("a cycle stops the boot and names it", async () => {
    const root = temp({ m: mod({ after: "chests", before: "reloader" }) }, { m: sys });
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
    const coreManifest = { name: "core", version: "0.1.0", server: { systems: CORE_ORDER.map((name) => ({ name })) } };
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
    assert.deepEqual(names, [...CORE_ORDER, "nat1"]);
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
    assert.deepEqual(r.systems.map((s) => s.name), CORE_ORDER);
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
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: CORE_ORDER.map((name) => ({ name })) } })), ...mods })) {
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
    for (const [n, m] of Object.entries({ core: JSON.parse(JSON.stringify({ name: "core", version: "0.1.0", server: { systems: CORE_ORDER.map((name) => ({ name })) } })), ...mods })) {
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
    assert.deepEqual(names.filter((n) => n !== "x"), CORE_ORDER);
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

describe("server modules: dispose() lifecycle", () => {
  const temp = (manifests: Record<string, unknown>, entries: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "mmo-dispose-"));
    const all: Record<string, unknown> = {
      core: { name: "core", version: "0.1.0", server: { systems: [] } },
      ...manifests,
    };
    for (const n of Object.keys(all)) {
      const m = all[n] as Record<string, unknown>;
      mkdirSync(join(root, n), { recursive: true });
      writeFileSync(join(root, n, "module.json"), JSON.stringify(m));
      if (entries[n]) {
        mkdirSync(join(root, n, "server"), { recursive: true });
        writeFileSync(join(root, n, "server", "index.js"), entries[n]);
      }
    }
    return root;
  };

  it("runs dispose in reverse dependency order", async () => {
    const order: string[] = [];
    const root = temp(
      {
        a: { name: "a", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s-a" }] } },
        b: { name: "b", version: "0.1.0", dependsOn: ["a"], server: { entry: "server/index.js", systems: [{ name: "s-b" }] } },
      },
      {
        a: `export function createSystems(){ return { "s-a": { name: "s-a", step(){} } }; }\nexport function dispose(){ globalThis.__disposeOrder.push("a"); }`,
        b: `export function createSystems(){ return { "s-b": { name: "s-b", step(){} } }; }\nexport async function dispose(){ globalThis.__disposeOrder.push("b"); }`,
      },
    );
    (globalThis as Record<string, unknown>).__disposeOrder = order;
    const r = await assembleServerSystems({ modulesDir: root, setFile: setFile(["a", "b"]), provided: { core: {} }, ctx });
    assert.deepEqual(r.modules, ["core", "a", "b"]);
    await r.disposeModules();
    assert.deepEqual(order, ["b", "a"]);
    delete (globalThis as Record<string, unknown>).__disposeOrder;
  });

  it("skips modules without a dispose export and keeps going past a failure", async () => {
    const calls: string[] = [];
    const root = temp(
      {
        a: { name: "a", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s-a" }] } },
        b: { name: "b", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s-b" }] } },
        c: { name: "c", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s-c" }] } },
      },
      {
        a: `export function createSystems(){ return { "s-a": { name: "s-a", step(){} } }; }`,
        b: `export function createSystems(){ return { "s-b": { name: "s-b", step(){} } }; }\nexport function dispose(){ globalThis.__calls.push("b"); throw new Error("boom"); }`,
        c: `export function createSystems(){ return { "s-c": { name: "s-c", step(){} } }; }\nexport function dispose(){ globalThis.__calls.push("c"); }`,
      },
    );
    (globalThis as Record<string, unknown>).__calls = calls;
    const r = await assembleServerSystems({ modulesDir: root, setFile: setFile(["a", "b", "c"]), provided: { core: {} }, ctx });
    await assert.rejects(r.disposeModules(), /b: boom/);
    // c (later in dependency order) still ran despite b throwing.
    assert.deepEqual(calls, ["c", "b"]);
    delete (globalThis as Record<string, unknown>).__calls;
  });

  it("disposeModules resolves fine when no module disposes", async () => {
    const root = temp(
      { m: { name: "m", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "x" }] } } },
      { m: `export function createSystems(){ return { x: { name: "x", step(){} } }; }` },
    );
    const r = await assembleServerSystems({ modulesDir: root, setFile: setFile(["m"]), provided: { core: {} }, ctx });
    await r.disposeModules();
  });
});

describe("economy module", () => {
  it("assembles wallet/trade/vendor/auction from the real modules dir", async () => {
    const ctx: { sim: never; log: () => void; stores?: Record<string, unknown> } = { sim: null as never, log: () => {} };
    const r = await assembleServerSystems({
      modulesDir: MODULES,
      setFile: setFile(["economy"]),
      provided: { core: {} },
      ctx,
    });
    assert.deepEqual(r.modules, ["core", "economy"]);
    for (const name of ["wallet", "trade", "vendor", "auction"]) {
      assert.ok(r.byName[name], `${name} must be assembled`);
      assert.equal(r.byName[name].name, name);
    }
    // The wallet is published for downstream modules (items/LootDropper).
    assert.equal(ctx.stores!.wallet, r.byName["wallet"]);
    assert.ok(ctx.stores!.walletStore, "walletStore must be published");
    await r.disposeModules();
    assert.equal(ctx.stores!.wallet, undefined, "dispose clears the published wallet");
  });

  it("items can declare a dependency on economy", async () => {
    const { validateManifest } = await import("@mmo-engine/modules");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = JSON.parse(readFileSync(join(MODULES, "items", "module.json"), "utf8"));
    const { problems, manifest } = validateManifest(raw, "items");
    assert.deepEqual(problems, []);
    assert.ok(manifest!.dependsOn!.includes("economy"), "items must depend on economy");
  });
});

describe("domain stores move to modules (character/social/dungeons)", () => {
  const storeCtx = (config: Record<string, Record<string, unknown>>): { sim: never; log: () => void; config: Record<string, Record<string, unknown>>; stores?: Record<string, unknown> } => ({
    sim: null as never,
    log: () => {},
    config,
  });
  const tmpDataDir = (): string => mkdtempSync(join(tmpdir(), "mmo-stores-"));
  const rules = { skills: { skills: [] }, disciplines: { disciplines: [] } };
  const storeName = (s: unknown): string => (s as { constructor: { name: string } }).constructor.name;

  it("character module publishes characterStore on ctx.stores", async () => {
    const ctx = storeCtx({ character: { dataDir: tmpDataDir(), rules } });
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["character"]), provided: { core: {} }, ctx });
    assert.ok(ctx.stores!.characterStore, "characterStore must be published");
    assert.equal(storeName(ctx.stores!.characterStore), "SqliteCharacterStore");
    await r.disposeModules();
    assert.equal(ctx.stores!.characterStore, undefined, "dispose clears characterStore");
  });

  it("social module publishes guild/social/party stores despite declaring no systems", async () => {
    const ctx = storeCtx({ social: { dataDir: tmpDataDir() } });
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["social"]), provided: { core: {} }, ctx });
    assert.deepEqual(r.systems, [], "a gateway-only module contributes no tick systems");
    assert.deepEqual(
      [storeName(ctx.stores!.guildStore), storeName(ctx.stores!.socialStore), storeName(ctx.stores!.partyStore)],
      ["SqliteGuildStore", "SqliteSocialStore", "SqlitePartyStore"],
    );
    await r.disposeModules();
    for (const key of ["guildStore", "socialStore", "partyStore"]) {
      assert.equal(ctx.stores![key], undefined, `dispose clears ${key}`);
    }
  });

  it("dungeons module publishes instanceResults and reads characterStore from ctx.stores", async () => {
    const ctx = storeCtx({
      character: { dataDir: tmpDataDir(), rules },
      dungeons: { dataDir: tmpDataDir(), getGame: () => ({}), credentialStore: null },
    });
    const r = await assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["character", "dungeons"]), provided: { core: {} }, ctx });
    // dungeons dependsOn character, so the character store exists when the
    // dungeons entry builds the InstanceManager.
    assert.ok(r.modules.indexOf("character") < r.modules.indexOf("dungeons"));
    assert.ok(ctx.stores!.instanceResults, "instanceResults must be published");
    assert.equal(storeName(ctx.stores!.instanceResults), "SqliteInstanceResultStore");
    assert.ok(r.extensions["dungeons"], "the dungeons gateway extension still assembles");
    await r.disposeModules();
    assert.equal(ctx.stores!.instanceResults, undefined, "dispose clears instanceResults");
  });

  it("dungeons without the character module is refused", async () => {
    const ctx = storeCtx({ dungeons: { dataDir: tmpDataDir() } });
    await assert.rejects(
      assembleServerSystems({ modulesDir: MODULES, setFile: setFile(["dungeons"]), provided: { core: {} }, ctx }),
      /requires "character"/,
    );
  });

  it("server.ts no longer constructs the moved stores", async () => {
    const src = readFileSync(join(REPO, "packages/engine-core/src/server.ts"), "utf8");
    for (const name of ["SqliteCharacterStore", "SqliteGuildStore", "SqliteSocialStore", "SqlitePartyStore", "SqliteInstanceResultStore"]) {
      assert.ok(!new RegExp(`new ${name}\\(`).test(src), `server.ts must not construct ${name}`);
    }
    for (const key of ["characterStore", "guildStore", "socialStore", "partyStore", "instanceResults"]) {
      assert.ok(src.includes(`stores!.${key}`), `server.ts must read ${key} from moduleCtx.stores`);
    }
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
