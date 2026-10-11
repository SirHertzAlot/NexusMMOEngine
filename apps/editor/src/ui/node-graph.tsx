/**
 * NodeGraph: the one node-graph canvas of the editor.
 *
 * PCG graphs, the game flow, and quests and dialogs all draw through this.
 * It owns its own view (pan, zoom, fit) and the pointer gestures: drag the
 * background to pan, wheel to zoom toward the cursor, press a node to pick
 * it, drag it with the move tool, double-click and right-click it. The
 * caller passes data and callbacks and decides what a node looks like:
 *
 *   <NodeGraph nodes={...} edges={...} nodeId={...} nodePos={...} edgeEnds={...}
 *              renderNode={(n, { selected }) => <rect .../>} onSelect={...} />
 *
 * Nodes are drawn at their position; `renderNode` returns SVG for the
 * inside of the node's box (origin at the node's top-left). The view's
 * maths and the edge routes are in graph-view.ts, where they are tested.
 */

import * as React from "react";
import {
  fitView,
  panFrom,
  toWorld,
  topDownRoute,
  zoomAt,
  ZOOM_STEP,
  type Box,
  type EdgeGeom,
  type GraphView,
} from "../graph-view.js";
import { useDrag } from "./use-drag.js";
import { IconButton, MIcon } from "./components.js";

export interface NodeGraphProps<N, E> {
  nodes: readonly N[];
  edges: readonly E[];
  nodeId: (n: N) => string;
  nodePos: (n: N) => { x: number; y: number };
  /** Every node's box size (default 168 x 52), or one per node. */
  nodeSize?: { w: number; h: number } | ((n: N) => { w: number; h: number });
  edgeEnds: (e: E) => { from: string; to: string };
  /** The inside of a node's box; the origin is the node's top-left corner. */
  renderNode: (n: N, state: { selected: boolean }) => React.ReactNode;
  /** An edge's route (default: top-down between the node boxes). */
  route?: (from: { node: N; box: Box }, to: { node: N; box: Box }, edge: E) => EdgeGeom;
  /** An edge's drawing (default: a grey arrow). `arrow` is the marker url for `markerEnd`. */
  renderEdge?: (edge: E, geom: EdgeGeom, arrow: string) => React.ReactNode;
  selectedId?: string | null;
  /** A node was picked, or (null) the background was pressed. */
  onSelect?: (id: string | null) => void;
  /** Whether pressing a node starts dragging it (the move tool). */
  canMove?: boolean;
  /** A node was dragged to (x, y) in world units. */
  onMove?: (id: string, x: number, y: number) => void;
  /** A node drag ended (commit one undo step). */
  onMoveEnd?: () => void;
  onNodeDoubleClick?: (id: string) => void;
  onNodeContextMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Re-fit the view when this changes (another document, another level). */
  fitKey?: string;
  /** Canvas height: a number is pixels. Default fills a 420px minimum. */
  height?: number | string;
  label: string;
  testId?: string;
}

const DEFAULT_SIZE = { w: 168, h: 52 };
const ARROW_FILL = "#90909A";

/** Which pointer gesture is in progress. */
type Gesture =
  | { kind: "pan"; origin: GraphView }
  | { kind: "node"; id: string; ox: number; oy: number };

