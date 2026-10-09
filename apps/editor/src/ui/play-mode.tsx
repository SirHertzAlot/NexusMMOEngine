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
import { createStore } from "./previews.js";
import { loadLastSetup, setupSummary } from "./play-setup.js";
import { clientWindowUrl, planLaunch, startOptions, type LaunchPlan } from "./play-launch.js";
import { getFlow } from "../flow-client.js";
import { sceneCamera } from "./scene-camera.js";
import type { FlowDoc } from "@mmo-engine/scene";
import type { PlayServer } from "../play-mode.js";
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
}

export const playUiStore = createStore<PlayUiState>({ entityId: "", autoRefresh: true, pmState: "idle" });

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

/** Toolbar / shortcut stop: real controller.stop(), valid while running or starting. */
export async function requestPlayStop(): Promise<void> {
  const c = sharedController;
  if (!c) return;
  const s = c.getState();
  if (s === "idle" || s === "stopping") return;
  await c.stop();
}

/** A start asked for before the panel mounted (Play from another workspace); the panel takes it on mount. */
let pendingStart = false;
let sharedStart: (() => Promise<void>) | null = null;
/** The Scenes camera at the moment Play was pressed: the viewport unmounts as the workspace changes. */
let cameraAtPlay: [number, number, number] | null = null;

/**
 * Play / F5 / a saved-setup key: start the owned server with the last setup.
 * Does nothing while a session is starting, running or stopping.
 */
export function requestPlayStart(): void {
  cameraAtPlay = sceneCamera.centre();
  const s = playUiStore.get().pmState;
  if (s !== "idle" && s !== "error") return;
  if (sharedStart) void sharedStart();
  else pendingStart = true;
}

/** One client of the session: its seeded account and whether it plays in the viewport or a client window. */
interface SessionClient {
  index: number;
  username: string;
  password: string;
  where: "viewport" | "window";
  url?: string;
  note?: string;
}

interface PlayStatus {
  running: boolean;
  edgeHealth?: { ok?: boolean; core?: string } | null;
  log?: string[];
  clients?: number;
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
  // The session the last Play started: what each seeded client does, the windows opened for them, the host's status.
  const planRef = React.useRef<LaunchPlan | null>(null);
  const windowsRef = React.useRef<Window[]>([]);
  const [session, setSession] = React.useState<{ setup: string; clients: SessionClient[]; edge: boolean; latencyMs: number } | null>(null);
  const [status, setStatus] = React.useState<PlayStatus | null>(null);

