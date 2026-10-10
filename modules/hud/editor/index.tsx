// Editor entry of the hud module (roadmap EA13): the Release workspace's HUD layout editor,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { HudEditor } from "../../../apps/editor/src/ui/hud-editor.js";

export const panels = [
  {
    id: "hud.editor",
    workspace: "release",
    title: "HUD layout",
    icon: "dashboard",
    render: () => <HudEditor />,
  },
];
