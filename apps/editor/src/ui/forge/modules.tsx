/**
 * Modules workspace preview for slice EB9: the real `ModulesPanel` in the
 * forge theme, against the real `/api/editor/modules` route.
 *
 * The capture script serves that route with the host's own handler, so the
 * modules, their dependencies and the enabled set are this repository's —
 * which matters here, because the dependency chain the dialog walks
 * (economy, then items, then civic) is a real one.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { ModulesPanel } from "../modules-panel.js";

function Frame(): React.JSX.Element {
  React.useEffect(() => {
    (window as unknown as { __modulesReady?: boolean }).__modulesReady = true;
  }, []);
  return (
    <div
      data-shot="modules"
      data-theme="forge"
      style={{
        width: 1280,
        height: 760,
        background: "var(--fg-panel)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--m3-font-ui)",
        border: "1px solid var(--fg-line)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ModulesPanel />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge modules preview: #root missing");
createRoot(root).render(<Frame />);
