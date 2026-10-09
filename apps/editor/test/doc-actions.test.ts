/**
 * doc-actions: the toolbar's Save/Undo/Redo target. Panels register while
 * they hold an open document; with nothing registered the toolbar renders
 * its buttons disabled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearDocActions,
  getAllDocActions,
  getDocActions,
  saveAllDocs,
  registerDocActions,
  subscribeDocActions,
  type DocActions,
} from "../src/ui/doc-actions.js";

function actions(label: string): DocActions {
  return {
    label,
    canSave: true,
    canUndo: true,
    canRedo: false,
    save: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
  };
}

describe("doc-actions", () => {
  it("starts with no document", () => {
    clearDocActions();
    assert.equal(getDocActions(), null);
  });

  it("register replaces the current document", () => {
    const a = actions('scene "a"');
    const b = actions("flow");
    registerDocActions(a);
    assert.equal(getDocActions(), a);
    registerDocActions(b);
    assert.equal(getDocActions(), b);
    clearDocActions();
  });

  it("notifies subscribers on register and clear", () => {
    let calls = 0;
    const unsub = subscribeDocActions(() => calls++);
    registerDocActions(actions("x"));
    assert.equal(calls, 1);
    clearDocActions();
    assert.equal(calls, 2);
    unsub();
    registerDocActions(actions("y"));
    assert.equal(calls, 2);
    clearDocActions();
  });

  it("clear with a stale handle keeps the newer document", () => {
    const a = actions("old");
    const b = actions("new");
    registerDocActions(a);
    registerDocActions(b);
    clearDocActions(a);
    assert.equal(getDocActions(), b);
    clearDocActions(b);
    assert.equal(getDocActions(), null);
  });
});

describe("doc-actions registry (several documents)", () => {
  it("keeps every registered document; the latest is active", () => {
    clearDocActions();
    const a = actions("a");
    const b = actions("b");
    registerDocActions(a);
    registerDocActions(b);
    assert.deepEqual(getAllDocActions(), [a, b]);
    assert.equal(getDocActions(), b);
    clearDocActions(b);
    assert.equal(getDocActions(), a);
    clearDocActions();
  });

  it("re-registering the same object moves it to active without duplicating", () => {
    clearDocActions();
    const a = actions("a");
    const b = actions("b");
    registerDocActions(a);
    registerDocActions(b);
    registerDocActions(a);
    assert.deepEqual(getAllDocActions(), [b, a]);
    clearDocActions();
  });

  it("saveAllDocs saves only dirty documents and reports refusals without stopping", async () => {
    clearDocActions();
    const saved: string[] = [];
    const clean = { ...actions("clean"), canSave: false, save: () => void saved.push("clean") };
    const bad = { ...actions("bad"), save: () => { throw new Error("refused: 2 problems"); } };
    const good = { ...actions("good"), save: async () => void saved.push("good") };
    registerDocActions(clean);
    registerDocActions(bad);
    registerDocActions(good);
    const r = await saveAllDocs();
    assert.deepEqual(saved, ["good"]);
    assert.deepEqual(r.saved, ["good"]);
    assert.deepEqual(r.failed, [{ label: "bad", error: "refused: 2 problems" }]);
    clearDocActions();
  });
});
