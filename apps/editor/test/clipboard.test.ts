/**
 * The in-memory editor clipboard: kind-scoped, structured-cloned.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearClipboard, peekClipboard, readClipboard, writeClipboard } from "../src/ui/clipboard.js";

describe("editor clipboard", () => {
  it("writes and reads by kind", () => {
    clearClipboard();
    writeClipboard("scene-node", { id: "n1", children: [] });
    assert.deepEqual(readClipboard("scene-node"), { id: "n1", children: [] });
  });

  it("refuses a different kind", () => {
    clearClipboard();
    writeClipboard("scene-node", { id: "n1" });
    assert.equal(readClipboard("flow-node"), null);
  });

  it("reads empty when nothing written", () => {
    clearClipboard();
    assert.equal(readClipboard("scene-node"), null);
    assert.equal(peekClipboard(), null);
  });

  it("structured-clones: later edits don't mutate the copy", () => {
    clearClipboard();
    const node = { id: "n1", children: [{ id: "n2" }] };
    writeClipboard("scene-node", node);
    node.children.push({ id: "n3" });
    assert.deepEqual(readClipboard("scene-node"), { id: "n1", children: [{ id: "n2" }] });
  });

  it("a second write replaces the first", () => {
    clearClipboard();
    writeClipboard("scene-node", { id: "n1" });
    writeClipboard("scene-node", { id: "n2" });
    assert.deepEqual(readClipboard("scene-node"), { id: "n2" });
  });
});
