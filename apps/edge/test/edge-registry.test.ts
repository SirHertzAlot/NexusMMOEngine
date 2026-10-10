import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EdgeRegistry,
  discoverNearestEdge,
  edgeModulesHandler,
  loadEdgeModules,
  probeUrl,
  type EdgeModuleInfo,
} from "../src/edge-registry.js";

const voice: EdgeModuleInfo = {
  module: "voice-us-east",
  version: "1.0.0",
  regions: ["us-east"],
  endpoint: "wss://voice-us-east.example.com",
  capabilities: ["voice", "video"],
};
const cdn: EdgeModuleInfo = {
  module: "cdn-eu",
  version: "2.1.0",
  regions: ["eu-west", "eu-central"],
  endpoint: "https://cdn-eu.example.com/assets",
  capabilities: ["cdn"],
};

describe("probeUrl", () => {
  it("maps ws(s) to http(s), leaves http(s) alone", () => {
    assert.equal(probeUrl("ws://x.example.com/socket"), "http://x.example.com/socket");
    assert.equal(probeUrl("wss://x.example.com:8443/socket"), "https://x.example.com:8443/socket");
    assert.equal(probeUrl("http://x.example.com/a"), "http://x.example.com/a");
    assert.equal(probeUrl("https://x.example.com/a"), "https://x.example.com/a");
  });
});

describe("EdgeRegistry", () => {
  it("registers and lists in insertion order", () => {
    const r = new EdgeRegistry();
    assert.equal(r.size, 0);
    assert.deepEqual(r.listEdges(), []);
    r.registerEdgeModule(voice);
    r.registerEdgeModule(cdn);
    assert.equal(r.size, 2);
    assert.deepEqual(r.listEdges().map((e) => e.module), ["voice-us-east", "cdn-eu"]);
  });
  it("filters by region and capability", () => {
    const r = new EdgeRegistry();
    r.registerEdgeModule(voice);
    r.registerEdgeModule(cdn);
    assert.deepEqual(r.listEdges({ region: "us-east" }).map((e) => e.module), ["voice-us-east"]);
    assert.deepEqual(r.listEdges({ region: "eu-central" }).map((e) => e.module), ["cdn-eu"]);
    assert.deepEqual(r.listEdges({ capability: "voice" }).map((e) => e.module), ["voice-us-east"]);
    assert.deepEqual(r.listEdges({ capability: "cdn" }).map((e) => e.module), ["cdn-eu"]);
    assert.deepEqual(r.listEdges({ region: "us-east", capability: "cdn" }), []);
    assert.deepEqual(r.listEdges({ region: "nowhere" }), []);
  });
  it("re-registering a module replaces it; unregister removes it", () => {
    const r = new EdgeRegistry();
    r.registerEdgeModule(voice);
    r.registerEdgeModule({ ...voice, version: "1.0.1", regions: ["us-east", "us-west"] });
    assert.equal(r.size, 1);
    assert.deepEqual(r.listEdges()[0].regions, ["us-east", "us-west"]);
    assert.ok(r.unregisterEdgeModule("voice-us-east"));
    assert.equal(r.size, 0);
    assert.ok(!r.unregisterEdgeModule("voice-us-east"));
  });
});

