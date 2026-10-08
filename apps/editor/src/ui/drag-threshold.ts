/**
 * Shared pointer-drag threshold for editor canvases.
 *
 * Flow, graph and dungeon canvases all gate drags behind the same few
 * pixels of movement so pointer jitter neither dirties the document nor
 * fights double-click (the established `moved < 5` click rule in
 * dungeon-view.tsx).
 */

export const DRAG_THRESHOLD_PX = 5;

/**
 * Whether the pointer has moved far enough from its press point for the
 * gesture to count as a drag. Compares in client pixels.
 */
export function pastDragThreshold(sx: number, sy: number, cx: number, cy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(cx - sx, cy - sy) >= threshold;
}
