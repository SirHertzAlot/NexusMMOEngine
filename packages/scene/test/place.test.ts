import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  History,
  addNode,
  emptyScene,
  findNode,
  keepLiveTransform,
  liveTransform,
  placePrefab,
  validateScene,
  worldNodes,
} from "../src/index.js";

describe("placePrefab", () => {
  it("adds a prefab node with a unique id at the position, and the result validates", () => {
    let doc = emptyScene("arena", "arena");
    const a = placePrefab(doc, "trees/oak", [3, 0, 4]);
    doc = a.doc;
    const b = placePrefab(doc, "trees/oak", [5, 0, 4]);
    assert.equal(a.id, "oak-1");
    assert.equal(b.id, "oak-2");
    const n = findNode(b.doc, "oak-2");
    assert.equal(n?.prefab, "trees/oak");
    assert.equal(n?.kind, "prefab");
    assert.deepEqual(n?.transform?.position, [5, 0, 4]);
    assert.deepEqual(validateScene(b.doc), []);
    assert.equal(doc.nodes.length, 1, "input untouched");
  });
});

describe("worldNodes", () => {
  it("composes parent position, yaw and scale into children", () => {
    let doc = emptyScene("arena", "arena");
    doc = addNode(doc, null, { id: "p", transform: { position: [10, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] } });
    doc = addNode(doc, "p", { id: "c", transform: { position: [1, 0, 0] } });
    const c = worldNodes(doc).find((w) => w.node.id === "c")!;
    // local +x, scaled x2, turned 90deg about +Y (x -> -z), then moved to x=10.
    assert.ok(Math.abs(c.position[0] - 10) < 1e-9);
    assert.ok(Math.abs(c.position[2] + 2) < 1e-9);
    assert.equal(c.yawDeg, 90);
    assert.deepEqual(c.scale, [2, 2, 2]);
    assert.equal(c.parentId, "p");
  });
});

describe("keep", () => {
  const sel = (fields: Record<string, string>) => [
    { name: "transform", fields: Object.entries(fields).map(([key, value]) => ({ key, value })) },
  ];
  it("reads position and yaw out of a live entity's transform", () => {
    const half = Math.PI / 4; // 90 degrees of yaw
    const t = liveTransform(sel({ px: "1.5", py: "2", pz: "-3", qy: String(Math.sin(half)), qw: String(Math.cos(half)) }));
    assert.deepEqual(t?.position, [1.5, 2, -3]);
    assert.ok(Math.abs(t!.yawDeg - 90) < 1e-6);
    assert.equal(liveTransform([]), null);
    assert.equal(liveTransform(sel({ px: "x", py: "0", pz: "0" })), null);
  });
  it("stores a child's scene-space transform relative to its parent (and round-trips)", () => {
    let d = addNode(emptyScene("arena", "arena"), null, { id: "p", transform: { position: [10, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] } });
    d = addNode(d, "p", { id: "c" });
    d = keepLiveTransform(d, "c", { position: [10, 0, -2], yawDeg: 90, scale: [4, 4, 4] });
    assert.deepEqual(findNode(d, "c")?.transform, { position: [1, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] });
    const w = worldNodes(d).find((x) => x.node.id === "c")!;
    assert.ok(Math.abs(w.position[2] + 2) < 1e-6 && Math.abs(w.scale[0] - 4) < 1e-9);
  });
  it("copies it into a node as one undoable step", () => {
    const base = addNode(emptyScene("arena", "arena"), null, { id: "n", transform: { position: [0, 0, 0] } });
    const h = new History(base);
    h.apply("keep", (d) => keepLiveTransform(d, "n", { position: [4, 0, 5], yawDeg: 30 }));
    assert.deepEqual(findNode(h.doc, "n")?.transform, { position: [4, 0, 5], rotation: [0, 30, 0] });
    h.undo();
    assert.deepEqual(findNode(h.doc, "n")?.transform, { position: [0, 0, 0] });
  });
});
