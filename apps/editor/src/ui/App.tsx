/**
 * Editor shell — one dock, one panel per inspector.
 *
 * Tabs: ECS Inspector (read-only entity browser), Play Mode (owned
 * local server + debug overlays), Terrain (sculpt the world heightmap),
 * PICG Graphs (the hierarchical graph editor, E7),
 * Art Asset Pipeline (pack scan / validation / browser load test),
 * Characters (read-only character records), Gameplay Tables (item bases,
 * creatures, loot and death rules), Rules (gameplay tunables).
 * Each inspector owns its panel and its view-model; the shell only
 * switches between them.
 */

import * as React from "react";
import { EcsInspectorPanel } from "./ecs-inspector.js";
import { PlayModePanel } from "./play-mode.js";
import { AssetInspectorPanel } from "./asset-inspector.js";
import { TerrainEditorPanel } from "./terrain-editor.js";
import { CharacterRecordPanel } from "./character-view.js";
import { GraphEditorPanel } from "./graph-editor.js";
import { DungeonPanel } from "./dungeon-view.js";

import { RulesPanel } from "./rules-editor.js";
import { ValgrindPanel } from "./valgrind-panel.js";
import { RulesPanel as TablesPanel } from "./rules-panel.js";

type Tab = "ecs" | "play" | "terrain" | "graphs" | "dungeons" | "assets" | "tables" | "rules" | "characters" | "valgrind";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "ecs", label: "ECS Inspector" },
  { id: "play", label: "Play Mode" },
  { id: "terrain", label: "Terrain" },
  { id: "graphs", label: "PICG Graphs" },
  { id: "dungeons", label: "Dungeons" },
  { id: "tables", label: "Gameplay Tables" },
  { id: "assets", label: "Art Assets" },
  { id: "rules", label: "Rules" },
  { id: "characters", label: "Characters" },
  { id: "valgrind", label: "Valgrind" },
];

export function App(): React.JSX.Element {
  const [tab, setTab] = React.useState<Tab>("ecs");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-bold">MMO Engine — Editor</h1>
            <p className="text-xs text-muted-foreground">
              Rogue Engine Editor customization · ECS · play mode · gameplay tables · art pipeline
            </p>
          </div>
          <nav className="flex gap-1" role="tablist" aria-label="Inspectors">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={
                  "rounded-md px-4 py-2 text-sm font-medium transition-colors " +
                  (tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
                }
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab === "ecs" && <EcsInspectorPanel />}
        {tab === "play" && <PlayModePanel />}
        {tab === "terrain" && <TerrainEditorPanel />}
        {tab === "graphs" && <GraphEditorPanel />}
        {tab === "dungeons" && <DungeonPanel />}
        {tab === "tables" && <TablesPanel />}
        {tab === "assets" && <AssetInspectorPanel />}
        {tab === "rules" && <RulesPanel />}
        {tab === "characters" && <CharacterRecordPanel />}
        {tab === "valgrind" && <ValgrindPanel />}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-muted-foreground">
        Server stays authoritative — the editor inspects live state and never
        edits a running simulation; terrain edits apply to the stored world, and
        saved gameplay tables are validated first, then picked up by a running server. Docs:{" "}
        <span className="font-mono">docs/EDITOR.md</span>
      </footer>
    </div>
  );
}
