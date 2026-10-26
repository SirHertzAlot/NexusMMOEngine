// Editor entry of the authoring module (Phase B): the Design workspace's
// Authoring panel, contributed through the module registry instead of
// hard-wired into the shell — the same pattern as every other panel.
import * as React from "react";
import { AuthoringView } from "../../../apps/editor/src/ui/authoring-view.js";

export const panels = [
  {
    id: "authoring.design",
    workspace: "design",
    title: "Authoring",
    icon: "design_services",
    render: () => <AuthoringView />,
  },
];