describe("loadEdgeModules", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "edge-mods-"));
    const modulesDir = join(root, "modules");
    const write = (name: string, manifest: unknown) => {
      mkdirSync(join(modulesDir, name), { recursive: true });
      writeFileSync(join(modulesDir, name, "module.json"), JSON.stringify(manifest));
    };
    write("voice-us-east", { name: "voice-us-east", version: "1.0.0", edge: { regions: ["us-east"], endpoint: "wss://voice.example.com", capabilities: ["voice"] } });
    write("plain", { name: "plain", version: "1.0.0" });
    write("bad", { name: "bad", version: "1.0.0", edge: { regions: [], endpoint: "nope", capabilities: [] } });
    write("disabled-edge", { name: "disabled-edge", version: "1.0.0", edge: { regions: ["eu"], endpoint: "wss://eu.example.com", capabilities: ["voice"] } });
    const setFile = join(root, "content", "modules.json");
    mkdirSync(join(root, "content"), { recursive: true });
    writeFileSync(setFile, JSON.stringify({ modules: ["voice-us-east", "plain", "bad"] }));
    return { modulesDir, setFile };
  };
  it("registers enabled edge modules, skips plain/disabled/invalid ones", () => {
    const { modulesDir, setFile } = setup();
    const { registry, problems } = loadEdgeModules(modulesDir, setFile);
    assert.deepEqual(registry.listEdges().map((e) => e.module), ["voice-us-east"]);
    // the bad manifest is reported, not registered
    assert.ok(problems.some((p) => p.module === "bad" && p.path === "edge.regions"));
    assert.ok(!registry.listEdges().some((e) => e.module === "disabled-edge"));
  });
  it("tolerates a missing modules dir and a missing set file", () => {
    const root = mkdtempSync(join(tmpdir(), "edge-empty-"));
    const { registry, problems } = loadEdgeModules(join(root, "modules"), join(root, "content", "modules.json"));
    assert.equal(registry.size, 0);
    assert.deepEqual(problems, []);
  });
});

describe("discoverNearestEdge", () => {
  const probeFor = (latencies: Record<string, number>) => async (url: string) => latencies[url] ?? Number.POSITIVE_INFINITY;
  it("picks the fastest reachable candidate", () => {
    const a = { ...voice, endpoint: "wss://a.example.com" };
    const b = { ...voice, module: "b", endpoint: "wss://b.example.com" };
    const c = { ...voice, module: "c", endpoint: "wss://c.example.com" };
    const probe = probeFor({ "wss://a.example.com": 120, "wss://b.example.com": 35, "wss://c.example.com": 80 });
    return discoverNearestEdge([a, b, c], { probe }).then((best) => {
      assert.equal(best?.module, "b");
    });
  });
  it("skips unreachable candidates and returns undefined when none are reachable", async () => {
    const a = { ...voice, endpoint: "wss://a.example.com" };
    const b = { ...voice, module: "b", endpoint: "wss://b.example.com" };
    const probe = probeFor({ "wss://b.example.com": 50 });
    assert.equal((await discoverNearestEdge([a, b], { probe }))?.module, "b");
    assert.equal(await discoverNearestEdge([a], { probe }), undefined);
    assert.equal(await discoverNearestEdge([], { probe }), undefined);
  });
  it("keeps input order on ties", async () => {
    const a = { ...voice, endpoint: "wss://a.example.com" };
    const b = { ...voice, module: "b", endpoint: "wss://b.example.com" };
    const probe = probeFor({ "wss://a.example.com": 50, "wss://b.example.com": 50 });
    assert.equal((await discoverNearestEdge([a, b], { probe }))?.module, "voice-us-east");
  });
});

describe("edgeModulesHandler", () => {
  const call = (registry: EdgeRegistry, query: Record<string, unknown>) => {
    let body: unknown;
    const req = { query } as unknown as Parameters<ReturnType<typeof edgeModulesHandler>>[0];
    const res = { json: (b: unknown) => { body = b; } } as unknown as Parameters<ReturnType<typeof edgeModulesHandler>>[1];
    edgeModulesHandler(registry)(req, res);
    return body as { ok: boolean; modules: EdgeModuleInfo[] };
  };
  it("serves the registry with region/capability filters", () => {
    const r = new EdgeRegistry();
    r.registerEdgeModule(voice);
    r.registerEdgeModule(cdn);
    assert.equal(call(r, {}).modules.length, 2);
    assert.deepEqual(call(r, { region: "us-east" }).modules.map((m) => m.module), ["voice-us-east"]);
    assert.deepEqual(call(r, { capability: "cdn" }).modules.map((m) => m.module), ["cdn-eu"]);
    const both = call(r, { region: "eu-west", capability: "cdn" });
    assert.ok(both.ok && both.modules.length === 1);
  });
});
