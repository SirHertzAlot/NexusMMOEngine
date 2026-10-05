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
import { PlayModePanel } from "./play-mode.js";
import { AssetInspectorPanel } from "./asset-inspector.js";
import { TerrainEditorPanel } from "./terrain-editor.js";
import { CharacterRecordPanel } from "./character-view.js";
import { GraphEditorPanel } from "./graph-editor.js";
import { DungeonPanel } from "./dungeon-view.js";
import { RulesPanel } from "./rules-editor.js";
import { RulesPanel as TablesPanel } from "./rules-panel.js";
import { Chip, DockPanel, EmptyState, IconButton, MIcon, OverflowMenu, SnackbarHost, StatusChip, TreeItem, notify, staged, useLocalStorage } from "./components.js";
import type { MenuItem } from "./components.js";
import {
  AnimDetails,
  AnimPreview,
  ArtAudioTree,
  AudioPreview,
  DataGridPreview,
  HudPreview,
  LiveOpsDetails,
  DatabaseRowDetails,
  FlowDetails,
  FlowGraphPreview,
  HudDetails,
  LiveOpsPreview,
  PipelinePreview,
  PlaytestPreview,
  QuestPreview,
  QueryPreview,
  ReleaseDeployDetails,
  SchemaTree,
  StoryDetails,
  StringsPreview,
  VfxPreview,
  WidgetList,
  PLAYERS,
  applyDeepSelection,
  liveOpsStore,
  readDeepSelection,
  storyStore,
  subscribeDeepSelection,
} from "./previews.js";

// ---------------------------------------------------------------- config

type WorkspaceId =
  | "world"
  | "scene"
  | "flow"
  | "characters"
  | "gameplay"
  | "dungeons"
  | "liveops"
  | "network"
  | "debug"
  | "database"
  | "story"
  | "artaudio"
  | "release";

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
    id: "flow", label: "Flow & UI", icon: "account_tree",
    views: [
      { id: "flow", label: "Flow graph", icon: "account_tree", kind: "panel", panel: <FlowGraphPreview /> },
      { id: "hud", label: "HUD layout", icon: "dashboard", kind: "panel", panel: <HudPreview /> },
    ],
    leftTitle: "Widgets",
  },
  {
    id: "characters", label: "Characters", icon: "person",
    views: [{ id: "records", label: "Records", icon: "person", kind: "panel", panel: <CharacterRecordPanel /> }],
    leftTitle: "Catalog",
  },
  {
    id: "gameplay", label: "Gameplay", icon: "table_view",
    views: [
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
    views: [{ id: "overview", label: "Overview", icon: "groups", kind: "panel", panel: <LiveOpsPreview /> }],
    leftTitle: "Scopes",
  },
  {
    id: "network", label: "Network", icon: "lan",
    views: [{ id: "network", label: "Routes", icon: "lan", kind: "soon", soon: { icon: "lan", title: "Edge routes arrive with the edge split", body: "Core vs local module routes, channel health and /metrics links (§7c)." } }],
    leftTitle: "Routes",
  },
  {
    id: "debug", label: "Debug", icon: "monitoring",
    views: [{ id: "play", label: "Play mode", icon: "play_arrow", kind: "panel", panel: <PlayModePanel /> }],
    leftTitle: "Sessions",
  },
  {
    id: "database", label: "Database", icon: "database",
    views: [
      { id: "grid", label: "Data grid", icon: "table_view", kind: "panel", panel: <DataGridPreview /> },
      { id: "query", label: "Query", icon: "code", kind: "panel", panel: <QueryPreview /> },
    ],
    leftTitle: "Schema",
  },
  {
    id: "story", label: "Story", icon: "auto_stories",
    views: [
      { id: "quests", label: "Quests", icon: "flag", kind: "panel", panel: <QuestPreview /> },
      { id: "strings", label: "Strings", icon: "translate", kind: "panel", panel: <StringsPreview /> },
    ],
    leftTitle: "Stories",
  },
  {
    id: "artaudio", label: "Art & audio", icon: "movie",
    views: [
      { id: "assets", label: "Art Assets", icon: "palette", kind: "panel", panel: <AssetInspectorPanel /> },
      { id: "animation", label: "Animation", icon: "directions_run", kind: "panel", panel: <AnimPreview /> },
      { id: "vfx", label: "VFX", icon: "sparkles", kind: "panel", panel: <VfxPreview /> },
      { id: "audio", label: "Audio", icon: "graphic_eq", kind: "panel", panel: <AudioPreview /> },
    ],
    leftTitle: "Library",
  },
  {
    id: "release", label: "Release", icon: "rocket_launch",
    views: [
      { id: "pipeline", label: "Pipeline", icon: "account_tree", kind: "panel", panel: <PipelinePreview /> },
      { id: "playtests", label: "Playtests", icon: "science", kind: "panel", panel: <PlaytestPreview /> },
    ],
    leftTitle: "Profiles",
  },
];

const SOON_WS: ReadonlySet<WorkspaceId> = new Set(["network"]);
/** Workspaces showing mockup-faithful previews over sample data. */
const PREVIEW_WS: ReadonlySet<WorkspaceId> = new Set(["flow", "liveops", "database", "story", "artaudio", "release"]);

// ---------------------------------------------------------------- shell

/** Edit / Simulate / Play (§3.2): a shortcut for where the shell looks.
 *  Edit opens the Scene workspace over documents; Simulate and Play open
 *  Play mode, which owns the server lifecycle. */
