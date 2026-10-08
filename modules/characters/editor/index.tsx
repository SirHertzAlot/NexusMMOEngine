// Editor entry of the characters module (roadmap EA3): the Characters
// workspace's Records panel, contributed instead of hard-wired into the shell.
import * as React from "react";
import { CharacterRecordPanel } from "../../../apps/editor/src/ui/character-view.js";

export const panels = [
  {
    id: "characters.records",
    workspace: "characters",
    title: "Records",
    icon: "person",
    render: () => <CharacterRecordPanel />,
  },
];
