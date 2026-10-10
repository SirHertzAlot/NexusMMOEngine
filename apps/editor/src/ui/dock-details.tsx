/**
 * Dock content that reads the real project instead of sample data: the World
 * outliner (the baked world's own overview), the Flow screens, the Release
 * build profiles, and the Details text for workspaces that have no selection
 * of their own.
 */
import * as React from "react";
import { getFlow } from "../flow-client.js";
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

/** The screens of content/flow/game.flow.json and the scene each shows. */
export function FlowScreens(): React.JSX.Element {
  const [nodes, setNodes] = React.useState<Array<[string, string]> | "error" | null>(null);
  React.useEffect(() => {
    getFlow().then(
      (b) => setNodes(Object.entries(b.content.nodes).map(([id, n]) => [id, (n as { scene?: string }).scene ?? ""] as [string, string])),
      () => setNodes("error"),
    );
  }, []);
  if (nodes === null) return <p className="px-3 text-xs" style={dim}>Reading the flow…</p>;
  if (nodes === "error") return <p className="px-3 text-xs" style={dim}>No game flow file (content/flow/game.flow.json).</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {nodes.map(([id, scene]) => (
        <TreeItem key={id} icon="account_tree" label={id} trailing={scene || undefined} mono />
      ))}
      <p className="px-3 pt-1 font-mono text-[11px]" style={dim}>content/flow/game.flow.json</p>
    </div>
  );
}

/** The build profiles the Pipeline view runs: the built-in one plus content/build/profiles. */
export function ReleaseProfiles(): React.JSX.Element {
  const [profiles, setProfiles] = React.useState<Array<{ name: string; description?: string; stages: unknown[] }> | "error" | null>(null);
  React.useEffect(() => {
    fetch("/api/editor/build/profiles")
      .then((r) => r.json() as Promise<{ profiles?: Array<{ name: string; description?: string; stages: unknown[] }> }>)
      .then((b) => setProfiles(b.profiles ?? "error"), () => setProfiles("error"));
  }, []);
  if (profiles === null) return <p className="px-3 text-xs" style={dim}>Reading the profiles…</p>;
  if (profiles === "error") return <p className="px-3 text-xs" style={dim}>Could not read the build profiles.</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {profiles.map((p) => (
        <TreeItem key={p.name} icon="rocket_launch" label={p.name} trailing={`${p.stages.length} stages`} mono />
      ))}
      <p className="px-3 pt-1 font-mono text-[11px]" style={dim}>built-in + content/build/profiles/*.json</p>
    </div>
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

export function ReleaseNote(): React.JSX.Element {
  return (
    <Note title="Release">
      <p>The Pipeline view runs a build profile stage by stage and keeps the run history; Deploy assembles the package and deploys it locally with a health check and rollback.</p>
      <p>Profiles are the built-in one and content/build/profiles/*.json; a profile that does not validate is listed in the Problems tab.</p>
    </Note>
  );
}
