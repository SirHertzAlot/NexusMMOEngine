/**
 * Shell-chrome preview for the 2026 design language (slice EU2).
 *
 * Mounts the REAL `ForgeContextBar` over the REAL stores it reads in the
 * running editor — `tool-store`, `editorSelection`, `playUiStore` — with
 * the forge inspector beneath it so the still shows the bar in a shell
 * rather than floating on its own. Nothing is reimplemented here.
 *
 * `window.__forgeDrive` writes those same stores, which is how
 * capture.mjs films the bar changing: every frame of the GIF is the real
 * component reacting to the real store, not a storyboard.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EntitySnapshot } from "../../inspectors/ecs.js";
import { ForgeContextBar } from "../forge-chrome.js";
import { ForgeEntityInspector } from "../forge-inspector.js";
import { ForgeProfilerView, type Timings } from "../forge-profiler.js";
import { ForgeSystemsView, systemSignatures } from "../forge-systems.js";
import { ForgeIntegrationsView, integrationRows } from "../forge-integrations.js";
import { indexEcsGraph, type EcsGraphPayload } from "../../ecs-graph-model.js";
import { editorSelection } from "../editor-selection.js";
import { setTool } from "../tool-store.js";
import { playUiStore } from "../play-ui-store.js";
import type { PlayModeState } from "../../play-mode.js";
import type { VcsFile } from "../../vcs-client.js";

const SNAPSHOT: EntitySnapshot = {
  tick: 184_210,
  entities: new Map([
    [
      13n,
      {
        wireId: 13n,
        transform: { px: 3, py: 1.6, pz: 2.5, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
        velocity: { lx: 1.4, ly: 0, lz: -0.35, ax: 0, ay: 0.6, az: 0 },
        health: { current: 64, max: 100 },
        chunk: { chunkId: 182n, seed: 90_210n, lod: 0 },
        body: {
          shapeKind: 1, halfX: 0.4, halfY: 0.9, halfZ: 0.4, radius: 0.4,
          mass: 72, motionType: 2, layer: 1, friction: 0.6, restitution: 0.1,
        },
      },
    ],
  ]),
};

const fixture = (): EntitySnapshot => SNAPSHOT;

function file(path: string, over: Partial<VcsFile> = {}): VcsFile {
  return { path, docType: "scene", status: "modified", staged: false, conflicted: false, ...over };
}

/** The tree states the bar distinguishes, in worsening order. */
const TREES: Record<string, { branch: string; files: VcsFile[] } | null> = {
  clean: { branch: "main", files: [] },
  changed: {
    branch: "claude/editor-ui-2026",
    files: [file("content/scenes/arena.json"), file("content/rules/combat.json")],
  },
  conflict: {
    branch: "claude/editor-ui-2026",
    files: [file("content/scenes/arena.json"), file("content/rules/combat.json", { conflicted: true })],
  },
  none: null,
};

export interface DriveStep {
  tree?: keyof typeof TREES;
  tool?: string;
  play?: PlayModeState;
  problems?: number;
  select?: boolean;
}

function Shell(): React.JSX.Element {
  const [tree, setTree] = React.useState<keyof typeof TREES>("clean");
  const [problems, setProblems] = React.useState(0);

  // The capture harness drives the real stores; only the two values the
  // shell owns in production (the VCS poll and the problem total) are
  // state here, because in the editor they are the shell's own.
  React.useEffect(() => {
    (window as unknown as { __forgeDrive?: (step: DriveStep) => void }).__forgeDrive = (step) => {
      if (step.tree) setTree(step.tree);
      if (step.problems !== undefined) setProblems(step.problems);
      if (step.tool) setTool(step.tool);
      if (step.play) playUiStore.set((p) => ({ ...p, pmState: step.play as PlayModeState }));
      if (step.select === true) {
        editorSelection.select({
          source: "entity-list",
          kind: "entity",
          id: "13",
          label: "Entity 13",
          components: [],
        });
      }
      if (step.select === false) editorSelection.clear("entity-list");
    };
  }, []);

  return (
    <div
      data-shot="chrome"
      data-theme="forge"
      style={{
        width: 1180,
        height: 560,
        display: "flex",
        flexDirection: "column",
        background: "var(--fg-canvas)",
        border: "1px solid var(--fg-line)",
      }}
    >
      <ForgeContextBar
        workspaceLabel="Scene"
        viewLabel="ECS Inspector"
        problems={problems}
        onGoWorkspace={() => undefined}
        onOpenProblems={() => undefined}
        vcs={TREES[tree]}
      />
      <div style={{ display: "flex", minHeight: 0, flex: 1, gap: 6, padding: 6 }}>
        {/* Stand-in for the viewport: the bar is what this shot is about. */}
        <div
          className="fg-panel"
          style={{ flex: 1, display: "grid", placeItems: "center" }}
        >
          <span className="fg-label">Viewport</span>
        </div>
        <div style={{ width: 340, minHeight: 0 }}>
          <ForgeEntityInspector fixture={fixture} initialSelected="13" />
        </div>
      </div>
    </div>
  );
}

