// Editor entry of the release module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { PipelineView } from "../../../apps/editor/src/ui/pipeline-view.js";
import { PlaytestsPanel } from "../../../apps/editor/src/ui/playtests-live.js";

export const panels = [
  {
    id: "pipeline",
    workspace: "release",
    title: "Pipeline",
    icon: "account_tree",
    render: () => <PipelineView />,
  },
  {
    id: "playtests",
    workspace: "release",
    title: "Playtests",
    icon: "science",
    render: () => <PlaytestsPanel />,
  },
];
