/**
 * Play Mode inspector — local-server play mode with debug overlays.
 *
 * One click starts an authoritative server owned by the editor dev host
 * (POST /api/editor/server/start), connects a mirror client, and offers
 * read-only debug overlays: active path waypoints per entity and loaded
 * navmesh tile bounds (protocol 0x0a). Stop disconnects the client and
 * kills ONLY the server process the editor started, then restores the
 * pre-play UI state via the controller hooks.
 *
 * While it runs, the game view (ROADMAP E4, game-view.tsx) shows the
 * world through the client's own renderer, driven by the same mirror
 * client the overlays query, with the renderer's numbers beside it, and
 * the debugger's panels over it (ROADMAP E5, play-debugger.tsx).
 */

import * as React from "react";
import type { DebugResponse, DebugQuery } from "@mmo-engine/protocol";
import { PlayModeController, type PlayModeState } from "../play-mode.js";
import { createHostServerControl } from "../server-control.js";
import { playableScene } from "../open-scene.js";
import { connectMirror } from "./mirror-connect.js";
import { createStore } from "../store.js";
import { botsCount, clientCount, loadLastSetup, shouldConnectPlayer, simulateLabel } from "./play-setup.js";
import { resolveSpawnTarget } from "../flow-spawn.js";
import { getSceneCameraPos } from "./camera-position.js";
import { armPlayPopup, openPlayPopupShell, takePendingPopup } from "./play-popup.js";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { HudData } from "@mmo-engine/client/render";

// The game view and its debugger (three.js, R3F, the client's scene) load only when play mode first runs.
const PlayDebugger = React.lazy(() => import("./play-debugger.js").then((m) => ({ default: m.PlayDebugger })));
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SectionTitle,
} from "./components.js";

const stateTones: Record<PlayModeState, "default" | "ok" | "warn" | "bad" | "info"> = {
  idle: "default",
  starting: "info",
  running: "ok",
  stopping: "warn",
  error: "bad",
};

interface OverlaySnapshot {
  waypoints: DebugResponse | null;
  tiles: DebugResponse | null;
}

/** Shared play-mode UI state: the debug dock drives the same entity-id
 *  and auto-refresh the overlays query, and mirrors the lifecycle state. */
export interface PlayUiState {
  entityId: string;
  autoRefresh: boolean;
  pmState: PlayModeState;
  paused: boolean;
}

export const playUiStore = createStore<PlayUiState>({ entityId: "", autoRefresh: true, pmState: "idle", paused: false });

export function setPlayEntityId(entityId: string): void {
  playUiStore.set((p) => ({ ...p, entityId }));
}

export function setPlayAutoRefresh(autoRefresh: boolean): void {
  playUiStore.set((p) => ({ ...p, autoRefresh }));
}

/**
 * The live controller, shared with the toolbar: its Pause/Step/Stop
 * buttons act on this instead of just navigating to the panel. Set by
 * the PlayModePanel while mounted; null when the panel is unmounted.
 */
let sharedController: PlayModeController | null = null;

export function getPlayController(): PlayModeController | null {
  return sharedController;
}

/** Toolbar Pause/Resume and Step: an admin command to the owned server; Pause toggles. */
export async function requestPlayTick(command: "pause" | "resume" | "step"): Promise<void> {
  const r = await sharedController?.admin(command);
  if (r?.ok && command !== "step") playUiStore.set((p) => ({ ...p, paused: command === "pause" }));
}

/** Toolbar / shortcut stop: real controller.stop(), valid while running or starting. */
export async function requestPlayStop(): Promise<void> {
  const c = sharedController;
  if (!c) return;
  const s = c.getState();
  if (s === "idle" || s === "stopping") return;
  await c.stop();
}

// Toolbar Play / F5 / Play menu: start with the last setup. The panel owns the
// controller and may not be mounted yet, so a request waits for it.
let startHandler: (() => void) | null = null;
let startPending = false;

export function requestPlayStart(): void {
  if (startHandler) startHandler();
  else startPending = true;
}

/** For tests: whether a start request is waiting for the panel to mount. */
export function isPlayStartPending(): boolean {
  return startPending;
}

