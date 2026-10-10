/**
 * TDD: Flow node context menu actions.
 * Rename, Duplicate, Delete for flow nodes — the same operations the
 * toolbar buttons offer, available on right-click.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  duplicateFlowNode,
  renameFlowNode,
  type FlowDoc,
} from "../src/flow-context.js";

const doc = (): FlowDoc => ({
  version: 1,
  start: "login",
  nodes: {
    login: { scene: "login", x: 0, y: 0 },
    world: { scene: "world", x: 200, y: 0 },
  },
  edges: [{ from: "login", on: "done", to: "world" }],
});

describe("flow context: rename", () => {
  it("renames a node id and rewires edges", () => {
    const d = renameFlowNode(doc(), "login", "signin");
    assert.ok(!("login" in d.nodes));
    assert.ok("signin" in d.nodes);
    assert.equal(d.edges[0].from, "signin");
  });

  it("updates the start node when renaming it", () => {
    const d = renameFlowNode(doc(), "login", "signin");
    assert.equal(d.start, "signin");
  });

  it("refuses a duplicate id", () => {
    assert.throws(() => renameFlowNode(doc(), "login", "world"), /already exists/);
  });

  it("refuses an empty id", () => {
    assert.throws(() => renameFlowNode(doc(), "login", ""), /empty/);
  });

  it("throws for a missing node", () => {
    assert.throws(() => renameFlowNode(doc(), "nope", "x"), /not found/);
  });
});

describe("flow context: duplicate", () => {
  it("copies the node with a fresh id, offset position", () => {
    const d = duplicateFlowNode(doc(), "world");
    const ids = Object.keys(d.nodes);
    assert.equal(ids.length, 3);
    const copyId = ids.find((id) => id !== "login" && id !== "world")!;
    assert.equal(d.nodes[copyId]?.scene, "world");
    assert.ok((d.nodes[copyId]?.x ?? 0) > (d.nodes.world?.x ?? 0));
  });

  it("does not copy edges", () => {
    const d = duplicateFlowNode(doc(), "world");
    assert.equal(d.edges.length, 1);
  });

  it("throws for a missing node", () => {
    assert.throws(() => duplicateFlowNode(doc(), "nope"), /not found/);
  });
});

describe("flow context: rename keeps the selection on the node", () => {
  it("the renamed id is the only new key, in the same place", () => {
    const d = renameFlowNode(doc(), "world", "overworld");
    assert.deepEqual(Object.keys(d.nodes), ["login", "overworld"]);
    assert.equal(d.edges[0].to, "overworld");
  });
});
