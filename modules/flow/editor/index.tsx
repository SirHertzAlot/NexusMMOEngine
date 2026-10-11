// Editor entry of the flow module (roadmap EA13): the Flow workspace's flow graph editor,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { FlowEditor } from "../../../apps/editor/src/ui/flow-editor.js";

export const panels = [
  {
    id: "flow.graph",
    workspace: "flow",
    title: "Flow graph",
    icon: "account_tree",
    render: () => <FlowEditor />,
  },
];
