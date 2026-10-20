// Editor entry of the terrain module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { TerrainEditorPanel } from "../../../apps/editor/src/ui/terrain-editor.js";

export const panels = [
  {
    id: "terrain",
    workspace: "world",
    title: "Viewport",
    icon: "landscape",
    render: () => <TerrainEditorPanel />,
  },
];