type RunMode = "edit" | "simulate" | "play";

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = React.useState<WorkspaceId>(() => initialHashLocation().workspace);
  const [view, setView] = React.useState<string>(() => initialHashLocation().view);
  const [leftTab, setLeftTab] = React.useState<string>("left");
  const [rightTab, setRightTab] = React.useState<string>("details");
  const [bottomTab, setBottomTab] = React.useState<string>("output");
  const [playMenu, setPlayMenu] = React.useState(false);
  const [layoutMenu, setLayoutMenu] = React.useState(false);
  const [mode, setMode] = React.useState<RunMode>("edit");
  const [palette, setPalette] = React.useState(false);

  // Dock layout: visibility + sizes persist locally; named layouts snapshot all of it.
  const [docks, setDocks] = useLocalStorage("mmo-editor.docks", { left: true, right: true, bottom: true });
  const [leftW, setLeftW] = useLocalStorage("mmo-editor.leftW", 256);
  const [rightW, setRightW] = useLocalStorage("mmo-editor.rightW", 320);
  const [bottomH, setBottomH] = useLocalStorage("mmo-editor.bottomH", 144);
  const [savedLayouts, setSavedLayouts] = useLocalStorage<Record<string, LayoutSnapshot>>("mmo-editor.layouts", {});
  const [dropHL, setDropHL] = React.useState(false);

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

  function goPlay(): void {
    pickWorkspace("debug");
    setView("play");
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
    else goPlay();
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
  });

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
  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setLayoutMenu(true);
      } else if (e.key === "Escape") {
        setPalette(false);
        setPlayMenu(false);
        setLayoutMenu(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--m3-surface)", color: "var(--m3-on-surface)" }}>
      <MenuBar
        workspace={workspace}
        onPick={pickWorkspace}
        onSearch={() => setPalette(true)}
        docks={docks}
        onToggleDock={toggleDock}
        onResetLayout={() => applyLayout(defaultLayout())}
        onGo={go}
      />
      <Toolbar
        playMenu={playMenu}
        onTogglePlayMenu={() => setPlayMenu((v) => !v)}
        onClosePlayMenu={() => setPlayMenu(false)}
        onPlay={goPlay}
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
          onWorkspace={(id) => {
            pickWorkspace(id);
            setPalette(false);
          }}
          onPlay={() => {
            goPlay();
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
                  { label: "Save layout as…", kbd: "Ctrl Shift S", run: () => notify("Use the layout menu (top right) to save this arrangement by name") },
                  { label: "Pop panel into a window", stagedFor: "EA · layout" },
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
              <OverflowMenu
                label="Viewport options"
                size={36}
                items={[
                  { label: "Grid", stagedFor: "EA · viewport tools" },
                  { label: "Gizmos", stagedFor: "EA · viewport tools" },
                  { label: "Wireframe", stagedFor: "EA · viewport tools" },
                  "sep",
                  { label: "Screenshot viewport", stagedFor: "core" },
                ]}
              />
            </span>
          </div>

          <div
            className="m3-scroll relative min-h-0 flex-1 overflow-auto rounded-xl p-3"
            style={{
              background: "var(--m3-surface-1)",
              outline: dropHL ? "2px dashed var(--m3-primary)" : undefined,
              outlineOffset: -2,
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("text/mmo-editor-node")) {
                e.preventDefault();
                setDropHL(true);
              }
            }}
            onDragLeave={() => setDropHL(false)}
            onDrop={(e) => {
              const name = e.dataTransfer.getData("text/mmo-editor-node");
              setDropHL(false);
              if (name) notify(`Drop ${name} to place — staged for the scene viewport slice`);
            }}
          >
            {activeView.kind === "panel" ? (
              activeView.panel
            ) : (
              <EmptyState icon={activeView.soon?.icon ?? "hourglass_empty"} title={activeView.soon?.title ?? "Coming soon"} body={activeView.soon?.body ?? ""} />
            )}
            {dropHL && (
              <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl text-sm font-medium" style={{ background: "rgba(54,68,154,.25)", color: "var(--m3-on-primary-container)" }}>
                Drop to place in the open scene
              </div>
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
                { id: "problems", label: "Problems · 2", icon: "error" },
                { id: "bakes", label: "Bakes", icon: "history" },
              ]}
              active={bottomTab}
              onTab={setBottomTab}
              actions={
                <OverflowMenu
                  label="Bottom dock options"
                  size={36}
                  items={[
                    { label: "Clear output", run: () => notify("Output is pinned to the owned server's log in this build") },
                    { label: "Pop panel into a window", stagedFor: "EA · layout" },
                    { label: "Hide bottom dock", run: () => toggleDock("bottom") },
                  ]}
                />
              }
            >
              <BottomPane tab={bottomTab} />
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
            tabs={[
              { id: "compare", label: "Compare", icon: "compare_arrows" },
              { id: "details", label: "Details", icon: "tune" },
            ]}
            active={rightTab}
            onTab={setRightTab}
            actions={
              <OverflowMenu
                label="Right dock options"
                size={36}
                items={[
                  { label: "Pop panel into a window", stagedFor: "EA · layout" },
                  { label: "Hide right dock", run: () => toggleDock("right") },
                ]}
              />
            }
          >
            {rightTab === "compare" ? <ComparePane /> : <DetailsPane workspace={workspace} view={view} />}
          </DockPanel>
        </div>
      </div>

      <StatusBar />
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
  const last = React.useRef<{ x: number; y: number } | null>(null);
  return (
    <span
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      title={title}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!last.current) return;
        onLive(e.clientX - last.current.x, e.clientY - last.current.y);
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => {
        last.current = null;
        onCommit();
      }}
      onPointerCancel={() => {
        last.current = null;
        onCommit();
      }}
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
  const loc = parseHashString(window.location.hash) ?? { workspace: "gameplay", view: "tables", sel: null };
  // Claim the selection synchronously (not in an effect) so the first
  // hash write already reflects it — idempotent across StrictMode retries.
  if (loc.sel !== null && hashClaimed !== window.location.hash) {
    hashClaimed = window.location.hash;
    applyDeepSelection(loc.sel);
  }
  return loc;
}

// ---------------------------------------------------------------- menu bar

