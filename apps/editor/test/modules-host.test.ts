/**
 * Modules host: the list, saving the enabled set (validated; a refused save
 * writes nothing), Apply, and reading the running server's tick order.
 * Writes go to a throwaway repo root.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModulesRoute, parseTickOrder, type ModulesHooks } from "../src/modules-host.js";

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-modules-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  const add = (name: string, manifest: unknown): void => {
    mkdirSync(join(root, "modules", name), { recursive: true });
    writeFileSync(join(root, "modules", name, "module.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  };
  mkdirSync(join(root, "content"), { recursive: true });
  add("core", { name: "core", version: "0.1.0", server: { systems: [{ name: "a" }, { name: "b" }] } });
  add("chars", { name: "chars", version: "0.1.0", dependsOn: ["core"], editor: { entry: "editor/index.tsx" } });
  add("sys", { name: "sys", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s", after: "a" }] } });
  add("broken", { name: "broken", version: "x", nope: 1 });
  writeFileSync(join(root, "content", "modules.json"), JSON.stringify({ modules: ["core", "chars"] }));
  return root;
}
const hooks = (over: Partial<ModulesHooks> = {}): ModulesHooks => ({ running: () => null, apply: async () => ({ restarted: false }), ...over });
const call = (root: string, method: string, path: string, body?: unknown, h = hooks()) =>
  handleModulesRoute(root, method, path, body === undefined ? undefined : JSON.stringify(body), h);

describe("GET /api/editor/modules", () => {
  it("lists modules with their state, and every problem of a broken manifest", async () => {
    const root = fakeRepo();
    const r = (await call(root, "GET", "/api/editor/modules"))!;
    assert.equal(r.status, 200);
    const b = r.body as { modules: Array<{ name: string; enabled: boolean; locked: boolean; editor: boolean; systems: string[] }>; invalid: Array<{ name: string; problems: unknown[] }>; enabled: string[]; tickOrder: string[] };
    assert.deepEqual(b.modules.map((m) => m.name), ["chars", "core", "sys"]);
    assert.deepEqual(b.modules.map((m) => m.enabled), [true, true, false]);
    assert.equal(b.modules.find((m) => m.name === "core")!.locked, true);
    assert.equal(b.modules.find((m) => m.name === "chars")!.editor, true);
    assert.deepEqual(b.modules.find((m) => m.name === "sys")!.systems, ["s"]);
    assert.equal(b.invalid[0].name, "broken");
    assert.ok(b.invalid[0].problems.length >= 2);
    assert.deepEqual(b.enabled, ["core", "chars"]);
    assert.deepEqual(b.tickOrder, ["a", "b"]);
    rmSync(root, { recursive: true });
  });
  it("reports the running server's tick order", async () => {
    const root = fakeRepo();
    const r = (await call(root, "GET", "/api/editor/modules", undefined, hooks({ running: () => ["a", "s", "b"] })))!;
    assert.deepEqual((r.body as { running: unknown }).running, { systems: ["a", "s", "b"] });
    rmSync(root, { recursive: true });
  });
});

describe("PUT /api/editor/modules", () => {
  it("saves a valid set, with core first", async () => {
    const root = fakeRepo();
    const r = (await call(root, "PUT", "/api/editor/modules", { enabled: ["sys", "chars"] }))!;
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "content", "modules.json"), "utf8")), { modules: ["core", "sys", "chars"] });
    rmSync(root, { recursive: true });
  });
  it("refuses unknown, invalid and non-string entries and writes nothing", async () => {
    const root = fakeRepo();
    const before = readFileSync(join(root, "content", "modules.json"), "utf8");
    for (const enabled of [["ghost"], ["broken"], [1], "sys"]) {
      const r = (await call(root, "PUT", "/api/editor/modules", { enabled }))!;
      assert.equal(r.status, 400, JSON.stringify(enabled));
      assert.ok(((r.body as { issues: unknown[] }).issues ?? []).length > 0 || (r.body as { error?: string }).error);
    }
    assert.equal(readFileSync(join(root, "content", "modules.json"), "utf8"), before);
    rmSync(root, { recursive: true });
  });
  it("refuses a set whose resolution fails (cycle) and writes nothing", async () => {
    const root = fakeRepo();
    writeFileSync(join(root, "modules", "sys", "module.json"), JSON.stringify({ name: "sys", version: "0.1.0", server: { entry: "server/index.js", systems: [{ name: "s", after: "b", before: "a" }] } }));
    const before = readFileSync(join(root, "content", "modules.json"), "utf8");
    const r = (await call(root, "PUT", "/api/editor/modules", { enabled: ["sys"] }))!;
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /cycle/);
    assert.equal(readFileSync(join(root, "content", "modules.json"), "utf8"), before);
    rmSync(root, { recursive: true });
  });
  it("creates content/modules.json when it does not exist", async () => {
    const root = fakeRepo();
    rmSync(join(root, "content", "modules.json"));
    assert.equal((await call(root, "PUT", "/api/editor/modules", { enabled: ["chars"] }))!.status, 200);
    assert.ok(existsSync(join(root, "content", "modules.json")));
    rmSync(root, { recursive: true });
  });
  it("rejects a body that is not JSON", async () => {
    const root = fakeRepo();
    const r = (await handleModulesRoute(root, "PUT", "/api/editor/modules", "{", hooks()))!;
    assert.equal(r.status, 400);
    rmSync(root, { recursive: true });
  });
});

describe("POST /api/editor/modules/apply and routing", () => {
  it("runs the apply hook and returns its result", async () => {
    const root = fakeRepo();
    const r = (await call(root, "POST", "/api/editor/modules/apply", undefined, hooks({ apply: async () => ({ restarted: true, url: "ws://x" }) })))!;
    assert.deepEqual(r.body, { ok: true, restarted: true, url: "ws://x" });
    rmSync(root, { recursive: true });
  });
  it("reports a failing apply as 500 with the message", async () => {
    const root = fakeRepo();
    const r = (await call(root, "POST", "/api/editor/modules/apply", undefined, hooks({ apply: async () => { throw new Error("boom"); } })))!;
    assert.equal(r.status, 500);
    assert.match(JSON.stringify(r.body), /boom/);
    rmSync(root, { recursive: true });
  });
  it("ignores other paths", async () => {
    assert.equal(await call("/x", "GET", "/api/editor/scenes"), null);
    assert.equal((await call("/x", "DELETE", "/api/editor/modules"))!.status, 405);
  });
});

describe("parseTickOrder", () => {
  it("reads the server's [modules] boot line", () => {
    const out = "x\n[modules] core, sample-heartbeat | tick order: reloader stats sample-heartbeat quests\nlistening";
    assert.deepEqual(parseTickOrder(out), ["reloader", "stats", "sample-heartbeat", "quests"]);
    assert.equal(parseTickOrder("nothing"), null);
  });
});
