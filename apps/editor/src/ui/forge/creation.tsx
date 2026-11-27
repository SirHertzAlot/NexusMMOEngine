/**
 * Character creation preview for slice EB7: the real `CreationRulesPanel`
 * in the forge theme, against the real `/api/editor/docs/characterCreation`
 * route, so the form holds this repository's own file.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { CreationRulesPanel } from "../creation-rules-panel.js";

function Frame(): React.JSX.Element {
  React.useEffect(() => {
    (window as unknown as { __creationReady?: boolean }).__creationReady = true;
  }, []);
  return (
    <div
      data-shot="creation"
      data-theme="forge"
      style={{
        width: 1180,
        height: 2060,
        background: "var(--fg-panel)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--m3-font-ui)",
        border: "1px solid var(--fg-line)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <CreationRulesPanel />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge creation preview: #root missing");
createRoot(root).render(<Frame />);
