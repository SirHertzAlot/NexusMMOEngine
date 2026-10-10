// Editor entry of the vfx module (roadmap EA13): the Art & audio workspace's VFX particle editor,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { ParticlePanel } from "../../../apps/editor/src/ui/particle-panel.js";

export const panels = [
  {
    id: "vfx.editor",
    workspace: "artaudio",
    title: "VFX",
    icon: "auto_awesome",
    render: () => <ParticlePanel />,
  },
];
