// Editor entry of the characters module (roadmap EA3): the Characters
// workspace's Records panel, contributed instead of hard-wired into the shell.
// (Complete-modularity: the Animation panel joined it in the Art & audio workspace.)
import * as React from "react";
import { CharacterRecordPanel } from "../../../apps/editor/src/ui/character-view.js";
import { AnimationPanel } from "../../../apps/editor/src/ui/animation-panel.js";
import { CreationRulesPanel } from "../../../apps/editor/src/ui/creation-rules-panel.js";

export const panels = [
  {
    id: "characters.records",
    workspace: "characters",
    title: "Records",
    icon: "person",
    render: () => <CharacterRecordPanel />,
  },
  {
    // EB7: what a player may choose when making one of these records.
    id: "characters.creation",
    workspace: "characters",
    title: "Creation",
    icon: "face",
    render: () => <CreationRulesPanel />,
  },
  {
    id: "animation",
    workspace: "artaudio",
    title: "Animation",
    icon: "directions_run",
    render: () => <AnimationPanel />,
  },
];
