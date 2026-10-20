import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  History,
  addComponent,
  addNode,
  emptyScene,
  findNode,
  moveNode,
  removeComponent,
  removeNode,
  setComponentField,
  setNodeProp,
  setTransform,
  validateScene,
  COMPONENTS,
  type SceneDoc,
} from "../src/index.js";

function sample(): SceneDoc {
  let d = emptyScene("arena", "arena");
  d = addNode(d, null, { id: "root", kind: "group" });
  d = addNode(d, "root", { id: "spawn", kind: "spawn-point", transform: { position: [1, 0, 2] } });
  return d;
}

describe("validateScene", () => {
  it("accepts a fresh scene and the sample", () => {
    assert.deepEqual(validateScene(emptyScene("a", "world")), []);
    assert.deepEqual(validateScene(sample()), []);
  });
  it("reports per-path errors", () => {
    const bad = {
      version: 1, name: "Bad Name", kind: "nope",
      nodes: [
        { id: "a", kind: "group", children: [{ id: "a" }] },
        { id: "b", components: { Ghost: {}, Spawner: { creature: 3, respawnSeconds: -1, extra: 1 } } },
        { id: "c", transform: { position: [1, 2] } },
      ],
    };
    const paths = validateScene(bad).map((i) => i.path);
    for (const p of ["name", "kind", "nodes[0].children[0].id", "nodes[1].components.Ghost",
      "nodes[1].components.Spawner.creature", "nodes[1].components.Spawner.respawnSeconds",
      "nodes[1].components.Spawner.extra", "nodes[2].transform.position"]) {
      assert.ok(paths.includes(p), `missing ${p} in ${paths.join(", ")}`);
    }
  });
  it("rejects non-objects and unknown versions", () => {
    assert.equal(validateScene(null)[0].path, "");
    assert.equal(validateScene({ ...emptyScene("a", "world"), version: 2 })[0].path, "version");
  });
});

describe("edit operations", () => {
  it("are pure", () => {
    const d = sample();
    const snap = JSON.stringify(d);
    setNodeProp(d, "spawn", "name", "Start");
    removeNode(d, "root");
    assert.equal(JSON.stringify(d), snap);
  });
  it("add, rename, transform, move, remove", () => {
    let d = sample();
    d = addNode(d, null, { id: "g2", kind: "group" });
    d = setNodeProp(d, "spawn", "name", "Start");
    d = setTransform(d, "spawn", { position: [5, 0, 5] });
    d = moveNode(d, "spawn", "g2", 0);
    assert.equal(findNode(d, "g2")?.children?.[0].id, "spawn");
    assert.equal(findNode(d, "spawn")?.name, "Start");
    assert.deepEqual(findNode(d, "spawn")?.transform?.position, [5, 0, 5]);
    assert.deepEqual(validateScene(d), []);
    d = removeNode(d, "g2");
    assert.equal(findNode(d, "spawn"), undefined);
  });
  it("refuses duplicate ids, missing nodes and moving into itself", () => {
    const d = sample();
    assert.throws(() => addNode(d, null, { id: "root" }), /already/);
    assert.throws(() => removeNode(d, "zzz"), /no node/);
    assert.throws(() => moveNode(d, "root", "spawn", 0), /inside itself/);
  });
  it("components get defaults and edits validate", () => {
    let d = addComponent(sample(), "spawn", "Spawner");
    assert.deepEqual(findNode(d, "spawn")?.components?.Spawner, COMPONENTS.Spawner.defaults());
    d = setComponentField(d, "spawn", "Spawner", "creature", "goblin");
    assert.equal(findNode(d, "spawn")?.components?.Spawner.creature, "goblin");
    assert.deepEqual(validateScene(d), []);
    assert.throws(() => addComponent(d, "spawn", "Spawner"), /already/);
    assert.throws(() => addComponent(d, "spawn", "Ghost"), /unknown component/);
    d = removeComponent(d, "spawn", "Spawner");
    assert.equal(findNode(d, "spawn")?.components, undefined);
  });
});

