/**
 * Authoring a prefab from scene nodes, and an instance's overrides
 * (roadmap EB3).
 *
 * The test that matters is the round trip: lift nodes into a prefab, place
 * the instance where they were, expand it with the same `expandPrefabs` the
 * server uses, and every node is back where it stood — including nodes
 * lifted out of a turned, scaled group, which is where the arithmetic
 * actually earns its place.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearOverride,
  expandPrefabs,
  instanceOverrides,
  prefabAuthorProblems,
  prefabFromNodes,
  selectionAnchor,
  topOfSelection,
  validatePrefab,
  worldNodes,
  type SceneDoc,
  type SceneNode,
} from "../src/index.js";

const scene = (nodes: SceneNode[]): SceneDoc => ({ version: 1, name: "s", kind: "world", nodes });

const camp = (): SceneDoc =>
  scene([
    { id: "fire", kind: "group", transform: { position: [10, 0, 4] } },
    { id: "tent-a", kind: "group", transform: { position: [14, 0, 4], rotation: [0, 90, 0] } },
    { id: "tent-b", kind: "group", transform: { position: [6, 2, 8] } },
    { id: "road", kind: "group", transform: { position: [-40, 0, 0] } },
  ]);

/** Every node's scene-space position by id, the prefab's children keyed by their original id. */
const places = (doc: SceneDoc): Record<string, [number, number, number]> =>
  Object.fromEntries(worldNodes(doc).map((w) => [w.node.id.split(".").pop()!, w.position.map((n) => Math.round(n * 1e3) / 1e3) as [number, number, number]]));

describe("choosing what goes in", () => {
  it("drops a node whose ancestor is also chosen", () => {
    const doc = scene([{ id: "group", children: [{ id: "inner" }, { id: "deeper", children: [{ id: "deepest" }] }] }, { id: "other" }]);
    assert.deepEqual(topOfSelection(doc, ["group", "inner", "deepest", "other"]), ["group", "other"]);
    assert.deepEqual(topOfSelection(doc, ["inner", "deepest"]), ["inner", "deepest"], "two nodes neither of which holds the other");
  });

  it("puts the origin in the middle of the spread, at the lowest node", () => {
    // fire 10, tent-a 14, tent-b 6 on X; 0, 0, 2 on Y; 4, 4, 8 on Z.
    assert.deepEqual(selectionAnchor(camp(), ["fire", "tent-a", "tent-b"]), [10, 0, 6]);
    assert.deepEqual(selectionAnchor(camp(), []), [0, 0, 0], "nothing chosen is not an error");
  });
});

describe("prefabFromNodes", () => {
  it("writes a prefab the loader accepts, and takes the nodes out of the scene", () => {
    const { prefab, doc, id, took } = prefabFromNodes(camp(), ["fire", "tent-a", "tent-b"], "goblin-camp");
    assert.deepEqual(validatePrefab(prefab), []);
    assert.deepEqual(took, ["fire", "tent-a", "tent-b"]);
    assert.deepEqual(prefab.children?.map((c) => c.id), ["fire", "tent-a", "tent-b"]);
    assert.deepEqual(doc.nodes.map((n) => n.id), ["road", id]);
    assert.equal(doc.nodes[1].prefab, "goblin-camp");
    assert.equal(id, "goblin-camp-1");
  });

  it("leaves every node exactly where it stood", () => {
    const before = places(camp());
    const { prefab, doc } = prefabFromNodes(camp(), ["fire", "tent-a", "tent-b"], "goblin-camp");
    const after = places(expandPrefabs(doc, { "goblin-camp": prefab }).doc);
    for (const node of ["fire", "tent-a", "tent-b", "road"]) assert.deepEqual(after[node], before[node], node);
  });

  it("keeps a node's own turn", () => {
    const { prefab } = prefabFromNodes(camp(), ["tent-a"], "tent");
    assert.deepEqual(prefab.children?.[0].transform?.rotation, [0, 90, 0]);
  });

  it("holds up when the nodes are inside a turned, scaled group", () => {
    const doc = scene([
      {
        id: "camp",
        kind: "group",
        transform: { position: [100, 0, -50], rotation: [0, 35, 0], scale: [2, 2, 2] },
        children: [
          { id: "fire", transform: { position: [1, 0, 0] } },
          { id: "tent", transform: { position: [0, 0, 3], rotation: [0, 20, 0] } },
        ],
      },
    ]);
    const before = places(doc);
    const { prefab, doc: next } = prefabFromNodes(doc, ["fire", "tent"], "camp-bits");
    const after = places(expandPrefabs(next, { "camp-bits": prefab }).doc);
    assert.deepEqual(after.fire, before.fire);
    assert.deepEqual(after.tent, before.tent);
    assert.equal(prefab.children?.[1].transform?.scale, undefined, "the group's scale is not baked in: the instance is inside the group, which goes on applying it");
    assert.deepEqual(prefab.children?.[0].transform?.position, [0.5, 0, -1.5], "the children keep the transforms they were authored with, shifted to the prefab's origin");
  });

  it("puts the instance in the group the nodes shared", () => {
    const doc = scene([{ id: "town", kind: "group", transform: { position: [5, 0, 5] }, children: [{ id: "a" }, { id: "b" }] }]);
    const { doc: next, id } = prefabFromNodes(doc, ["a", "b"], "pair");
    assert.deepEqual(next.nodes[0].children?.map((n) => n.id), [id], "still inside town");
    assert.deepEqual(places(next)[id], [5, 0, 5], "and in the same place it would be at the root");
  });

  it("puts it at the root when they did not share one", () => {
    const doc = scene([{ id: "town", children: [{ id: "a" }] }, { id: "b" }]);
    const { doc: next, id } = prefabFromNodes(doc, ["a", "b"], "pair");
    assert.deepEqual(next.nodes.map((n) => n.id), ["town", id]);
  });

  it("brings a chosen node's children along as they are", () => {
    const doc = scene([{ id: "tent", transform: { position: [4, 0, 0] }, children: [{ id: "bedroll", transform: { position: [0, 0, 1] } }] }]);
    const { prefab } = prefabFromNodes(doc, ["tent"], "tent-kit");
    assert.deepEqual(prefab.children?.[0].children?.[0].transform?.position, [0, 0, 1], "a child stays relative to its parent");
  });

  it("refuses to make a prefab out of nothing", () => {
    assert.throws(() => prefabFromNodes(camp(), [], "empty"), /no nodes/);
  });
});

