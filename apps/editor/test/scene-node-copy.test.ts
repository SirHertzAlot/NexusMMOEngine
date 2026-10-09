import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addNode, type SceneNode } from "@mmo-engine/scene";
import { parentIdOf, withFreshIds } from "../src/scene-node-copy.js";

const n = (id: string, children?: SceneNode[]): SceneNode => ({ id, kind: "group", ...(children ? { children } : {}) }) as SceneNode;

const ids = (node: SceneNode): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];

describe("withFreshIds", () => {
  const doc = { nodes: [n("node-1", [n("node-2", [n("node-3")]), n("node-4")])] };

  it("gives a copied subtree ids that are unique and new to the document", () => {
    const copy = withFreshIds(doc, doc.nodes[0]);
    const got = ids(copy);
    assert.equal(new Set(got).size, got.length, `duplicate ids in ${got.join(", ")}`);
    for (const id of got) assert.ok(!ids(doc.nodes[0]).includes(id), `${id} already used`);
    assert.deepEqual(got, ["node-5", "node-6", "node-7", "node-8"]);
  });

  it("keeps the shape and leaves the original alone", () => {
    const before = structuredClone(doc);
    const copy = withFreshIds(doc, doc.nodes[0]);
    assert.equal(copy.children?.[0].children?.length, 1);
    assert.deepEqual(doc, before);
  });

  it("the copy can be added beside the original", () => {
    const full = { version: 1, name: "a", kind: "arena", nodes: doc.nodes } as Parameters<typeof addNode>[0];
    const copy = withFreshIds(full, full.nodes[0]);
    assert.doesNotThrow(() => addNode(full, null, copy));
  });
});

describe("parentIdOf", () => {
  const doc = { nodes: [n("a", [n("b", [n("c")])]), n("d")] };
  it("finds the holder of a nested node", () => {
    assert.equal(parentIdOf(doc, "c"), "b");
    assert.equal(parentIdOf(doc, "b"), "a");
  });
  it("is null at the top level or for an unknown id", () => {
    assert.equal(parentIdOf(doc, "d"), null);
    assert.equal(parentIdOf(doc, "zzz"), null);
  });
});
