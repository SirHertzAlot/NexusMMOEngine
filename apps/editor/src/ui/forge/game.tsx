/**
 * Game panel preview for slice EB10: the real `GamePanel` in the forge
 * theme, against the real `/api/editor/game` route.
 *
 * The capture script serves the route with the host's own handler over a
 * throwaway project, so the modules and their declared settings are read
 * from real `module.json` files rather than from a fixture.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { GamePanel } from "../game-panel.js";

function Frame(): React.JSX.Element {
  React.useEffect(() => {
    (window as unknown as { __gameReady?: boolean }).__gameReady = true;
  }, []);
  return (
    <div
      data-shot="game"
      data-theme="forge"
      style={{
        width: 1180,
        height: 620,
        background: "var(--fg-panel)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--m3-font-ui)",
        border: "1px solid var(--fg-line)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <GamePanel />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge game preview: #root missing");
createRoot(root).render(<Frame />);
