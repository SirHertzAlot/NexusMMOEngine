import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDeepSelection, readDeepSelection } from "../src/ui/previews.js";
import { editorSelection } from "../src/ui/editor-selection.js";

describe("deep links stay backward compatible", () => {
  it("keys still parse to their workspaces", () => {
    assert.deepEqual(applyDeepSelection("clip:Jog_Fwd"), { workspace: "artaudio", view: "animation" });
    assert.deepEqual(applyDeepSelection("effect:embers"), { workspace: "artaudio", view: "vfx" });
    assert.deepEqual(applyDeepSelection("event:hit"), { workspace: "artaudio", view: "audio" });
  });

  it("rejects garbage without crashing", () => {
    assert.equal(applyDeepSelection("nope"), null);
    assert.equal(applyDeepSelection("move:abc"), null);
    assert.deepEqual(applyDeepSelection("move:3"), { workspace: "artaudio", view: "animation" });
  });
});

describe("real selections round-trip through the hash", () => {
  it("scene names survive", () => {
    editorSelection.clear();
    assert.deepEqual(applyDeepSelection("scene:my-scene"), { workspace: "scenes", view: "scene" });
    assert.equal(readDeepSelection("scenes", "scene"), "scene:my-scene");
    assert.deepEqual(applyDeepSelection("scene:my-scene/node-1"), { workspace: "scenes", view: "scene" });
    assert.equal(readDeepSelection("scenes", "scene"), "scene:my-scene/node-1");
    editorSelection.clear();
  });

  it("dungeon picks survive", () => {
    editorSelection.clear();
    assert.deepEqual(applyDeepSelection("dungeon-prop:a0"), { workspace: "dungeons", view: "dungeons" });
    assert.equal(readDeepSelection("dungeons", "dungeons"), "dungeon-prop:a0");
    assert.deepEqual(applyDeepSelection("dungeon-room:3"), { workspace: "dungeons", view: "dungeons" });
    assert.equal(readDeepSelection("dungeons", "dungeons"), "dungeon-room:3");
    assert.deepEqual(applyDeepSelection("dungeon-spawn:1"), { workspace: "dungeons", view: "dungeons" });
    assert.equal(readDeepSelection("dungeons", "dungeons"), "dungeon-spawn:1");
    editorSelection.clear();
  });

  it("ECS entities survive", () => {
    editorSelection.clear();
    assert.deepEqual(applyDeepSelection("entity:42"), { workspace: "scene", view: "ecs" });
    assert.equal(readDeepSelection("scene", "ecs"), "entity:42");
    editorSelection.clear();
  });

  it("stops writing sel where nothing can consume it", () => {
    editorSelection.clear();
    editorSelection.select({ source: "entity-list", kind: "entity", id: "42", label: "E42", components: [] });
    assert.equal(readDeepSelection("gameplay", "tables"), null);
    assert.equal(readDeepSelection("scenes", "scene"), null);
    assert.equal(readDeepSelection("dungeons", "dungeons"), null);
    assert.equal(readDeepSelection("scene", "ecs"), "entity:42");
    editorSelection.clear();
    assert.equal(readDeepSelection("scene", "ecs"), null);
    assert.equal(readDeepSelection("scenes", "scene"), null);
  });
});
