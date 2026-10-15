/**
 * Editor shell — Material Design 3 workspace layout (UI-ONLY).
 *
 * EDITOR-ARCHITECTURE.md §3: menu bar + workspace tabs, toolbar with the
 * play cluster, dockable left/center/right/bottom panels, status bar.
 * Every inspector panel below is mounted unchanged — the shell only
 * decides which existing panel is visible and wraps it in dock chrome.
 * Workspaces without a panel yet render an EmptyState that names the
 * EA slice that will own them; nothing here edits simulation state.
 */

import * as React from "react";
import { EcsInspectorPanel } from "./ecs-inspector.js";
import { PlayModePanel, getPlayController, playUiStore, requestPlayStart, requestPlayStop, requestPlayTick, setPlayAutoRefresh, setPlayEntityId } from "./play-mode.js";
import { AssetInspectorPanel } from "./asset-inspector.js";
import { TerrainEditorPanel } from "./terrain-editor.js";
import { ModulesPanel, moduleRegistry, useModuleRegistry } from "./modules-panel.js";
import { GraphEditorPanel } from "./graph-editor.js";
import { DungeonPanel } from "./dungeon-view.js";
import { PipelineView } from "./pipeline-view.js";
import { RulesPanel } from "./rules-editor.js";
import { ValgrindPanel } from "./valgrind-panel.js";
import { StringsPanel } from "./strings-panel.js";
import { AnimationPanel } from "./animation-panel.js";
import { MaterialsPanel } from "./materials-panel.js";
import { ChangesPanel } from "./vcs-panel.js";
import { RulesPanel as TablesPanel } from "./rules-panel.js";
import { ContentBrowserPanel, GameplayGridsPanel } from "./gameplay-grids.js";
import { DatabaseAuditPanel, DatabaseGridPanel, DatabaseQueryPanel } from "./database-workspace.js";
import { DockPanel, EmptyState, IconButton, MIcon, OverflowMenu, SnackbarHost, StatusChip, TreeItem, notify, useLocalStorage } from "./components.js";
import { clipboardVersion, subscribeClipboard } from "./clipboard.js";
import { flagBlocked, getViewportActions, screenshotBlocked, subscribeViewportActions, toggleViewportFlag, viewportFlags } from "./viewport-actions.js";
import { getTool, setTool, subscribeTool } from "./tool-store.js";
import { getDocActions, subscribeDocActions } from "./doc-actions.js";
import { TOOLBAR_GROUPS, isShown, loadToolbar, saveToolbar, toggleGroup, DEFAULT_TOOLBAR, type ToolbarConfig } from "../toolbar-config.js";
import { usePendingChanges } from "./pending-changes.js";
import { catalogCommands, rankCommands, type PaletteCommand } from "../palette.js";
import { requestOpenAsset } from "./open-asset.js";
import { loadCatalog } from "../gameplay-client.js";
import { BakesPane, OutputPane, ProblemsPane, problemCount, useDiskProblems, useDocProblems, useServerOutput, type DiskProblems, type ServerOutput } from "./dock-panes.js";
import { DatabaseNote, FlowNote, FlowScreens, ReleaseNote, ReleaseProfiles, WorldTree } from "./dock-details.js";
import { OwnedFiles } from "./owned-files.js";
import { StoryTree } from "./story-tree.js";
import { PreferencesDialog, ProfileDialog, ShellDialog } from "./shell-dialogs.js";
import { anyUnsaved, canExport, canImport, exportActive, importActive, popOutPanel, revertActive, screenshotViewport } from "./shell-actions.js";
import { browserStorage, currentProfile, loadPrefs, recallView, rememberView, signOut } from "./editor-prefs.js";
import { requestNewScene } from "../open-scene.js";
import { loadLastSetup, saveLastSetup, setupSummary, type PlaySetup } from "./play-setup.js";
import { PlayMenu } from "./play-menu.js";
import { savedSetupsStore } from "./play-setups-store.js";
import { resolveSetupShortcut } from "./play-shortcuts.js";
import { isSelectionVisible, useEditorSelection } from "./editor-selection.js";
import { TOOL_SHORTCUT_BUTTON_LABELS, resolveEditorShortcut, shouldSkipShortcut } from "./shortcuts.js";
import { useDrag } from "./use-drag.js";
import { SelectableList } from "./selectable-list.js";
import { ViewList } from "./view-list.js";
import { LiveOpsDetailsLive, LiveOpsViews } from "./liveops-live.js";
import { ConnectionsPanel, EdgeRoutesPanel, NetworkDetailsLive } from "./network-live.js";
import { PlaytestDetails, PlaytestsPanel } from "./playtests-live.js";
import { QuestDetailsLive, QuestsPanel, QuestsTree } from "./quests-live.js";
import { AssetLibraryTree } from "./asset-library-tree.js";
import { AnimDetails, ClipList } from "./animation-library.js";
import { applyDeepSelection, readDeepSelection, subscribeDeepSelection } from "./deep-selection.js";

// ---------------------------------------------------------------- config

type WorkspaceId =
  | "world"
  | "scene"
  | "scenes"
  | "flow"
  | "characters"
  | "gameplay"
  | "dungeons"
  | "liveops"
  | "network"
  | "debug"
  | "database"
  | "changes"
  | "story"
  | "artaudio"
  | "release"
  | "modules";

interface Workspace {
  id: WorkspaceId;
  label: string;
  icon: string;
  /** Center views: existing panels (implementations untouched). */
  views: Array<{ id: string; label: string; icon: string; kind: "panel" | "soon"; panel?: React.JSX.Element; soon?: { icon: string; title: string; body: string } }>;
  leftTitle: string;
}

const WORKSPACES: Workspace[] = [
  {
    id: "world", label: "World", icon: "public",
    views: [{ id: "terrain", label: "Viewport", icon: "landscape", kind: "panel", panel: <TerrainEditorPanel /> }],
    leftTitle: "Outliner",
  },
  {
    id: "scene", label: "Scene", icon: "landscape",
    views: [{ id: "ecs", label: "Viewport", icon: "view_in_ar", kind: "panel", panel: <EcsInspectorPanel /> }],
    leftTitle: "Outliner",
  },
  {
    id: "scenes", label: "Scenes", icon: "account_tree",
    views: [], // contributed by the scenes module (modules/scenes/editor)
    leftTitle: "Scenes",
  },
  {
    id: "flow", label: "Flow & UI", icon: "account_tree",
    views: [], // flow graph contributed by the flow module (modules/flow/editor)
    leftTitle: "Widgets",
  },
  {
    id: "characters", label: "Characters", icon: "person",
    views: [], // contributed by the characters module (modules/characters/editor)
    leftTitle: "Catalog",
  },
  {
    id: "gameplay", label: "Gameplay", icon: "table_view",
    views: [
      { id: "grids", label: "Data grids", icon: "grid_on", kind: "panel", panel: <GameplayGridsPanel /> },
      { id: "content", label: "Content browser", icon: "folder_open", kind: "panel", panel: <ContentBrowserPanel /> },
      { id: "tables", label: "Tables", icon: "table_view", kind: "panel", panel: <TablesPanel /> },
      { id: "rules", label: "Rules", icon: "tune", kind: "panel", panel: <RulesPanel /> },
    ],
    leftTitle: "Tables",
  },
  {
    id: "dungeons", label: "Dungeons & PCG", icon: "castle",
    views: [
      { id: "dungeons", label: "Dungeon", icon: "castle", kind: "panel", panel: <DungeonPanel /> },
      { id: "graphs", label: "PICG Graphs", icon: "graph_3", kind: "panel", panel: <GraphEditorPanel /> },
    ],
    leftTitle: "Library",
  },
  {
    id: "liveops", label: "Live ops", icon: "groups",
    views: LiveOpsViews(),
    leftTitle: "Live ops",
  },
  {
    id: "network", label: "Network", icon: "lan",
    views: [
      { id: "routes", label: "Edge routes", icon: "lan", kind: "panel", panel: <EdgeRoutesPanel /> },
      { id: "connections", label: "Connections", icon: "network_check", kind: "panel", panel: <ConnectionsPanel /> },
    ],
    leftTitle: "Network",
  },
  {
    id: "debug", label: "Debug", icon: "monitoring",
    views: [{ id: "play", label: "Play mode", icon: "play_arrow", kind: "panel", panel: <PlayModePanel /> }],
    leftTitle: "Sessions",
  },
  {
    id: "changes", label: "Changes", icon: "commit",
    views: [{ id: "changes", label: "Changes", icon: "commit", kind: "panel", panel: <ChangesPanel /> }],
    leftTitle: "Changes",
  },
  {
    id: "database", label: "Database", icon: "database",
    views: [
      { id: "grid", label: "Data grid", icon: "table_view", kind: "panel", panel: <DatabaseGridPanel /> },
      { id: "query", label: "Query", icon: "code", kind: "panel", panel: <DatabaseQueryPanel /> },
      { id: "audit", label: "Audit log", icon: "history", kind: "panel", panel: <DatabaseAuditPanel /> },
    ],
    leftTitle: "Schema",
  },
  {
    id: "story", label: "Story", icon: "auto_stories",
    views: [
      { id: "quests", label: "Quests", icon: "flag", kind: "panel", panel: <QuestsPanel /> },
      { id: "strings", label: "Strings", icon: "translate", kind: "panel", panel: <StringsPanel /> },
    ], // quest & dialog editor contributed by the story module (modules/story/editor)
    leftTitle: "Stories",
  },
  {
    id: "artaudio", label: "Art & audio", icon: "movie",
    views: [
      { id: "assets", label: "Art Assets", icon: "palette", kind: "panel", panel: <AssetInspectorPanel /> },
      { id: "animation", label: "Animation", icon: "directions_run", kind: "panel", panel: <AnimationPanel /> },
      { id: "materials", label: "Materials", icon: "texture", kind: "panel", panel: <MaterialsPanel /> },
    ], // VFX and audio panels contributed by the vfx/audio modules
    leftTitle: "Library",
  },
  {
    id: "release", label: "Release", icon: "rocket_launch",
    views: [
      { id: "pipeline", label: "Pipeline", icon: "account_tree", kind: "panel", panel: <PipelineView /> },
      { id: "playtests", label: "Playtests", icon: "science", kind: "panel", panel: <PlaytestsPanel /> },
      { id: "valgrind", label: "Valgrind", icon: "memory", kind: "panel", panel: <ValgrindPanel /> },
    ], // HUD layout editor contributed by the hud module (modules/hud/editor)
    leftTitle: "Profiles",
  },
  {
    id: "modules", label: "Modules", icon: "extension",
    views: [{ id: "modules", label: "Modules", icon: "extension", kind: "panel", panel: <ModulesPanel /> }],
    leftTitle: "Modules",
  },
];

