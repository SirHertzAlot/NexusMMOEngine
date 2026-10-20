// Editor entry of the dungeons module (complete-modularity): the Dungeons &
// PCG workspace panels, contributed instead of hard-wired into the shell.
// Panel ids preserve the pre-module view ids so saved layouts keep working.
import * as React from "react";
import { DungeonPanel } from "../../../apps/editor/src/ui/dungeon-view.js";
import { GraphEditorPanel } from "../../../apps/editor/src/ui/graph-editor.js";
import { DungeonRulesPanel } from "../../../apps/editor/src/ui/dungeon-rules-panel.js";
import { SettlementPanel } from "../../../apps/editor/src/ui/settlement-panel.js";

export const panels = [
  {
    id: "dungeons",
    workspace: "dungeons",
    title: "Dungeon",
    icon: "castle",
    render: () => <DungeonPanel />,
  },
  {
    id: "graphs",
    workspace: "dungeons",
    title: "PICG Graphs",
    icon: "graph_3",
    render: () => <GraphEditorPanel />,
  },
  {
    id: "runs",
    workspace: "dungeons",
    title: "Runs",
    icon: "timer",
    render: () => <DungeonRulesPanel />,
  },
  {
    id: "towns",
    workspace: "dungeons",
    title: "Towns",
    icon: "location_city",
    render: () => <SettlementPanel />,
  },
];
