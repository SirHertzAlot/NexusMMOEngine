/**
 * doc-actions: the toolbar's Save/Undo/Redo target. Panels register while
 * they hold an open document; with nothing registered the toolbar renders
 * its buttons disabled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearDocActions,
  getDocActions,
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
