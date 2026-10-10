// Editor entry of the scenes module (roadmap EA13): the Scenes workspace's Scene document panel,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { ScenesPanel } from "../../../apps/editor/src/ui/scenes-panel.js";

export const panels = [
  {
    id: "scenes.document",
    workspace: "scenes",
    title: "Scene document",
    icon: "account_tree",
    render: () => <ScenesPanel />,
  },
];
