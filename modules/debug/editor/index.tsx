// Editor entry of the debug module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { PlayModePanel } from "../../../apps/editor/src/ui/play-mode.js";

export const panels = [
  {
    id: "play",
    workspace: "debug",
    title: "Play mode",
    icon: "play_arrow",
    render: () => <PlayModePanel />,
  },
];
