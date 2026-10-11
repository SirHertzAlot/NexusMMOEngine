/**
 * Scene host storage: name rules (no traversal), confinement to
 * content/scenes, validated saves, and that a refused save writes
 * nothing. Writes go to a throwaway repo root.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScene } from "@mmo-engine/scene";
import { handleScenesRoute, isSceneName, listScenes, readScene, resolveScenePath, saveScene } from "../src/scenes-host.js";

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-scenes-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "scenes"), { recursive: true });
  return root;
}

describe("scene names and paths", () => {
  it("accepts plain names only", () => {
    assert.ok(isSceneName("arena-01"));
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "A", "a.b", "-a"]) assert.ok(!isSceneName(bad), bad);
  });
  it("resolves inside content/scenes and rejects the rest with 404", () => {
    const root = fakeRepo();
    assert.ok(resolveScenePath(root, "arena").endsWith("arena.scene.json"));
    assert.throws(() => resolveScenePath(root, "../rules"), { status: 404 });
    rmSync(root, { recursive: true });
  });
});

describe("save and read", () => {
  it("lists, writes pretty JSON and reads it back", () => {
    const root = fakeRepo();
    assert.deepEqual(listScenes(root), []);
    saveScene(root, "arena", emptyScene("arena", "arena"));
    assert.deepEqual(listScenes(root), ["arena"]);
    const text = readFileSync(join(root, "content", "scenes", "arena.scene.json"), "utf8");
    assert.ok(text.startsWith('{\n  "version": 1'));
    assert.ok(text.endsWith("}\n"));
    assert.deepEqual(readScene(root, "arena"), emptyScene("arena", "arena"));
    rmSync(root, { recursive: true });
  });
  it("a refused save writes nothing and lists every problem", () => {
    const root = fakeRepo();
    const bad = { ...emptyScene("arena", "arena"), kind: "nope", nodes: [{ id: "a" }, { id: "a" }] };
    assert.throws(
      () => saveScene(root, "arena", bad),
      (e: { status?: number; issues?: Array<{ path: string }> }) =>
        e.status === 400 && e.issues!.some((i) => i.path === "kind") && e.issues!.some((i) => i.path === "nodes[1].id"),
    );
    assert.deepEqual(readdirSync(join(root, "content", "scenes")), []);
    // The document's name must match the file it is saved to.
    assert.throws(() => saveScene(root, "other", emptyScene("arena", "arena")), { status: 400 });
    assert.deepEqual(readdirSync(join(root, "content", "scenes")), []);
    rmSync(root, { recursive: true });
  });
  it("a refused save leaves the old file as it was", () => {
    const root = fakeRepo();
    saveScene(root, "arena", emptyScene("arena", "arena"));
    const file = join(root, "content", "scenes", "arena.scene.json");
    const before = readFileSync(file, "utf8");
    assert.throws(() => saveScene(root, "arena", { nope: 1 }), { status: 400 });
    assert.equal(readFileSync(file, "utf8"), before);
    assert.ok(!existsSync(`${file}.tmp`));
    rmSync(root, { recursive: true });
  });
  it("collider data validates: a bad shape refuses and writes nothing, a good one saves", () => {
    const root = fakeRepo();
    const bad = {
      ...emptyScene("arena", "arena"),
      nodes: [{ id: "tree", components: { Collider: { shape: "cube", hx: 0.5, hy: 2, hz: 0.5 } } }],
    };
    assert.throws(
      () => saveScene(root, "arena", bad),
      (e: { status?: number; issues?: Array<{ path: string }> }) =>
        e.status === 400 && e.issues!.some((i) => i.path === "nodes[0].components.Collider.shape"),
    );
    assert.deepEqual(readdirSync(join(root, "content", "scenes")), []);
    const good = {
      ...emptyScene("arena", "arena"),
      nodes: [{ id: "tree", components: { Collider: { shape: "box", hx: 0.5, hy: 2, hz: 0.5 } } }],
    };
    saveScene(root, "arena", good);
    assert.deepEqual(readScene(root, "arena"), good);
    rmSync(root, { recursive: true });
  });
});

describe("handleScenesRoute", () => {
  it("serves list, get, put and refuses bad ones", () => {
    const root = fakeRepo();
    const doc = emptyScene("arena", "arena");
    assert.equal(handleScenesRoute(root, "GET", "/api/editor/other", undefined), null);
    assert.deepEqual(handleScenesRoute(root, "GET", "/api/editor/scenes", undefined)?.body, { ok: true, scenes: [] });
    assert.equal(handleScenesRoute(root, "GET", "/api/editor/scenes/arena", undefined)?.status, 404);
    assert.equal(handleScenesRoute(root, "PUT", "/api/editor/scenes/arena", "not json")?.status, 400);
    assert.equal(handleScenesRoute(root, "PUT", "/api/editor/scenes/arena", JSON.stringify({ content: { x: 1 } }))?.status, 400);
    assert.equal(handleScenesRoute(root, "PUT", "/api/editor/scenes/arena", JSON.stringify({ content: doc }))?.status, 200);
    assert.deepEqual(handleScenesRoute(root, "GET", "/api/editor/scenes/arena", undefined)?.body, { ok: true, name: "arena", content: doc });
    assert.equal(handleScenesRoute(root, "GET", "/api/editor/scenes/..%2Frules", undefined)?.status, 404);
    rmSync(root, { recursive: true });
  });
});

describe("content/scenes", () => {
  it("every shipped scene is valid and named for its file", () => {
    // dist/test/<name>.test.js -> repo root (four levels up).
    const repo = join(import.meta.dirname, "..", "..", "..", "..");
    const names = listScenes(repo);
    assert.ok(names.length > 0);
    const scratch = fakeRepo();
    for (const n of names) saveScene(scratch, n, readScene(repo, n));
    rmSync(scratch, { recursive: true });
  });
});
