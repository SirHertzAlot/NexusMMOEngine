/**
 * The scene viewport's gizmo follows the SHARED tool (slice EU6).
 *
 * It used to keep the gizmo mode in its own `useState` with its own
 * W/E/R keys, so the toolbar could say "move" while the viewport showed
 * a rotate ring, and the shell's context bar — which reports the shared
 * tool — would then be reporting the wrong one. These tests pin the one
 * mapping both sides now go through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canDragDungeonProp,
  canDragGraphNode,
  canSculptTerrain,
  gizmoModeFor,
  toolForGizmoMode,
} from "../src/ui/viewport-tools.js";
import type { GizmoMode } from "../src/ui/scene-view.js";

describe("gizmo mode follows the shared tool", () => {
  it("maps each edit tool to its gizmo", () => {
    assert.equal(gizmoModeFor("move"), "translate");
    assert.equal(gizmoModeFor("rotate"), "rotate");
    assert.equal(gizmoModeFor("scale"), "scale");
  });

  it("shows no gizmo at all under select — camera and pick only", () => {
    assert.equal(gizmoModeFor("select"), null);
  });

  it("treats the toolbar-local snap toggle, and anything a module adds, as select", () => {
    assert.equal(gizmoModeFor("snap"), null);
    assert.equal(gizmoModeFor("some-module-tool"), null);
  });

  it("round-trips: picking a gizmo in the viewport sets the tool that shows it", () => {
    for (const mode of ["translate", "rotate", "scale"] as GizmoMode[]) {
      assert.equal(gizmoModeFor(toolForGizmoMode(mode)), mode);
    }
  });

  it("agrees with the edit-gesture rule the other viewports already follow", () => {
    // move is the edit gesture everywhere; the scene viewport's translate
    // gizmo is the same tool, so these cannot drift apart again.
    assert.equal(toolForGizmoMode("translate"), "move");
    assert.ok(canSculptTerrain(toolForGizmoMode("translate")));
    assert.ok(canDragDungeonProp(toolForGizmoMode("translate")));
    assert.ok(canDragGraphNode(toolForGizmoMode("translate")));
    // and rotate/scale stay camera-only in those viewports
    assert.equal(canSculptTerrain("rotate"), false);
    assert.equal(canDragDungeonProp("scale"), false);
  });
});
