import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HudDoc } from "@mmo-engine/scene";
import {
  hudDirty,
  hudDragEnd,
  hudDragStart,
  hudDragWidget,
  hudEdit,
  hudMarkSaved,
  hudModel,
  hudPatchWidget,
  hudReanchor,
  hudRedo,
  hudRevert,
  hudSetTheme,
  hudUndo,
  widgetProblems,
} from "../src/hud-model.js";

const DOC: HudDoc = {
  version: 1,
  theme: { card: "#101010" },
  widgets: { chat: { anchor: "bottom-right", x: 16, y: 16, w: 100, h: 50 }, settings: { anchor: "top-left", x: 0, y: 0, w: 100, h: 50 } },
};

describe("hud model", () => {
  it("a drag is one undo step, and moves toward the pointer for a right-anchored widget", () => {
    let m = hudModel(DOC);
    const start = hudDragStart(m);
    m = hudDragWidget(m, start, "chat", -20, -10, 100); // pointer moved left/up: right/bottom offsets grow
    m = hudDragWidget(m, start, "chat", -30, -10, 100);
    assert.deepEqual([m.doc.widgets.chat.x, m.doc.widgets.chat.y], [46, 26]);
    assert.equal(m.past.length, 0, "no step until the drag ends");
    m = hudDragEnd(m, start);
    assert.equal(m.past.length, 1);
    assert.equal(hudDirty(m), true);
    m = hudUndo(m);
    assert.deepEqual(m.doc, DOC);
    assert.equal(hudDirty(m), false);
    m = hudRedo(m);
    assert.equal(m.doc.widgets.chat.x, 46);
  });
  it("a drag that goes nowhere is not a step", () => {
    const m = hudModel(DOC);
    const start = hudDragStart(m);
    assert.equal(hudDragEnd(hudDragWidget(m, start, "chat", 0, 0, 100), start).past.length, 0);
  });
  it("patches, re-anchors and themes are steps; no-ops are not", () => {
    let m = hudModel(DOC);
    m = hudPatchWidget(m, "chat", { w: 120 });
    m = hudPatchWidget(m, "chat", { w: 120 });
    m = hudReanchor(m, "chat", "top-left", { w: 1920, h: 1080 }, 100);
    m = hudSetTheme(m, "primary", "#3b82f6");
    assert.equal(m.past.length, 3);
    assert.equal(m.doc.widgets.chat.anchor, "top-left");
    assert.equal(hudPatchWidget(m, "nope", { w: 1 }), m);
  });
  it("saved, revert and a new edit dropping the redo stack", () => {
    let m = hudPatchWidget(hudModel(DOC), "chat", { x: 99 });
    m = hudMarkSaved(m);
    assert.equal(hudDirty(m), false);
    m = hudPatchWidget(m, "chat", { x: 5 });
    assert.equal(hudDirty(m), true);
    m = hudRevert(m);
    assert.equal(m.doc.widgets.chat.x, 99);
    m = hudUndo(m);
    assert.equal(m.doc.widgets.chat.x, 5);
    m = hudPatchWidget(hudUndo(m), "chat", { x: 7 });
    assert.equal(m.future.length, 0);
    assert.equal(hudEdit(m, m.doc), m);
  });
  it("lists what one widget collides with", () => {
    const p = widgetProblems({ overlaps: [["a", "b"], ["b", "c"], ["c", "d"]], offscreen: ["b"] }, "b");
    assert.deepEqual(p, { overlaps: ["a", "c"], offscreen: true });
  });
});
