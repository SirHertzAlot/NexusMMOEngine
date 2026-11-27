// Editor entry of the core module (complete-modularity): the Modules
// registry workspace, contributed instead of hard-wired into the shell.
import * as React from "react";
import { ModulesPanel } from "../../../apps/editor/src/ui/modules-panel.js";
import { GamePanel } from "../../../apps/editor/src/ui/game-panel.js";

export const panels = [
  {
    id: "modules",
    workspace: "modules",
    title: "Modules",
    icon: "extension",
    render: () => <ModulesPanel />,
  },
  {
    // EB10: the game's own manifest and the settings its modules read.
    id: "game",
    workspace: "modules",
    title: "Game",
    icon: "tune",
    render: () => <GamePanel />,
  },
];
