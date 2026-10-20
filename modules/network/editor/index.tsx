// Editor entry of the network module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { EdgeRoutesPanel, ConnectionsPanel } from "../../../apps/editor/src/ui/network-live.js";

export const panels = [
  {
    id: "routes",
    workspace: "network",
    title: "Edge routes",
    icon: "lan",
    render: () => <EdgeRoutesPanel />,
  },
  {
    id: "connections",
    workspace: "network",
    title: "Connections",
    icon: "network_check",
    render: () => <ConnectionsPanel />,
  },
];