describe("prefabAuthorProblems", () => {
  const existing = ["goblin-camp"];

  it("passes a name and a selection the loader would take", () => {
    assert.deepEqual(prefabAuthorProblems(camp(), ["fire"], "watch-post", existing), []);
  });

  it("names what is wrong", () => {
    const of = (ids: string[], name: string): string[] => prefabAuthorProblems(camp(), ids, name, existing).map((i) => `${i.path}: ${i.message}`);
    assert.deepEqual(of(["fire"], "Goblin Camp"), ["name: must be lowercase letters, digits and dashes"]);
    assert.match(of(["fire"], "goblin-camp")[0], /already there/);
    assert.match(of([], "post")[0], /at least one node/);
    assert.match(of(["ghost"], "post").join("\n"), /not in this scene: ghost/);
  });

  it("refuses a selection that would make the prefab place itself", () => {
    const doc = scene([{ id: "here", children: [{ id: "inner", prefab: "post" }] }]);
    assert.match(prefabAuthorProblems(doc, ["here"], "post").map((i) => i.message).join(), /place itself/);
  });
});

describe("an instance's overrides", () => {
  const prefab = {
    version: 1,
    name: "goblin-camp",
    components: { Spawner: { creature: "goblin", respawnSeconds: 90 } },
  };

  it("lists only the fields that differ", () => {
    const node: SceneNode = {
      id: "camp-1",
      prefab: "goblin-camp",
      components: { Spawner: { creature: "goblin", respawnSeconds: 20 }, ItemSpawn: { base: "torch" } },
    };
    assert.deepEqual(instanceOverrides(node, prefab), [
      { component: "Spawner", field: "respawnSeconds", value: 20, base: 90, added: false },
      { component: "ItemSpawn", field: "base", value: "torch", added: true },
    ]);
  });

  it("counts a field the prefab never states as an override of that component", () => {
    const node: SceneNode = { id: "c", components: { Spawner: { species: "wolf" } } };
    assert.deepEqual(instanceOverrides(node, prefab), [{ component: "Spawner", field: "species", value: "wolf", added: false }]);
  });

  it("is empty for an instance that states nothing, or nothing new", () => {
    assert.deepEqual(instanceOverrides({ id: "c" }, prefab), []);
    assert.deepEqual(instanceOverrides({ id: "c", components: { Spawner: { creature: "goblin" } } }, prefab), []);
  });

  it("drops one back to the prefab's value, and the block with it when it empties", () => {
    const doc = scene([{ id: "c", prefab: "goblin-camp", components: { Spawner: { respawnSeconds: 20, creature: "orc" } } }]);
    const one = clearOverride(doc, "c", "Spawner", "respawnSeconds");
    assert.deepEqual(one.nodes[0].components, { Spawner: { creature: "orc" } });
    const none = clearOverride(one, "c", "Spawner", "creature");
    assert.equal("components" in none.nodes[0], false, "an empty override block is not left behind");
    assert.deepEqual(clearOverride(doc, "c", "Spawner").nodes[0].components, undefined, "or the whole component at once");
    assert.throws(() => clearOverride(doc, "ghost", "Spawner"), /no node/);
  });
});
