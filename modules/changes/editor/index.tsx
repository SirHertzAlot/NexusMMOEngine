// Editor entry of the changes module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { ChangesPanel } from "../../../apps/editor/src/ui/vcs-panel.js";

export const panels = [
  {
    id: "changes",
    workspace: "changes",
    title: "Changes",
    icon: "commit",
    render: () => <ChangesPanel />,
  },
];
