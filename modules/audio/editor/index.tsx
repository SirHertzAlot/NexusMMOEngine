// Editor entry of the audio module (roadmap EA13): the Art & audio workspace's audio panel,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { AudioPanel } from "../../../apps/editor/src/ui/audio-panel.js";

export const panels = [
  {
    id: "audio.panel",
    workspace: "artaudio",
    title: "Audio",
    icon: "graphic_eq",
    render: () => <AudioPanel />,
  },
];
