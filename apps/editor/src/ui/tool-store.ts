/**
 * Shared viewport tool store — the toolbar's single source of truth.
 *
 * The toolbar used to keep `tool` in local useState, so no viewport
 * could see it. Every viewport now reads this store instead:
 *
 * - terrain sculpt: only while the move tool is active (otherwise the
 *   left button orbits like everywhere else);
 * - dungeon: prop drag only with move, otherwise orbit + pick;
 * - graph / flow canvases: node drag only with move, otherwise pan +
 *   select;
 * - game view: no separate orbit mode (the follow camera owns it), so
 *   select stays the camera/pick default there.
 *
 * Tools are the toolbar's existing ids: select | move | rotate | scale.
 * ("snap" stays a toolbar-local toggle, not a viewport mode: viewports
 * treat any unknown tool like select.)
 */

export type EditorTool = string;

let current: EditorTool = "select";
const listeners = new Set<() => void>();

export function getTool(): EditorTool {
  return current;
}

export function setTool(t: EditorTool): void {
  if (t === current) return;
  current = t;
  listeners.forEach((fn) => fn());
}

export function subscribeTool(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
