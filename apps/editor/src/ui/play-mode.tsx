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
import { connectMirror } from "./mirror-connect.js";
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

export function PlayModePanel(): React.JSX.Element {
  const [pmState, setPmState] = React.useState<PlayModeState>("idle");
  const [detail, setDetail] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  const [entityId, setEntityId] = React.useState("");
  const [autoRefresh, setAutoRefresh] = React.useState(true);
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
    const serverControl = createHostServerControl();
    controllerRef.current = new PlayModeController(
      serverControl,
      async (server) => {
        // Credentials come from the host: it seeds a one-session dev user
        // for the server it just started (see src/host.ts).
        const c = await connectMirror(
          server.url,
          "mmo-editor-play",
          { username: server.username, password: server.password },
          () => {
            lastStateAt.current = performance.now();
          },
        );
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
        onEnterPlay: () => ({ entityId, autoRefresh }),
        onExitPlay: (saved) => {
          const s = saved as { entityId: string; autoRefresh: boolean } | null;
          if (s) {
            setEntityId(s.entityId);
            setAutoRefresh(s.autoRefresh);
          }
          setOverlays({ waypoints: null, tiles: null });
        },
        onStateChange: (s, d) => {
          setPmState(s);
          setDetail(d);
        },
      },
    );
  }
  const controller = controllerRef.current;

  async function onStart(): Promise<void> {
    setBusy(true);
    setDetail(undefined);
    try {
      await controller.start();
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
              <Button variant="danger" onClick={onStop} disabled={busy || pmState !== "running"}>
                {busy ? "Stopping…" : "⏹ Stop"}
              </Button>
            )}
            {pmState === "starting" && (
              <p className="text-xs text-muted-foreground">Spawning local server…</p>
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
              onChange={(e) => setAutoRefresh(e.target.checked)}
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
                onChange={(e) => setEntityId(e.target.value)}
                placeholder="entity wire id…"
                aria-label="Entity wire id"
                disabled={!running}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEntityId(mirror?.playerEntity?.toString() ?? "")}
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