// Module contributions (EA3): each workspace shows its own views plus the panels enabled
// modules add; a workspace left with none says which module would fill it. The registry
// refreshes after every enable/disable, and App re-renders on its version (useModuleRegistry).
const OWN_VIEWS = new Map(WORKSPACES.map((w) => [w.id, w.views]));
function syncModuleViews(): void {
  for (const w of WORKSPACES) {
    const added = moduleRegistry.panels(w.id).map((p) => ({ id: p.id, label: p.title, icon: p.icon, kind: "panel" as const, panel: p.render() as React.JSX.Element }));
    const all = [...(OWN_VIEWS.get(w.id) ?? []), ...added];
    w.views = all.length > 0 ? all : [{ id: "none", label: "Disabled", icon: "extension_off", kind: "soon", soon: { icon: "extension_off", title: `No module contributes to ${w.label}`, body: "Enable one in the Modules workspace." } }];
  }
}
syncModuleViews();
moduleRegistry.subscribe(syncModuleViews);

/** Words that find a view in Ctrl K beyond its label. */
const VIEW_KEYWORDS: Record<string, string> = {
  terrain: "terrain sculpt brush heightmap regenerate world map",
  ecs: "ecs inspector entities components live",
  scene: "scene document outliner nodes viewport place",
  flow: "flow graph screens login character select transitions",
  hud: "hud layout frames chat bag widgets",
  records: "characters records accounts saved",
  grids: "creatures items skills spells species stats balance",
  content: "content browser catalog assets prefabs",
  tables: "tables rules items loot",
  rules: "rules editor combat death body",
  dungeons: "dungeon rooms layout instances",
  graphs: "picg graph nodes procedural",
  play: "play mode debugger overlays navmesh waypoints server",
  changes: "git commit diff merge locks version control",
  grid: "database sqlite tables rows",
  query: "database sql query",
  audit: "database audit log undo",
  "story-editor": "quest dialog npc story graph",
  assets: "art assets models textures import",
  modules: "modules enable disable apply",
};

const SOON_WS: ReadonlySet<WorkspaceId> = new Set([]);
/** Workspaces whose whole content is still a preview over sample data (none: Live ops and Network went real with the playtests port). */
const PREVIEW_WS: ReadonlySet<WorkspaceId> = new Set([]);

// ---------------------------------------------------------------- shell

/** Edit / Simulate / Play (§3.2): a shortcut for where the shell looks.
 *  Edit opens the Scene workspace over documents; Simulate and Play open
 *  Play mode, which owns the server lifecycle. */
type RunMode = "edit" | "simulate" | "play";

