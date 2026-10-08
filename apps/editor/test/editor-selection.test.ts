import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EditorSelectionModel, inferSelectionLocation, isSelectionVisible } from "../src/ui/editor-selection.js";

describe("EditorSelectionModel", () => {
  it("shares a component decomposition and notifies readers", () => {
    const model = new EditorSelectionModel();
    let notifications = 0;
    const unsubscribe = model.subscribe(() => notifications++);
    model.select({
      source: "entity-list",
      kind: "entity",
      id: "42",
      label: "E42",
      components: [{ name: "health", fields: [{ key: "current", value: "80" }] }],
    });

    assert.equal(notifications, 1);
    assert.deepEqual(model.get(), {
      source: "entity-list",
      kind: "entity",
      id: "42",
      label: "E42",
      components: [{ name: "health", fields: [{ key: "current", value: "80" }] }],
    });
    unsubscribe();
  });

  it("only clears a selection owned by the requested source", () => {
    const model = new EditorSelectionModel();
    model.select({ source: "outliner", kind: "region", id: "0,0", label: "Region 0,0", components: [] });
    model.clear("viewport");
    assert.equal(model.get()?.id, "0,0");
    model.clear("outliner");
    assert.equal(model.get(), null);
  });

  it("clears everything when no source is given", () => {
    const model = new EditorSelectionModel();
    model.select({ source: "entity-list", kind: "entity", id: "7", label: "E7", components: [] });
    model.clear();
    assert.equal(model.get(), null);
  });
});

describe("selection scoping", () => {
  it("maps entity picks to the ECS view", () => {
    assert.deepEqual(
      inferSelectionLocation({ source: "entity-list", kind: "entity", id: "42", label: "E42", components: [] }),
      { workspace: "scene", view: "ecs" },
    );
  });

  it("hides a stale entity after a workspace switch", () => {
    const entity = { source: "entity-list" as const, kind: "entity", id: "42", label: "E42", components: [] };
    assert.equal(isSelectionVisible(entity, "scene", "ecs"), true);
    assert.equal(isSelectionVisible(entity, "liveops", "overview"), false);
    assert.equal(isSelectionVisible(entity, "dungeons", "dungeons"), false);
  });

  it("scopes scene, dungeon, flow and graph picks to their views", () => {
    const sceneNode = { source: "outliner" as const, kind: "scene-node", id: "my-scene/node-1", label: "node-1", components: [] };
    assert.equal(isSelectionVisible(sceneNode, "scenes", "scene"), true);
    assert.equal(isSelectionVisible(sceneNode, "dungeons", "dungeons"), false);
    const prop = { source: "outliner" as const, kind: "dungeon-prop", id: "a0", label: "Prop a0", components: [] };
    assert.equal(isSelectionVisible(prop, "dungeons", "dungeons"), true);
    assert.equal(isSelectionVisible(prop, "scenes", "scene"), false);
    const flow = { source: "outliner" as const, kind: "flow-node", id: "login", label: "login", components: [] };
    assert.equal(isSelectionVisible(flow, "flow", "flow"), true);
    assert.equal(isSelectionVisible(flow, "flow", "hud"), false);
    const graph = { source: "outliner" as const, kind: "graph-node", id: "trunk", label: "Trunk", components: [] };
    assert.equal(isSelectionVisible(graph, "dungeons", "graphs"), true);
    assert.equal(isSelectionVisible(graph, "dungeons", "dungeons"), false);
  });

  it("keeps generic inspect picks visible with an honest fallback", () => {
    const inspect = { source: "outliner" as const, kind: "inspect", id: "Coast Wardens", label: "Coast Wardens", components: [] };
    assert.deepEqual(inferSelectionLocation(inspect), null);
    assert.equal(isSelectionVisible(inspect, "liveops", "overview"), true);
    assert.equal(isSelectionVisible(inspect, "world", "terrain"), true);
    assert.equal(isSelectionVisible(null, "world", "terrain"), false);
  });
});
