// Editor entry of the terrain module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";

// Lazy-load the heavy TerrainEditor panel (code splitting)
const TerrainEditorPanel = React.lazy(() =>
  import("../../../apps/editor/src/ui/terrain-editor.js").then((m) => ({ default: m.TerrainEditorPanel }))
);

export const panels = [
  {
    id: "terrain",
    workspace: "world",
    title: "Viewport",
    icon: "landscape",
    // Wrap in Suspense for lazy loading
    render: () => (
      <React.Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground">Loading terrain editor…</div>}>
        <TerrainEditorPanel />
      </React.Suspense>
    ),
  },
];
