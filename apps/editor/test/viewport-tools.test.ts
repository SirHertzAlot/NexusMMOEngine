/**
 * viewport-tools: pure mapping of the shared toolbar tool to per-viewport
 * gestures. select is camera/pick everywhere; move is the edit gesture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canDragDungeonProp,
  canDragGraphNode,
  canSculptTerrain,
  gameViewToolNote,
} from "../src/ui/viewport-tools.js";

describe("viewport-tools", () => {
  it("select is camera/pick: no viewport edits on left-drag", () => {
    assert.equal(canSculptTerrain("select"), false);
    assert.equal(canDragDungeonProp("select"), false);
    assert.equal(canDragGraphNode("select"), false);
  });

  it("move is the edit gesture in every gated viewport", () => {
    assert.equal(canSculptTerrain("move"), true);
    assert.equal(canDragDungeonProp("move"), true);
    assert.equal(canDragGraphNode("move"), true);
  });

  it("rotate/scale/unknown fall back to camera (no edit)", () => {
    for (const t of ["rotate", "scale", "snap", "", "banana"]) {
      assert.equal(canSculptTerrain(t), false, t);
      assert.equal(canDragDungeonProp(t), false, t);
      assert.equal(canDragGraphNode(t), false, t);
    }
  });

  it("game view documents its select default", () => {
    assert.match(gameViewToolNote(), /select/);
  });
});
