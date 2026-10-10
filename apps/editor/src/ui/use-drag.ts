/**
 * One pointer-drag gesture for every draggable thing in the editor: dock
 * dividers, graph nodes and bend handles, canvas pans.
 *
 * The hook owns the part each of them hand-wrote: ignore non-primary
 * buttons, capture the pointer so the drag survives leaving the element,
 * hold the gesture in a ref (no React state per pointermove), gate the
 * drag behind a few pixels so a click is not a drag, and always finish
 * on release or cancel. The caller supplies only what is specific: what
 * the gesture starts with, what a move does, and what the end does.
 *
 * `begin` starts a gesture from code that decided on its own (a node
 * inside a canvas that has a pan gesture), still handled by the same
 * element-level move/up handlers.
 */

import * as React from "react";
import { DRAG_THRESHOLD_PX, pastDragThreshold } from "./drag-threshold.js";

export interface DragDelta {
  /** Pointer travel since the press, in client pixels. */
  dx: number;
  dy: number;
  /** Travel since the previous move event. */
  stepX: number;
  stepY: number;
  /** The first move past the threshold (a good place to open an undo step). */
  first: boolean;
}

export interface DragOptions<S> {
  /** Start a gesture from a press: return its state, or undefined to ignore the press. */
  start?: (e: React.PointerEvent) => S | undefined;
  /** Called for every move past the threshold. */
  move: (e: React.PointerEvent, state: S, d: DragDelta) => void;
  /** Called on release or cancel; `moved` is whether the threshold was passed. */
  end?: (e: React.PointerEvent, state: S, moved: boolean) => void;
  /** Pixels of travel before the gesture counts as a drag (default 5; 0 = immediately). */
  threshold?: number;
  /** Stop the press from reaching ancestors (a node inside a pannable canvas). */
  stopPropagation?: boolean;
}

export interface DragHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

interface Live<S> {
  state: S;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
}

export interface Drag<S> {
  /** Spread on the element that starts the drag. */
  handlers: DragHandlers;
  /** Start a gesture by hand (the press event must come from the element that should capture). */
  begin: (e: React.PointerEvent, state: S) => void;
  /** Whether a gesture is in progress. */
  active: () => boolean;
}

export function useDrag<S>(options: DragOptions<S>): Drag<S> {
  const opts = React.useRef(options);
  opts.current = options;
  const live = React.useRef<Live<S> | null>(null);

  return React.useMemo<Drag<S>>(() => {
    const begin = (e: React.PointerEvent, state: S): void => {
      live.current = { state, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    };
    const finish = (e: React.PointerEvent): void => {
      const g = live.current;
      live.current = null;
      if (g) opts.current.end?.(e, g.state, g.moved);
    };
    const handlers: DragHandlers = {
      onPointerDown: (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        const o = opts.current;
        if (o.stopPropagation) e.stopPropagation();
        const state = o.start?.(e);
        if (state === undefined) return;
        begin(e, state);
      },
      onPointerMove: (e) => {
        const g = live.current;
        if (!g) return;
        const t = opts.current.threshold ?? DRAG_THRESHOLD_PX;
        if (!g.moved && t > 0 && !pastDragThreshold(g.sx, g.sy, e.clientX, e.clientY, t)) return;
        const first = !g.moved;
        g.moved = true;
        const d: DragDelta = { dx: e.clientX - g.sx, dy: e.clientY - g.sy, stepX: e.clientX - g.lx, stepY: e.clientY - g.ly, first };
        g.lx = e.clientX;
        g.ly = e.clientY;
        opts.current.move(e, g.state, d);
      },
      onPointerUp: finish,
      onPointerCancel: finish,
    };
    return { handlers, begin, active: () => live.current !== null };
  }, []);
}
