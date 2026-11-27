/**
 * Viewport preview for slice EU6: the real `SceneView` over a tiny scene,
 * driven by the real shared tool store.
 *
 * Nothing is reimplemented. `window.__viewportDrive({ tool })` writes
 * `tool-store.ts` — the same store the toolbar writes — and the gizmo on
 * screen is whatever `SceneView` makes of it, which is the point of the
 * slice. The corner triad is `three`'s own `ViewHelper`, drawn by
 * `SceneView`'s render loop.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { SceneDoc } from "@mmo-engine/scene";
import { SceneView } from "../scene-view.js";
import { selectOnly } from "../../scene-selection.js";
import { setTool } from "../tool-store.js";
import { gizmoModeFor } from "../viewport-tools.js";

const DOC: SceneDoc = {
  version: 1,
  name: "gizmo-preview",
  kind: "world",
  nodes: [
    { id: "a", name: "Marker A", kind: "group", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1.6, 1.6, 1.6] } },
    { id: "b", name: "Marker B", kind: "group", transform: { position: [6, 0, -4], rotation: [0, 30, 0], scale: [1, 2.2, 1] } },
    { id: "c", name: "Marker C", kind: "group", transform: { position: [-7, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ],
};

function Preview(): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewRef = React.useRef<SceneView | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const view = new SceneView(canvas, {
      onSelect: () => undefined,
      onTransform: () => undefined,
      onPlace: () => undefined,
    });
    viewRef.current = view;
    view.setDoc(DOC, selectOnly("a"), new Set());
    // Frame, then close in, so the gizmo fills the shot rather than sitting
    // at the default orbit distance.
    view.frame();
    for (let i = 0; i < 4; i += 1) view.zoomIn();
    (window as unknown as { __viewportDrive?: (s: { tool?: string; axes?: boolean }) => void }).__viewportDrive =
      (step) => {
        if (step.tool) {
          setTool(step.tool);
          const mode = gizmoModeFor(step.tool);
          view.setGizmos(mode !== null);
          if (mode) view.setMode(mode);
        }
        if (step.axes !== undefined) view.setAxes(step.axes);
      };
    (window as unknown as { __viewportReady?: boolean }).__viewportReady = true;
    return () => view.dispose();
  }, []);

  return (
    <div
      data-shot="viewport"
      data-theme="forge"
      style={{ width: 900, height: 560, background: "var(--fg-canvas)", border: "1px solid var(--fg-line)" }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge viewport preview: #root missing");
createRoot(root).render(<Preview />);
