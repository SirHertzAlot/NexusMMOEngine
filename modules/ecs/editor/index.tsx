// Editor entry of the ecs module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { EcsInspectorPanel } from "../../../apps/editor/src/ui/ecs-inspector.js";
import { ForgeEntityInspector } from "../../../apps/editor/src/ui/forge-inspector.js";
import { ForgeSystemsPanel } from "../../../apps/editor/src/ui/forge-systems.js";

export const panels = [
  {
    id: "ecs",
    workspace: "scene",
    title: "Viewport",
    icon: "view_in_ar",
    render: () => <EcsInspectorPanel />,
  },
  {
    // The 2026 design language on a real screen (docs/EDITOR-UI-2026.md).
    // Same session hook as the panel above, different presentation.
    id: "ecs-forge",
    workspace: "scene",
    title: "Inspector (Forge)",
    icon: "dashboard_customize",
    render: () => <ForgeEntityInspector />,
  },
  {
    // Every system, its component signature from the committed ECS graph,
    // and what it costs on the running tick (docs/EDITOR-UI-2026.md §2.3).
    id: "ecs-systems",
    workspace: "scene",
    title: "Systems",
    icon: "schema",
    render: () => <ForgeSystemsPanel />,
  },
];
