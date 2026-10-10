import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, docReducer, emptyDoc, sameValue, type DocState } from "../src/document-state.js";

type D = { n: number };
const run = (...steps: Array<Parameters<typeof docReducer<D>>[1]>): DocState<D> => steps.reduce((s, a) => docReducer(s, a), emptyDoc<D>());

describe("document state", () => {
  it("a loaded document is clean with no history", () => {
    const s = run({ type: "load", doc: { n: 1 } });
    assert.deepEqual([s.present, s.dirty, s.past.length, s.future.length], [{ n: 1 }, false, 0, 0]);
  });

  it("an edit is dirty and undoable; typing the value back is clean again", () => {
    let s = run({ type: "load", doc: { n: 1 } }, { type: "edit", next: { n: 2 } });
    assert.equal(s.dirty, true);
    s = docReducer(s, { type: "edit", next: { n: 1 } });
    assert.equal(s.dirty, false);
    s = docReducer(s, { type: "undo" });
    assert.deepEqual([s.present, s.dirty], [{ n: 2 }, true]);
    s = docReducer(s, { type: "redo" });
    assert.deepEqual([s.present, s.dirty], [{ n: 1 }, false]);
  });

  it("a merged edit folds a drag into one undo step", () => {
    let s = run({ type: "load", doc: { n: 0 } }, { type: "edit", next: { n: 1 } });
    s = docReducer(s, { type: "edit", next: (c) => ({ n: c.n + 1 }), merge: true });
    s = docReducer(s, { type: "edit", next: (c) => ({ n: c.n + 1 }), merge: true });
    assert.equal(s.past.length, 1);
    s = docReducer(s, { type: "undo" });
    assert.deepEqual(s.present, { n: 0 });
  });

  it("a new edit clears redo; undo and redo at the ends do nothing", () => {
    let s = run({ type: "load", doc: { n: 0 } }, { type: "undo" }, { type: "redo" });
    assert.equal(s.present?.n, 0);
    s = docReducer(docReducer(s, { type: "edit", next: { n: 1 } }), { type: "undo" });
    assert.equal(s.future.length, 1);
    s = docReducer(s, { type: "edit", next: { n: 5 } });
    assert.equal(s.future.length, 0);
  });

  it("saving makes the draft the baseline and keeps history; revert returns to it as one step", () => {
    let s = run({ type: "load", doc: { n: 0 } }, { type: "edit", next: { n: 1 } }, { type: "saved" });
    assert.deepEqual([s.saved, s.dirty, s.past.length], [{ n: 1 }, false, 1]);
    s = docReducer(s, { type: "edit", next: { n: 9 } });
    s = docReducer(s, { type: "revert" });
    assert.deepEqual([s.present, s.dirty], [{ n: 1 }, false]);
    s = docReducer(s, { type: "undo" });
    assert.deepEqual([s.present, s.dirty], [{ n: 9 }, true]);
  });

  it("saving an older copy (the host saved what was sent) can leave a newer draft dirty", () => {
    let s = run({ type: "load", doc: { n: 0 } }, { type: "edit", next: { n: 1 } });
    s = docReducer(s, { type: "edit", next: { n: 2 } });
    s = docReducer(s, { type: "saved", doc: { n: 1 } });
    assert.equal(s.dirty, true);
  });

  it("history is capped", () => {
    let s = run({ type: "load", doc: { n: 0 } });
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) s = docReducer(s, { type: "edit", next: { n: i } });
    assert.equal(s.past.length, HISTORY_LIMIT);
  });
});

it("sameValue compares by value, so typing a field back leaves it clean", () => {
  assert.equal(sameValue({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false);
});
