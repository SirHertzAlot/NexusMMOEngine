import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffDocs, mergeDocs, summarize, type Json } from "../src/vcs-merge.js";

const scene = (nodes: Json[]): Json => ({ version: 1, name: "a", nodes });
const base = scene([
  { id: "spawn", transform: { position: [0, 0, 0] } },
  { id: "camp", transform: { position: [20, 0, -10] }, children: [{ id: "tent", name: "Tent" }] },
]);

describe("diffDocs", () => {
  it("reports by node id, not by position", () => {
    const after = scene([
      { id: "camp", transform: { position: [25, 0, -10] }, children: [{ id: "tent", name: "Tent" }] },
      { id: "spawn", transform: { position: [0, 0, 0] } },
      { id: "chest", name: "Chest" },
    ]);
    const lines = summarize(diffDocs(base, after));
    assert.deepEqual(lines, [
      "nodes[camp].transform.position: [20,0,-10] -> [25,0,-10]",
      'nodes[chest]: added {"id":"chest","name":"Chest"}',
    ]);
  });
  it("diffs rules tables by key and removals", () => {
    const c = diffDocs({ creatures: { goblin: { health: 60 }, wolf: { health: 5 } } }, { creatures: { goblin: { health: 75 } } });
    assert.deepEqual(summarize(c), ["creatures.goblin.health: 60 -> 75", "creatures.wolf: removed"]);
  });
  it("is empty for equal documents", () => assert.deepEqual(diffDocs(base, structuredClone(base)), []));
});

describe("mergeDocs", () => {
  it("merges two scene edits by node id with no conflict", () => {
    const ours = structuredClone(base) as { nodes: Array<{ id: string; transform?: unknown }> };
    ours.nodes[0].transform = { position: [1, 0, 0] };
    const theirs = structuredClone(base) as { nodes: Array<Record<string, unknown>> };
    theirs.nodes[1].name = "Camp";
    theirs.nodes.push({ id: "chest" });
    const { merged, conflicts } = mergeDocs(base, ours as Json, theirs as Json);
    assert.deepEqual(conflicts, []);
    const m = merged as { nodes: Array<{ id: string; name?: string; transform?: { position: number[] } }> };
    assert.deepEqual(m.nodes.map((n) => n.id), ["spawn", "camp", "chest"]);
    assert.deepEqual(m.nodes[0].transform?.position, [1, 0, 0]);
    assert.equal(m.nodes[1].name, "Camp");
  });
  it("reports a true conflict at the node field and keeps ours", () => {
    const ours = structuredClone(base) as { nodes: Array<{ transform: { position: number[] } }> };
    ours.nodes[1].transform.position = [1, 1, 1];
    const theirs = structuredClone(base) as { nodes: Array<{ transform: { position: number[] } }> };
    theirs.nodes[1].transform.position = [2, 2, 2];
    const { merged, conflicts } = mergeDocs(base, ours as Json, theirs as Json);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, "nodes[camp].transform.position");
    assert.deepEqual((merged as typeof ours).nodes[1].transform.position, [1, 1, 1]);
  });
  it("delete vs edit conflicts; delete vs untouched deletes", () => {
    const ours = scene([{ id: "spawn", transform: { position: [0, 0, 0] } }]);
    const theirs = structuredClone(base) as { nodes: Array<Record<string, unknown>> };
    theirs.nodes[1].name = "Camp";
    const r = mergeDocs(base, ours, theirs as Json);
    assert.equal(r.conflicts[0].path, "nodes[camp]");
    const r2 = mergeDocs(base, ours, structuredClone(base));
    assert.deepEqual(r2.conflicts, []);
    assert.equal((r2.merged as { nodes: unknown[] }).nodes.length, 1);
  });
  it("two creatures edited on two sides merge cleanly", () => {
    const b = { creatures: { goblin: { health: 60 }, wolf: { health: 5 } } };
    const r = mergeDocs(b, { creatures: { goblin: { health: 70 }, wolf: { health: 5 } } }, { creatures: { goblin: { health: 60 }, wolf: { health: 9 } } });
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.merged, { creatures: { goblin: { health: 70 }, wolf: { health: 9 } } });
  });
});
