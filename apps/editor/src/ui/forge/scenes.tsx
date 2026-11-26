/**
 * Scenes workspace preview for slices EB4 and EB4b: the real `ScenesPanel`,
 * in the forge theme, against the real host routes.
 *
 * Nothing here is a fixture. The capture script serves
 * `/api/editor/scenes`, `/api/editor/content/placeables` and
 * `/api/editor/scene/visuals` with the host's own handlers, so the scene,
 * the palette's contents and the sizes in the viewport are this
 * repository's. The frame only gives the panel a size and a theme.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { ScenesPanel } from "../scenes-panel.js";

function Frame(): React.JSX.Element {
  React.useEffect(() => {
    (window as unknown as { __scenesReady?: boolean }).__scenesReady = true;
  }, []);
  return (
    <div
      data-shot="scenes"
      data-theme="forge"
      style={{
        width: 1280,
        height: 720,
        background: "var(--fg-panel)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--m3-font-ui)",
        border: "1px solid var(--fg-line)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ScenesPanel />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge scenes preview: #root missing");
createRoot(root).render(<Frame />);