export function NodeGraph<N, E>(props: NodeGraphProps<N, E>): React.JSX.Element {
  const { nodes, edges, nodeId, nodePos, edgeEnds, renderNode } = props;
  const uid = React.useId().replace(/:/g, "");
  const arrow = `url(#ng-arrow-${uid})`;
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [view, setView] = React.useState<GraphView>({ x: -60, y: -60, scale: 1 });
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const drag = useDrag<Gesture>({
    start: () => {
      props.onSelect?.(null);
      return { kind: "pan", origin: viewRef.current };
    },
    move: (_e, g, d) => {
      if (g.kind === "pan") {
        setView(panFrom(g.origin, d.dx, d.dy));
      } else {
        const k = viewRef.current.scale;
        props.onMove?.(g.id, g.ox + d.dx / k, g.oy + d.dy / k);
      }
    },
    end: (_e, g, moved) => {
      if (g.kind === "node" && moved) props.onMoveEnd?.();
    },
  });
  const [size, setSize] = React.useState({ w: 800, h: 500 });

  const sizeOf = (n: N): { w: number; h: number } => {
    const s = props.nodeSize ?? DEFAULT_SIZE;
    return typeof s === "function" ? s(n) : s;
  };
  const boxes = new Map<string, { node: N; box: Box }>();
  for (const n of nodes) {
    const p = nodePos(n);
    boxes.set(nodeId(n), { node: n, box: { x: p.x, y: p.y, ...sizeOf(n) } });
  }

  // Track the canvas's size, for the grid and the wheel.
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = (): void => {
    const el = svgRef.current;
    setView(fitView([...boxes.values()].map((b) => b.box), { w: el?.clientWidth ?? 800, h: el?.clientHeight ?? 500 }));
  };
  // Fit when the document changes, not on every edit.
  React.useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  // The wheel zooms toward the cursor. A native listener, because React's
  // wheel handler is passive and could not stop the page scrolling.
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const v = viewRef.current;
      const p = toWorld(v, el.getBoundingClientRect(), e.clientX, e.clientY);
      setView(zoomAt(v, p.x, p.y, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number): void => {
    const v = viewRef.current;
    setView(zoomAt(v, v.x + size.w / v.scale / 2, v.y + size.h / v.scale / 2, factor));
  };

  const edgeNode = props.renderEdge;
  const route = props.route ?? ((a, b) => topDownRoute(a.box, b.box));

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        className="w-full cursor-grab touch-none select-none rounded-xl"
        style={{ height: props.height ?? "60vh", minHeight: 260, background: "var(--m3-surface-0)" }}
        role="img"
        aria-label={props.label}
        data-testid={props.testId ?? "node-graph"}
        {...drag.handlers}
      >
        <defs>
          <marker id={`ng-arrow-${uid}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={ARROW_FILL} />
          </marker>
          <pattern id={`ng-grid-${uid}`} width="40" height="40" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--m3-outline-variant)" opacity="0.6" />
          </pattern>
        </defs>
        <g transform={`scale(${view.scale}) translate(${-view.x},${-view.y})`}>
          <rect
            x={view.x - 40}
            y={view.y - 40}
            width={size.w / view.scale + 80}
            height={size.h / view.scale + 80}
            fill={`url(#ng-grid-${uid})`}
            pointerEvents="none"
          />
          {edges.map((e, i) => {
            const { from, to } = edgeEnds(e);
            const a = boxes.get(from);
            const b = boxes.get(to);
            if (!a || !b) return null;
            const geom = route(a, b, e);
            return (
              <g key={i} pointerEvents="none">
                {edgeNode ? edgeNode(e, geom, arrow) : <path d={geom.d} fill="none" stroke={ARROW_FILL} strokeWidth={1.5} markerEnd={arrow} />}
              </g>
            );
          })}
          {nodes.map((n) => {
            const id = nodeId(n);
            const { box } = boxes.get(id)!;
            return (
              <g
                key={id}
                data-node={id}
                transform={`translate(${box.x} ${box.y})`}
                style={{ cursor: props.canMove ? "grab" : "pointer" }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  props.onSelect?.(id);
                  if (!props.canMove) return;
                  // Captured on the node (not the canvas), so its double-click still lands on it.
                  drag.begin(e, { kind: "node", id, ox: box.x, oy: box.y });
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  props.onNodeDoubleClick?.(id);
                }}
                onContextMenu={(e) => {
                  if (!props.onNodeContextMenu) return;
                  e.preventDefault();
                  e.stopPropagation();
                  props.onNodeContextMenu(id, { x: e.clientX, y: e.clientY });
                }}
              >
                {renderNode(n, { selected: props.selectedId === id })}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute right-2 top-2 flex gap-1" role="toolbar" aria-label="Graph view">
        <IconButton label="Zoom in" size={36} onClick={() => zoomBy(ZOOM_STEP * ZOOM_STEP)}><MIcon name="add" size={16} /></IconButton>
        <IconButton label="Zoom out" size={36} onClick={() => zoomBy(1 / (ZOOM_STEP * ZOOM_STEP))}><MIcon name="remove" size={16} /></IconButton>
        <IconButton label="Fit the graph" size={36} onClick={fit}><MIcon name="fit_screen" size={16} /></IconButton>
      </div>
    </div>
  );
}
