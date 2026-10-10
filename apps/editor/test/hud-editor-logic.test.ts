/**
 * TDD: EA23 HUD drag editor — overlap detection and layout operations.
 *
 * The editor shows widgets as boxes on a screen-sized canvas. Dragging
 * moves them (updating offset); the anchor can be changed per widget.
 * Overlaps are flagged so the author can fix them before saving.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  widgetRect,
  findOverlaps,
  moveWidget,
  type WidgetBox,
} from "../src/ui/hud-editor-logic.js";

const SCREEN = { w: 1920, h: 1080 };

function box(id: string, x: number, y: number, w: number, h: number): WidgetBox {
  return { id, x, y, w, h };
}

describe("widgetRect", () => {
  it("computes the screen rect for a bottom-left widget", () => {
    const r = widgetRect({ anchor: "bottom-left", offset: { x: 16, y: 16 } }, { w: 200, h: 100 }, SCREEN);
    assert.deepEqual(r, { x: 16, y: 1080 - 16 - 100, w: 200, h: 100 });
  });

  it("computes the screen rect for a top-right widget", () => {
    const r = widgetRect({ anchor: "top-right", offset: { x: 16, y: 64 } }, { w: 200, h: 100 }, SCREEN);
    assert.deepEqual(r, { x: 1920 - 16 - 200, y: 64, w: 200, h: 100 });
  });

  it("computes the screen rect for a centered widget", () => {
    const r = widgetRect({ anchor: "center", offset: { x: 0, y: 0 } }, { w: 200, h: 100 }, SCREEN);
    assert.deepEqual(r, { x: 860, y: 490, w: 200, h: 100 });
  });
});

describe("findOverlaps", () => {
  it("finds overlapping widgets", () => {
    const boxes = [box("a", 0, 0, 100, 100), box("b", 50, 50, 100, 100), box("c", 200, 200, 50, 50)];
    const overlaps = findOverlaps(boxes);
    assert.deepEqual(overlaps, [["a", "b"]]);
  });

  it("returns empty when nothing overlaps", () => {
    const boxes = [box("a", 0, 0, 100, 100), box("b", 200, 200, 100, 100)];
    assert.deepEqual(findOverlaps(boxes), []);
  });

  it("touching edges do not count as overlap", () => {
    const boxes = [box("a", 0, 0, 100, 100), box("b", 100, 0, 100, 100)];
    assert.deepEqual(findOverlaps(boxes), []);
  });
});

describe("moveWidget", () => {
  it("updates the offset when dragged within the same anchor", () => {
    const placement = { anchor: "bottom-left" as const, offset: { x: 16, y: 16 }, visible: true };
    const moved = moveWidget(placement, { dx: 10, dy: -5 }, SCREEN, { w: 200, h: 100 });
    // Drag right (+10) grows the left offset; drag up (-5) grows the bottom offset.
    assert.deepEqual(moved.offset, { x: 26, y: 21 });
    assert.equal(moved.anchor, "bottom-left");
  });

  it("clamps the widget inside the screen", () => {
    const placement = { anchor: "top-left" as const, offset: { x: 0, y: 0 }, visible: true };
    const moved = moveWidget(placement, { dx: -100, dy: -100 }, SCREEN, { w: 200, h: 100 });
    assert.deepEqual(moved.offset, { x: 0, y: 0 });
  });
});
