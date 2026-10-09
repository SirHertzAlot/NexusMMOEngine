/** scene-clipboard: pasted and duplicated nodes get free ids and leave the original untouched. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addNode, emptyScene, findNode, validateScene } from "@mmo-engine/scene";
import { clearClipboard, clipboardNode, copyNode, duplicateCandidate, pasteCandidate, withFreshIds } from "../src/ui/scene-clipboard.js";

function sample() {
  let d = emptyScene("t", "arena");
  d = addNode(d, null, { id: "camp", kind: "group", transform: { position: [1, 0, 2] } });
  d = addNode(d, "camp", { id: "goblin", kind: "group", prefab: "camps/goblin" });
  return d;
}

describe("scene-clipboard", () => {
  it("nothing to paste until something is copied", () => {
    clearClipboard();
    assert.equal(pasteCandidate(sample()), null);
    assert.equal(copyNode(sample(), "missing"), false);
    assert.equal(clipboardNode(), null);
  });

  it("paste gives the subtree fresh ids and the result validates", () => {
    const d = sample();
    assert.ok(copyNode(d, "camp"));
    const p = pasteCandidate(d)!;
    assert.equal(p.id, "camp-2");
    assert.equal(p.children?.[0].id, "goblin-2");
    assert.deepEqual(p.transform, { position: [1, 0, 2] });
    const next = addNode(d, null, p);
    assert.deepEqual(validateScene(next), []);
    // pasting again never collides
    assert.equal(pasteCandidate(next)!.id, "camp-3");
    clearClipboard();
  });

  it("duplicate leaves the original and the source copy independent", () => {
    const d = sample();
    const dup = duplicateCandidate(d, "goblin")!;
    assert.equal(dup.id, "goblin-2");
    dup.prefab = "changed";
    assert.equal(findNode(d, "goblin")!.prefab, "camps/goblin");
    assert.equal(duplicateCandidate(d, "nope"), null);
  });

  it("withFreshIds reserves every id it hands out", () => {
    const used = new Set(["a"]);
    const n = withFreshIds({ id: "a", children: [{ id: "a" }, { id: "a" }] }, used);
    assert.deepEqual([n.id, n.children![0].id, n.children![1].id], ["a-2", "a-3", "a-4"]);
  });
});
