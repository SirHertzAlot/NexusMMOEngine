/**
 * Mirror client app shell (Phase 3).
 *
 * Login screen → character screen → world screen. After login the player
 * chooses (or creates) a character, then enters the world as it
 * (docs/MESSAGE-CATALOG.md §0x0c–0x0e). The world screen is WorldCanvas
 * (a React Three Fiber scene whose frame loop samples the Interpolator,
 * syncs the world, and forwards changed input as PlayerIntent events)
 * under the player's interface (for now, the settings menu). With
 * `npm run dev` (dev-tools.ts) it shows the developer panels instead
 * (ui/dev-panels.tsx): status, performance graphs (ui/perf-hud.tsx),
 * tools and controls, each movable, resizable, fadeable, and ` hides
 * them all. They move to the editor's play mode later (docs/ROADMAP.md).
 *
 * The session token lives in a ref (memory only) — reconnect presents
 * it via the token hello variant (docs/MESSAGE-CATALOG.md).
 *
 * No client prediction: the mirror renders strictly behind the server
 * by one tick interval (see mirror/interpolate.ts).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { AccountMessage, WelcomeMessage } from "@mmo-engine/protocol";
import { MirrorClient, type JoinReply } from "@mmo-engine/mirror";
import { BrowserSocket } from "@mmo-engine/mirror";
import { WorldCanvas, type HudData } from "./render/world-canvas.js";
import type { GpuInfo } from "./render/gpu.js";
import { QUALITY_TIERS, type QualityTier } from "./render/quality.js";
import { PlaceholderAssets } from "./render/assets.js";
import { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
import { CharacterScreen } from "./ui/character-screen.js";
import { AdminConsole } from "./ui/admin-console.js";
import { PerfHud } from "./ui/perf-hud.js";
import { DevHud, type Viewport } from "./ui/dev-panels.js";
import { SettingsMenu } from "./ui/settings-menu.js";
import { DEV_TOOLS } from "./dev-tools.js";
import type { DevLayout } from "./ui/dev-layout.js";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "./ui/components.js";

type Screen = "login" | "connecting" | "characters" | "world";
type AuthMode = "login" | "register";

const MODE_LABEL = ["walking", "swimming", "flying"];
const QUALITY_CYCLE: ("auto" | QualityTier)[] = ["auto", ...QUALITY_TIERS];

/** Where the dev panels start (and return to on "reset layout"): status and performance top left, tools top right. */
function devLayoutDefaults(vp: Viewport): DevLayout {
  const panel = (x: number, y: number, w: number, open = true) => ({ x, y, w, h: null, opacity: 0.9, open, collapsed: false });
  return {
    hidden: false,
    panels: {
      status: panel(16, 16, 320),
      perf: panel(16, 104, 320),
      tools: panel(vp.width - 16 - 300, 16, 300),
      controls: panel(16, vp.height - 140, 380, false),
    },
  };
}

const DEFAULT_URL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "wss://localhost:7777"
    : "ws://localhost:7777";

