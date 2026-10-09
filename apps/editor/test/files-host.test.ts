/**
 * files-host: rename / duplicate / delete for the documents the editor owns.
 * Whitelisted kinds, path-confined, validated, no overwrite, and a refused
 * request writes nothing. Everything runs in a throwaway repo root.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScene } from "@mmo-engine/scene";
import { handleFilesRoute, listFiles } from "../src/files-host.js";

const PLAYTEST = {
  version: 1,
  name: "smoke",
  description: "d",
  seed: 1,
  bots: 0,
  durationTicks: 150,
  script: [{ at: 0, do: "admin", command: "whoami" }],
  assertions: [{ kind: "connected" }],
};
const PROFILE = {
  version: 1,
  name: "mine",
  description: "d",
  target: "local",
  build: ["@mmo-engine/engine-core"],
  bakes: [],
  tests: [],
  valgrind: { memcheck: [], perf: false, required: false },
  modules: ["core"],
  edge: false,
  env: {},
};

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-files-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  for (const d of ["scenes", "playtests", "build", "flow"]) mkdirSync(join(root, "content", d), { recursive: true });
  writeFileSync(join(root, "content", "scenes", "arena.scene.json"), JSON.stringify(emptyScene("arena", "arena")));
  writeFileSync(join(root, "content", "playtests", "smoke.playtest.json"), JSON.stringify(PLAYTEST));
  writeFileSync(join(root, "content", "build", "mine.json"), JSON.stringify(PROFILE));
  return root;
}

const call = (root: string, method: string, path: string, body?: unknown) =>
  handleFilesRoute(root, method, path, body === undefined ? undefined : JSON.stringify(body));

describe("files-host", () => {
  it("lists each kind from its own folder only", () => {
    const root = fakeRepo();
    assert.deepEqual(listFiles(root, "scene"), ["arena"]);
    assert.deepEqual(listFiles(root, "playtest"), ["smoke"]);
    assert.deepEqual(listFiles(root, "build"), ["mine"]);
    assert.deepEqual(listFiles(root, "prefab"), []);
    assert.deepEqual(call(root, "GET", "/api/editor/files/scene")?.body, { ok: true, names: ["arena"] });
    rmSync(root, { recursive: true });
  });

  it("only handles its own paths and whitelisted kinds", () => {
    const root = fakeRepo();
    assert.equal(call(root, "GET", "/api/editor/scenes"), null);
    assert.equal(call(root, "GET", "/api/editor/files/rules")?.status, 404);
    assert.equal(call(root, "GET", "/api/editor/files/..")?.status, 404);
    rmSync(root, { recursive: true });
  });

  it("renames a scene, updating the name inside, and never overwrites", () => {
    const root = fakeRepo();
    writeFileSync(join(root, "content", "scenes", "other.scene.json"), JSON.stringify(emptyScene("other", "arena")));
    assert.equal(call(root, "POST", "/api/editor/files/scene/arena/rename", { to: "other" })?.status, 409);
    assert.ok(existsSync(join(root, "content", "scenes", "arena.scene.json")));
    assert.equal(call(root, "POST", "/api/editor/files/scene/arena/rename", { to: "pit" })?.status, 200);
    assert.deepEqual(listFiles(root, "scene"), ["other", "pit"]);
    const doc = JSON.parse(readFileSync(join(root, "content", "scenes", "pit.scene.json"), "utf8")) as { name: string };
    assert.equal(doc.name, "pit");
    rmSync(root, { recursive: true });
  });

  it("duplicates with a free default name and validates the copy", () => {
    const root = fakeRepo();
    assert.deepEqual(call(root, "POST", "/api/editor/files/scene/arena/duplicate")?.body, { ok: true, name: "arena-copy" });
    assert.deepEqual(call(root, "POST", "/api/editor/files/scene/arena/duplicate")?.body, { ok: true, name: "arena-copy-2" });
    assert.equal(call(root, "POST", "/api/editor/files/playtest/smoke/duplicate", { to: "smoke-two" })?.status, 200);
    const copy = JSON.parse(readFileSync(join(root, "content", "playtests", "smoke-two.playtest.json"), "utf8")) as { name: string };
    assert.equal(copy.name, "smoke-two");
    assert.equal(call(root, "POST", "/api/editor/files/build/mine/duplicate", { to: "mine-2" })?.status, 200);
    assert.deepEqual(listFiles(root, "build"), ["mine", "mine-2"]);
    rmSync(root, { recursive: true });
  });

  it("refuses bad names and traversal, writing nothing", () => {
    const root = fakeRepo();
    for (const to of ["../evil", "A", "a/b", "", "a.b", "-x"]) {
      assert.equal(call(root, "POST", "/api/editor/files/scene/arena/rename", { to })?.status, 400, to);
    }
    assert.equal(call(root, "DELETE", "/api/editor/files/scene/..%2Frules")?.status, 400);
    assert.equal(call(root, "POST", "/api/editor/files/scene/arena/rename", {})?.status, 400);
    assert.deepEqual(readdirSync(join(root, "content", "scenes")), ["arena.scene.json"]);
    rmSync(root, { recursive: true });
  });

  it("refuses to copy a document that is no longer valid", () => {
    const root = fakeRepo();
    writeFileSync(join(root, "content", "build", "bad.json"), JSON.stringify({ version: 1, name: "bad" }));
    const r = call(root, "POST", "/api/editor/files/build/bad/duplicate", { to: "bad-2" });
    assert.equal(r?.status, 400);
    assert.deepEqual(listFiles(root, "build"), ["bad", "mine"]);
    rmSync(root, { recursive: true });
  });

  it("deletes a file; a scene the game flow uses is protected", () => {
    const root = fakeRepo();
    writeFileSync(join(root, "content", "flow", "game.flow.json"), JSON.stringify({ nodes: { start: { scene: "arena" } } }));
    assert.equal(call(root, "DELETE", "/api/editor/files/scene/arena")?.status, 409);
    assert.equal(call(root, "POST", "/api/editor/files/scene/arena/rename", { to: "pit" })?.status, 409);
    assert.ok(existsSync(join(root, "content", "scenes", "arena.scene.json")));
    assert.equal(call(root, "DELETE", "/api/editor/files/playtest/smoke")?.status, 200);
    assert.deepEqual(listFiles(root, "playtest"), []);
    assert.equal(call(root, "DELETE", "/api/editor/files/playtest/smoke")?.status, 404);
    rmSync(root, { recursive: true });
  });
});
