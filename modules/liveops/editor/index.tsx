// Editor entry of the liveops module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { LiveOpsOverview, LiveOpsConsole, LiveOpsTelemetryView } from "../../../apps/editor/src/ui/liveops-live.js";

export const panels = [
  {
    id: "overview",
    workspace: "liveops",
    title: "Server & world",
    icon: "groups",
    render: () => <LiveOpsOverview />,
  },
  {
    id: "console",
    workspace: "liveops",
    title: "Admin console",
    icon: "terminal",
    render: () => <LiveOpsConsole />,
  },
  {
    id: "telemetry",
    workspace: "liveops",
    title: "Telemetry",
    icon: "monitoring",
    render: () => <LiveOpsTelemetryView />,
  },
];