export function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("login");
  const [mode, setMode] = useState<AuthMode>("login");
  const [url, setUrl] = useState(DEFAULT_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<HudData>({
    tick: 0, entities: 0, fps: 0, px: 0, py: 0, pz: 0, mode: null, breath: 1, time: null, weather: null, perf: [],
  });
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [showcase, setShowcase] = useState(false);
  // Graphics quality: "auto" follows the GPU and the frame rate; a preset pins it.
  const [quality, setQuality] = useState<"auto" | QualityTier>("auto");
  const [activeQuality, setActiveQuality] = useState<{ active: QualityTier; detected: QualityTier | null } | null>(null);
  const [account, setAccount] = useState<AccountMessage | null>(null);
  const [characterName, setCharacterName] = useState<string | null>(null);

  const clientRef = useRef<MirrorClient | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const lastStateAtRef = useRef(0);
  const [assets] = useState(() => new PlaceholderAssets());

  /** Shared MirrorClient construction with the standard callbacks. */
  const createClient = (): MirrorClient =>
    new MirrorClient((u) => new BrowserSocket(u), {
      onWelcome: (_w: WelcomeMessage) => {
        sessionTokenRef.current = _w.session_token;
        setCharacterName(_w.character?.name ?? null);
      },
      onState: (tick: number) => {
        lastStateAtRef.current = performance.now();
        void tick;
      },
      onError: (e) => setError(`server error ${e.code}: ${e.message}`),
      onClose: () => {
        // The server sends an error frame before closing on every
        // rejection; keep that reason instead of masking it.
        setError((prev) => prev ?? "connection closed");
        setScreen("login");
      },
    });

  /**
   * Run one handshake (login, register, or token reconnect) against a
   * fresh client. The server answers with the account's characters (the
   * character screen) — or, for a token that already entered as a
   * character, the welcome straight into the world.
   */
  const runHandshake = async (
    handshake: (client: MirrorClient) => Promise<JoinReply>,
  ): Promise<void> => {
    setScreen("connecting");
    setError(null);
    const client = createClient();
    clientRef.current = client;
    try {
      const reply = await handshake(client);
      if (reply.kind === "account") {
        sessionTokenRef.current = reply.account.session_token;
        setAccount(reply.account);
        setScreen("characters");
      } else {
        setScreen("world");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen("login");
      clientRef.current = null;
    }
  };

  /**
   * Launch the mirror: log in with an existing account, or create the
   * account first (protocol 0x0b `register`) and join with it.
   */
  const launch = (): Promise<void> =>
    runHandshake((client) =>
      client.join(
        url,
        username || "mirror",
        mode === "register" ? { register: { username, password } } : { username, password },
      ),
    );

  /** Enter the world as a character (the character screen). */
  const enterWorld = async (id: number): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    await client.enterWorld(id);
    setScreen("world");
  };

  /** Reconnect with the stored session token (skips the password). */
  const reconnectWithToken = (): Promise<void> => {
    const token = sessionTokenRef.current;
    if (!token) return Promise.resolve();
    disconnect();
    return runHandshake((client) =>
      client.join(url, username || "mirror", { token }),
    );
  };

  const usernameOk = /^[A-Za-z0-9_-]{3,32}$/.test(username);
  const passwordOk = password.length >= 8;
  const canSubmit =
    screen !== "connecting" &&
    usernameOk &&
    passwordOk &&
    (mode === "login" || password === confirmPassword);

  const disconnect = (): void => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setAccount(null);
    setScreen("login");
  };

  // ---- world -------------------------------------------------------------
  const client = screen === "world" ? clientRef.current : null;
  // PCG assets (trees, …) come from the region's Pcg webrpc service on the game port.
  const pcg = useMemo(
    () => (client ? new PcgRpcClient(httpBaseForGameUrl(url), () => client.sessionToken) : undefined),
    // One service per joined client (the URL it joined with).
    [client],
  );
  const onGpu = (info: GpuInfo): void => {
    setGpu(info);
    if (info.software) {
      console.warn(
        `[client] software WebGL (${info.renderer}): enable hardware acceleration ` +
          `in browser settings (chrome://gpu shows why it is off).`,
      );
    }
  };

  const toggleWireframe = (): void => setWireframe((w) => !w);
  const toggleShowcase = (): void => setShowcase((v) => !v);
  const cycleQuality = (): void => setQuality((q) => QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(q) + 1) % QUALITY_CYCLE.length]);
  const onQuality = useCallback((active: QualityTier, detected: QualityTier | null) => setActiveQuality({ active, detected }), []);

  if (screen === "characters" && account) {
    return (
      <CharacterScreen
        characters={account.characters}
        maxCharacters={account.max_characters}
        onCreate={async (name, look) => {
          const client = clientRef.current;
          if (!client) throw new Error("not connected");
          const updated = await client.createCharacter(name, look);
          setAccount(updated);
          if (updated.created !== undefined) await enterWorld(updated.created);
        }}
        onEnter={enterWorld}
        onLeave={disconnect}
      />
    );
  }

  if (client) {
    return (
      <div className="relative h-full w-full">
        <WorldCanvas
          client={client}
          assets={assets}
          pcg={pcg}
          lastStateAt={() => lastStateAtRef.current}
          wireframe={wireframe}
          showcase={showcase}
          quality={quality}
          onQuality={onQuality}
          onGpu={onGpu}
          onHud={setHud}
        />
        {DEV_TOOLS ? (
          <DevHud
            defaults={devLayoutDefaults}
            panels={[
              {
                id: "status",
                title: characterName ?? "mirror client",
                label: "status",
                badge: gpu?.software && (
                  <span
                    className="shrink-0 rounded border border-amber-400/60 px-1 text-[10px] text-amber-300"
                    title="Software rendering: hardware acceleration is off, so fps will stay in single digits. Enable it in browser settings (see chrome://gpu)."
                  >
                    ⚠ software GPU
                  </span>
                ),
                content: (
                  <div className="text-muted-foreground tabular-nums">
                    tick <span className="text-foreground">{hud.tick}</span>
                    {hud.time && <> · <span className="text-foreground">{hud.time}</span></>}
                    {hud.weather && <> · <span className="text-foreground">{hud.weather}</span></>}
                    {" "}· <span className="text-foreground">{hud.fps}</span> fps · pos{" "}
                    <span className="text-foreground">
                      {hud.px.toFixed(0)}, {hud.py.toFixed(0)}, {hud.pz.toFixed(0)}
                    </span>
                    {hud.mode !== null && hud.mode !== 0 && <> · {MODE_LABEL[hud.mode] ?? hud.mode}</>}
                    {hud.breath < 1 && <> · air {Math.round(hud.breath * 100)}%</>}
                    {gpu && (
                      <div className="truncate" title={gpu.renderer}>
                        gpu <span className="text-foreground">{gpu.renderer}</span>
                      </div>
                    )}
                  </div>
                ),
              },
              { id: "perf", title: "performance", content: <PerfHud samples={hud.perf} /> },
              {
                id: "tools",
                title: "tools",
                content: (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={toggleWireframe}>
                      {wireframe ? "solid terrain" : "wireframe terrain"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={cycleQuality}
                      title={activeQuality?.detected ? `this GPU's preset: ${activeQuality.detected}` : "detecting the GPU…"}
                    >
                      quality: {quality === "auto" ? `auto (${activeQuality?.active ?? "…"})` : quality}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={toggleShowcase}>
                      {showcase ? "hide FX" : "FX showcase"}
                    </Button>
                    {sessionTokenRef.current && (
                      <Button size="sm" variant="secondary" onClick={() => void reconnectWithToken()}>
                        reconnect (token)
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={disconnect}>
                      disconnect
                    </Button>
                    </div>
                    <AdminConsole client={client} />
                  </>
                ),
              },
              {
                id: "controls",
                title: "controls",
                content: (
                  <div className="text-muted-foreground">
                    WASD move · Space jump / up · C down · F fly · mouse look (click canvas; Esc frees the pointer) · wheel zoom
                    <br />
                    left click attack (click again in rhythm to combo) · hold right click guard · Q dodge
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <SettingsMenu
            quality={quality === "auto" ? `auto (${activeQuality?.active ?? "…"})` : quality}
            onQuality={cycleQuality}
            onDisconnect={disconnect}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <Card className="w-[380px]">
        <CardHeader>
          <CardTitle>MMO Engine — mirror</CardTitle>
          <p className="text-sm text-muted-foreground">
            {screen === "connecting"
              ? "connecting…"
              : mode === "register"
                ? "Create an account on the server, then mirror the world."
                : "Log in to mirror the authoritative world."}
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={mode === "login" ? "default" : "outline"}
                className="flex-1"
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
              >
                Log in
              </Button>
              <Button
                variant={mode === "register" ? "default" : "outline"}
                className="flex-1"
                onClick={() => {
                  setMode("register");
                  setError(null);
                }}
              >
                Create account
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="url">server URL</Label>
              <Input
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://localhost:7777"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username">username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void launch();
                  }
                }}
              />
            </div>
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="confirm-password">confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void launch();
                    }
                  }}
                />
                {confirmPassword && password !== confirmPassword && (
                  <p className="text-xs text-destructive">
                    passwords don&apos;t match
                  </p>
                )}
              </div>
            )}
            {error && (
              <div className="rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm text-foreground">
                {error}
              </div>
            )}
            <Button
              className="w-full"
              disabled={!canSubmit}
              onClick={() => void launch()}
            >
              {screen === "connecting"
                ? "connecting…"
                : mode === "register"
                  ? "create account & connect"
                  : "connect"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {mode === "register"
                ? "username: 3\u201332 chars (letters, digits, _, -) · password: 8+ chars"
                : "Prefer the CLI? On the server host run MMO_DEV_PASSWORD=\u2026 npm run seed:user --workspace=@mmo-engine/engine-core -- <name>"}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