export function App(): React.JSX.Element {
  useModuleRegistry();
  const [workspace, setWorkspace] = React.useState<WorkspaceId>(() => initialHashLocation().workspace);
  const [view, setView] = React.useState<string>(() => initialHashLocation().view);
  const [leftTab, setLeftTab] = React.useState<string>("left");
  const [rightTab, setRightTab] = React.useState<string>("details");
  const [bottomTab, setBottomTab] = React.useState<string>("output");
  const [playMenu, setPlayMenu] = React.useState(false);
  const [layoutMenu, setLayoutMenu] = React.useState(false);
  const [mode, setMode] = React.useState<RunMode>("edit");
  const [palette, setPalette] = React.useState(false);
  // Play setup: owned here so the toolbar chip and the Play menu stay in
  // sync; every change persists (the Play button / F5 runs the last one,
  // and the Play mode panel reads it back on start for bots → MMO_BOTS).
  const [playSetup, setPlaySetup] = React.useState<PlaySetup>(() => loadLastSetup());
  function updatePlaySetup(next: PlaySetup): void {
    setPlaySetup(next);
    saveLastSetup(next);
  }
  // Play tint + read-only Details (§3.4/§3.5): entering play swaps what
  // panels show, never where they are.
  const { pmState } = playUiStore.use();
  const output = useServerOutput();
  const problems = useDocProblems();
  const diskProblems = useDiskProblems();
  const problemTotal = problemCount(diskProblems, problems);
  const [dialog, setDialog] = React.useState<"prefs" | "profile" | null>(null);
  const playing = pmState === "running" || pmState === "starting";

  // Dock layout: visibility + sizes persist locally; named layouts snapshot all of it.
  const [docks, setDocks] = useLocalStorage("mmo-editor.docks", { left: true, right: true, bottom: true });
  const [leftW, setLeftW] = useLocalStorage("mmo-editor.leftW", 256);
  const [rightW, setRightW] = useLocalStorage("mmo-editor.rightW", 320);
  const [bottomH, setBottomH] = useLocalStorage("mmo-editor.bottomH", 144);
  const [savedLayouts, setSavedLayouts] = useLocalStorage<Record<string, LayoutSnapshot>>("mmo-editor.layouts", {});

  // Dock element refs for transient (per-frame) resize without re-render.
  const leftRef = React.useRef<HTMLDivElement>(null);
  const rightRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  function liveResize(ref: React.RefObject<HTMLDivElement | null>, edge: "l" | "r" | "b", dx: number, dy: number): void {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (edge === "l") el.style.width = `${Math.min(480, Math.max(200, rect.width + dx))}px`;
    else if (edge === "r") el.style.width = `${Math.min(480, Math.max(240, rect.width - dx))}px`;
    else el.style.height = `${Math.min(480, Math.max(96, rect.height - dy))}px`;
  }

  function commitResize(ref: React.RefObject<HTMLDivElement | null>, edge: "l" | "r" | "b"): void {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (edge === "l") setLeftW(Math.round(rect.width));
    else if (edge === "r") setRightW(Math.round(rect.width));
    else setBottomH(Math.round(rect.height));
  }

  const ws = WORKSPACES.find((w) => w.id === workspace) ?? WORKSPACES[0];
  const activeView = ws.views.find((v) => v.id === view) ?? ws.views[0];

  function pickWorkspace(id: WorkspaceId): void {
    setWorkspace(id);
    const next = WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0];
    setView(next.views[0].id);
    setPlayMenu(false);
  }

  /** Open the Play mode panel without starting anything. */
  function showPlay(): void {
    pickWorkspace("debug");
    setView("play");
  }

  /** Play with the last setup: open the panel and start the server unless one is already running. */
  function goPlay(): void {
    pickWorkspace("debug");
    setView("play");
    requestPlayStart();
  }

  /** A saved setup becomes the last one and plays; while a run is live it asks for Stop first. */
  function playSaved(s: { name: string; setup: PlaySetup }): void {
    const st = playUiStore.get().pmState;
    if (st === "running" || st === "starting" || st === "stopping") {
      notify(`Stop play first (Shift+F5) to start “${s.name}”`);
      return;
    }
    updatePlaySetup(s.setup);
    goPlay();
  }

  const playSavedRef = React.useRef(playSaved);
  playSavedRef.current = playSaved;
  const savedSetups = savedSetupsStore.use();

  /** The shell's own commands for Ctrl K: what the menus, toolbar and shortcuts do, plus the layout and play settings. */
  function shellCommands(): PaletteCommand[] {
    const doc = getDocActions();
    const close = (run: () => void) => () => {
      setPalette(false);
      run();
    };
    const cmds: PaletteCommand[] = [];
    if (doc?.canSave) cmds.push({ id: "cmd:save", label: `Save ${doc.label}`, group: "Command", hint: "Ctrl S", icon: "save", run: close(() => doc.save()) });
    if (doc?.canUndo) cmds.push({ id: "cmd:undo", label: `Undo ${doc.label}`, group: "Command", hint: "Ctrl Z", icon: "undo", run: close(() => doc.undo()) });
    if (doc?.canRedo) cmds.push({ id: "cmd:redo", label: `Redo ${doc.label}`, group: "Command", hint: "Ctrl Y", icon: "redo", run: close(() => doc.redo()) });
    cmds.push(
      { id: "cmd:tool-select", label: "Tool: Select", group: "Command", hint: "V", icon: "nearby", run: close(() => setTool("select")) },
      { id: "cmd:tool-move", label: "Tool: Move", group: "Command", hint: "W", icon: "open_with", run: close(() => setTool("move")) },
      { id: "cmd:tool-rotate", label: "Tool: Rotate", group: "Command", hint: "E", icon: "rotate_right", run: close(() => setTool("rotate")) },
      { id: "cmd:tool-scale", label: "Tool: Scale", group: "Command", hint: "R", icon: "expand", run: close(() => setTool("scale")) },
      { id: "cmd:layout-reset", label: "Reset layout", group: "Command", icon: "restart_alt", run: close(() => applyLayout(defaultLayout())) },
      { id: "cmd:layout-save", label: "Save layout…", group: "Command", hint: "Ctrl Shift S", icon: "dashboard", run: close(() => setLayoutMenu(true)) },
      { id: "cmd:fullscreen", label: "Toggle fullscreen", group: "Command", hint: "F11", icon: "fullscreen", run: close(() => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void document.documentElement.requestFullscreen().catch(() => notify("Fullscreen was blocked by the browser"));
      }) },
      { id: "set:dock-left", label: `${docks.left ? "Hide" : "Show"} the left dock`, group: "Setting", icon: "left_panel_open", run: close(() => toggleDock("left")) },
      { id: "set:dock-right", label: `${docks.right ? "Hide" : "Show"} the right dock`, group: "Setting", icon: "right_panel_open", run: close(() => toggleDock("right")) },
      { id: "set:dock-bottom", label: `${docks.bottom ? "Hide" : "Show"} the bottom dock`, group: "Setting", icon: "bottom_panel_open", run: close(() => toggleDock("bottom")) },
      { id: "set:tint", label: `Play tint: ${playSetup.tint ? "on" : "off"} (click to turn ${playSetup.tint ? "off" : "on"})`, group: "Setting", icon: "palette", run: close(() => updatePlaySetup({ ...playSetup, tint: !playSetup.tint })) },
    );
    for (const n of ["0", "10", "50", "200"]) {
      cmds.push({ id: `set:bots-${n}`, label: `Play setup: ${n} bots${playSetup.bots === n ? " (current)" : ""}`, group: "Setting", icon: "smart_toy", run: close(() => updatePlaySetup({ ...playSetup, bots: n })) });
    }
    for (const s of savedSetups) {
      cmds.push({ id: `play:${s.name}`, label: `Play: ${s.name}`, group: "Command", ...(s.shortcut ? { hint: s.shortcut.replaceAll("+", " ") } : {}), icon: "play_arrow", run: close(() => playSaved(s)) });
    }
    return cmds;
  }

  function go(ws: WorkspaceId, view?: string): void {
    pickWorkspace(ws);
    if (view) setView(view);
  }

  interface LayoutSnapshot {
    workspace: WorkspaceId;
    view: string;
    leftTab: string;
    rightTab: string;
    bottomTab: string;
    leftW: number;
    rightW: number;
    bottomH: number;
    docks: { left: boolean; right: boolean; bottom: boolean };
  }

  function snapshot(): LayoutSnapshot {
    return { workspace, view, leftTab, rightTab, bottomTab, leftW, rightW, bottomH, docks };
  }

  function applyLayout(s: LayoutSnapshot): void {
    setWorkspace(s.workspace);
    setView(s.view);
    setLeftTab(s.leftTab);
    setRightTab(s.rightTab);
    setBottomTab(s.bottomTab);
    setLeftW(s.leftW);
    setRightW(s.rightW);
    setBottomH(s.bottomH);
    setDocks(s.docks);
    setLayoutMenu(false);
  }

  function defaultLayout(): LayoutSnapshot {
    return {
      workspace: "gameplay", view: "tables", leftTab: "left", rightTab: "details", bottomTab: "output",
      leftW: 256, rightW: 320, bottomH: 144, docks: { left: true, right: true, bottom: true },
    };
  }

  function toggleDock(d: "left" | "right" | "bottom"): void {
    setDocks((p) => ({ ...p, [d]: !p[d] }));
  }

  function setRunMode(m: RunMode): void {
    setMode(m);
    if (m === "edit") pickWorkspace("scene");
    else showPlay();
  }

  // Deep links (#/workspace/view/selection): read once on load and on
  // browser back/forward; write (replaceState, no history spam) on change.
  // Selection changes re-render the shell via the store subscription so the
  // hash — and any pasted link — always reflects the live selection.
  const [, setSelTick] = React.useState(0);
  React.useEffect(() => subscribeDeepSelection(() => setSelTick((t) => t + 1)), []);
  React.useEffect(() => {
    parseHash();
    window.addEventListener("hashchange", parseHash);
    return () => window.removeEventListener("hashchange", parseHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    const sel = readDeepSelection(workspace, view);
    const h = `#/${workspace}/${view}${sel ? `/${encodeURIComponent(sel)}` : ""}`;
    if (window.location.hash !== h) window.history.replaceState(null, "", h);
    rememberView(browserStorage(), workspace, view);
  });
  // Preference: the browser confirms closing the tab while the open document has unsaved edits.
  React.useEffect(() => {
    if (!loadPrefs(browserStorage()).warnUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!anyUnsaved()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  function parseHash(): void {
    const loc = parseHashString(window.location.hash);
    if (!loc) return;
    if (loc.sel !== null) {
      const implied = applyDeepSelection(loc.sel);
      if (implied) {
        const iws = WORKSPACES.find((w) => w.id === implied.workspace);
        const iv = iws?.views.find((x) => x.id === implied.view);
        if (iws && iv) {
          setWorkspace(iws.id as WorkspaceId);
          setView(iv.id);
          return;
        }
      }
    }
    setWorkspace(loc.workspace);
    setView(loc.view);
  }

  // Ctrl K opens the command palette (§3.5); Ctrl Shift S opens layout save; Esc closes menus.
  // F5 plays, Shift+F5 stops (same goPlay the play cluster uses); V/W/E/R
  // click the toolbar's transform buttons so one handler owns each tool.
  // Play/tool keys carry a typing guard and preventDefault (F5 must not reload).
  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // A saved play setup's own key starts it (EA14); never while typing.
      const saved = shouldSkipShortcut(e.target) || e.repeat ? null : resolveSetupShortcut(e, savedSetupsStore.get());
      if (saved) {
        e.preventDefault();
        playSavedRef.current(saved);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setLayoutMenu(true);
      } else if (e.key === "F5" && !e.ctrlKey && !e.metaKey) {
        // F5 plays with the last setup (opens Play mode); Shift F5 stops
        // the owned server for real. Ctrl F5 stays the browser's
        // hard-reload — no hint claims it.
        e.preventDefault();
        if (e.shiftKey) void requestPlayStop();
        else goPlay();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        // Ctrl S saves the toolbar's open document; refused saves write nothing.
        const target = getDocActions();
        if (target?.canSave) {
          e.preventDefault();
          target.save();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const target = getDocActions();
        if (target?.canUndo) {
          e.preventDefault();
          target.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        const target = getDocActions();
        if (target?.canRedo) {
          e.preventDefault();
          target.redo();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "x") {
        // Cut / copy / paste / duplicate act on the open document; skip
        // when typing in a field so the OS clipboard keeps working there.
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canCut) {
          e.preventDefault();
          target.cut?.();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "c") {
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canCopy) {
          e.preventDefault();
          target.copy?.();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "v") {
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canPaste) {
          e.preventDefault();
          target.paste?.();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canDuplicate) {
          e.preventDefault();
          target.duplicate?.();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "a") {
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canSelectAll) {
          e.preventDefault();
          target.selectAll?.();
        }
      } else if (e.key === "Delete") {
        if (shouldSkipShortcut(e.target)) return;
        const target = getDocActions();
        if (target?.canDelete) {
          e.preventDefault();
          target.deleteSelection?.();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "+" || e.key === "=")) {
        // View menu zoom acts on the mounted 3D viewport.
        const vp = getViewportActions();
        if (vp?.canZoomIn) {
          e.preventDefault();
          vp.zoomIn();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "-") {
        const vp = getViewportActions();
        if (vp?.canZoomOut) {
          e.preventDefault();
          vp.zoomOut();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "0") {
        const vp = getViewportActions();
        if (vp?.canReset) {
          e.preventDefault();
          vp.reset();
        }
      } else if (e.key === "Escape") {
        setPalette(false);
        setPlayMenu(false);
        setLayoutMenu(false);
      } else {
        const action = resolveEditorShortcut({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        });
        if (action === null) return;
        if (shouldSkipShortcut(e.target)) return;
        e.preventDefault();
        if (action === "play") {
          goPlay();
        } else if (action === "stop") {
          // Unreachable today (Shift F5 is handled above with the F5
          // branch), but must stay the real stop, not a navigation.
          void requestPlayStop();
          showPlay();
        } else {
          const label = TOOL_SHORTCUT_BUTTON_LABELS[action];
          const btn = document.querySelector(`button[aria-label="${label}"]`);
          if (btn instanceof HTMLButtonElement) btn.click();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="flex h-screen flex-col"
      style={{
        background: "var(--m3-surface)",
        color: "var(--m3-on-surface)",
        // Play tint (§3.2, §3.5): the window edge goes tertiary while
        // running so nobody edits a live world by mistake.
        ...(playing ? { outline: "2px solid var(--m3-tertiary)", outlineOffset: -2 } : {}),
      }}
    >
      <MenuBar
        workspace={workspace}
        onPick={pickWorkspace}
        onSearch={() => setPalette(true)}
        docks={docks}
        onToggleDock={toggleDock}
        onResetLayout={() => applyLayout(defaultLayout())}
        onGo={go}
        onDialog={setDialog}
      />
      <Toolbar
        playMenu={playMenu}
        onTogglePlayMenu={() => setPlayMenu((v) => !v)}
        onClosePlayMenu={() => setPlayMenu(false)}
        onPlay={goPlay}
        onShowPlay={showPlay}
        playSetup={playSetup}
        onPlaySetup={updatePlaySetup}
        mode={mode}
        onMode={setRunMode}
        layoutMenu={layoutMenu}
        onToggleLayoutMenu={() => setLayoutMenu((v) => !v)}
        onCloseLayoutMenu={() => setLayoutMenu(false)}
        savedLayouts={savedLayouts}
        onApplyLayout={applyLayout}
        onSaveLayout={(name) => setSavedLayouts((p) => ({ ...p, [name]: snapshot() }))}
        onDeleteLayout={(name) => setSavedLayouts((p) => {
          const rest = { ...p };
          delete rest[name];
          return rest;
        })}
        onResetLayout={() => applyLayout(defaultLayout())}
        currentSnapshot={snapshot()}
      />
      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onGo={(ws, v) => {
            go(ws as WorkspaceId, v);
            setPalette(false);
          }}
          commands={shellCommands()}
          onPlay={() => {
            goPlay();
            setPalette(false);
          }}
          onStop={() => {
            void requestPlayStop();
            showPlay();
            setPalette(false);
          }}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-1.5 p-1.5">
        {/* left dock */}
        <div
          ref={leftRef}
          className={`flex-none ${docks.left ? "hidden md:block" : "hidden"}`}
          style={{ width: leftW }}
        >
          <DockPanel
            tabs={[
              { id: "left", label: ws.leftTitle, icon: "list" },
              { id: "content", label: "Content", icon: "folder" },
            ]}
            active={leftTab}
            onTab={setLeftTab}
            actions={
              <OverflowMenu
                label="Left dock options"
                size={36}
                items={[
                  { label: "Save layout as…", kbd: "Ctrl Shift S", run: () => setLayoutMenu(true) },
                  { label: "Pop panel into a window", run: popOutPanel },
                  { label: "Hide left dock", run: () => toggleDock("left") },
                ]}
              />
            }
          >
            {leftTab === "content" ? <ContentTree onGo={go} /> : <LeftTree workspace={workspace} view={view} onView={setView} views={ws.views} onGo={go} />}
          </DockPanel>
        </div>
        {docks.left && (
          <Divider
            vertical
            title="Drag to resize the left dock (double-click resets)"
            onLive={(dx, dy) => liveResize(leftRef, "l", dx, dy)}
            onCommit={() => commitResize(leftRef, "l")}
            onReset={() => setLeftW(256)}
          />
        )}

        {/* center: viewport tabs + panel + bottom dock */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            className="flex h-9 flex-none items-center gap-0.5 rounded-xl px-1.5"
            role="tablist"
            aria-label="Views"
            style={{ background: "var(--m3-surface-0)" }}
          >
            {ws.views.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={activeView.id === v.id}
                onClick={() => setView(v.id)}
                className="m3-focus flex items-center gap-1.5 rounded-t-lg px-2.5 py-1.5 text-[12.5px] font-medium"
                style={
                  activeView.id === v.id
                    ? { background: "var(--m3-surface-1)", color: "var(--m3-on-surface)" }
                    : { background: "transparent", color: "var(--m3-on-surface-variant)" }
                }
              >
                <MIcon name={v.icon} size={16} />
                {v.label}
              </button>
            ))}
            <span
              className="ml-2 hidden truncate font-mono text-[11px] xl:inline"
              style={{ color: "var(--m3-outline)" }}
            >
              {workspaceLabel(workspace)} · {activeView.label.toLowerCase()}
            </span>
            <span className="ml-auto flex items-center gap-0.5">
              <ViewportOptions />
            </span>
          </div>

          <div
            className="m3-scroll relative min-h-0 flex-1 overflow-auto rounded-xl p-3"
            style={{
              background: "var(--m3-surface-1)",
            }}
          >
            {activeView.kind === "panel" ? (
              activeView.panel
            ) : (
              <EmptyState icon={activeView.soon?.icon ?? "hourglass_empty"} title={activeView.soon?.title ?? "Coming soon"} body={activeView.soon?.body ?? ""} />
            )}
          </div>

          {docks.bottom && (
            <Divider
              title="Drag to resize the bottom dock (double-click resets)"
              onLive={(dx, dy) => liveResize(bottomRef, "b", dx, dy)}
              onCommit={() => commitResize(bottomRef, "b")}
              onReset={() => setBottomH(144)}
            />
          )}
          <div ref={bottomRef} className={docks.bottom ? "flex-none" : "hidden"} style={{ height: bottomH }}>
            <DockPanel
              tabs={[
                { id: "output", label: "Output", icon: "terminal" },
                { id: "problems", label: problemTotal > 0 ? `Problems · ${problemTotal}` : "Problems", icon: "error" },
                { id: "bakes", label: "Bakes", icon: "history" },
              ]}
              active={bottomTab}
              onTab={setBottomTab}
              actions={
                <OverflowMenu
                  label="Bottom dock options"
                  size={36}
                  items={[
                    { label: "Clear output", run: output.clear },
                    { label: "Check problems again", run: diskProblems.refresh },
                    { label: "Pop panel into a window", run: popOutPanel },
                    { label: "Hide bottom dock", run: () => toggleDock("bottom") },
                  ]}
                />
              }
            >
              <BottomPane tab={bottomTab} output={output} problems={problems} disk={diskProblems} />
            </DockPanel>
          </div>
        </div>

        {docks.right && (
          <Divider
            vertical
            title="Drag to resize the right dock (double-click resets)"
            onLive={(dx, dy) => liveResize(rightRef, "r", dx, dy)}
            onCommit={() => commitResize(rightRef, "r")}
            onReset={() => setRightW(320)}
          />
        )}
        {/* right dock */}
        <div
          ref={rightRef}
          className={`flex-none ${docks.right ? "hidden lg:block" : "hidden"}`}
          style={{ width: rightW }}
        >
          <DockPanel
            tabs={[{ id: "details", label: "Details", icon: "tune" }]}
            active={rightTab}
            onTab={setRightTab}
            actions={
              <OverflowMenu
                label="Right dock options"
                size={36}
                items={[
                  { label: "Pop panel into a window", run: popOutPanel },
                  { label: "Hide right dock", run: () => toggleDock("right") },
                ]}
              />
            }
          >
            {playing ? (
              <div className="flex flex-col gap-2">
                <p
                  className="rounded-xl px-3 py-2 text-xs font-medium"
                  style={{ background: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)" }}
                >
                  Playing — Details is read-only until play stops.
                </p>
                <fieldset disabled aria-disabled="true" style={{ minWidth: 0 }}>
                  <DetailsPane workspace={workspace} view={view} />
                </fieldset>
              </div>
            ) : (
              <DetailsPane workspace={workspace} view={view} />
            )}
          </DockPanel>
        </div>
      </div>

      <StatusBar problems={problemTotal} onOpenProblems={() => { setBottomTab("problems"); setDocks((d) => ({ ...d, bottom: true })); }} />
      {dialog === "prefs" && <PreferencesDialog onClose={() => setDialog(null)} />}
      {dialog === "profile" && <ProfileDialog onClose={() => setDialog(null)} />}
      <SnackbarHost />
    </div>
  );
}

/** Draggable divider between dock stacks (UI-only; sizes persist locally).
 *
 *  rerender-use-ref-transient-values: the gesture mutates the dock's width
 *  directly (no React state per pointermove), and commits once on release —
 *  one re-render per drag instead of one per frame.
 */
function Divider({ vertical = false, title, onLive, onCommit, onReset }: {
  vertical?: boolean;
  title: string;
  onLive: (dx: number, dy: number) => void;
  onCommit: () => void;
  onReset: () => void;
}): React.JSX.Element {
  const drag = useDrag<true>({
    threshold: 0,
    start: () => true,
    move: (_e, _s, d) => onLive(d.stepX, d.stepY),
    end: () => onCommit(),
  });
  return (
    <span
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      title={title}
      onDoubleClick={onReset}
      {...drag.handlers}
      className={`flex-none rounded-full hover:bg-white/10 ${vertical ? "w-1.5 cursor-col-resize self-stretch" : "h-1.5 cursor-row-resize"}`}
      style={{ touchAction: "none" }}
    />
  );
}

function workspaceLabel(id: WorkspaceId): string {
  return WORKSPACES.find((w) => w.id === id)?.label.toLowerCase() ?? id;
}

/** Parse a deep-link hash into shell state (null = not a link; use defaults).
 *  Also feeds the useState initializers so the first paint already matches
 *  the link — no mount-effect race with the hash writer (StrictMode-safe). */
function parseHashString(hash: string): { workspace: WorkspaceId; view: string; sel: string | null } | null {
  const m = hash.match(/^#\/([\w-]+)\/([\w-]+)(?:\/(.+))?$/);
  if (!m) return null;
  const ws = WORKSPACES.find((w) => w.id === m[1]);
  if (!ws) return null;
  const v = ws.views.find((x) => x.id === m[2]);
  if (!v) return null;
  return { workspace: ws.id as WorkspaceId, view: v.id, sel: m[3] !== undefined ? decodeURIComponent(m[3]) : null };
}

let hashClaimed: string | null = null;

function initialHashLocation(): { workspace: WorkspaceId; view: string } {
  if (typeof window === "undefined") return { workspace: "gameplay", view: "tables" };
  const fromHash = parseHashString(window.location.hash);
  if (!fromHash && loadPrefs(browserStorage()).restoreLastView) {
    const last = recallView(browserStorage());
    const w = last ? WORKSPACES.find((x) => x.id === last.workspace) : undefined;
    if (last && w?.views.some((v) => v.id === last.view)) return { workspace: w.id as WorkspaceId, view: last.view };
  }
  const loc = fromHash ?? { workspace: "gameplay", view: "tables", sel: null };
  // Claim the selection synchronously (not in an effect) so the first
  // hash write already reflects it — idempotent across StrictMode retries.
  if (loc.sel !== null && hashClaimed !== window.location.hash) {
    hashClaimed = window.location.hash;
    applyDeepSelection(loc.sel);
  }
  return loc;
}

// ---------------------------------------------------------------- viewport options

/** The center header's viewport menu: Grid / Gizmos / Wireframe act on the active 3D viewport, Screenshot saves a PNG of it. */
function ViewportOptions(): React.JSX.Element {
  const vp = React.useSyncExternalStore(subscribeViewportActions, getViewportActions);
  const flags = viewportFlags.use();
  const toggle = (label: string, key: "grid" | "gizmos" | "wireframe"): { label: string; checked: boolean; disabled?: string; run: () => void } => ({
    label,
    checked: flags[key],
    ...(flagBlocked(key) !== null ? { disabled: flagBlocked(key) as string } : {}),
    run: () => toggleViewportFlag(key),
  });
  void vp; // re-render when the active viewport changes
  return (
    <OverflowMenu
      label="Viewport options"
      size={36}
      items={[
        toggle("Grid", "grid"),
        toggle("Gizmos", "gizmos"),
        toggle("Wireframe", "wireframe"),
        "sep",
        { label: "Screenshot viewport", run: () => void screenshotViewport(), ...(screenshotBlocked() !== null ? { disabled: screenshotBlocked() as string } : {}) },
      ]}
    />
  );
}

// ---------------------------------------------------------------- menu bar

function MenuBar({ workspace, onPick, onSearch, docks, onToggleDock, onResetLayout, onGo, onDialog }: {
  workspace: WorkspaceId;
  onPick: (id: WorkspaceId) => void;
  onSearch: () => void;
  docks: { left: boolean; right: boolean; bottom: boolean };
  onToggleDock: (d: "left" | "right" | "bottom") => void;
  onResetLayout: () => void;
  onGo: (ws: WorkspaceId, view?: string) => void;
  onDialog: (d: "prefs" | "profile") => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<"shortcuts" | "about" | null>(null);
  const profile = currentProfile(browserStorage());

  function fullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => notify("Fullscreen was blocked by the browser"));
  }

  const doc = React.useSyncExternalStore(subscribeDocActions, getDocActions);
  // Re-render the menus when the clipboard changes (Paste enables after Copy).
  React.useSyncExternalStore(subscribeClipboard, () => clipboardVersion());
  // The View menu's viewport items follow the mounted 3D viewport.
  const viewport = React.useSyncExternalStore(subscribeViewportActions, getViewportActions);
  // A menu item is enabled when there's an open document that supports it.
  // Unsupported operations disable with a reason — no "soon" placeholders.
  const docItem = (
    label: string,
    kbd: string | undefined,
    can: boolean | undefined,
    run: (() => void) | undefined,
    noDocReason = "no open document to act on",
  ): { label: string; kbd?: string; run?: () => void; disabled?: boolean; disabledReason?: string } => {
    if (!doc) return { label, kbd, disabled: true, disabledReason: noDocReason };
    if (!can || !run) return { label, kbd, disabled: true, disabledReason: `${doc.label} doesn't support ${label.toLowerCase()}` };
    return { label, kbd, run };
  };
  // The View menu's viewport items act on the mounted 3D viewport.
  const viewportItem = (
    label: string,
    kbd: string | undefined,
    can: boolean | undefined,
    run: (() => void) | undefined,
  ): { label: string; kbd?: string; run?: () => void; disabled?: boolean; disabledReason?: string } => {
    if (!viewport) return { label, kbd, disabled: true, disabledReason: "no viewport open" };
    if (!can || !run) return { label, kbd, disabled: true, disabledReason: `${viewport.label} doesn't support ${label.toLowerCase()}` };
    return { label, kbd, run };
  };
  const menus: Record<string, Array<{ label: string; kbd?: string; run?: () => void; disabled?: boolean; disabledReason?: string } | "sep">> = {
    File: [
      { label: "New Scene…", run: () => { requestNewScene(); onGo("scenes"); } },
      { label: "Open Scene…", run: () => onGo("scenes") },
      "sep",
      { label: doc ? `Save ${doc.label}` : "Save", kbd: "Ctrl S", disabled: !doc?.canSave, disabledReason: !doc ? "no open document to act on" : undefined, run: () => doc?.save() },
      // Save All saves the open document (panels hold one document at a time) unless the panel has its own.
      docItem("Save All", undefined, doc?.canSaveAll ?? doc?.canSave, doc?.saveAll ?? doc?.save),
      docItem("Revert", undefined, doc?.canRevert ?? (!!doc?.revert && doc.canSave), () => void revertActive()),
      "sep",
      docItem("Import…", undefined, canImport(doc), () => void importActive()),
      docItem("Export…", undefined, canExport(doc), exportActive),
    ],
    Edit: [
      { label: "Undo", kbd: "Ctrl Z", disabled: !doc?.canUndo, disabledReason: !doc ? "no open document to act on" : undefined, run: () => doc?.undo() },
      { label: "Redo", kbd: "Ctrl Y", disabled: !doc?.canRedo, disabledReason: !doc ? "no open document to act on" : undefined, run: () => doc?.redo() },
      "sep",
      docItem("Cut", "Ctrl X", doc?.canCut, doc?.cut),
      docItem("Copy", "Ctrl C", doc?.canCopy, doc?.copy),
      docItem("Paste", "Ctrl V", doc?.canPaste, doc?.paste),
      docItem("Duplicate", "Ctrl D", doc?.canDuplicate, doc?.duplicate),
      docItem("Delete", "Del", doc?.canDelete, doc?.deleteSelection),
      "sep",
      docItem("Select All", "Ctrl A", doc?.canSelectAll, doc?.selectAll),
    ],
    View: [
      { label: `${docks.left ? "✓ " : ""}Left dock`, run: () => onToggleDock("left") },
      { label: `${docks.right ? "✓ " : ""}Right dock`, run: () => onToggleDock("right") },
      { label: `${docks.bottom ? "✓ " : ""}Bottom dock`, run: () => onToggleDock("bottom") },
      "sep",
      viewportItem("Zoom In", "Ctrl +", viewport?.canZoomIn, viewport?.zoomIn),
      viewportItem("Zoom Out", "Ctrl -", viewport?.canZoomOut, viewport?.zoomOut),
      viewportItem("Reset Viewport", "Ctrl 0", viewport?.canReset, viewport?.reset),
      "sep",
      { label: "Screenshot Viewport", run: () => void screenshotViewport(), disabled: screenshotBlocked() !== null, disabledReason: screenshotBlocked() ?? undefined },
      { label: "Fullscreen", kbd: "F11", run: fullscreen },
    ],
    Window: [
      ...WORKSPACES.map((w) => ({ label: `Workspace: ${w.label}`, run: () => onGo(w.id) })),
      "sep",
      { label: "Pop panel into a window", run: popOutPanel },
      { label: "Reset layout", run: onResetLayout },
    ],
    Help: [
      { label: "Keyboard Shortcuts", kbd: "?", run: () => setDialog("shortcuts") },
      { label: "About MMO Engine Editor", run: () => setDialog("about") },
    ],
  };

  return (
    <>
    <div
      className="flex h-12 flex-none items-center gap-1.5 px-3"
      style={{ background: "var(--m3-surface-0)" }}
    >
      <span
        className="flex-none select-none text-[15px] font-extrabold"
        style={{
          letterSpacing: "0.18em",
          background: "linear-gradient(135deg, var(--m3-primary), #7f8cff 55%, var(--m3-tertiary))",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
        aria-label="Nexus editor"
      >
        NEXUS
      </span>
      {(Object.keys(menus) as Array<keyof typeof menus>).map((m) => (
        <span key={m} className="relative hidden sm:inline">
          <button
            onClick={() => setOpen((v) => (v === m ? null : m))}
            onMouseEnter={() => {
              if (open !== null) setOpen(m);
            }}
            aria-expanded={open === m}
            aria-haspopup="menu"
            className="m3-focus hidden rounded-md px-2 py-1.5 text-[13px] sm:inline"
            style={{
              color: "var(--m3-on-surface-variant)",
              background: open === m ? "var(--m3-surface-2)" : undefined,
            }}
          >
            {m}
          </button>
          {open === m && (
            <>
              <span className="fixed inset-0 z-40" onClick={() => setOpen(null)} aria-hidden="true" />
              <menu
                className="absolute left-0 top-9 z-50 min-w-60 rounded-xl p-1.5"
                style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
                aria-label={`${m} menu`}
              >
                {menus[m].map((it, i) => {
                  if (it === "sep") {
                    return <li key={`sep-${i}`} className="list-none" style={{ borderTop: "1px solid var(--m3-outline-variant)", margin: "4px 2px" }} />;
                  }
                  const run = it.run ?? (() => undefined);
                  const off = it.disabled === true;
                  const tip = it.disabled ? `${it.label} — ${it.disabledReason ?? "not available"}` : undefined;
                  return (
                    <li key={it.label} className="list-none">
                      <button
                        disabled={off}
                        title={tip}
                        onClick={() => {
                          setOpen(null);
                          run();
                        }}
                        className="m3-focus flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]"
                        style={{ color: "var(--m3-on-surface)", opacity: off ? 0.55 : undefined }}
                      >
                        {it.label}
                        {it.kbd && (
                          <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
                            {it.kbd}
                          </kbd>
                        )}
                      </button>
                    </li>
                  );
                })}
              </menu>
            </>
          )}
        </span>
      ))}
      <button
        onClick={onSearch}
        className="m3-focus ml-auto flex h-8 flex-none items-center gap-2 rounded-full px-3 text-[13px]"
        style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)" }}
        title="Command search — finds any command, panel, asset or setting (Ctrl K)"
      >
        <MIcon name="search" size={18} />
        <span className="hidden xl:inline">Search everything</span>
        <kbd
          className="rounded border px-1 font-mono text-[11px]"
          style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}
        >
          Ctrl K
        </kbd>
      </button>
      <span className="relative flex-none">
        <button
          onClick={() => setOpen((v) => (v === "profile" ? null : "profile"))}
          aria-expanded={open === "profile"}
          aria-haspopup="menu"
          aria-label={`Profile: ${profile}`}
          title={`Profile ${profile} — preferences are kept per profile`}
          className="m3-focus grid h-9 w-9 place-items-center rounded-full text-sm font-semibold"
          style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}
        >
          {profile.slice(0, 1).toUpperCase()}
        </button>
        {open === "profile" && (
          <>
            <span className="fixed inset-0 z-40" onClick={() => setOpen(null)} aria-hidden="true" />
            <menu
              className="absolute right-0 top-10 z-50 w-72 rounded-xl p-1.5"
              style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
              aria-label="Profile menu"
            >
              <li className="list-none px-2.5 py-2">
                <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>{profile}</p>
                <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
                  local profile · play sessions log in through the host
                </p>
              </li>
              {[
                { label: "Switch profile", run: () => onDialog("profile") },
                { label: "Preferences", run: () => onDialog("prefs") },
                {
                  label: "Sign out",
                  run: () => {
                    // Forget the stored session (profile, last view, last play setup) and start fresh.
                    signOut(browserStorage());
                    window.history.replaceState(null, "", window.location.pathname);
                    window.location.reload();
                  },
                },
              ].map((it) => (
                <li key={it.label} className="list-none">
                  <button
                    onClick={() => {
                      setOpen(null);
                      it.run();
                    }}
                    className="m3-focus flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px]"
                    style={{ color: "var(--m3-on-surface)" }}
                  >
                    {it.label}
                  </button>
                </li>
              ))}
            </menu>
          </>
        )}
      </span>
      {dialog === "shortcuts" && (
        <ShellDialog title="Keyboard Shortcuts" onClose={() => setDialog(null)}>
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            {[
              ["Ctrl K", "Command search"],
              ["Ctrl Shift S", "Save layout as…"],
              ["F5", "Play with the last settings"],
              ["Shift F5", "Stop play mode"],
              ["V / W / E / R", "Select / Move / Rotate / Scale"],
              ["Esc", "Close menus and dialogs"],
            ].map(([kbd, what]) => (
              <React.Fragment key={kbd}>
                <kbd className="rounded border px-1.5 py-0.5 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)" }}>{kbd}</kbd>
                <span style={{ color: "var(--m3-on-surface-variant)" }}>{what}</span>
              </React.Fragment>
            ))}
          </div>
        </ShellDialog>
      )}
      {dialog === "about" && (
        <ShellDialog title="MMO Engine — Editor" onClose={() => setDialog(null)}>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
            Standalone developer companion to the authoritative simulation. The editor edits validated
            documents (scenes, flows, rules, terrain, modules) and inspects live state — it never writes
            a running simulation's ECS state.
          </p>
          <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--m3-outline)" }}>
            docs/EDITOR.md · docs/EDITOR-ARCHITECTURE.md
          </p>
        </ShellDialog>
      )}
    </div>
    <div
      className="flex h-10 flex-none items-center px-3"
      style={{ background: "var(--m3-surface-0)", borderTop: "1px solid var(--m3-surface-2)" }}
    >
      <nav
        className="m3-scroll flex min-w-0 flex-1 items-center justify-center gap-px overflow-x-auto"
        aria-label="Workspaces"
      >
        {WORKSPACES.map((w) => {
          const on = w.id === workspace;
          return (
            <button
              key={w.id}
              aria-current={on ? "page" : undefined}
              onClick={() => onPick(w.id)}
              title={SOON_WS.has(w.id) ? `${w.label} — module slot (EA slice)` : PREVIEW_WS.has(w.id) ? `${w.label} — preview over sample data` : w.label}
              className="m3-focus flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[5px] text-[13px] font-medium"
              style={
                on
                  ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }
                  : { background: "transparent", color: "var(--m3-on-surface-variant)" }
              }
            >
              <MIcon name={w.icon} size={16} />
              {w.label}
            </button>
          );
        })}
      </nav>
    </div>
    </>
  );
}

// ---------------------------------------------------------------- toolbar

function ModulesChip(): React.JSX.Element {
  const n = useModuleRegistry().state?.enabled.length;
  return <>{n === undefined ? "modules" : `${n} module${n === 1 ? "" : "s"}`}</>;
}

function Toolbar(props: {
  playMenu: boolean;
  onTogglePlayMenu: () => void;
  onClosePlayMenu: () => void;
  onPlay: () => void;
  onShowPlay: () => void;
  playSetup: PlaySetup;
  onPlaySetup: (s: PlaySetup) => void;
  mode: RunMode;
  onMode: (m: RunMode) => void;
  layoutMenu: boolean;
  onToggleLayoutMenu: () => void;
  onCloseLayoutMenu: () => void;
  savedLayouts: Record<string, {
    workspace: WorkspaceId;
    view: string;
    leftTab: string;
    rightTab: string;
    bottomTab: string;
    leftW: number;
    rightW: number;
    bottomH: number;
    docks: { left: boolean; right: boolean; bottom: boolean };
  }>;
  onApplyLayout: (s: {
    workspace: WorkspaceId;
    view: string;
    leftTab: string;
    rightTab: string;
    bottomTab: string;
    leftW: number;
    rightW: number;
    bottomH: number;
    docks: { left: boolean; right: boolean; bottom: boolean };
  }) => void;
  onSaveLayout: (name: string) => void;
  onDeleteLayout: (name: string) => void;
  onResetLayout: () => void;
  currentSnapshot: {
    workspace: WorkspaceId;
    view: string;
    leftTab: string;
    rightTab: string;
    bottomTab: string;
    leftW: number;
    rightW: number;
    bottomH: number;
    docks: { left: boolean; right: boolean; bottom: boolean };
  };
}): React.JSX.Element {
  // The shared viewport tool: every viewport gates its edit gesture on
  // it (select = camera/pick, move = edit). V/W/E/R switch it (§3.2).
  const tool = React.useSyncExternalStore(subscribeTool, getTool);
  // The toolbar's document target: panels register while they hold an
  // open document; with none the buttons disable with a tooltip.
  const doc = React.useSyncExternalStore(subscribeDocActions, getDocActions);
  const { pmState, paused } = playUiStore.use();
  const stopping = pmState === "stopping";
  const canStop = pmState === "running" || pmState === "starting" || pmState === "error";
  const [cfg, setCfg] = React.useState<ToolbarConfig>(() => loadToolbar());
  const [customize, setCustomize] = React.useState<{ x: number; y: number } | null>(null);
  const change = (next: ToolbarConfig): void => {
    setCfg(next);
    saveToolbar(next);
  };
  const show = (id: string): boolean => isShown(cfg, id);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = (e.target as HTMLElement | null)?.tagName;
      if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "v") setTool("select");
      else if (k === "w") setTool("move");
      else if (k === "e") setTool("rotate");
      else if (k === "r") setTool("scale");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="relative flex h-[52px] flex-none items-center gap-1 px-3"
      style={{
        background: "var(--m3-surface)",
        borderBottom: pmState === "running" || pmState === "starting"
          ? "2px solid var(--m3-tertiary)"
          : "1px solid var(--m3-outline-variant)",
      }}
    >
      <div
        className="absolute inset-0"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          e.preventDefault();
          setCustomize({ x: e.clientX, y: e.clientY });
        }}
        aria-hidden="true"
      />
      {show("document") && <div className="relative flex items-center gap-0.5" role="toolbar" aria-label="Edit tools">
        <IconButton
          label={doc ? (doc.canSave ? `Save ${doc.label} (Ctrl S)` : `${doc.label} — no unsaved changes`) : "Save — no open document"}
          title={doc ? (doc.canSave ? `Save ${doc.label}` : `${doc.label} — no unsaved changes`) : "Save — no open document"}
          size={36}
          disabled={!doc?.canSave}
          onClick={() => doc?.save()}
        >
          <MIcon name="save" size={20} />
        </IconButton>
        <IconButton
          label={doc && doc.canUndo ? `Undo ${doc.label} (Ctrl Z)` : "Undo — nothing to undo"}
          title={doc && doc.canUndo ? `Undo ${doc.label}` : "Undo — nothing to undo"}
          size={36}
          disabled={!doc?.canUndo}
          onClick={() => doc?.undo()}
        >
          <MIcon name="undo" size={20} />
        </IconButton>
        <IconButton
          label={doc && doc.canRedo ? `Redo ${doc.label} (Ctrl Y)` : "Redo — nothing to redo"}
          title={doc && doc.canRedo ? `Redo ${doc.label}` : "Redo — nothing to redo"}
          size={36}
          disabled={!doc?.canRedo}
          onClick={() => doc?.redo()}
        >
          <MIcon name="redo" size={20} />
        </IconButton>
      </div>}
      {show("transform") && <div
        className="relative mx-1 hidden items-center gap-0.5 lg:flex"
        role="toolbar"
        aria-label="Transform tools"
        style={{ borderLeft: "1px solid var(--m3-outline-variant)", paddingLeft: 8 }}
      >
        <IconButton label="Select (V)" active={tool === "select"} onClick={() => setTool("select")} size={36}><MIcon name="nearby" size={20} /></IconButton>
        <IconButton label="Move (W)" active={tool === "move"} onClick={() => setTool("move")} size={36}><MIcon name="open_with" size={20} /></IconButton>
        <IconButton label="Rotate (E)" active={tool === "rotate"} onClick={() => setTool("rotate")} size={36}><MIcon name="rotate_right" size={20} /></IconButton>
        <IconButton label="Scale (R)" active={tool === "scale"} onClick={() => setTool("scale")} size={36}><MIcon name="expand" size={20} /></IconButton>
        <IconButton label="Snap" active={tool === "snap"} onClick={() => setTool(tool === "snap" ? "select" : "snap")} size={36}><MIcon name="grid_on" size={20} /></IconButton>
      </div>}

      {/* play cluster — segmented mode + split Play, always centered.
          Tertiary so play state reads at a glance (§3.2, §3.5). */}
      <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1.5 md:flex">
        <div
          className="flex h-10 items-center overflow-hidden rounded-full text-sm font-medium"
          role="group"
          aria-label="Edit, Simulate, or Play"
          title="Edit documents, Simulate the world with no player, or Play in the viewport"
          style={{ border: "1px solid var(--m3-outline-variant)" }}
        >
          {([["edit", "Edit"], ["simulate", "Simulate"], ["play", "Play"]] as Array<[RunMode, string]>).map(([m, label]) => {
            const on = props.mode === m;
            return (
              <button
                key={m}
                onClick={() => props.onMode(m)}
                aria-pressed={on}
                className="m3-focus flex h-full items-center px-3.5"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div
          className="flex h-10 items-center overflow-hidden rounded-full text-sm font-semibold"
          style={{ background: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)" }}
          role="group"
          aria-label="Play controls"
        >
          <button
            onClick={props.onPlay}
            title="Play with the last settings (F5)"
            className="m3-focus flex h-full items-center gap-1.5 pl-4 pr-3"
          >
            <MIcon name="play_arrow" size={20} />
            {!cfg.iconsOnly && "Play"}
          </button>
          <button
            onClick={props.onTogglePlayMenu}
            aria-expanded={props.playMenu}
            aria-haspopup="menu"
            title="Play menu — every way to run the game"
            className="m3-focus flex h-full items-center px-2.5"
            style={{ borderLeft: "1px solid rgba(161,80,48,0.35)" }}
          >
            <MIcon name="expand_more" size={20} />
          </button>
        </div>
        {show("tick") && <IconButton
          label={pmState !== "running" ? "Pause — play mode is not running" : paused ? "Resume the server's tick loop" : "Pause the server's tick loop"}
          title={pmState !== "running" ? "Pause — play mode is not running" : paused ? "Resume the server's tick loop" : "Pause the server's tick loop"}
          size={36}
          disabled={pmState !== "running"}
          onClick={() => void requestPlayTick(paused ? "resume" : "pause")}
        >
          <MIcon name={paused ? "play_arrow" : "pause"} size={20} />
        </IconButton>}
        {show("tick") && <IconButton
          label={paused ? "Step one tick" : "Step — pause the server first"}
          title={paused ? "Step one tick" : "Step — pause the server first"}
          size={36}
          disabled={pmState !== "running" || !paused}
          onClick={() => void requestPlayTick("step")}
        >
          <MIcon name="skip_next" size={20} />
        </IconButton>}
        <IconButton
          label={pmState === "idle" ? "Stop — play mode is not running" : stopping ? "Stopping…" : "Stop (Shift F5) — stops the owned server, even while starting"}
          title={pmState === "idle" ? "Stop — play mode is not running" : stopping ? "Stopping…" : "Stop — stops the owned server, even while starting"}
          size={36}
          disabled={!canStop || stopping}
          onClick={() => {
            void requestPlayStop();
            props.onShowPlay();
          }}
        >
          <MIcon name="stop" size={20} />
        </IconButton>
        {show("setup") && !cfg.iconsOnly && <span
          className="hidden h-7 items-center whitespace-nowrap rounded-full px-2.5 text-xs xl:inline-flex"
          style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
          title="Current play setup — the Play menu changes it"
        >
          {setupSummary(props.playSetup)}
        </span>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <StatusChip live={pmState === "running"}>{pmState === "running" ? "Playing" : pmState === "starting" ? "Starting…" : "Server idle"}</StatusChip>
        {show("modules") && <span
          className="hidden h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs lg:inline-flex"
          style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
          title="Enabled modules (content/modules.json)"
        >
          <MIcon name="extension" size={15} /><ModulesChip />
        </span>}
        {show("layout") && <span className="relative">
          <IconButton
            label="Layout menu (Ctrl Shift S saves)"
            size={36}
            onClick={props.onToggleLayoutMenu}
            title="Layouts are saved per workspace; popped-out panels stay in sync"
          >
            <MIcon name="dashboard" size={20} />
          </IconButton>
          {props.layoutMenu && (
            <LayoutMenuBody
              saved={props.savedLayouts}
              onApply={(name) => {
                const s = props.savedLayouts[name];
                if (s) {
                  props.onApplyLayout(s);
                  notify(`Layout “${name}” applied`);
                }
              }}
              onSave={(name) => {
                props.onSaveLayout(name);
                notify(`Layout “${name}” saved in this browser`);
              }}
              onDelete={props.onDeleteLayout}
              onReset={() => {
                props.onResetLayout();
                notify("Layout reset to the workspace default");
              }}
              onClose={props.onCloseLayoutMenu}
            />
          )}
        </span>}
      </div>

      {customize && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setCustomize(null)} onContextMenu={(e) => (e.preventDefault(), setCustomize(null))} aria-hidden="true" />
          <menu
            className="fixed z-50 w-72 rounded-xl p-2"
            style={{ left: Math.min(customize.x, window.innerWidth - 300), top: customize.y, background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
            aria-label="Customize toolbar"
          >
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Customize toolbar</p>
            {TOOLBAR_GROUPS.map((g) => (
              <li key={g.id} className="list-none">
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm" style={{ color: "var(--m3-on-surface)" }}>
                  <input type="checkbox" checked={show(g.id)} onChange={() => change(toggleGroup(cfg, g.id))} />
                  {g.label}
                </label>
              </li>
            ))}
            <li className="list-none">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm" style={{ color: "var(--m3-on-surface)" }}>
                <input type="checkbox" checked={cfg.iconsOnly} onChange={() => change({ ...cfg, iconsOnly: !cfg.iconsOnly })} />
                Icons only (no Play label or setup summary)
              </label>
            </li>
            <li className="list-none">
              <button className="m3-focus w-full rounded-lg px-2 py-1.5 text-left text-sm" style={{ color: "var(--m3-primary)" }} onClick={() => change(DEFAULT_TOOLBAR)}>
                Reset to default
              </button>
            </li>
          </menu>
        </>
      )}

      {props.playMenu && (
        <>
          <span className="fixed inset-0 z-40" onClick={props.onClosePlayMenu} aria-hidden="true" />
          <div className="absolute left-1/2 top-[52px] z-50 -translate-x-1/2">
            <PlayMenu setup={props.playSetup} onChange={props.onPlaySetup} onPlay={props.onPlay} onClose={props.onClosePlayMenu} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- layout menu
// Named dock arrangements, persisted in this browser (§3.4). Applying one
// restores workspace, views, tabs, dock sizes and visibility for real;
// "Pop panel into a window" opens the current deep link in a new window.

function LayoutMenuBody({ saved, onApply, onSave, onDelete, onReset, onClose }: {
  saved: Record<string, {
    workspace: WorkspaceId; view: string; leftTab: string; rightTab: string; bottomTab: string;
    leftW: number; rightW: number; bottomH: number; docks: { left: boolean; right: boolean; bottom: boolean };
  }>;
  onApply: (name: string) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onReset: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState("");
  const names = Object.keys(saved);
  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <menu
        className="absolute right-0 top-10 z-50 w-80 rounded-xl p-2"
        style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
        aria-label="Layout menu"
      >
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
          Layout
        </p>
        {names.length === 0 && (
          <li className="list-none px-2.5 py-2 text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            No saved layouts yet — arrange the docks, then save one by name.
          </li>
        )}
        {names.map((n) => (
          <li key={n} className="group flex list-none items-center gap-1 rounded-lg px-2 py-1.5 text-sm" style={{ color: "var(--m3-on-surface)" }}>
            <button onClick={() => onApply(n)} className="m3-focus flex flex-1 items-center gap-2 text-left">
              <MIcon name="dashboard" size={16} />{n}
            </button>
            <button
              onClick={() => onDelete(n)}
              aria-label={`Delete layout ${n}`}
              title={`Delete layout ${n}`}
              className="m3-focus rounded-full p-1 opacity-0 group-hover:opacity-100"
            >
              <MIcon name="delete" size={16} />
            </button>
          </li>
        ))}
        {naming ? (
          <li className="flex list-none items-center gap-1.5 rounded-lg px-2 py-1.5" style={{ borderTop: "1px solid var(--m3-outline-variant)", marginTop: 4, paddingTop: 8 }}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() !== "") {
                  onSave(name.trim());
                  setName("");
                  setNaming(false);
                }
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder="Layout name…"
              aria-label="Layout name"
              className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none"
              style={{ borderColor: "var(--m3-outline)" }}
            />
            <button
              onClick={() => {
                if (name.trim() !== "") {
                  onSave(name.trim());
                  setName("");
                  setNaming(false);
                }
              }}
              className="m3-focus h-9 rounded-full px-3 text-sm font-medium"
              style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
            >
              Save
            </button>
          </li>
        ) : (
          <li className="list-none" style={{ borderTop: "1px solid var(--m3-outline-variant)", marginTop: 4, paddingTop: 4 }}>
            <button onClick={() => setNaming(true)} className="m3-focus flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="save" size={16} /> Save layout as…
              <kbd className="ml-auto font-mono text-[11px]">Ctrl Shift S</kbd>
            </button>
            <button onClick={popOutPanel} className="m3-focus flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="open_in_new" size={16} /> Pop panel into a window
            </button>
            <button onClick={onReset} className="m3-focus flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="restart_alt" size={16} /> Reset to default
            </button>
          </li>
        )}
      </menu>
    </>
  );
}
// ---------------------------------------------------------------- command palette

function CommandPalette({ onClose, onGo, onPlay, onStop, commands: shell }: {
  onClose: () => void;
  onGo: (workspace: string, view: string) => void;
  onPlay: () => void;
  onStop: () => void;
  commands: PaletteCommand[];
}): React.JSX.Element {
  const [q, setQ] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [assets, setAssets] = React.useState<PaletteCommand[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => inputRef.current?.focus(), []);
  // Assets come from the content catalog (the host reads the files); the palette works without them.
  React.useEffect(() => {
    let live = true;
    loadCatalog().then(
      (c) => live && setAssets(catalogCommands(c.entries, onGo, requestOpenAsset)),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commands: PaletteCommand[] = [
    ...WORKSPACES.flatMap((w) =>
      w.views.map((v) => ({
        id: `go:${w.id}:${v.id}`,
        label: `${w.label} → ${v.label}`,
        group: "Go to" as const,
        hint: SOON_WS.has(w.id) ? "module slot" : PREVIEW_WS.has(w.id) ? "preview" : "workspace",
        icon: v.icon,
        keywords: VIEW_KEYWORDS[v.id],
        run: () => onGo(w.id, v.id),
      })),
    ),
    { id: "cmd:play", label: "Play with the last settings", group: "Command", hint: "F5", icon: "play_arrow", run: onPlay },
    { id: "cmd:stop", label: "Stop play mode", group: "Command", hint: "Shift F5", icon: "stop", run: onStop },
    ...shell,
    ...assets,
  ];
  const hits = rankCommands(commands, q, 12);
  const at = Math.min(cursor, Math.max(hits.length - 1, 0));

  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" style={{ background: "rgba(0,0,0,.4)" }} />
      <div
        className="fixed left-1/2 top-24 z-50 w-[32rem] max-w-[90vw] overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Command search"
        style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
          <MIcon name="search" size={20} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor(Math.min(at + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor(Math.max(at - 1, 0));
              } else if (e.key === "Enter" && hits.length > 0) hits[at].run();
            }}
            placeholder="Find any command, panel, asset or setting…"
            aria-label="Command search"
            className="h-8 flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--m3-on-surface)" }}
          />
          <kbd className="rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
            Ctrl K
          </kbd>
        </div>
        <ul className="m3-scroll max-h-80 overflow-y-auto p-2">
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                onClick={h.run}
                onMouseEnter={() => setCursor(i)}
                aria-current={i === at ? "true" : undefined}
                className="m3-focus flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"
                style={i === at ? { background: "rgba(255,255,255,.08)" } : undefined}
              >
                <span style={{ color: "var(--m3-on-surface-variant)" }}>
                  <MIcon name={h.icon} size={18} />
                </span>
                <span className="min-w-0 truncate">{h.label}</span>
                <span className="ml-auto flex-none font-mono text-[11px]" style={{ color: "var(--m3-outline)" }}>{h.hint ?? h.group}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && (
            <li className="px-3 py-6 text-center text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              No command, asset or setting matches “{q}”.
            </li>
          )}
        </ul>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- trees
// Drill-down outliner rows with per-item CRUD. Inspect/select runs against
// real shell state; Rename/Duplicate/Delete stage honestly for their slice.

function useTree(): {
  open: string[];
  sel: string | null;
  toggle: (id: string) => void;
  pick: (id: string) => void;
} {
  const [open, setOpen] = React.useState<string[]>([]);
  const [sel, setSel] = React.useState<string | null>(null);
  return {
    open,
    sel,
    toggle: (id: string) => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
    pick: (id: string) => setSel(id),
  };
}

function LeftTree(props: { workspace: WorkspaceId; view: string; onView: (v: string) => void; views: Workspace["views"]; onGo: (ws: WorkspaceId, view?: string) => void }): React.JSX.Element {
  if (props.workspace === "world") return <WorldTree />;
  if (props.workspace === "database") return <ViewListTree {...props} hint="Tables are listed in the grid; edits apply with the game server stopped." />;
  if (props.workspace === "flow") return <FlowScreens />;
  if (props.workspace === "story") return props.view === "quests" ? <QuestsTree onView={props.onView} /> : <StoryTree onOpen={() => props.onGo("story", "story-editor")} />;
  if (props.workspace === "artaudio") {
    if (props.view === "assets") return <AssetLibraryTree />;
    if (props.view === "animation") return <ClipList />;
    if (props.view === "materials") return <p className="px-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>The toon look and the terrain surfaces live in content/materials/materials.json; edit them in the panel.</p>;
    return <ViewListTree {...props} hint="Each editor lists its own content in its panel." />;
  }
  if (props.workspace === "release") return <ReleaseProfiles />;
  if (props.workspace === "liveops") return <ViewList views={props.views} view={props.view} onView={props.onView} hint="Every control sends one of the running server's admin commands." />;
  if (props.workspace === "network") return <ViewList views={props.views} view={props.view} onView={props.onView} hint="Routes are content/edge/routes.json; connections are the running server's." />;
  if (props.workspace === "gameplay" || props.workspace === "dungeons") {
    return <ViewListTree {...props} hint="Row-level tables (items, creatures, loot…) live inside the Tables panel." />;
  }
  if (props.workspace === "debug") {
    return <DebugTree />;
  }
  if (props.workspace === "scenes") {
    return (
      <div className="flex flex-col gap-0.5">
        <OwnedFiles
          kind="scene"
          onOpen={(name) => {
            props.onGo("scenes", "scene");
            requestOpenAsset("scene", name);
          }}
        />
        <p className="px-3 pt-1 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>content/scenes · the ⋯ menu on a row renames, duplicates or deletes</p>
      </div>
    );
  }
  return <ViewListTree {...props} hint="This workspace's content is in its panel; the Content tab browses every file." />;
}

/** The workspace's views as a list, with a line on where its content lives. */
function ViewListTree(props: { view: string; onView: (v: string) => void; views: Workspace["views"]; hint: string }): React.JSX.Element {
  return (
    <div>
      <SelectableList
        navigation
        size="lg"
        items={props.views}
        itemKey={(v) => v.id}
        label={(v) => v.label}
        icon={(v) => v.icon}
        selected={props.view}
        onPick={(v) => props.onView(v.id)}
      />
      <p className="mt-2 px-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>{props.hint}</p>
    </div>
  );
}

/** Debug sessions dock: live server state plus the overlay controls the
 *  Play mode panel itself uses — same store, both directions. */
function DebugTree(): React.JSX.Element {
  const t = useTree();
  const { entityId, autoRefresh, pmState } = playUiStore.use();
  return (
    <div className="flex flex-col gap-0.5">
      <TreeItem
        icon="dns" label="Owned server" trailing={pmState}
        hasKids expanded={t.open.includes("server")} onToggle={() => t.toggle("server")}
        selected={false} onPick={() => t.toggle("server")}
      />
      {t.open.includes("server") && (
        <p className="px-3 py-1 pl-11 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          Start and Stop live in the Play mode panel; this dock mirrors its state and overlays.
        </p>
      )}
      <div className="flex items-center gap-2 py-1.5 pl-11 pr-1.5">
        <input
          value={entityId}
          onChange={(e) => setPlayEntityId(e.target.value)}
          placeholder="Entity wire id…"
          aria-label="Overlay entity wire id"
          title="Waypoint overlay entity — same field as the Play mode panel"
          className="m3-focus h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2 font-mono text-xs"
          style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface)" }}
        />
      </div>
      <button
        onClick={() => setPlayAutoRefresh(!autoRefresh)}
        aria-pressed={autoRefresh}
        className="m3-focus flex h-9 items-center gap-3 rounded-full px-3 text-left text-sm"
        style={{ color: "var(--m3-on-surface)" }}
      >
        <MIcon name={autoRefresh ? "check_box" : "check_box_outline_blank"} size={19} />
        Auto-refresh overlays
        <span className="ml-auto font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>2 s</span>
      </button>
      <TickTimingsPanel />
      <p className="mt-2 px-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Timings come from the running play server via the debug API.
      </p>
    </div>
  );
}

/** Live tick timings from the play server (debug API). */
function TickTimingsPanel(): React.JSX.Element {
  const [timings, setTimings] = React.useState<{ ticks: number; p50: number; p99: number; systems: Array<{ name: string; avg: number; max: number }> } | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let live = true;
    // One query at a time: a slow server must not pile up a request every 2 s.
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const c = getPlayController();
        if (!c || c.getState() !== "running") {
          if (live) {
            setTimings(null);
            setError("");
          }
          return;
        }
        const res = await c.debugTimings();
        if (!live) return;
        if (res.query === "timings") {
          setTimings({ ticks: res.ticks, p50: res.p50, p99: res.p99, systems: res.systems });
          setError("");
        }
      } catch {
        // Running but unanswered: the query rides the player's client, which Simulate doesn't connect.
        if (live) {
          setTimings(null);
          setError("Tick timings come through the player's client; Simulate runs without one.");
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (error) return <p className="px-3 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{error}</p>;
  if (!timings) {
    return (
      <p className="px-3 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        Start play mode to see live tick timings.
      </p>
    );
  }
  return (
    <div className="px-3">
      <p className="text-xs font-medium">Tick timings ({timings.ticks} ticks)</p>
      <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        p50 {timings.p50.toFixed(1)}ms · p99 {timings.p99.toFixed(1)}ms
      </p>
      {timings.systems.length > 0 && (
        <ul className="mt-1">
          {timings.systems.slice(0, 5).map((s) => (
            <li key={s.name} className="flex justify-between font-mono text-xs">
              <span>{s.name}</span>
              <span style={{ color: "var(--m3-on-surface-variant)" }}>{s.avg.toFixed(2)}ms avg · {s.max.toFixed(1)} max</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
/** Content browser: real content paths, explorable.
 *  Clicking a document navigates to the workspace that owns it today. */
function ContentTree({ onGo }: { onGo: (ws: WorkspaceId, view?: string) => void }): React.JSX.Element {
  useModuleRegistry();
  const openScene = (name: string): void => {
    onGo("scenes", "scene");
    requestOpenAsset("scene", name);
  };
  const t = useTree();
  const RULES = ["appearance", "body", "combat", "creatures", "death", "disciplines", "ingress", "items", "loot", "needs", "skills", "spells", "stats"];
  const folder = (id: string, label: string, icon: string, kids: React.ReactNode): React.JSX.Element => (
    <div key={id}>
      <TreeItem
        icon={icon} label={label} mono
        hasKids expanded={t.open.includes(id)} onToggle={() => t.toggle(id)}
        selected={t.sel === id} onPick={() => { t.pick(id); t.toggle(id); }}
      />
      {t.open.includes(id) && kids}
    </div>
  );
  // Files the editor does not own open in their workspace; rename / duplicate / delete are for owned files (OwnedFiles).
  const file = (path: string, name: string, go?: [WorkspaceId, string?], depth = 1): React.JSX.Element => (
    <TreeItem
      key={path}
      icon="description" label={name} depth={depth} mono
      selected={t.sel === path} onPick={() => {
        t.pick(path);
        if (go) onGo(go[0], go[1]);
      }}
      menu={go ? [{ label: `Open ${name}`, icon: "open_in_new", run: () => onGo(go[0], go[1]) }] : undefined}
    />
  );
  return (
    <div className="flex flex-col gap-0.5">
      {folder("rules", "content/rules", "folder", (
        <>
          {RULES.map((r) => file(`content/rules/${r}.json`, `${r}.json`, ["gameplay", r === "creatures" || r === "items" ? "tables" : undefined]))}
        </>
      ))}
      {folder("pcg", "content/pcg", "folder", (
        <>
          {file("content/pcg/index.json", "index.json", undefined)}
          {["trees/oak.pcg", "trees/birch.pcg", "trees/pine.pcg", "parts/trunk.pcgsubgraph"].map((f) => file(`content/pcg/${f}`, f.split("/")[1], ["dungeons", "graphs"]))}
        </>
      ))}
      {folder("quests", "content/quests", "folder", (
        <>
          {["quests.json", "steps.json", "npcs.json", "dialogs.json"].map((f) => file(`content/quests/${f}`, f, ["story", "quests"]))}
        </>
      ))}
      {folder("dungeons", "content/dungeons", "folder", (
        <>
          {["instances.json", "entrances.json"].map((f) => file(`content/dungeons/${f}`, f, ["dungeons", "dungeons"]))}
        </>
      ))}
      {folder("edge", "content/edge", "folder", (
        <>{file("content/edge/routes.json", "routes.json", ["network"])}</>
      ))}
      {folder("scenes", "content/scenes", "folder", (
        <OwnedFiles kind="scene" onOpen={openScene} />
      ))}
      {folder("playtests", "content/playtests", "folder", (
        <OwnedFiles kind="playtest" onOpen={() => onGo("release", "playtests")} />
      ))}
      {folder("build", "content/build/profiles", "folder", (
        <OwnedFiles kind="build" onOpen={() => onGo("release", "pipeline")} />
      ))}
      {folder("modules", `modules · ${moduleRegistry.state?.enabled.length ?? "?"} enabled`, "extension", (
        <>
          {(moduleRegistry.state?.modules ?? []).map((m) => file(`modules/${m.name}/module.json`, m.name, ["modules", "modules"]))}
        </>
      ))}
      <p className="px-3 pt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Files open in the workspace that owns them. Scenes, playtests and build profiles can be renamed, duplicated and deleted here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- right dock

function GameplayDetails(): React.JSX.Element {
  const report = usePendingChanges();
  const icon = { edit: "edit", add: "add_circle", remove: "remove_circle", error: "error" } as const;
  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-xl p-2.5 text-[12.5px]"
        style={{ background: "var(--m3-success-container)", color: "#d7f8c3" }}
      >
        <MIcon name="bolt" size={16} /> Saved tables hot-reload into the running server
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
        Unsaved changes
      </p>
      {report === null ? (
        <p className="text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          Nothing changed. Edits in the grid list here until you save; a refused save writes nothing.
        </p>
      ) : (
        <ul className="text-[12.5px]" aria-label={`Unsaved changes in ${report.label}`}>
          {report.changes.map((c, i) => (
            <li key={`${c.kind}:${c.path}:${i}`} className="flex items-center gap-2 border-b py-1.5" style={{ borderColor: "#2a2b31" }}>
              <MIcon name={icon[c.kind]} size={16} />
              <span className="font-mono text-xs">{c.path}</span>
              <span className="ml-auto text-right" style={{ color: c.kind === "error" ? "var(--m3-error)" : "var(--m3-on-surface-variant)" }}>{c.change}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailsPane({ workspace, view }: { workspace: WorkspaceId; view: string }): React.JSX.Element {
  const selection = useEditorSelection();
  if (selection && isSelectionVisible(selection, workspace, view)) return <SelectionDetails selection={selection} />;
  if (workspace === "liveops") return <LiveOpsDetailsLive />;
  if (workspace === "network") return <NetworkDetailsLive />;
  if (workspace === "database") return <DatabaseNote />;
  if (workspace === "release") return view === "playtests" ? <PlaytestDetails /> : <ReleaseNote />;
  if (workspace === "flow") return <FlowNote />;
  if (workspace === "story" && view === "quests") return <QuestDetailsLive />;
  if (workspace === "artaudio" && view === "animation") return <AnimDetails />;
  if (workspace === "gameplay") return <GameplayDetails />;

  function SelectionDetails({ selection }: { selection: NonNullable<ReturnType<typeof useEditorSelection>> }): React.JSX.Element {
    return (
      <div className="flex flex-col gap-3 text-xs">
        <div>
          <p className="text-sm font-semibold">{selection.label}</p>
          <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {selection.kind} · {selection.id}
          </p>
        </div>
        <span className="w-fit rounded-md px-2 py-1 text-[11px] font-medium" style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}>
          Selected from {selection.source.replace("-", " ")}
        </span>
        {selection.components.length === 0 ? (
          <p style={{ color: "var(--m3-on-surface-variant)" }}>no details for {selection.kind} {selection.id} — pick something else.</p>
        ) : (
          selection.components.map((component) => (
            <section key={component.name} className="rounded-lg p-2.5" style={{ background: "var(--m3-surface-2)" }}>
              <p className="mb-2 font-medium">{component.name}</p>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 font-mono text-[11px]">
                {component.fields.map((field) => (
                  <React.Fragment key={field.key}>
                    <dt style={{ color: "var(--m3-on-surface-variant)" }}>{field.key}</dt>
                    <dd className="text-right">{field.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
    );
  }
  return (
    <EmptyState
      icon="tune"
      title="No selection"
      body="Pick in the viewport, the outliner or the entity list — one shared selection feeds every Details panel."
    />
  );
}

// ---------------------------------------------------------------- bottom dock

function BottomPane({ tab, output, problems, disk }: { tab: string; output: ServerOutput; problems: ReturnType<typeof useDocProblems>; disk: DiskProblems }): React.JSX.Element {
  if (tab === "problems") return <ProblemsPane doc={problems} disk={disk} />;
  if (tab === "bakes") return <BakesPane visible={tab === "bakes"} />;
  return <OutputPane output={output} />;
}

// ---------------------------------------------------------------- status bar

function StatusBar({ problems, onOpenProblems }: { problems: number; onOpenProblems: () => void }): React.JSX.Element {
  return (
    <footer
      className="flex h-7 flex-none items-center gap-3 px-3 text-[11px]"
      style={{ background: "var(--m3-surface-0)", color: "var(--m3-on-surface-variant)" }}
    >
      <span className="hidden sm:inline">Server stays authoritative — the editor inspects live state, never a running simulation.</span>
      <span className="sm:hidden">Authoritative server · read-only inspect</span>
      <span className="ml-auto font-mono">docs/EDITOR.md</span>
      <button
        className="m3-focus rounded px-1 font-mono hover:underline"
        title="Open the Problems tab"
        onClick={onOpenProblems}
      >
        {problems === 0 ? "no problems" : `${problems} problem${problems === 1 ? "" : "s"}`}
      </button>
    </footer>
  );
}
