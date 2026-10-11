/**
 * Valgrind tab: hosts the standalone dashboard (scripts/valgrind) in a
 * frame. The dashboard is its own dependency-free server, so it keeps
 * working when the editor changes; this tab only embeds it.
 */

import * as React from "react";

const DASHBOARD_URL = "http://localhost:5180";

export function ValgrindPanel(): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "6px 12px", fontSize: 13 }}>
        Needs <code>npm run valgrind:dashboard</code> running.{" "}
        <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">
          Open in a new tab
        </a>
      </div>
      <iframe title="Valgrind dashboard" src={DASHBOARD_URL} style={{ flex: 1, border: 0, minHeight: 600 }} />
    </div>
  );
}