export function PlayModePanel(): React.JSX.Element {
  const [detail, setDetail] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  const { entityId, autoRefresh, pmState } = playUiStore.use();
  const [overlays, setOverlays] = React.useState<OverlaySnapshot>({
    waypoints: null,
    tiles: null,
  });
  const [overlayError, setOverlayError] = React.useState<string | null>(null);
  // The game view's mirror client (the same one the overlays query) and its last state time.
  const [mirror, setMirror] = React.useState<MirrorClient | null>(null);
  const lastStateAt = React.useRef(0);
  const [hud, setHud] = React.useState<HudData | null>(null);

  const controllerRef = React.useRef<PlayModeController | null>(null);
  if (!controllerRef.current) {
    const serverControl = createHostServerControl("", playableScene);
    controllerRef.current = new PlayModeController(
      serverControl,
      async (server, index) => {
        if (index > 0) {
          // Extra load client: its own seeded login (one account per client;
          // a second session of the play login would evict the game view's),
          // headless, so it never drives the game view.
          const username = server.loadUsers?.[index - 1];
          if (!username) throw new Error(`no login for extra client ${index}`);
          // Same simulated latency as the game view's client.
          const c = await connectMirror(
            server.url,
            `mmo-editor-load-${index}`,
            { username, password: server.password },
            () => undefined,
            { latency: loadLastSetup().latency },
          );
          return { debug: (q) => c.debug(q as DebugQuery), disconnect: () => c.disconnect() };
        }
        // Credentials come from the host: it seeds a one-session dev user
        // for the server it just started (see src/host.ts).
        const c = await connectMirror(
          server.url,
          "mmo-editor-play",
          { username: server.username, password: server.password },
          () => {
            lastStateAt.current = performance.now();
          },
          // The Play menu's simulated-latency option, honored here.
          { latency: loadLastSetup().latency },
        );
        setMirror(c);
        return {
          debug: (q) => c.debug(q as DebugQuery),
          admin: (command) => c.admin(command),
          disconnect: () => {
            setMirror(null);
            setHud(null);
            c.disconnect();
          },
        };
      },
      {
        // Snapshot the overlay inputs; they come back verbatim on exit.
        onEnterPlay: () => ({ entityId: playUiStore.get().entityId, autoRefresh: playUiStore.get().autoRefresh }),
        onExitPlay: (saved) => {
          const s = saved as { entityId: string; autoRefresh: boolean } | null;
          if (s) {
            setPlayEntityId(s.entityId);
            setPlayAutoRefresh(s.autoRefresh);
          }
          setOverlays({ waypoints: null, tiles: null });
        },
        onStateChange: (s, d) => {
          playUiStore.set((p) => ({ ...p, pmState: s, paused: s === "running" ? p.paused : false }));
          setDetail(d);
        },
      },
    );
  }
  const controller = controllerRef.current;
  React.useEffect(() => {
    sharedController = controller;
    return () => {
      if (sharedController === controller) sharedController = null;
    };
  }, [controller]);

  async function onStart(): Promise<void> {
    setBusy(true);
    setDetail(undefined);
    try {
      // The Play menu's honored start options: bots → MMO_BOTS, simulate
      // mode (world only, no player), client count (1/2/4/8),
      // fresh/keep (world snapshot/restore), and "Start from" (spawn target).
      const setup = loadLastSetup();
      const spawnTarget = resolveSpawnTarget(setup.from, getSceneCameraPos());
      // "New window": open the popup in this click gesture (or the blocker
      // eats it). The game view attaches when it mounts; a failed start
      // closes the orphan popup.
      const wantPopup = setup.where === "window" && shouldConnectPlayer(setup);
      const popup = wantPopup ? openPlayPopupShell("Play") : null;
      if (wantPopup && !popup) {
        setDetail("Popup blocked — the game view stays in the viewport. Allow popups and try again.");
      }
      armPlayPopup(popup);
      await controller.start({
        bots: botsCount(setup),
        noClient: !shouldConnectPlayer(setup),
        clients: clientCount(setup),
        fresh: setup.fresh,
        keep: setup.keep,
        ...(spawnTarget.kind === "at" ? { spawn: { x: spawnTarget.x, z: spawnTarget.z } } : {}),
      });
      if (spawnTarget.kind === "preview") {
        // Honest: the menu badges it, but surface the reason here too.
        setDetail(`Start from "${setup.from}" is preview: ${spawnTarget.reason}`);
      } else if (spawnTarget.kind === "default" && "note" in spawnTarget) {
        setDetail(spawnTarget.note);
      }
    } catch (err) {
      // detail already carries the message via onStateChange(error).
      // A failed start must not leave an orphan popup behind.
      const orphan = takePendingPopup();
      if (orphan) {
        try {
          orphan.close();
        } catch {
          /* ignore */
        }
      }
      void err;
    } finally {
      setBusy(false);
    }
  }

  // Starts only from a stopped state: a click while running or starting does nothing.
  const startRef = React.useRef<() => void>(() => undefined);
  startRef.current = () => {
    const st = controller.getState();
    if (st === "idle" || st === "error") void onStart();
  };
  React.useEffect(() => {
    const handler = (): void => startRef.current();
    startHandler = handler;
    if (startPending) {
      startPending = false;
      handler();
    }
    return () => {
      if (startHandler === handler) startHandler = null;
    };
  }, []);

  async function onStop(): Promise<void> {
    setBusy(true);
    try {
      await controller.stop();
    } finally {
      setBusy(false);
    }
  }

  const fetchOverlays = React.useCallback(async () => {
    if (controller.getState() !== "running") return;
    setOverlayError(null);
    try {
      const [waypoints, tiles] = await Promise.all([
        entityId
          ? controller.debugWaypoints(entityId).catch(() => null)
          : Promise.resolve(null),
        controller.debugTiles().catch(() => null),
      ]);
      setOverlays({ waypoints, tiles });
    } catch (err) {
      setOverlayError(err instanceof Error ? err.message : String(err));
    }
  }, [controller, entityId]);

  React.useEffect(() => {
    if (pmState !== "running" || !autoRefresh) return;
    void fetchOverlays();
    const t = setInterval(() => void fetchOverlays(), 2000);
    return () => clearInterval(t);
  }, [pmState, autoRefresh, fetchOverlays]);

  const running = pmState === "running";
  const server = controller.serverInfo;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Play Mode</CardTitle>
            <Badge tone={stateTones[pmState]}>{pmState}</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            {!running && pmState !== "starting" && pmState !== "stopping" && (
              <Button onClick={onStart} disabled={busy}>
                {busy ? "Starting…" : pmState === "error" ? "Retry play mode" : "▶ Start play mode"}
              </Button>
            )}
            {(running || pmState === "starting") && (
              <Button variant="danger" onClick={onStop} disabled={busy}>
                {busy ? "Stopping…" : "⏹ Stop"}
              </Button>
            )}
            {pmState === "starting" && (
              <p className="text-xs text-muted-foreground">Spawning local server… Stop stays available while it starts.</p>
            )}
            {pmState === "stopping" && (
              <p className="text-xs text-muted-foreground">
                Disconnecting and stopping the owned server…
              </p>
            )}
          </div>

          {running && detail && (
            <p className="rounded-md border border-border p-3 text-xs text-muted-foreground" role="status">{detail}</p>
          )}

          {running && !mirror && server && (
            <p className="rounded-md border border-border p-3 text-xs text-muted-foreground" role="status">
              {simulateLabel(loadLastSetup())}. The world ticks on the owned server with no player connected, so
              there is no game view, and the overlays and tick timings (which ask through the player&apos;s
              client) stay empty until you play with a client.
            </p>
          )}

          {running && mirror && server && (
            <div className="flex flex-col gap-2">
              <React.Suspense fallback={<p className="text-xs text-muted-foreground">Loading the game view…</p>}>
                <PlayDebugger
                  client={mirror}
                  url={server.url}
                  lastStateAt={() => lastStateAt.current}
                  onHud={setHud}
                />
              </React.Suspense>
              <GameViewStats hud={hud} />
            </div>
          )}

          {pmState === "error" && detail && (
            <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
              <span className="font-semibold">Play mode failed: </span>
              {detail}
              <p className="mt-1 text-red-200/70">
                The owned server was stopped and your pre-play editor state was
                restored.
              </p>
            </div>
          )}

          {server && (
            <div className="rounded-md border border-border p-3 text-xs">
              <SectionTitle>Owned server</SectionTitle>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono">
                <div>
                  <Label>pid</Label>
                  <p>{server.pid}</p>
                </div>
                <div>
                  <Label>url</Label>
                  <p className="break-all">{server.url}</p>
                </div>
                <div>
                  <Label>ownership</Label>
                  <p>editor-spawned only</p>
                </div>
              </div>
              <p className="mt-2 text-muted-foreground">
                Stop kills only this process (tracked handle — never a port
                scan). The ECS inspector can connect to it while it runs.
              </p>
            </div>
          )}

          {!running && pmState !== "error" && (
            <p className="text-xs text-muted-foreground">
              Play mode spawns <span className="font-mono">npm run server</span>{" "}
              as a child of the editor dev host, then connects a mirror client
              — the same authoritative simulation the game client sees, with
              editor-only debug overlays below.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Debug overlays</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs">
            <input
              id="pm-autorefresh"
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setPlayAutoRefresh(e.target.checked)}
              disabled={!running}
            />
            <Label htmlFor="pm-autorefresh">Auto-refresh (2 s)</Label>
            <Button variant="outline" size="sm" onClick={() => void fetchOverlays()} disabled={!running}>
              Refresh now
            </Button>
          </div>

          <div>
            <SectionTitle>Path waypoints</SectionTitle>
            <div className="mt-2 flex gap-2">
              <Input
                value={entityId}
                onChange={(e) => setPlayEntityId(e.target.value)}
                placeholder="entity wire id…"
                aria-label="Entity wire id"
                disabled={!running}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPlayEntityId(mirror?.playerEntity?.toString() ?? "")}
                disabled={!running || mirror?.playerEntity == null}
              >
                My avatar
              </Button>
            </div>
            <OverlayWaypoints response={overlays.waypoints} enabled={running} />
          </div>

          <div>
            <SectionTitle>Navmesh tiles</SectionTitle>
            <OverlayTiles response={overlays.tiles} enabled={running} />
          </div>

          {overlayError && (
            <p className="text-xs text-red-400">{overlayError}</p>
          )}
          {!running && (
            <p className="text-xs text-muted-foreground">
              Overlays are live only while play mode is running (read-only 0x0a
              queries).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The renderer's once-a-second numbers under the game view. */
function GameViewStats({ hud }: { hud: HudData | null }): React.JSX.Element {
  if (!hud) return <p className="text-xs text-muted-foreground">Waiting for the first frame… click the view to steer the avatar (Esc releases the mouse).</p>;
  const cells: Array<[string, string]> = [
    ["fps", String(hud.fps)],
    ["tick", String(hud.tick)],
    ["entities", String(hud.entities)],
    ["position", `${hud.px.toFixed(1)}, ${hud.py.toFixed(1)}, ${hud.pz.toFixed(1)}`],
    ["time", hud.time ?? "fixed"],
    ["weather", hud.weather ?? "clear"],
  ];
  return (
    <div className="grid grid-cols-3 gap-2 font-mono text-xs sm:grid-cols-6" data-testid="game-view-stats">
      {cells.map(([k, v]) => (
        <div key={k}>
          <Label>{k}</Label>
          <p>{v}</p>
        </div>
      ))}
    </div>
  );
}

function OverlayWaypoints({
  response,
  enabled,
}: {
  response: DebugResponse | null;
  enabled: boolean;
}): React.JSX.Element {
  if (!enabled) return <Placeholder text="start play mode" />;
  if (!response) return <Placeholder text="no data yet" />;
  if (response.query !== "waypoints") return <Placeholder text="unexpected response" />;
  return (
    <div className="mt-1 text-xs">
      <p>
        entity <span className="font-mono">{response.entity}</span> · status{" "}
        <Badge tone={response.status === "active" ? "ok" : "default"}>
          {response.status}
        </Badge>
      </p>
      {response.waypoints.length > 0 ? (
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono">
          {response.waypoints.map((w, i) => (
            <li key={i}>
              [{i}] ({w[0].toFixed(2)}, {w[1].toFixed(2)}, {w[2].toFixed(2)})
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted-foreground">
          No active path — click-to-move or pathfind intents create one.
        </p>
      )}
    </div>
  );
}

function OverlayTiles({
  response,
  enabled,
}: {
  response: DebugResponse | null;
  enabled: boolean;
}): React.JSX.Element {
  if (!enabled) return <Placeholder text="start play mode" />;
  if (!response) return <Placeholder text="no data yet" />;
  if (response.query !== "tiles") return <Placeholder text="unexpected response" />;
  return (
    <div className="mt-1 text-xs">
      <p>{response.tiles.length} tile(s) loaded</p>
      {response.tiles.length > 0 && (
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono">
          {response.tiles.map((t, i) => (
            <li key={i}>
              [{i}] x[{t[0]}, {t[2]}] z[{t[1]}, {t[3]}]
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Placeholder({ text }: { text: string }): React.JSX.Element {
  return <p className="mt-1 text-xs italic text-muted-foreground">— {text} —</p>;
}