describe("History", () => {
  it("undoes and redoes, and a new edit clears redo", () => {
    const h = new History(sample());
    h.apply("rename", (d) => setNodeProp(d, "spawn", "name", "A"));
    h.apply("rename", (d) => setNodeProp(d, "spawn", "name", "B"));
    assert.equal(findNode(h.doc, "spawn")?.name, "B");
    assert.equal(h.undo(), "rename");
    assert.equal(findNode(h.doc, "spawn")?.name, "A");
    assert.ok(h.canRedo);
    h.redo();
    assert.equal(findNode(h.doc, "spawn")?.name, "B");
    h.undo();
    h.apply("x", (d) => removeNode(d, "spawn"));
    assert.ok(!h.canRedo);
    h.undo(); h.undo(); h.undo();
    assert.ok(!h.canUndo);
    assert.equal(findNode(h.doc, "spawn")?.name, undefined);
  });
  it("a failing edit changes nothing; replace resets history", () => {
    const h = new History(sample());
    assert.throws(() => h.apply("bad", (d) => removeNode(d, "zzz")));
    assert.ok(!h.canUndo);
    h.apply("ok", (d) => setNodeProp(d, "root", "name", "R"));
    assert.ok(h.dirty);
    h.markSaved();
    assert.ok(!h.dirty);
    h.replace(emptyScene("b", "world"));
    assert.ok(!h.canUndo);
  });
});

describe("Collider component", () => {
  it("defaults to a valid box and round-trips through edits", () => {
    let d = addComponent(sample(), "spawn", "Collider");
    assert.deepEqual(findNode(d, "spawn")?.components?.Collider, COMPONENTS.Collider.defaults());
    assert.deepEqual(validateScene(d), []);
    d = setComponentField(d, "spawn", "Collider", "hy", 2);
    assert.deepEqual(validateScene(d), []);
  });
  it("a box needs positive half-extents", () => {
    let d = addComponent(sample(), "spawn", "Collider");
    d = setComponentField(d, "spawn", "Collider", "hx", 0);
    const paths = validateScene(d).map((i) => i.path);
    assert.ok(paths.includes("nodes[0].children[0].components.Collider.hx"), paths.join(", "));
    // Unknown shapes and non-numbers are already reported by the field check.
    d = setComponentField(d, "spawn", "Collider", "hx", 0.5);
    d = setComponentField(d, "spawn", "Collider", "shape", "cube");
    assert.ok(validateScene(d).some((i) => i.path === "nodes[0].children[0].components.Collider.shape"));
  });
  it("a sphere needs a positive radius; none needs nothing", () => {
    let d = addComponent(sample(), "spawn", "Collider");
    d = setComponentField(d, "spawn", "Collider", "shape", "sphere");
    d = setComponentField(d, "spawn", "Collider", "radius", 0);
    assert.ok(validateScene(d).some((i) => i.path.endsWith("components.Collider.radius")));
    d = setComponentField(d, "spawn", "Collider", "radius", 1.5);
    assert.deepEqual(validateScene(d), []);
    // Walk-through decoration: zeroed dimensions are fine when shape is none.
    d = setComponentField(d, "spawn", "Collider", "shape", "none");
    d = setComponentField(d, "spawn", "Collider", "hx", 0);
    d = setComponentField(d, "spawn", "Collider", "radius", 0);
    assert.deepEqual(validateScene(d), []);
  });
});

describe("Structure component", () => {
  it("is a footprint and a kind: defaults to a four-metre box with one door, refuses a footprint with no size", () => {
    let d = addComponent(sample(), "spawn", "Structure");
    assert.deepEqual(findNode(d, "spawn")?.components?.Structure, { kind: "", asset: "", width: 4, depth: 4, height: 4, entrances: 1, capacity: 0 });
    assert.deepEqual(validateScene(d), []);
    d = setComponentField(d, "spawn", "Structure", "kind", "smithy");
    d = setComponentField(d, "spawn", "Structure", "width", 0);
    const paths = validateScene(d).map((i) => i.path);
    assert.deepEqual(paths, ["nodes[0].children[0].components.Structure.width"]);
  });
});
