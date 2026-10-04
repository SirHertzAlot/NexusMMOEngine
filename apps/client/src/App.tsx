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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountMessage, WelcomeMessage } from "@mmo-engine/protocol";
import type { ChatBroadcast, ChatChannel, FriendsState, GuildState, PartyState } from "@mmo-engine/protocol";
import type { InventoryMessage, ItemView, SkillsMessage, StatsMessage } from "@mmo-engine/protocol";
import { treatmentNotice } from "./ui/treatment-notice.js";
import { disarmNotice, disciplineNotices } from "./ui/mastery-notice.js";
import { spellNotice } from "./ui/spell-notice.js";
import { MirrorClient, type JoinReply } from "@mmo-engine/mirror";
import { BrowserSocket } from "@mmo-engine/mirror";
import { WorldCanvas, type CombatView, type HudData, type NearDrop } from "./render/world-canvas.js";
import { CombatFeedback } from "./render/combat-feedback.js";
import type { GpuInfo } from "./render/gpu.js";
import { QUALITY_TIERS, type QualityTier } from "./render/quality.js";
import { PlaceholderAssets } from "./render/assets.js";
import { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
import { CharacterScreen } from "./ui/character-screen.js";
import { PlayerFrame } from "./ui/player-frame.js";
import { TargetFrame } from "./ui/target-frame.js";
import { AdminConsole } from "./ui/admin-console.js";
import { ChatPanel } from "./ui/chat-panel.js";
import { PartyFrame } from "./ui/party-frame.js";
import { FriendsFrame } from "./ui/friends-frame.js";
import { GuildFrame } from "./ui/guild-frame.js";
import { parseChatCommand } from "./ui/chat-command.js";
import { CharacterSheet } from "./ui/character-sheet.js";
import { BagPanel } from "./ui/bag-panel.js";
import { PerfHud } from "./ui/perf-hud.js";
import { DevHud, type Viewport } from "./ui/dev-panels.js";
import { SettingsMenu } from "./ui/settings-menu.js";
import { applyUiScale, loadUiScale, type UiScale } from "./ui/ui-scale.js";
import {
  ACTIONS,
  ACTION_LABELS,
  FIXED_MOUSE,
  loadBindings,
  prettyCode,
  resetBindings,
  saveBindings,
  type Bindings,
} from "./input/bindings.js";
import { DEV_TOOLS } from "./dev-tools.js";
import type { DevLayout } from "./ui/dev-layout.js";

/** Our game's techniques and the aims R and T step through (M3, catalog 0x19). */
const TECHNIQUES = ["cut", "thrust", "bludgeon"] as const;
const AIMS = ["torso", "head", "legLeft", "legRight", "armUpperLeft", "armUpperRight"];

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
    hp: null, maxHp: null, sp: null, maxSp: null,
  });
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [showcase, setShowcase] = useState(false);
  // Graphics quality: "auto" follows the GPU and the frame rate; a preset pins it.
  const [quality, setQuality] = useState<"auto" | QualityTier>("auto");
  // Remappable keyboard bindings + UI scale (U4), persisted per browser.
  const [bindings, setBindingsState] = useState<Bindings>(loadBindings);
  const [uiScale, setUiScaleState] = useState<UiScale>(loadUiScale);
  useEffect(() => {
    applyUiScale(uiScale);
  }, [uiScale]);
  const setBindings = useCallback((b: Bindings) => {
    saveBindings(b);
    setBindingsState(b);
  }, []);
  const onResetBindings = useCallback(() => setBindings(resetBindings()), [setBindings]);
  const setUiScale = useCallback((s: UiScale) => setUiScaleState(s), []);
  const [activeQuality, setActiveQuality] = useState<{ active: QualityTier; detected: QualityTier | null } | null>(null);
  const [account, setAccount] = useState<AccountMessage | null>(null);
  const [characterName, setCharacterName] = useState<string | null>(null);
  // Region chat (U6): the last lines plus the sending tab.
  const [chatLines, setChatLines] = useState<ChatBroadcast[]>([]);
  const [party, setParty] = useState<PartyState | null>(null);
  const [guild, setGuild] = useState<GuildState | null>(null);
  const [friends, setFriends] = useState<FriendsState | null>(null);
  const [chatChannel, setChatChannel] = useState<ChatChannel>("say");
  // Character sheet (U9): the latest stats message lines, plus panel toggle.
  const [sheet, setSheet] = useState<{ attributes: StatsMessage["attributes"]; stats: StatsMessage["stats"] } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Items (M3a): the bag, the drop in pickup range, and the last refusal or pickup.
  const [bag, setBag] = useState<InventoryMessage["bag"] | null>(null);
  const [hands, setHands] = useState<{ main: ItemView | null; off: ItemView | null }>({ main: null, off: null });
  const [bagOpen, setBagOpen] = useState(false);
  const [nearDrop, setNearDrop] = useState<NearDrop | null>(null);
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);

  const clientRef = useRef<MirrorClient | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const lastStateAtRef = useRef(0);
  // The last skills message (M4): a discipline new since it is announced.
  const skillsRef = useRef<SkillsMessage | null>(null);
  const [assets] = useState(() => new PlaceholderAssets());
  // Hit feedback (U12a): flashes and the target, written by combat messages.
  const [combat] = useState(() => new CombatFeedback());
  const [combatView, setCombatView] = useState<CombatView | null>(null);

  /** Shared MirrorClient construction with the standard callbacks. */
  const createClient = (): MirrorClient => {
    skillsRef.current = null;
    return new MirrorClient((u) => new BrowserSocket(u), {
      onWelcome: (_w: WelcomeMessage) => {
        sessionTokenRef.current = _w.session_token;
        setCharacterName(_w.character?.name ?? null);
      },
      onState: (tick: number) => {
        lastStateAtRef.current = performance.now();
        void tick;
      },
      onError: (e) => {
        // A refusal in the world (too far, someone else's, bag full) is a
        // notice, not a failed connection.
        if (e.code === 4005 && clientRef.current?.playerEntity != null) setNotice({ text: e.message, at: performance.now() });
        else setError(`server error ${e.code}: ${e.message}`);
      },
      onClose: () => {
        // The server sends an error frame before closing on every
        // rejection; keep that reason instead of masking it.
        setError((prev) => prev ?? "connection closed");
        setScreen("login");
      },
      onChat: (c) => setChatLines((prev) => [...prev.slice(-49), c]),
      onParty: setParty,
      onGuild: setGuild,
      onFriends: setFriends,
      onStats: (s) => setSheet({ attributes: s.attributes, stats: s.stats }),
      onInventory: (inv) => {
        setBag(inv.bag);
        setHands({ main: inv.main ?? null, off: inv.off ?? null });
      },
      onHit: (h) => {
        combat.hit(h, clientRef.current?.playerEntity ?? null);
        const text = disarmNotice(h, clientRef.current?.playerEntity?.toString() ?? null);
        if (text) setNotice({ text, at: performance.now() });
      },
      onSpell: (sp) => {
        const text = spellNotice(sp, clientRef.current?.playerEntity?.toString() ?? null);
        if (text) setNotice({ text, at: performance.now() });
      },
      onSkills: (next) => {
        const [text] = disciplineNotices(skillsRef.current, next);
        skillsRef.current = next;
        if (text) setNotice({ text, at: performance.now() });
      },
      onLife: (l) => combat.life(l),
      onTreatment: (t) => {
        const c = clientRef.current;
        const name = c?.body?.parts.find((p) => p.id === t.part)?.name;
        const text = treatmentNotice(t, c?.playerEntity?.toString() ?? null, name);
        if (text) setNotice({ text, at: performance.now() });
      },
    });
  };

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
    setChatLines([]);
    setParty(null);
    setGuild(null);
    setFriends(null);
    setSheet(null);
    setSheetOpen(false);
    setBag(null);
    setHands({ main: null, off: null });
    setBagOpen(false);
    setNearDrop(null);
    combat.select(null);
    setCombatView(null);
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
  const toggleBag = useCallback(() => setBagOpen((o) => !o), []);
  // Stance (M3): R turns to the next technique, T to the next aim; the server keeps it.
  const stance = useRef<{ technique: number; aim: number }>({ technique: -1, aim: 0 });
  const onStance = useCallback((which: "technique" | "aim") => {
    const c = clientRef.current;
    if (!c) return;
    const known = new Set(c.body?.parts.filter((p) => p.state !== "dismembered").map((p) => p.id) ?? AIMS);
    const aims = AIMS.filter((a) => known.has(a));
    const st = stance.current;
    if (which === "technique") st.technique = (st.technique + 1) % TECHNIQUES.length;
    else st.aim = (st.aim + 1) % Math.max(1, aims.length);
    const technique = st.technique >= 0 ? TECHNIQUES[st.technique] : null;
    const aim = aims[st.aim % Math.max(1, aims.length)] ?? null;
    c.stance(technique, aim);
    const label = (id: string | null): string => (id ? id.replace(/([A-Z])/g, " $1").toLowerCase() : "your weapon's");
    setNotice({ text: `${label(technique)} · aim: ${label(aim)}`, at: performance.now() });
  }, []);
  // Medicine (M4): H treats your own worst wound; how it goes comes back as a notice.
  const onTreat = useCallback(() => clientRef.current?.treat(), []);
  // G casts Mend on yourself (mana's first spender).
  const onMend = useCallback(() => clientRef.current?.cast("mend"), []);
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
          bindings={bindings}
          quality={quality}
          onQuality={onQuality}
          onGpu={onGpu}
          onHud={setHud}
          onBag={toggleBag}
          onStance={onStance}
          onTreat={onTreat}
          onMend={onMend}
          onNearDrop={setNearDrop}
          combat={combat}
          onCombat={setCombatView}
        />
        {nearDrop && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            pick up <span style={{ color: nearDrop.color }}>{nearDrop.name}</span>
          </div>
        )}
        {notice && <Notice key={notice.at} text={notice.text} onDone={() => setNotice(null)} />}
        <PlayerFrame
          name={characterName}
          hp={combatView?.hp ?? hud.hp}
          maxHp={combatView?.maxHp ?? hud.maxHp}
          sp={hud.sp}
          maxSp={hud.maxSp}
        />
        <TargetFrame target={combatView?.target ?? null} />
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
                    {ACTIONS.map((a) => `${ACTION_LABELS[a]}: ${bindings[a].map(prettyCode).join("/")}`).join(" · ")}
                    <br />
                    {FIXED_MOUSE.map((m) => `${m.label}: ${m.code === "Mouse0" ? "left click" : "right click"}`).join(" · ")}
                    {" "}· mouse look (click canvas; Esc frees the pointer) · wheel zoom
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
            bindings={bindings}
            onBindings={setBindings}
            onResetBindings={onResetBindings}
            uiScale={uiScale}
            onUiScale={setUiScale}
          />
        )}
        <PartyFrame
          party={party}
          self={characterName}
          onAccept={() => client?.party("accept")}
          onLeave={() => client?.party("leave")}
          onKick={(n) => client?.party("kick", n)}
          onPromote={(n) => client?.party("promote", n)}
          onInviteExpired={() => setParty((p) => (p ? { ...p, invite: undefined } : p))}
        />
        <GuildFrame
          guild={guild}
          self={characterName}
          onAccept={() => client?.guild("accept")}
          onLeave={() => client?.guild("leave")}
          onKick={(name) => client?.guild("kick", { name })}
          onRank={(name, rank) => client?.guild("setRank", { name, rank })}
          onInviteExpired={() => setGuild((g) => (g ? { ...g, invite: undefined } : g))}
        />
        <FriendsFrame
          friends={friends}
          onWhisper={(n) => setNotice({ text: `/w ${n} <message>`, at: Date.now() })}
          onRemove={(n) => client?.friend(n, false)}
        />
        <ChatPanel
          lines={chatLines}
          channel={chatChannel}
          onChannel={setChatChannel}
          onSend={(line) => {
            const c = parseChatCommand(line, chatChannel);
            if (c.kind === "party") client?.party(c.op, c.name);
            else if (c.kind === "guild") client?.guild(c.op, c);
            else if (c.kind === "friend") client?.friend(c.name, c.on);
            else if (c.kind === "chat") client?.chat(c.channel, c.text, c.to);
            else if (c.kind === "error") setNotice({ text: c.text, at: Date.now() });
          }}
        />
        <div className="absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
          {bagOpen && bag && (
            <BagPanel
              bag={bag}
              hands={hands}
              onDrop={(id) => client?.dropItem(id)}
              onEquip={(id) => client?.equip(id)}
              onUnequip={(hand) => client?.unequip(hand)}
            />
          )}
          {sheetOpen && sheet && (
            <CharacterSheet name={characterName} attributes={sheet.attributes} stats={sheet.stats} />
          )}
          <Button size="sm" variant="secondary" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen} title="Character sheet">
            sheet
          </Button>
          <Button size="sm" variant="secondary" onClick={toggleBag} aria-expanded={bagOpen} title={`Bag (${prettyCode(bindings.bag[0] ?? "KeyB")})`}>
            bag
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

/** A short-lived message over the world (a refused pickup, …), gone after a few seconds. */
function Notice({ text, onDone }: { text: string; onDone: () => void }): React.ReactElement {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div role="status" className="pointer-events-none absolute left-1/2 top-24 z-10 -translate-x-1/2 rounded-md border bg-card/90 px-3 py-1 text-sm text-amber-200 shadow-sm">
      {text}
    </div>
  );
}
