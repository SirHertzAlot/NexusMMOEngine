// Editor entry of the gameplay module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { GameplayGridsPanel, ContentBrowserPanel } from "../../../apps/editor/src/ui/gameplay-grids.js";
import { RulesPanel as TablesPanel } from "../../../apps/editor/src/ui/rules-panel.js";
import { RulesPanel } from "../../../apps/editor/src/ui/rules-editor.js";

export const panels = [
  {
    id: "grids",
    workspace: "gameplay",
    title: "Data grids",
    icon: "grid_on",
    render: () => <GameplayGridsPanel />,
  },
  {
    id: "content",
    workspace: "gameplay",
    title: "Content browser",
    icon: "folder_open",
    render: () => <ContentBrowserPanel />,
  },
  {
    id: "tables",
    workspace: "gameplay",
    title: "Tables",
    icon: "table_view",
    render: () => <TablesPanel />,
  },
  {
    id: "rules",
    workspace: "gameplay",
    title: "Rules",
    icon: "tune",
    render: () => <RulesPanel />,
  },
];
