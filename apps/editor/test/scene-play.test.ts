/**
 * Content browser listing and the play-scene hand-off (EA5/EA6): what can
 * be placed, and how the open scene reaches the play server without ever
 * touching content/scenes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScene, addNode } from "@mmo-engine/scene";
import { handleContentRoute, listPlaceables, playSceneEnv } from "../src/scene-play.js";

function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-scene-play-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "rules"), { recursive: true });
  mkdirSync(join(root, "content", "pcg"), { recursive: true });
  mkdirSync(join(root, "content", "scenes"), { recursive: true });
  mkdirSync(join(root, "packages", "scatter", "examples"), { recursive: true });
  writeFileSync(join(root, "content", "rules", "creatures.json"), JSON.stringify({ creatures: { goblin: { name: "Goblin" } } }));
  writeFileSync(join(root, "content", "pcg", "index.json"), JSON.stringify({ assets: [{ id: "oak", displayName: "Oak" }] }));
  writeFileSync(
    join(root, "packages", "scatter", "examples", "forest.spawn-table.json"),
    JSON.stringify({ archetypes: { oak: { asset: "oak" }, pine: { asset: "pine" } } }),
  );
  return root;
}

describe("listPlaceables", () => {
  it("lists species, props and PICG assets", () => {
    const root = fakeRepo();
    try {
      const p = listPlaceables(root);
      assert.deepEqual(p.species, [{ id: "goblin", label: "Goblin" }]);
      assert.deepEqual(p.props.map((x) => x.id), ["oak", "pine"]);
      assert.deepEqual(p.pcg, [{ id: "oak", label: "Oak" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("is empty, not an error, when a source is missing", () => {
    const root = join(tmpdir(), `mmo-scene-play-none-${process.pid}`);
    assert.deepEqual(listPlaceables(root), { species: [], props: [], pcg: [] });
  });
  it("serves GET /api/editor/content/placeables only", () => {
    const root = fakeRepo();
    try {
      assert.equal(handleContentRoute(root, "GET", "/api/editor/content/placeables")?.status, 200);
      assert.equal(handleContentRoute(root, "POST", "/api/editor/content/placeables")?.status, 404);
      assert.equal(handleContentRoute(root, "GET", "/api/editor/scenes"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("playSceneEnv", () => {
  it("is empty without a request", () => {
    assert.deepEqual(playSceneEnv("/repo", "/data", undefined), {});
  });
  it("names a saved scene by MMO_SCENE and writes nothing", () => {
    const root = fakeRepo();
    try {
      writeFileSync(join(root, "content", "scenes", "arena.scene.json"), JSON.stringify(emptyScene("arena", "arena")));
      assert.deepEqual(playSceneEnv(root, join(root, "data"), { name: "arena" }), { MMO_SCENE: "arena" });
      assert.throws(() => playSceneEnv(root, join(root, "data"), { name: "ghost" }), { status: 404 });
      assert.throws(() => playSceneEnv(root, join(root, "data"), { name: "../x" }), { status: 400 });
      assert.ok(!existsSync(join(root, "data")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("plays the open (unsaved) document from the data dir and leaves content/scenes alone", () => {
    const root = fakeRepo();
    try {
      const doc = addNode(emptyScene("arena", "arena"), null, { id: "n", prefab: "goblin" });
      const env = playSceneEnv(root, join(root, "data"), { name: "arena", content: doc });
      assert.equal(env.MMO_SCENE, "arena");
      assert.ok(env.MMO_SCENES?.startsWith(join(root, "data")));
      assert.equal(JSON.parse(readFileSync(join(env.MMO_SCENES!, "arena.scene.json"), "utf8")).nodes[0].id, "n");
      assert.deepEqual(readdirSync(join(root, "content", "scenes")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses an invalid document or a frontend scene (400) and writes nothing", () => {
    const root = fakeRepo();
    try {
      const bad = { ...emptyScene("arena", "arena"), nodes: [{}] };
      assert.throws(() => playSceneEnv(root, join(root, "data"), { name: "arena", content: bad }), { status: 400 });
      assert.throws(() => playSceneEnv(root, join(root, "data"), { name: "arena", content: emptyScene("arena", "frontend") }), { status: 400 });
      assert.throws(() => playSceneEnv(root, join(root, "data"), { name: "other", content: emptyScene("arena", "arena") }), { status: 400 });
      assert.ok(!existsSync(join(root, "data")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
