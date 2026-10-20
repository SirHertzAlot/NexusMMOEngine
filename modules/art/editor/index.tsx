// Editor entry of the art module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { AssetInspectorPanel } from "../../../apps/editor/src/ui/asset-inspector.js";
import { MaterialsPanel } from "../../../apps/editor/src/ui/materials-panel.js";
import { ScalePanel } from "../../../apps/editor/src/ui/scale-panel.js";

export const panels = [
  {
    id: "assets",
    workspace: "artaudio",
    title: "Art Assets",
    icon: "palette",
    render: () => <AssetInspectorPanel />,
  },
  {
    id: "materials",
    workspace: "artaudio",
    title: "Materials",
    icon: "texture",
    render: () => <MaterialsPanel />,
  },
  {
    id: "scale",
    workspace: "artaudio",
    title: "Scale",
    icon: "straighten",
    render: () => <ScalePanel />,
  },
];
