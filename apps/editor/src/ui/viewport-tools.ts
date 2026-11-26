/**
 * Viewport tool mapping — what the shared toolbar tool means per viewport.
 *
 * select is the camera/pick default everywhere. move is the edit gesture:
 * terrain sculpting, dungeon prop drags, graph/flow node drags. rotate
 * and scale are reserved for the scene viewport's gizmos; the viewports
 * below treat them as camera (no left-button edit). Unknown tools
 * (including the toolbar-local "snap" toggle) fall back to select.
 */

import type { EditorTool } from "./tool-store.js";
import type { GizmoMode } from "./scene-view.js";

/**
 * Which transform gizmo the scene viewport shows for a tool, or null for
 * camera/pick with no gizmo at all.
 *
 * The scene viewport used to keep this in its own `useState` with its own
 * W/E/R keys, so the toolbar's tool and the gizmo on screen could say two
 * different things at once — and the shell's context bar, which reports
 * the shared tool, would then be reporting the wrong one. One store now
 * drives both.
 */
export function gizmoModeFor(tool: EditorTool): GizmoMode | null {
  switch (tool) {
    case "move":
      return "translate";
    case "rotate":
      return "rotate";
    case "scale":
      return "scale";
    // select, snap, and anything a module adds: camera and pick only.
    default:
      return null;
  }
}

/** The tool that shows `mode` — the inverse of `gizmoModeFor`. */
export function toolForGizmoMode(mode: GizmoMode): EditorTool {
  return mode === "translate" ? "move" : mode;
}

/** Left-drag sculpts terrain only with the move tool. */
export function canSculptTerrain(tool: EditorTool): boolean {
  return tool === "move";
}

/** Dragging a dungeon prop moves it only with the move tool. */
export function canDragDungeonProp(tool: EditorTool): boolean {
  return tool === "move";
}

/** Dragging a graph/flow node moves it only with the move tool. */
export function canDragGraphNode(tool: EditorTool): boolean {
  return tool === "move";
}

/**
 * Game view: no sensible tool mapping — the follow camera owns orbit
 * and a left click picks the target. select stays the camera/pick
 * default; the tool changes nothing there (noted, not pretended).
 */
export function gameViewToolNote(): string {
  return "select is the camera/pick default; the follow camera owns orbit in every tool";
}
