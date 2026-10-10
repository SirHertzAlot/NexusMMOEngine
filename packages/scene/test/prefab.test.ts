/**
 * Prefabs: a component bundle with overrides that scenes place by name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandPrefabs, validatePrefab, validateScene, worldNodes, type PrefabDoc, type SceneDoc } from "../src/index.js";

const camp: PrefabDoc = {
  version: 1,
  name: "goblin-camp",
  kind: "group",
  components: { Spawner: { creature: "goblin", respawnSeconds: 90 } },
  children: [{ id: "lookout", transform: { position: [6, 0, 2] }, components: { Spawner: { creature: "goblin" } } }],
};
const scene = (nodes: SceneDoc["nodes"]): SceneDoc => ({ version: 1, name: "t", kind: "world", nodes });

describe("validatePrefab", () => {
  it("accepts a good bundle", () => {
    assert.deepEqual(validatePrefab(camp), []);
  });

  it("reports every problem with the path inside the prefab", () => {
    const bad = {
      version: 2,
      name: "Goblin Camp",
      colour: "red",
      components: { Spawner: { respawnSeconds: -1 }, Nope: {} },
      children: [{ id: "a" }, { id: "a" }],
    };
    const text = validatePrefab(bad).map((i) => `${i.path}: ${i.message}`).join("\n");
    assert.match(text, /version: must be 1/);
    assert.match(text, /name: must be lowercase/);
    assert.match(text, /colour: unknown field/);
    assert.match(text, /components\.Spawner\.respawnSeconds: must be at least 0/);
    assert.match(text, /components\.Nope: unknown component/);
    assert.match(text, /children\[1\]\.id: id "a" is used twice/);
    assert.deepEqual(validatePrefab(5).map((i) => i.message), ["a prefab must be a JSON object"]);
  });
});

describe("expandPrefabs", () => {
  it("instantiates the bundle: components, kind and children, with the node's overrides on top", () => {
    const doc = scene([
      { id: "camp-1", prefab: "goblin-camp", transform: { position: [10, 0, 10] }, components: { Spawner: { respawnSeconds: 30 } } },
    ]);
    const { doc: out, used, problems } = expandPrefabs(doc, { "goblin-camp": camp });
    assert.deepEqual(used, ["goblin-camp"]);
    assert.deepEqual(problems, []);
    const n = out.nodes[0];
    assert.equal(n.prefab, undefined);
    assert.equal(n.kind, "group");
    assert.deepEqual(n.components, { Spawner: { creature: "goblin", respawnSeconds: 30 } }, "the node overrides one field, keeps the rest");
    assert.equal(n.children?.[0].id, "camp-1.lookout");
    assert.deepEqual(validateScene(out), []);
    const w = worldNodes(out).find((x) => x.node.id === "camp-1.lookout")!;
    assert.deepEqual(w.position, [16, 0, 12], "children are placed relative to the node");
  });

  it("finds a prefab by its last path segment, and leaves unknown names for the spawner", () => {
    const doc = scene([
      { id: "a", prefab: "camps/goblin-camp" },
      { id: "b", prefab: "camps/orc" },
    ]);
    const { doc: out, used } = expandPrefabs(doc, (n) => (n === "goblin-camp" ? camp : undefined));
    assert.deepEqual(used, ["goblin-camp"]);
    assert.equal(out.nodes[0].components?.Spawner.creature, "goblin");
    assert.equal(out.nodes[1].prefab, "camps/orc", "not a prefab file: untouched");
  });

  it("expands prefabs placed by prefabs and the node's own children, and reports a cycle", () => {
    const fort: PrefabDoc = { version: 1, name: "fort", children: [{ id: "c", prefab: "goblin-camp" }] };
    const doc = scene([{ id: "f", prefab: "fort", children: [{ id: "g", prefab: "goblin-camp" }] }]);
    const { doc: out } = expandPrefabs(doc, { fort, "goblin-camp": camp });
    const ids = worldNodes(out).map((w) => w.node.id);
    assert.deepEqual(ids, ["f", "f.c", "f.c.lookout", "g", "g.lookout"]);

    const loop: PrefabDoc = { version: 1, name: "loop", children: [{ id: "again", prefab: "loop" }] };
    const r = expandPrefabs(scene([{ id: "l", prefab: "loop" }]), { loop });
    assert.match(r.problems.join(), /places itself/);
  });
});
