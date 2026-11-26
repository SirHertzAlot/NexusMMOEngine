/**
 * Viewport preview for slice EB1: the real `SceneView` over a scene of real
 * placeables, with and without the visual table.
 *
 * Nothing is mocked. `window.__visualsDrive({ visuals })` hands the view the
 * table the host built from the engine's own tables (the capture script
 * reads it with `readSceneVisuals`), and what changes on screen is
 * `SceneView`'s own reaction: a goblin becomes a 1.8 m capsule, a wolf a
 * knee-high one, an oak a tree-sized box. Called with no table, the view
 * draws what it always drew — one 1 m cube each.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { SceneDoc } from "@mmo-engine/scene";
import type { NodeVisual } from "../../scene-visuals.js";
import { SceneView } from "../scene-view.js";

/** Scene-space rows: creatures at the front, trees behind them. */
const ROW: Array<[string, number, number]> = [
  ["wolf", -7, 3],
  ["goblin", -3.5, 3],
  ["giant-spider", 0, 3],
  ["bear", 3.5, 3],
  ["troll", 7, 3],
  ["oak", -6, -6],
  ["pine", 0, -7],
  ["birch", 6, -6],
];

const DOC: SceneDoc = {
  version: 1,
  name: "eb1-preview",
  kind: "world",
  nodes: ROW.map(([prefab, x, z]) => ({
    id: prefab,
    name: prefab,
    kind: "prefab",
    prefab,
    transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })),
};

const SPECIES = new Set(["wolf", "goblin", "giant-spider", "bear", "troll"]);

function Preview(): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const view = new SceneView(canvas, {
      onSelect: () => undefined,
      onTransform: () => undefined,
      onPlace: () => undefined,
    });
    view.setDoc(DOC, null, SPECIES);
    view.setGizmos(false);
    view.lookAt(0, -1);
    for (let i = 0; i < 5; i += 1) view.zoomIn();
    (window as unknown as { __visualsDrive?: (s: { visuals?: Record<string, NodeVisual> }) => void }).__visualsDrive =
      (step) => view.setVisuals(step.visuals ?? {});
    (window as unknown as { __visualsReady?: boolean }).__visualsReady = true;
    return () => view.dispose();
  }, []);

  return (
    <div
      data-shot="visuals"
      data-theme="forge"
      style={{ width: 900, height: 520, background: "var(--fg-canvas)", border: "1px solid var(--fg-line)" }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge visuals preview: #root missing");
createRoot(root).render(<Preview />);
