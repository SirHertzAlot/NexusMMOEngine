/**
 * Dock content that reads the real project instead of sample data: the World
 * outliner (the baked world's own overview), the Content tree's scenes, and
 * the Details text for workspaces that have no selection of their own.
 */
import * as React from "react";
import { loadWorldOverview, type WorldOverview } from "../terrain/terrain-api.js";
import { editorSelection } from "./editor-selection.js";
import { ScopeTree, TreeItem } from "./components.js";
import type { ScopeNode } from "./scope-tree.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;

interface WorldNode extends ScopeNode {
  kind: string;
  children?: WorldNode[];
}

export function worldNodes(w: WorldOverview): WorldNode[] {
  const size = (w.bounds.maxChunk - w.bounds.minChunk + 1) * w.chunkWorldSize;
  const chunks = (r: [number, number, number, number]): number => (r[2] - r[0] + 1) * (r[3] - r[1] + 1);
  return [
    {
      id: "world", label: w.name, icon: "public", trailing: `${size} × ${size} m`, kind: "world",
      children: [
        {
          id: "regions", label: "Regions", icon: "grid_view", trailing: String(w.regions.length), kind: "collection",
          children: w.regions.map((r) => ({
            id: `region-${r.rx},${r.rz}`, label: `Region ${r.rx},${r.rz}`, icon: "terrain", trailing: `${chunks(r.range)} chunks`, kind: "region",
          })),
        },
        ...(w.spawn ? [{ id: "spawn", label: "Spawn", icon: "flag", trailing: `${Math.round(w.spawn.x)}, ${Math.round(w.spawn.z)}`, kind: "world item" }] : []),
        ...(w.seaLevel !== undefined ? [{ id: "sea", label: "Sea level", icon: "waves", trailing: `${w.seaLevel} m`, kind: "world item" }] : []),
      ],
    },
  ];
}

export function WorldTree(): React.JSX.Element {
  const [world, setWorld] = React.useState<WorldOverview | null | "error">(null);
  const [open, setOpen] = React.useState<string[]>(["world", "regions"]);
  const [sel, setSel] = React.useState<string | null>(null);
  React.useEffect(() => {
    loadWorldOverview().then((w) => setWorld(w ?? "error"), () => setWorld("error"));
  }, []);
  if (world === null) return <p className="px-3 text-xs" style={dim}>Reading the world…</p>;
  if (world === "error") return <p className="px-3 text-xs" style={dim}>No baked world found. Bake one from Release › Pipeline (Bake world).</p>;
  return (
    <ScopeTree
      nodes={worldNodes(world)}
      open={open}
      selected={sel}
      onToggle={(id) => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
      onPick={(n) => {
        setSel(n.id);
        editorSelection.select({
          source: "outliner",
          kind: n.kind,
          id: n.id,
          label: n.label,
          components: [{ name: "Outliner node", fields: [{ key: "workspace", value: "World" }, { key: "kind", value: n.kind }, ...(n.trailing ? [{ key: "info", value: n.trailing }] : [])] }],
        });
      }}
    />
  );
}

/** The scene documents in content/scenes, each opening the Scenes workspace. */
export function SceneFiles({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const [names, setNames] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    fetch("/api/editor/scenes")
      .then((r) => r.json() as Promise<{ scenes?: string[] }>)
      .then((b) => setNames(b.scenes ?? []), () => setNames([]));
  }, []);
  if (names === null) return <p className="px-3 py-1 pl-12 text-xs" style={dim}>Reading scenes…</p>;
  if (names.length === 0) return <p className="px-3 py-1 pl-12 text-xs" style={dim}>No scene documents yet. Create one in the Scenes workspace.</p>;
  return (
    <>
      {names.map((n) => (
        <TreeItem key={n} icon="description" label={`${n}.scene.json`} depth={1} mono selected={false} onPick={onOpen} />
      ))}
    </>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-xs leading-relaxed" style={dim}>
      <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>{title}</p>
      {children}
    </div>
  );
}

export function FlowNote(): React.JSX.Element {
  return (
    <Note title="Game flow">
      <p>Pick a node in the graph to see its scene and its edges here.</p>
      <p>Save writes content/flow/game.flow.json. A save is refused, and nothing is written, if the start node is missing, an edge dangles, an event or scene is unknown, or a node is unreachable. The game client reads the file when it loads.</p>
    </Note>
  );
}

export function DatabaseNote(): React.JSX.Element {
  return (
    <Note title="Database">
      <p>Cell edits collect as pending changes in the grid. Apply writes them through the persistence core and logs each one in the Audit log, where it can be undone.</p>
      <p>Edits are accepted only while the game server is stopped; the grid reports it if the host refuses.</p>
    </Note>
  );
}

export function GameplayNote(): React.JSX.Element {
  return (
    <Note title="Gameplay data">
      <p>Rules tables (creatures, items, loot, skills, spells) save to content/rules, and a running server swaps them in on its next tick. Species, crafting (refining, reagents) and prefabs save to their own files under content; restart the server to load those.</p>
      <p>A save is validated against every other table first. A refused save lists its issues and writes nothing. Problems in what is already on disk show in the Problems tab below.</p>
    </Note>
  );
}