function MenuBar({ workspace, onPick, onSearch, docks, onToggleDock, onResetLayout, onGo }: {
  workspace: WorkspaceId;
  onPick: (id: WorkspaceId) => void;
  onSearch: () => void;
  docks: { left: boolean; right: boolean; bottom: boolean };
  onToggleDock: (d: "left" | "right" | "bottom") => void;
  onResetLayout: () => void;
  onGo: (ws: WorkspaceId, view?: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<"shortcuts" | "about" | null>(null);

  function fullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => notify("Fullscreen was blocked by the browser"));
  }

  const menus: Record<string, Array<{ label: string; kbd?: string; run?: () => void; stagedFor?: string } | "sep">> = {
    File: [
      { label: "New Scene", run: staged("New Scene", "EA · scenes"), stagedFor: "EA · scenes" },
      { label: "Open Scene…", run: staged("Open Scene", "EA · scenes"), stagedFor: "EA · scenes" },
      "sep",
      { label: "Save", kbd: "Ctrl S", run: staged("Save", "the open document's slice"), stagedFor: "the open document's slice" },
      { label: "Save All", run: staged("Save All", "the open document's slice"), stagedFor: "the open document's slice" },
      { label: "Revert", run: staged("Revert", "the open document's slice"), stagedFor: "the open document's slice" },
      "sep",
      { label: "Import…", run: staged("Import", "EA · content browser"), stagedFor: "EA · content browser" },
      { label: "Export…", run: staged("Export", "EA · content browser"), stagedFor: "EA · content browser" },
    ],
    Edit: [
      { label: "Undo", kbd: "Ctrl Z", run: staged("Undo", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      { label: "Redo", kbd: "Ctrl Y", run: staged("Redo", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      "sep",
      { label: "Cut", kbd: "Ctrl X", run: staged("Cut", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      { label: "Copy", kbd: "Ctrl C", run: staged("Copy", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      { label: "Paste", kbd: "Ctrl V", run: staged("Paste", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      { label: "Duplicate", kbd: "Ctrl D", run: staged("Duplicate", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      { label: "Delete", kbd: "Del", run: staged("Delete", "the shared command stack (§3.1)"), stagedFor: "the shared command stack (§3.1)" },
      "sep",
      { label: "Select All", kbd: "Ctrl A", run: staged("Select All", "the shared selection model (§3.1)"), stagedFor: "the shared selection model (§3.1)" },
    ],
    View: [
      { label: `${docks.left ? "✓ " : ""}Left dock`, run: () => onToggleDock("left") },
      { label: `${docks.right ? "✓ " : ""}Right dock`, run: () => onToggleDock("right") },
      { label: `${docks.bottom ? "✓ " : ""}Bottom dock`, run: () => onToggleDock("bottom") },
      "sep",
      { label: "Zoom In", kbd: "Ctrl +", run: staged("Zoom In", "EA · viewport tools"), stagedFor: "EA · viewport tools" },
      { label: "Zoom Out", kbd: "Ctrl -", run: staged("Zoom Out", "EA · viewport tools"), stagedFor: "EA · viewport tools" },
      { label: "Reset Viewport", kbd: "Ctrl 0", run: staged("Reset Viewport", "EA · viewport tools"), stagedFor: "EA · viewport tools" },
      "sep",
      { label: "Fullscreen", kbd: "F11", run: fullscreen },
    ],
    Window: [
      ...WORKSPACES.map((w) => ({ label: `Workspace: ${w.label}`, run: () => onGo(w.id) })),
      "sep",
      { label: "Pop panel into a window", run: staged("Pop panel into a window", "EA · layout") },
      { label: "Reset layout", run: onResetLayout },
    ],
    Help: [
      { label: "Keyboard Shortcuts", kbd: "?", run: () => setDialog("shortcuts") },
      { label: "Editor Guide (docs/EDITOR.md)", run: () => notify("docs/EDITOR.md — open it in your code editor") },
      { label: "Architecture (EDITOR-ARCHITECTURE.md)", run: () => notify("docs/EDITOR-ARCHITECTURE.md — open it in your code editor") },
      "sep",
      { label: "About MMO Engine Editor", run: () => setDialog("about") },
    ],
  };

  return (
    <div
      className="flex h-12 flex-none items-center gap-1.5 px-3"
      style={{ background: "var(--m3-surface-0)" }}
    >
      <span
        className="grid h-[30px] w-[30px] flex-none place-items-center text-sm font-extrabold"
        style={{
          borderRadius: 9,
          background: "linear-gradient(135deg, var(--m3-primary), #7f8cff 55%, var(--m3-tertiary))",
          color: "var(--m3-on-primary)",
        }}
        aria-hidden="true"
      >
        N
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
                  const run = it.run ?? (it.stagedFor ? staged(it.label, it.stagedFor) : () => undefined);
                  return (
                    <li key={it.label} className="list-none">
                      <button
                        onClick={() => {
                          setOpen(null);
                          run();
                        }}
                        className="m3-focus flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]"
                        style={{ color: "var(--m3-on-surface)" }}
                      >
                        {it.label}
                        {it.stagedFor && (
                          <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--m3-outline)" }}>staged</span>
                        )}
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
      <nav
        className="m3-scroll ml-2 flex min-w-0 flex-1 items-center gap-px overflow-x-auto rounded-full p-[3px]"
        aria-label="Workspaces"
        style={{ background: "var(--m3-surface-1)" }}
      >
        {WORKSPACES.map((w) => {
          const on = w.id === workspace;
          return (
            <button
              key={w.id}
              aria-current={on ? "page" : undefined}
              onClick={() => onPick(w.id)}
              title={SOON_WS.has(w.id) ? `${w.label} — module slot (EA slice)` : PREVIEW_WS.has(w.id) ? `${w.label} — preview over sample data` : w.label}
              className="m3-focus flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[5px] text-xs font-medium"
              style={
                on
                  ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }
                  : { background: "transparent", color: "var(--m3-on-surface-variant)" }
              }
            >
              <MIcon name={w.icon} size={15} />
              {w.label}
            </button>
          );
        })}
      </nav>
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
          aria-label="Profile: signed in as editor (dev)"
          title="Signed in as editor (dev) — seeded admin"
          className="m3-focus grid h-9 w-9 place-items-center rounded-full text-sm font-semibold"
          style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}
        >
          P
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
                <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>editor (dev)</p>
                <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
                  seeded admin · one-session login via the host
                </p>
              </li>
              {[
                { label: "Switch profile", stagedFor: "EA · auth (A1)" },
                { label: "Preferences", stagedFor: "EA · project settings" },
                { label: "Sign out", stagedFor: "EA · auth (A1)" },
              ].map((it) => (
                <li key={it.label} className="list-none">
                  <button
                    onClick={() => {
                      setOpen(null);
                      staged(it.label, it.stagedFor)();
                    }}
                    className="m3-focus flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px]"
                    style={{ color: "var(--m3-on-surface)" }}
                  >
                    {it.label}
                    <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--m3-outline)" }}>staged</span>
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
  );
}

function ShellDialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" style={{ background: "rgba(0,0,0,.4)" }} />
      <div
        className="fixed left-1/2 top-1/3 z-50 w-[26rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/3 rounded-2xl p-5"
        role="dialog"
        aria-label={title}
        style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      >
        <div className="mb-3 flex items-center">
          <p className="text-base font-medium">{title}</p>
          <span className="ml-auto">
            <IconButton label={`Close ${title}`} size={36} onClick={onClose}>
              <MIcon name="close" size={19} />
            </IconButton>
          </span>
        </div>
        {children}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar(props: {
  playMenu: boolean;
  onTogglePlayMenu: () => void;
  onClosePlayMenu: () => void;
  onPlay: () => void;
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
  return (
    <div
      className="relative flex h-[52px] flex-none items-center gap-1 px-3"
      style={{ background: "var(--m3-surface)", borderBottom: "1px solid var(--m3-outline-variant)" }}
    >
      <div className="flex items-center gap-0.5" role="toolbar" aria-label="Edit tools">
        <IconButton label="Save (Ctrl S)" size={36}><MIcon name="save" size={20} /></IconButton>
        <IconButton label="Undo (Ctrl Z)" size={36}><MIcon name="undo" size={20} /></IconButton>
        <IconButton label="Redo (Ctrl Y)" size={36}><MIcon name="redo" size={20} /></IconButton>
      </div>
      <div
        className="mx-1 hidden items-center gap-0.5 lg:flex"
        role="toolbar"
        aria-label="Transform tools"
        style={{ borderLeft: "1px solid var(--m3-outline-variant)", paddingLeft: 8 }}
      >
        <IconButton label="Select (V)" active size={36}><MIcon name="nearby" size={20} /></IconButton>
        <IconButton label="Move (W)" size={36}><MIcon name="open_with" size={20} /></IconButton>
        <IconButton label="Rotate (E)" size={36}><MIcon name="rotate_right" size={20} /></IconButton>
        <IconButton label="Scale (R)" size={36}><MIcon name="expand" size={20} /></IconButton>
        <IconButton label="Snap" size={36}><MIcon name="grid_on" size={20} /></IconButton>
      </div>

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
            title="Play with the last settings (F5) — opens Play mode"
            className="m3-focus flex h-full items-center gap-1.5 pl-4 pr-3"
          >
            <MIcon name="play_arrow" size={20} />
            Play
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
        <IconButton label="Pause (opens Play mode)" size={36} onClick={props.onPlay} title="Pause — managed by the Play mode panel">
          <MIcon name="pause" size={20} />
        </IconButton>
        <IconButton label="Step one tick (opens Play mode)" size={36} onClick={props.onPlay} title="Step — one 30 Hz tick, managed by the Play mode panel">
          <MIcon name="skip_next" size={20} />
        </IconButton>
        <IconButton label="Stop (Shift F5, opens Play mode)" size={36} onClick={props.onPlay} title="Stop — managed by the Play mode panel">
          <MIcon name="stop" size={20} />
        </IconButton>
        <span
          className="hidden h-7 items-center whitespace-nowrap rounded-full px-2.5 text-xs xl:inline-flex"
          style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
          title="Current play setup"
        >
          In editor · 1 client · edge + core
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <StatusChip live={false}>Server idle</StatusChip>
        <span
          className="hidden h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs lg:inline-flex"
          style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
          title="Enabled modules (content/modules.json)"
        >
          <MIcon name="extension" size={15} />6 modules
        </span>
        <span className="relative">
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
        </span>
      </div>

      {props.playMenu && (
        <>
          <span className="fixed inset-0 z-40" onClick={props.onClosePlayMenu} aria-hidden="true" />
          <div className="absolute left-1/2 top-[52px] z-50 -translate-x-1/2">
            <PlayMenu onPlay={props.onPlay} onClose={props.onClosePlayMenu} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- layout menu
// Named dock arrangements, persisted in this browser (§3.4). Applying one
// restores workspace, views, tabs, dock sizes and visibility for real;
// popping a panel into its own window waits on the docking engine.

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
            <button onClick={() => staged("Pop panel into a window", "EA · layout")()} className="m3-focus flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="open_in_new" size={16} /> Pop panel into a window
              <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--m3-outline)" }}>staged</span>
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
// Every way to run the game (§3.5, ux-06). Selections stage the coming
// play-menu slice as local UI state; Play hands off to the Play mode
// panel, which owns start/stop today.

function PlayMenu({ onPlay, onClose }: { onPlay: () => void; onClose: () => void }): React.JSX.Element {
  const [where, setWhere] = React.useState("viewport");
  const [from, setFrom] = React.useState("World");
  const [clients, setClients] = React.useState("1");
  const [bots, setBots] = React.useState("10");
  const [net, setNet] = React.useState("Edge + core");
  const [latency, setLatency] = React.useState("0");
  const [fresh, setFresh] = React.useState(true);
  const [keep, setKeep] = React.useState(false);
  const [tint, setTint] = React.useState(true);

  return (
    <menu
      className="m3-scroll max-h-[80vh] w-[30rem] overflow-y-auto rounded-2xl p-4"
      style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      aria-label="Play menu"
    >
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
        Where to play
      </p>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[
          ["viewport", "fullscreen", "In viewport", "Panels stay around it"],
          ["window", "open_in_new", "New window", "The player's client"],
          ["simulate", "visibility", "Simulate", "World only, no player"],
        ].map(([id, icon, title, body]) => {
          const on = where === id;
          return (
            <button
              key={id}
              onClick={() => setWhere(id)}
              aria-pressed={on}
              className="m3-focus flex flex-col gap-1 rounded-xl p-3 text-left"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
            >
              <MIcon name={icon} size={22} />
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{body}</span>
            </button>
          );
        })}
      </div>

      <PlayMenuLabel>Start from</PlayMenuLabel>
      <PlayMenuRow options={["Login", "Character creation", "World", "Camera position"]} value={from} onPick={setFrom} />

      <PlayMenuLabel>Test setup</PlayMenuLabel>
      <div className="mb-1 flex flex-col gap-2">
        <PlayMenuSplit label="Clients" options={["1", "2", "4", "8"]} value={clients} onPick={setClients} />
        <PlayMenuSplit label="Bots near spawn" options={["0", "10", "50", "200"]} value={bots} onPick={setBots} />
        <PlayMenuSplit label="Network" options={["Core only", "Edge + core"]} value={net} onPick={setNet} />
        <PlayMenuSplit label="Simulated latency" options={["0", "80 ms", "200 ms"]} value={latency} onPick={setLatency} />
      </div>

      <div className="mt-2 flex flex-col gap-2.5 text-sm">
        <PlayCheck checked={fresh} onFlip={() => setFresh((v) => !v)} label="Fresh world from the scene (discard saved state)" />
        <PlayCheck checked={keep} onFlip={() => setKeep((v) => !v)} label="Keep play changes on stop" />
        <PlayCheck checked={tint} onFlip={() => setTint((v) => !v)} label="Tint the editor while playing" />
      </div>

      <div className="mt-3 flex flex-col gap-1.5 text-sm" style={{ borderTop: "1px solid var(--m3-outline-variant)", paddingTop: 10 }}>
        <span className="flex items-center gap-2" style={{ color: "var(--m3-on-surface-variant)" }}>
          <MIcon name="history" size={16} /> Last: In viewport · World · 1 client
          <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)" }}>F5</kbd>
        </span>
        <span className="flex items-center gap-2" style={{ color: "var(--m3-on-surface-variant)" }}>
          <MIcon name="bookmark" size={16} /> Saved: “Raid test” · 8 clients · 200 bots
          <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)" }}>Ctrl F5</kbd>
        </span>
      </div>

      <button
        onClick={() => {
          onClose();
          onPlay();
        }}
        className="m3-focus mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold"
        style={{ background: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)" }}
      >
        <MIcon name="play_arrow" size={20} />
        Play — {where === "viewport" ? "in viewport" : where === "window" ? "in a new window" : "simulate"} · {from} · {clients} client{clients === "1" ? "" : "s"}
      </button>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        The Play mode panel owns start/stop today and runs this setup once chosen there.
      </p>
    </menu>
  );
}

function PlayMenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
      {children}
    </p>
  );
}

function PlayMenuRow({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }): React.JSX.Element {
  return (
    <div className="mb-2.5 flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Chip key={o} selected={value === o} onClick={() => onPick(o)}>
          {value === o && o !== "1" && o !== "0" && <MIcon name="check" size={15} />}
          {o}
        </Chip>
      ))}
    </div>
  );
}

function PlayMenuSplit({ label, options, value, onPick }: { label: string; options: string[]; value: string; onPick: (v: string) => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 flex-none text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</span>
      <div
        className="flex h-9 flex-1 items-center overflow-hidden rounded-full text-sm"
        role="group"
        aria-label={label}
        style={{ border: "1px solid var(--m3-outline-variant)" }}
      >
        {options.map((o) => {
          const on = value === o;
          return (
            <button
              key={o}
              onClick={() => onPick(o)}
              aria-pressed={on}
              className="m3-focus flex h-full flex-1 items-center justify-center whitespace-nowrap px-2"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlayCheck({ checked, onFlip, label }: { checked: boolean; onFlip: () => void; label: string }): React.JSX.Element {
  return (
    <button onClick={onFlip} role="checkbox" aria-checked={checked} className="m3-focus flex items-center gap-2.5 text-left">
      <span
        className="grid h-5 w-5 flex-none place-items-center rounded-[4px]"
        style={checked ? { background: "var(--m3-primary)", color: "var(--m3-on-primary)" } : { border: "2px solid var(--m3-outline)" }}
      >
        {checked && <MIcon name="check" size={15} />}
      </span>
      <span style={{ color: "var(--m3-on-surface)" }}>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------- command palette

function CommandPalette({ onClose, onWorkspace, onPlay }: {
  onClose: () => void;
  onWorkspace: (id: WorkspaceId) => void;
  onPlay: () => void;
}): React.JSX.Element {
  const [q, setQ] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => inputRef.current?.focus(), []);

  const commands: Array<{ label: string; hint: string; icon: string; run: () => void }> = [
    ...WORKSPACES.flatMap((w) =>
      w.views.map((v) => ({
        label: `${w.label} → ${v.label}`,
        hint: SOON_WS.has(w.id) ? "module slot" : PREVIEW_WS.has(w.id) ? "preview" : "workspace",
        icon: v.icon,
        run: () => onWorkspace(w.id),
      })),
    ),
    { label: "Play with the last settings", hint: "F5", icon: "play_arrow", run: onPlay },
    { label: "Stop play mode", hint: "Shift F5", icon: "stop", run: onPlay },
  ];
  const hits = commands.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);

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
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits.length > 0) hits[0].run();
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
          {hits.map((h) => (
            <li key={h.label}>
              <button onClick={h.run} className="m3-focus flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5">
                <span style={{ color: "var(--m3-on-surface-variant)" }}>
                  <MIcon name={h.icon} size={18} />
                </span>
                {h.label}
                <span className="ml-auto font-mono text-[11px]" style={{ color: "var(--m3-outline)" }}>{h.hint}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && (
            <li className="px-3 py-6 text-center text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
              No command matches “{q}”. Modules add their own commands here.
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

function crudMenu(label: string, slice: string, onInspect?: () => void): Array<MenuItem | "sep"> {
  return [
    { label: `Inspect ${label}`, icon: "search", run: onInspect ?? (() => notify(`${label} selected in the outliner`)) },
    "sep",
    { label: "Rename…", icon: "edit", stagedFor: slice },
    { label: "Duplicate", icon: "content_copy", stagedFor: slice },
    { label: "Delete", icon: "delete", danger: true, stagedFor: slice },
  ];
}

function LeftTree(props: { workspace: WorkspaceId; view: string; onView: (v: string) => void; views: Workspace["views"]; onGo: (ws: WorkspaceId, view?: string) => void }): React.JSX.Element {
  if (props.workspace === "world") return <WorldTree />;
  if (props.workspace === "database") return <SchemaTree />;
  if (props.workspace === "flow") return <WidgetList />;
  if (props.workspace === "story") return <StoryTree />;
  if (props.workspace === "artaudio") return <ArtAudioTree view={props.view} />;
  if (props.workspace === "release") return <ReleaseTree />;
  if (props.workspace === "liveops") return <LiveOpsTree />;
  if (props.workspace === "gameplay" || props.workspace === "dungeons") {
    return (
      <ul className="flex flex-col gap-0.5">
        {props.views.map((v) => {
          const on = v.id === props.view;
          return (
            <li key={v.id}>
              <button
                onClick={() => props.onView(v.id)}
                aria-current={on ? "page" : undefined}
                className="m3-focus flex h-10 w-full items-center gap-3 rounded-full px-3 text-sm"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name={v.icon} size={20} />
                {v.label}
              </button>
            </li>
          );
        })}
        <li className="mt-2 px-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          Row-level tables (items, creatures, loot…) live inside the Tables panel.
        </li>
      </ul>
    );
  }
  if (props.workspace === "debug") {
    return (
      <ul className="flex flex-col gap-0.5 text-sm">
        {[["Owned server", "dns", true], ["Tick timings", "timer", false], ["Per-system costs", "bar_chart", false]].map(([label, icon, on]) => (
          <li key={label as string}>
            <span
              className="flex h-10 items-center gap-3 rounded-full px-3"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              <MIcon name={icon as string} size={20} />
              {label as string}
            </span>
          </li>
        ))}
        <li className="mt-2 px-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          The Play mode panel owns the server lifecycle; timings arrive with E5.
        </li>
      </ul>
    );
  }
  return (
    <EmptyState
      icon="draft"
      title="Nothing pinned here yet"
      body="Layouts save per workspace (Ctrl Shift S). Panels you open will dock here."
    />
  );
}

function WorldTree(): React.JSX.Element {
  const t = useTree();
  const item = (id: string, icon: string, label: string, trailing?: string, depth = 0, slice = "EA · world (E9)"): React.JSX.Element => (
    <TreeItem
      icon={icon}
      label={label}
      trailing={trailing}
      depth={depth}
      selected={t.sel === id}
      onPick={() => t.pick(id)}
      menu={crudMenu(label, slice)}
    />
  );
  return (
    <div className="flex flex-col gap-0.5">
      <TreeItem icon="public" label="default.world" trailing="4 × 4 km" hasKids expanded={t.open.includes("world")} onToggle={() => t.toggle("world")} selected={t.sel === "world"} onPick={() => t.pick("world")} menu={crudMenu("default.world", "EA · world (E9)")} />
      {t.open.includes("world") && (
        <>
          <TreeItem icon="grid_view" label="Regions" trailing="4" depth={1} hasKids expanded={t.open.includes("regions")} onToggle={() => t.toggle("regions")} selected={t.sel === "regions"} onPick={() => t.pick("regions")} menu={crudMenu("Regions", "EA · world (E9)")} />
          {t.open.includes("regions") && ["Region 0,0", "Region 1,0"].map((r) => (
            <div key={r}>
              <TreeItem icon="terrain" label={r} trailing={r === "Region 0,0" ? "loaded" : undefined} depth={2} hasKids expanded={t.open.includes(r)} onToggle={() => t.toggle(r)} selected={t.sel === r} onPick={() => t.pick(r)} menu={crudMenu(r, "EA · world (E9)")} />
              {t.open.includes(r) && (
                <>
                  {item(`${r}-chunks`, "grid_on", "chunks 8 × 8", "1,024", 3)}
                  {item(`${r}-cache`, "cached", "tile cache", "212 tiles", 3)}
                </>
              )}
            </div>
          ))}
          <TreeItem icon="forest" label="Ecology: wilds" depth={1} hasKids expanded={t.open.includes("eco")} onToggle={() => t.toggle("eco")} selected={t.sel === "eco"} onPick={() => t.pick("eco")} menu={crudMenu("Ecology: wilds", "EA · world (E9)")} />
          {t.open.includes("eco") && ["oak", "birch", "pine"].map((s) => (
            <span key={s}>{item(`eco-${s}`, "park", s, "pcg", 2)}</span>
          ))}
          {item("formations", "grid_on", "Formations", "WFC", 1)}
          {item("coast", "waves", "Coast and sea", undefined, 1)}
          {item("sky", "wb_sunny", "Sky, day and weather", undefined, 1)}
          {item("nav", "account_tree", "Navmesh tiles", "212", 1)}
        </>
      )}
      <p className="px-3 pt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Region editing, bakes and the tile cache arrive with world-scale editing (E9).
      </p>
    </div>
  );
}

/** Live ops scopes (ux-08). Players bind to the admin console selection. */
function LiveOpsTree(): React.JSX.Element {
  const t = useTree();
  const names = PLAYERS.map(([c]) => c);
  return (
    <div className="flex flex-col gap-0.5">
      <TreeItem
        icon="groups" label="Players" trailing="214"
        hasKids expanded={t.open.includes("players")} onToggle={() => t.toggle("players")}
        selected={t.sel === "players"} onPick={() => t.pick("players")}
        menu={crudMenu("Players", "EA · live ops")}
      />
      {t.open.includes("players") && names.map((n) => (
        <TreeItem
          key={n} icon="person" label={n} depth={1}
          selected={false}
          onPick={() => liveOpsStore.set({ player: n })}
          menu={crudMenu(n, "EA · live ops")}
        />
      ))}
      {[
        ["badge", "Accounts", ""],
        ["diversity_3", "Guilds", ""],
        ["group", "Parties", ""],
        ["forum", "Chat & events", ""],
        ["receipt_long", "Item ledger", ""],
        ["monitoring", "Telemetry", ""],
      ].map(([icon, label]) => (
        <TreeItem
          key={label} icon={icon} label={label}
          selected={t.sel === label} onPick={() => t.pick(label)}
          menu={crudMenu(label, "EA · live ops")}
        />
      ))}
    </div>
  );
}

/** Story quests and dialogs (ux-13). Quest steps bind to the graph selection. */
function StoryTree(): React.JSX.Element {
  const t = useTree();
  const steps: Record<string, Array<[string, string]>> = {
    "warden-hale": [["talk", "Talk"], ["clear", "Clear"], ["return", "Return"], ["reward", "Reward"], ["refused", "Refused"]],
    "lost-pelts": [["track", "Track"], ["trap", "Trap"], ["return", "Return"]],
    "tower-key": [["knock", "Knock"], ["riddle", "Riddle"], ["fetch", "Fetch"], ["craft", "Craft"], ["climb", "Climb"], ["unlock", "Unlock"], ["claim", "Claim"]],
  };
  const quests: Array<[string, string, string]> = [
    ["warden-hale", "5 steps", "flag"],
    ["lost-pelts", "3 steps", "flag"],
    ["tower-key", "7 steps", "flag"],
    ["hale.intro", "12 beats", "forum"],
    ["hale.return", "4 beats", "forum"],
    ["smith.shop", "6 beats", "forum"],
    ["camp-errands", "generated", "auto_awesome"],
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {quests.map(([q, trailing, icon]) => {
        const kids = steps[q];
        const open = t.open.includes(q);
        return (
          <div key={q}>
            <TreeItem
              icon={icon}
              label={q}
              trailing={trailing}
              mono
              hasKids={kids !== undefined}
              expanded={open}
              onToggle={kids ? () => t.toggle(q) : undefined}
              selected={t.sel === q}
              onPick={() => t.pick(q)}
              menu={crudMenu(q, "EA · story")}
            />
            {kids && open && kids.map(([id, label]) => (
              <TreeItem
                key={id}
                icon="chevron_right"
                label={label}
                depth={1}
                mono
                selected={false}
                onPick={() => {
                  if (q === "warden-hale") storyStore.set((p) => ({ ...p, node: id }));
                  else notify(`${q} · ${label} — staged for EA · story`);
                }}
                menu={crudMenu(`${q} · ${label}`, "EA · story")}
              />
            ))}
          </div>
        );
      })}
      <p className="px-3 pt-1 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
        content/quests · validated as a set at boot
      </p>
    </div>
  );
}

/** Release profiles and the staging settings (ux-12). */
function ReleaseTree(): React.JSX.Element {
  const t = useTree();
  const profiles: Array<[string, string, string[]]> = [
    ["local-dev", "local", ["npm run editor", "MMO_PORT 7777"]],
    ["staging", "ssh", ["0.14.2 · up 22 h", "MMO_BOTS 40"]],
    ["public-alpha", "ssh", ["0.14.0 · 31 players"]],
    ["perf-check", "local", ["valgrind:perf baseline"]],
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {profiles.map(([p, target, kids]) => {
        const open = t.open.includes(p);
        return (
          <div key={p}>
            <TreeItem
              icon={p === "staging" ? "dns" : p === "public-alpha" ? "public" : p === "perf-check" ? "speed" : "computer"}
              label={p}
              trailing={target}
              mono
              hasKids
              expanded={open}
              onToggle={() => t.toggle(p)}
              selected={t.sel === p}
              onPick={() => t.pick(p)}
              menu={crudMenu(p, "EA · release")}
            />
            {open && kids.map((k) => (
              <TreeItem key={k} icon="chevron_right" label={k} depth={1} mono menu={crudMenu(k, "EA · release")} />
            ))}
          </div>
        );
      })}
      <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
        Staging · settings
      </p>
      <div className="px-3 font-mono text-[11px] leading-[1.9]" style={{ color: "var(--m3-on-surface-variant)" }}>
        {[["MMO_PORT", "7777"], ["MMO_DATA_DIR", "/srv/nexus/data"], ["MMO_WORLD_SEED", "1337"], ["MMO_ALLOW_REGISTER", "0"], ["MMO_BOTS", "40"], ["MMO_MODULES", "core, goblin-ai"]].map(([k, v]) => (
          <p key={k} className="flex"><span>{k}</span><span className="ml-auto" style={{ color: "var(--m3-on-surface)" }}>{v}</span></p>
        ))}
      </div>
    </div>
  );
}
/** Content browser: real content paths, explorable, draggable into the viewport.
 *  Clicking a document navigates to the workspace that owns it today. */
function ContentTree({ onGo }: { onGo: (ws: WorkspaceId, view?: string) => void }): React.JSX.Element {
  const t = useTree();
  const RULES = ["appearance", "body", "combat", "creatures", "death", "disciplines", "ingress", "items", "loot", "needs", "skills", "spells", "stats"];
  const folder = (id: string, label: string, icon: string, kids: React.ReactNode, slice = "EA · content browser"): React.JSX.Element => (
    <div key={id}>
      <TreeItem
        icon={icon} label={label} mono
        hasKids expanded={t.open.includes(id)} onToggle={() => t.toggle(id)}
        selected={t.sel === id} onPick={() => t.pick(id)}
        menu={[
          { label: "New file…", icon: "note_add", stagedFor: slice },
          { label: "New folder…", icon: "create_new_folder", stagedFor: slice },
          "sep",
          { label: "Reveal in file browser", icon: "folder_open", stagedFor: slice },
        ]}
      />
      {t.open.includes(id) && kids}
    </div>
  );
  const file = (path: string, name: string, go?: [WorkspaceId, string?], depth = 1): React.JSX.Element => (
    <TreeItem
      key={path}
      icon="description" label={name} depth={depth} mono
      drag={path}
      selected={t.sel === path} onPick={() => {
        t.pick(path);
        if (go) onGo(go[0], go[1]);
      }}
      menu={[
        { label: `Open ${name}`, icon: "open_in_new", run: go ? () => onGo(go[0], go[1]) : staged(`Open ${name}`, "EA · content browser") },
        "sep",
        { label: "Rename…", icon: "edit", stagedFor: "EA · content browser" },
        { label: "Duplicate", icon: "content_copy", stagedFor: "EA · content browser" },
        { label: "Delete", icon: "delete", danger: true, stagedFor: "EA · content browser" },
      ]}
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
        <p className="px-3 py-1 pl-12 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          No scenes yet — the scenes slice owns this folder (§5).
        </p>
      ))}
      {folder("art", "art pack · scanned", "image", (
        <>
          {["models · 38", "textures · 112", "audio · 24 clips"].map((f) => (
            <TreeItem key={f} icon="chevron_right" label={f} depth={1} mono menu={crudMenu(f, "EA · art & audio")} />
          ))}
        </>
      ))}
      {folder("modules", "modules · 6 enabled", "extension", (
        <>
          {["core", "characters", "creatures", "items", "goblin-ai", "weather-ai"].map((m) => file(`modules/${m}/module.json`, m, undefined))}
        </>
      ))}
      <p className="px-3 pt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Drag a file into the viewport to place it — drop targets stage the scene-viewport slice.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- right dock

function DetailsPane({ workspace, view }: { workspace: WorkspaceId; view: string }): React.JSX.Element {
  if (workspace === "liveops") return <LiveOpsDetails />;
  if (workspace === "database") return <DatabaseRowDetails />;
  if (workspace === "release") return <ReleaseDeployDetails />;
  if (workspace === "flow" && view === "hud") return <HudDetails />;
  if (workspace === "flow" && view === "flow") return <FlowDetails />;
  if (workspace === "story" && view === "quests") return <StoryDetails />;
  if (workspace === "artaudio" && view === "animation") return <AnimDetails />;
  if (workspace === "gameplay") {
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
        <ul className="text-[12.5px]">
          {[["edit", "goblin.health", "55 → 60"], ["error", "ogre.health", "480 → −40"], ["edit", "wolf.pack", "3–5 → 3–6"]].map(([icon, path, change]) => (
            <li key={path} className="flex items-center gap-2 border-b py-1.5" style={{ borderColor: "#2a2b31" }}>
              <MIcon name={icon} size={16} />
              <span className="font-mono text-xs">{path}</span>
              <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{change}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          Live values from the open panel appear here once Details binds to the selection model (§3.1). Edits stay
          validated — a refused save writes nothing.
        </p>
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

function ComparePane(): React.JSX.Element {
  const rows: Array<[string, number, number]> = [
    ["Health", 0.62, 0.78],
    ["Aggro", 0.55, 0.9],
    ["Leash", 0.6, 0.95],
    ["Pack max", 0.35, 0.5],
    ["Respawn", 0.85, 0.6],
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Goblin vs Wolf</p>
      <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>Compare · 2 rows</p>
      {rows.map(([label, a, b]) => (
        <div key={label}>
          <p className="mb-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</p>
          <div className="h-2 rounded" style={{ width: `${a * 100}%`, background: "var(--m3-secondary)" }} />
          <div className="mt-0.5 h-2 rounded" style={{ width: `${b * 100}%`, background: "var(--m3-tertiary)" }} />
        </div>
      ))}
      <p className="mt-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        <span style={{ color: "var(--m3-secondary)" }}>●</span> goblin&nbsp;&nbsp;
        <span style={{ color: "var(--m3-tertiary)" }}>●</span> wolf
      </p>
      <div className="mt-1 flex gap-6">
        {[["142", "kills"], ["31", "player deaths"], ["8.4 s", "avg fight"]].map(([n, l]) => (
          <div key={l}>
            <p className="text-lg font-medium">{n}</p>
            <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{l}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
        Live in play (last 10 min)
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- bottom dock

function BottomPane({ tab }: { tab: string }): React.JSX.Element {
  if (tab === "problems") {
    return (
      <ul className="font-mono text-xs leading-relaxed">
        <li><span style={{ color: "var(--m3-error)" }}>error</span> <span style={{ color: "var(--m3-on-surface-variant)" }}>creatures.json · ogre.health</span> must be ≥ 1</li>
        <li><span style={{ color: "var(--m3-tertiary)" }}>warn</span> <span style={{ color: "var(--m3-on-surface-variant)" }}>creatures.json · wolf.pack</span> widened 3–5 → 3–6, check spawn budget</li>
      </ul>
    );
  }
  if (tab === "bakes") {
    return (
      <ul className="font-mono text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        <li>region 0,0 · 1,024 chunks · 3.2 s</li>
        <li>nav 212 tiles rebuilt from tile cache</li>
      </ul>
    );
  }
  return (
    <ul className="font-mono text-xs leading-relaxed">
      <li><span style={{ color: "var(--m3-success)" }}>[world]</span> <span style={{ color: "var(--m3-on-surface-variant)" }}>region 0,0 baked · 1,024 chunks · 3.2 s</span></li>
      <li><span style={{ color: "var(--m3-primary)" }}>[nav]</span> <span style={{ color: "var(--m3-on-surface-variant)" }}>212 tiles rebuilt from tile cache</span></li>
      <li><span style={{ color: "var(--m3-tertiary)" }}>[ecology]</span> <span style={{ color: "var(--m3-on-surface-variant)" }}>wilds: 18,431 props placed</span></li>
    </ul>
  );
}

// ---------------------------------------------------------------- status bar

function StatusBar(): React.JSX.Element {
  return (
    <footer
      className="flex h-7 flex-none items-center gap-3 px-3 text-[11px]"
      style={{ background: "var(--m3-surface-0)", color: "var(--m3-on-surface-variant)" }}
    >
      <span className="hidden sm:inline">Server stays authoritative — the editor inspects live state, never a running simulation.</span>
      <span className="sm:hidden">Authoritative server · read-only inspect</span>
      <span className="ml-auto font-mono">docs/EDITOR.md</span>
      <span className="font-mono">2 problems</span>
    </footer>
  );
}
