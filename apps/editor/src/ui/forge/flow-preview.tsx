/**
 * Flow preview for slice EB6: the real `FlowPreviewPane` framing the real
 * client dev server.
 *
 * The URL comes from `previewTarget`, the same function the flow editor
 * calls, and the frame is an iframe onto whatever the capture script was
 * told the client is running on — so the screen in the shot is the client,
 * not a picture of one.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { FlowDoc } from "@mmo-engine/scene";
import { previewTarget } from "../../flow-preview.js";
import { FlowPreviewPane } from "../flow-preview-pane.js";

const CLIENT = (window as unknown as { __client?: string }).__client ?? "http://localhost:5173";

const DOC = {
  version: 1,
  start: "login",
  nodes: { login: { scene: "login" }, create: { scene: "character-creation" }, world: { scene: "world" } },
  edges: [
    { from: "login", to: "create", event: "new-character" },
    { from: "create", to: "world", event: "created" },
  ],
} as unknown as FlowDoc;

function Frame(): React.JSX.Element {
  const [sizeId, setSizeId] = React.useState("fit");
  const target = previewTarget(DOC, "login", { client: CLIENT });
  React.useEffect(() => {
    (window as unknown as { __previewReady?: boolean }).__previewReady = true;
  }, []);
  return (
    <div
      data-shot="flow-preview"
      data-theme="forge"
      style={{
        width: 900,
        height: 450,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        background: "var(--fg-panel)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--m3-font-ui)",
        border: "1px solid var(--fg-line)",
      }}
    >
      <FlowPreviewPane
        target={"url" in target ? target : null}
        note={"error" in target ? target.error : ""}
        sizeId={sizeId}
        onSize={setSizeId}
        onOpenTab={() => undefined}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge flow preview: #root missing");
createRoot(root).render(<Frame />);