/**
 * A plausible tick, for the profiler shot. These are shapes of real
 * numbers (the gateway's own system names, a 30 Hz tick with headroom),
 * fed through the panel's real budget arithmetic — the panel computes
 * every share and tone on screen from them.
 */
const TIMINGS: Timings = {
  ticks: 1000,
  p50: 8.42,
  p99: 21.7,
  systems: [
    { name: "interest", avg: 4.12, max: 18.24 },
    { name: "movement", avg: 2.48, max: 9.07 },
    { name: "prop-collision", avg: 1.31, max: 5.6 },
    { name: "character-bridge", avg: 0.94, max: 3.38 },
    { name: "combat", avg: 0.77, max: 3.41 },
    { name: "abilities", avg: 0.41, max: 2.15 },
    { name: "resident-schedule", avg: 0.33, max: 1.78 },
    { name: "death", avg: 0.08, max: 0.52 },
  ],
};

function ProfilerShot(): React.JSX.Element {
  return (
    <div
      data-shot="profiler"
      data-theme="forge"
      style={{
        width: 560,
        height: 460,
        background: "var(--fg-canvas)",
        padding: 8,
        // The panels inside scroll, so the shot must bound them;
        // without this they grow and overlap the next section.
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ForgeProfilerView state={{ kind: "timings", timings: TIMINGS }} />
    </div>
  );
}

/**
 * The systems shot runs over the REAL committed ECS graph, which
 * capture-shell.mjs reads off disk and hands to the page, indexed by the
 * shipped `indexEcsGraph`. The costs are the fixture tick above, so the
 * join the panel exists for is the thing in the picture.
 */
function SystemsShot(): React.JSX.Element {
  const graph = (window as unknown as { __ECS_GRAPH?: EcsGraphPayload }).__ECS_GRAPH;
  const signatures = graph ? systemSignatures(indexEcsGraph(graph)) : null;
  const costs = new Map(TIMINGS.systems.map((s) => [s.name, s.avg]));
  return (
    <div
      data-shot="systems"
      data-theme="forge"
      style={{
        width: 560,
        height: 560,
        background: "var(--fg-canvas)",
        padding: 8,
        // The panels inside scroll, so the shot must bound them;
        // without this they grow and overlap the next section.
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ForgeSystemsView signatures={signatures} costs={costs} />
    </div>
  );
}

/**
 * The integrations shot. Inputs are a plausible working state fed
 * through the panel's real `integrationRows`, which decides every tone
 * and word on screen — including the two we have not built, which the
 * list always carries.
 */
function IntegrationsShot(): React.JSX.Element {
  const rows = integrationRows({
    play: "running",
    vcs: {
      branch: "claude/editor-ui-2026",
      files: [file("content/scenes/arena.json"), file("content/rules/combat.json")],
    },
    locks: { "content/scenes/arena.json": { owner: "sam", since: "2026-11-26T10:00:00Z" } },
    graph: {
      state: "stale",
      graphCommit: "207c31b",
      compareCommit: "a3b7d7b",
      compareLabel: "repo HEAD",
      reason: "stale · graph 207c31b != repo HEAD a3b7d7b",
    },
  });
  return (
    <div
      data-shot="integrations"
      data-theme="forge"
      style={{
        width: 560,
        height: 360,
        background: "var(--fg-canvas)",
        padding: 8,
        // The panels inside scroll, so the shot must bound them;
        // without this they grow and overlap the next section.
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ForgeIntegrationsView rows={rows} />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("forge shell preview: #root missing");
createRoot(root).render(
  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 16 }}>
    <Shell />
    <ProfilerShot />
    <SystemsShot />
    <IntegrationsShot />
  </div>,
);
