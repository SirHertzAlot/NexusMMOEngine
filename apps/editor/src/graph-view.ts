/**
 * The pure half of the shared node-graph canvas (ui/node-graph.tsx): the
 * view transform (pan, zoom, fit) and the edge routes. Every graph in the
 * editor (PCG graphs, the game flow, quests and dialogs) draws through
 * these, so they pan, zoom and route the same way.
 */

/** What the canvas shows: the world point at the top-left corner and the zoom. */
export interface GraphView {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.5;
export const ZOOM_STEP = 1.1;

/** A node's rectangle in world units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clampScale = (scale: number, min = MIN_SCALE, max = MAX_SCALE): number => Math.min(max, Math.max(min, scale));

/** The world point under a client point. `rect` is the canvas's bounding rect. */
export function toWorld(view: GraphView, rect: { left: number; top: number }, clientX: number, clientY: number): { x: number; y: number } {
  return { x: view.x + (clientX - rect.left) / view.scale, y: view.y + (clientY - rect.top) / view.scale };
}

/** The view after dragging the background by (dx, dy) client pixels from `origin`. */
export function panFrom(origin: GraphView, dx: number, dy: number): GraphView {
  return { ...origin, x: origin.x - dx / origin.scale, y: origin.y - dy / origin.scale };
}

/**
 * Zoom by `factor` keeping the world point (wx, wy) where it is on screen,
 * so the wheel zooms toward the cursor. The scale is clamped.
 */
export function zoomAt(view: GraphView, wx: number, wy: number, factor: number): GraphView {
  const scale = clampScale(view.scale * factor);
  const k = view.scale / scale;
  return { scale, x: wx - (wx - view.x) * k, y: wy - (wy - view.y) * k };
}

/**
 * A view showing every node in a canvas of `size` pixels: centred, zoomed
 * out when the graph is bigger than the canvas (never in past 1:1).
 */
export function fitView(boxes: readonly Box[], size: { w: number; h: number }, pad = 40): GraphView {
  if (boxes.length === 0) return { x: -pad, y: -pad, scale: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const bw = Math.max(...boxes.map((b) => b.x + b.w)) - minX;
  const bh = Math.max(...boxes.map((b) => b.y + b.h)) - minY;
  const scale = clampScale(Math.min(1, (size.w - 2 * pad) / bw, (size.h - 2 * pad) / bh));
  // Centre the graph on the canvas (world units visible: size / scale).
  return { scale, x: minX - (size.w / scale - bw) / 2, y: minY - (size.h / scale - bh) / 2 };
}

/** Where an edge runs and where its label sits. */
export interface EdgeGeom {
  d: string;
  mid: { x: number; y: number };
}

/** The cubic from (x1, y1) down to (x2, y2): leaves downward, arrives from above. */
export function verticalCurve(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.max(30, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/**
 * Top-down edge: leaves the bottom of `a`, arrives at the top of `b`. The
 * optional x values pick pins along those sides (default the middle). An
 * edge from a node to itself loops under it.
 */
export function topDownRoute(a: Box, b: Box, pins: { fromX?: number; toX?: number } = {}): EdgeGeom {
  const x1 = pins.fromX ?? a.x + a.w / 2;
  const y1 = a.y + a.h;
  if (a === b) {
    return { d: `M ${x1} ${y1} q 40 40 80 0`, mid: { x: x1 + 40, y: y1 + 20 } };
  }
  const x2 = pins.toX ?? b.x + b.w / 2;
  return { d: verticalCurve(x1, y1, x2, b.y), mid: { x: (x1 + x2) / 2, y: (y1 + b.y) / 2 } };
}

/**
 * Left-to-right edge: leaves the right side of `a`, arrives at the left of
 * `b`. When `b` is not to the right (a way back), it loops under both.
 */
export function leftRightRoute(a: Box, b: Box): EdgeGeom {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (x2 <= x1) {
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    return {
      d: `M${ax},${a.y + a.h} C${ax},${a.y + a.h + 60} ${bx},${b.y + b.h + 60} ${bx},${b.y + b.h}`,
      mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 + 56 },
    };
  }
  return { d: `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6 } };
}