  const controllerRef = React.useRef<PlayModeController | null>(null);
  if (!controllerRef.current) {
    const serverControl = createHostServerControl("", playableScene);
    controllerRef.current = new PlayModeController(
      serverControl,
      async (server) => {
        // Credentials come from the host: it seeds a one-session dev user
        // for the server it just started (see src/host.ts).
        const plan = planRef.current;
        // Simulate (and a start at a client-only node) joins nobody in the viewport: the world just runs.
        if (plan && plan.viewportAccount === null) {
          return {
            debug: () => Promise.reject(new Error("nobody is playing in the viewport")),
            disconnect: () => undefined,
          };
        }
        const account = server.accounts?.[plan?.viewportAccount ?? 0] ?? server;
        const c = await connectMirror(
          server.url,
          "mmo-editor-play",
          { username: account.username, password: account.password },
          () => {
            lastStateAt.current = performance.now();
          },
        );
        // "Camera position": the avatar starts where the Scenes camera looks.
        const cam = cameraAtPlay;
        if (plan?.teleportToCamera && cam) {
          const r = await c.admin("teleport", { x: cam[0], z: cam[2] }).catch((e: unknown) => ({ ok: false, message: String(e) }));
          if (!r.ok) setDetail(`camera start: ${r.message}`);
        }
        setMirror(c);
        return {
          debug: (q) => c.debug(q as DebugQuery),
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
          playUiStore.set((p) => ({ ...p, pmState: s }));
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

  /** Open the player's client for one session client; false when the browser blocked the window. */
  function openClientWindow(c: SessionClient): boolean {
    if (!c.url) return false;
    const w = window.open(c.url, `mmo-play-${c.index}`, "popup,width=1100,height=720");
    if (!w) return false;
    windowsRef.current.push(w);
    return true;
  }

  /** Window clients: start the player's client dev server if needed and build one address per seeded account. */
  async function prepareWindows(plan: LaunchPlan, server: PlayServer, doc: FlowDoc | null): Promise<SessionClient[]> {
    const accounts = server.accounts ?? [{ username: server.username, password: server.password }];
    const clients: SessionClient[] = accounts.map((a, index) => ({
      index,
      username: a.username,
      password: a.password,
      where: index === plan.viewportAccount ? "viewport" : "window",
    }));
    const windows = clients.filter((c) => c.where === "window");
    if (windows.length === 0) return clients;
    try {
      const res = await fetch("/api/editor/play/client", { method: "POST" });
      const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!res.ok || !body.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      for (const c of windows) {
        if (!doc) {
          c.note = "the game flow could not be read";
          continue;
        }
        const r = clientWindowUrl(doc, plan.node, body.url, { url: server.url, user: c.username, pass: c.password });
        if ("error" in r) c.note = r.error;
        else c.url = r.url;
      }
    } catch (e) {
      for (const c of windows) c.note = `the player's client did not start: ${e instanceof Error ? e.message : String(e)}`;
    }
    return clients;
  }

  async function onStart(): Promise<void> {
    setBusy(true);
    setDetail(undefined);
    try {
      const setup = loadLastSetup();
      const doc: FlowDoc | null = await getFlow().then((b) => b.content, () => null);
      const plan = planLaunch(setup, doc);
      planRef.current = plan;
      setSession(null);
      await controller.start(startOptions(setup));
      const server = controller.serverInfo;
      if (server) {
        const clients = await prepareWindows(plan, server, doc);
        setSession({ setup: setupSummary(setup), clients, edge: server.edge === true, latencyMs: server.latencyMs ?? 0 });
        // Pop-up blockers may refuse windows opened this long after the click: the buttons below open them.
        for (const c of clients) if (c.where === "window") openClientWindow(c);
      }
    } catch (err) {
      // detail already carries the message via onStateChange(error)
      void err;
    } finally {
      setBusy(false);
    }
  }

  async function onStop(): Promise<void> {
    setBusy(true);
    try {
      await controller.stop();
    } finally {
      setBusy(false);
    }
  }

  // Play / F5 / a setup key asked for a start (see requestPlayStart).
  const startRef = React.useRef(onStart);
  startRef.current = onStart;
  React.useEffect(() => {
    sharedStart = () => startRef.current();
    if (pendingStart) {
      pendingStart = false;
      void sharedStart();
    }
    return () => {
      sharedStart = null;
    };
  }, []);

  // A stopped session closes the windows it opened and forgets its clients.
  React.useEffect(() => {
    if (pmState !== "idle" && pmState !== "error") return;
    for (const w of windowsRef.current) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    windowsRef.current = [];
    setSession(null);
    setStatus(null);
  }, [pmState]);

  // The host's view of the session (edge health, server log), refreshed while it runs.
  React.useEffect(() => {
    if (pmState !== "running") return;
    let alive = true;
    const poll = (): void => {
      fetch("/api/editor/play/status")
        .then((r) => r.json() as Promise<PlayStatus>)
        .then((st) => alive && setStatus(st), () => undefined);
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pmState]);

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

          {running && session && <SessionCard session={session} status={status} onOpen={openClientWindow} viewportLive={mirror !== null} />}

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

/** The running session: its setup, every seeded client (viewport or window), edge health and the server's log. */
function SessionCard({ session, status, onOpen, viewportLive }: {
  session: { setup: string; clients: SessionClient[]; edge: boolean; latencyMs: number };
  status: PlayStatus | null;
  onOpen: (c: SessionClient) => boolean;
  viewportLive: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-3 text-xs" data-testid="play-session">
      <SectionTitle>Session · {session.setup}</SectionTitle>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone="info">{session.clients.length} seeded account{session.clients.length === 1 ? "" : "s"}</Badge>
        {session.edge && (
          <Badge tone={status?.edgeHealth?.core === "up" ? "ok" : "warn"}>edge · core {status?.edgeHealth?.core ?? "unknown"}</Badge>
        )}
        {session.latencyMs > 0 && <Badge tone="info">{session.latencyMs} ms round trip</Badge>}
        {session.clients.every((c) => c.where === "window") && session.clients.length > 0 && !viewportLive && (
          <Badge tone="default">nobody in the viewport</Badge>
        )}
      </div>
      <ul className="mt-2 space-y-1 font-mono">
        {session.clients.map((c) => (
          <li key={c.index} className="flex items-center gap-2">
            <span>{c.username}</span>
            <span className="text-muted-foreground">{c.where === "viewport" ? "in the viewport" : "player's client"}</span>
            {c.where === "window" && c.url && (
              <Button variant="outline" size="sm" onClick={() => onOpen(c)}>
                Open window
              </Button>
            )}
            {c.note && <span className="text-red-400">{c.note}</span>}
            <span className="ml-auto text-muted-foreground">password {c.password}</span>
          </li>
        ))}
      </ul>
      {status?.log && status.log.length > 0 && (
        <pre className="mt-2 max-h-28 overflow-auto rounded bg-black/30 p-2 text-[11px] leading-snug">{status.log.join("\n")}</pre>
      )}
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
