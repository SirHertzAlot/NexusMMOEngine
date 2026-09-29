/**
 * Mirror client app shell (Phase 3).
 *
 * Login screen → character screen → world screen. After login the player
 * chooses (or creates) a character, then enters the world as it
 * (docs/MESSAGE-CATALOG.md §0x0c–0x0e). The world screen is WorldCanvas
 * (a React Three Fiber scene whose frame loop samples the Interpolator,
 * syncs the world, and forwards changed input as PlayerIntent events)
 * under the HUD: connection state, server tick, entity count, fps, and
 * player position.
 *
 * The session token lives in a ref (memory only) — reconnect presents
 * it via the token hello variant (docs/MESSAGE-CATALOG.md).
 *
 * No client prediction: the mirror renders strictly behind the server
 * by one tick interval (see mirror/interpolate.ts).
 */

import { useMemo, useRef, useState } from "react";
import type { AccountMessage, WelcomeMessage } from "@mmo-engine/protocol";
import { MirrorClient, type JoinReply } from "@mmo-engine/mirror";
import { BrowserSocket } from "@mmo-engine/mirror";
import { WorldCanvas, type HudData } from "./render/world-canvas.js";
import type { GpuInfo } from "./render/gpu.js";
import { PlaceholderAssets } from "./render/assets.js";
import { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
import { CharacterScreen } from "./ui/character-screen.js";
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
    tick: 0, entities: 0, fps: 0, px: 0, py: 0, pz: 0, mode: null, breath: 1, time: null, weather: null,
  });
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [showcase, setShowcase] = useState(false);
  const [effects, setEffects] = useState(true);
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
  const toggleEffects = (): void => setEffects((v) => !v);

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
          effects={effects}
          onGpu={onGpu}
          onHud={setHud}
        />
        <div className="absolute left-4 top-4 rounded-md bg-slate-950/75 px-4 py-3 text-sm shadow backdrop-blur-sm">
          <div className="font-medium text-foreground">{characterName ?? "mirror client"}</div>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            <div>tick <span className="text-foreground">{hud.tick}</span></div>
            {hud.time && <div>time <span className="text-foreground">{hud.time}</span></div>}
            {hud.weather && <div>weather <span className="text-foreground">{hud.weather}</span></div>}
            <div>entities <span className="text-foreground">{hud.entities}</span></div>
            <div>fps <span className="text-foreground">{hud.fps}</span></div>
            <div>
              pos <span className="text-foreground">
                {hud.px.toFixed(1)}, {hud.py.toFixed(1)}, {hud.pz.toFixed(1)}
              </span>
            </div>
            {hud.mode !== null && (
              <div>
                moving <span className="text-foreground">{MODE_LABEL[hud.mode] ?? hud.mode}</span>
                {hud.breath < 1 && (
                  <> · air <span className="text-foreground">{Math.round(hud.breath * 100)}%</span></>
                )}
              </div>
            )}
            {gpu && (
              <div className="max-w-64 truncate" title={gpu.renderer}>
                gpu <span className="text-foreground">{gpu.renderer}</span>
              </div>
            )}
          </div>
          {gpu?.software && (
            <div className="mt-2 max-w-64 rounded-md border border-input bg-secondary/50 px-2 py-1 text-xs text-foreground">
              Software rendering: hardware acceleration is off, so fps will
              stay in single digits. Enable it in browser settings
              (see chrome://gpu).
            </div>
          )}
          <div className="mt-2 text-xs text-muted-foreground">
            WASD move · Space jump / up · C down · F fly · mouse look (click canvas) · wheel zoom
            <br />
            left click attack (click again in rhythm to combo) · hold right click guard · Q dodge
          </div>
        </div>
        <div className="absolute right-4 top-4 flex gap-2">
          <Button size="sm" variant="secondary" onClick={toggleWireframe}>
            {wireframe ? "solid terrain" : "wireframe terrain"}
          </Button>
          <Button size="sm" variant="secondary" onClick={toggleEffects}>
            {effects ? "effects off" : "effects on"}
          </Button>
          <Button size="sm" variant="secondary" onClick={toggleShowcase}>
            {showcase ? "hide FX" : "FX showcase"}
          </Button>
          {sessionTokenRef.current && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void reconnectWithToken()}
            >
              reconnect (token)
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={disconnect}>
            disconnect
          </Button>
        </div>
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
