// Editor entry of the ecs module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { EcsInspectorPanel } from "../../../apps/editor/src/ui/ecs-inspector.js";

export const panels = [
  {
    id: "ecs",
    workspace: "scene",
    title: "Viewport",
    icon: "view_in_ar",
    render: () => <EcsInspectorPanel />,
  },
];
