/**
 * EA23 HUD drag editor: pure layout math.
 *
 * The editor canvas represents the screen. Widgets are boxes; dragging
 * one updates its anchor offset. Overlaps are computed from the boxes so
 * the UI can flag them before the author saves.
 *
 * The Anchor/WidgetPlacement shapes mirror apps/client/src/ui/hud-layout.ts
 * (the client owns the schema; the editor reads and writes the JSON).
 */

export type Anchor =
  | "top-left" | "top-center" | "top-right"
  | "center-left" | "center" | "center-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export interface WidgetPlacement {
  anchor: Anchor;
  offset: { x: number; y: number };
  visible: boolean;
}

export interface Screen { w: number; h: number }
export interface Size { w: number; h: number }
export interface Rect extends Size { x: number; y: number }
export interface WidgetBox extends Rect { id: string }

/** Screen rect of a widget placement (for the editor canvas). */
export function widgetRect(placement: Pick<WidgetPlacement, "anchor" | "offset">, size: Size, screen: Screen): Rect {
  const { anchor, offset } = placement;
  const { x, y } = offset;
  const { w, h } = size;
  switch (anchor) {
    case "top-left": return { x, y, w, h };
    case "top-center": return { x: screen.w / 2 - w / 2 + x, y, w, h };
    case "top-right": return { x: screen.w - x - w, y, w, h };
    case "center-left": return { x, y: screen.h / 2 - h / 2 + y, w, h };
    case "center": return { x: screen.w / 2 - w / 2 + x, y: screen.h / 2 - h / 2 + y, w, h };
    case "center-right": return { x: screen.w - x - w, y: screen.h / 2 - h / 2 + y, w, h };
    case "bottom-left": return { x, y: screen.h - y - h, w, h };
    case "bottom-center": return { x: screen.w / 2 - w / 2 + x, y: screen.h - y - h, w, h };
    case "bottom-right": return { x: screen.w - x - w, y: screen.h - y - h, w, h };
  }
}

/** Pairs of widget ids whose boxes overlap (touching edges are fine). */
export function findOverlaps(boxes: WidgetBox[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) out.push([a.id, b.id]);
    }
  }
  return out;
}

/**
 * Drag a widget by (dx, dy) screen pixels. The anchor stays; the offset
 * moves, clamped so the widget stays on screen.
 */
export function moveWidget(
  placement: WidgetPlacement,
  delta: { dx: number; dy: number },
  screen: Screen,
  size: Size,
): WidgetPlacement {
  // Convert the screen delta to an offset delta for the anchor.
  // For right/bottom anchors, moving right/down on screen *decreases* the offset.
  const { anchor } = placement;
  const sx = anchor.includes("right") ? -1 : 1;
  const sy = anchor.includes("bottom") ? -1 : 1;
  // Center anchors: the widget is centered, so offset moves 1:1 with the drag.
  const ox = placement.offset.x + delta.dx * sx;
  const oy = placement.offset.y + delta.dy * sy;

  // Clamp: keep the widget fully on screen.
  const rect = widgetRect({ anchor, offset: { x: ox, y: oy } }, size, screen);
  let cx = ox, cy = oy;
  if (rect.x < 0) cx = ox - rect.x * sx;
  if (rect.y < 0) cy = oy - rect.y * sy;
  if (rect.x + size.w > screen.w) cx = ox - (rect.x + size.w - screen.w) * sx;
  if (rect.y + size.h > screen.h) cy = oy - (rect.y + size.h - screen.h) * sy;
  return { ...placement, offset: { x: Math.round(cx), y: Math.round(cy) } };
}
