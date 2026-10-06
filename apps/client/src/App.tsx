/**
 * Mirror client app shell (Phase 3).
 *
 * Login screen → character screen → world screen. After login the player
 * chooses (or creates) a character, then enters the world as it
 * (docs/MESSAGE-CATALOG.md §0x0c–0x0e). The world screen is WorldCanvas
 * (a React Three Fiber scene whose frame loop samples the Interpolator,
 * syncs the world, and forwards changed input as PlayerIntent events)
 * under the player's interface. Developer tooling belongs in the editor's
 * play mode; this app only renders player-facing controls.
 *
 * The session token lives in a ref (memory only) — reconnect presents
 * it via the token hello variant (docs/MESSAGE-CATALOG.md).
 *
 * No client prediction: the mirror renders strictly behind the server
 * by one tick interval (see mirror/interpolate.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountMessage, WelcomeMessage } from "@mmo-engine/protocol";
import type { BlocksState, ChatBroadcast, ChatChannel, FriendsState, GuildState, PartyState } from "@mmo-engine/protocol";
import type { BodyMessage, InventoryMessage, ItemView, ManaMessage, SkillsMessage, StatsMessage } from "@mmo-engine/protocol";
import type { NpcView, QuestView } from "@mmo-engine/protocol";
import { DialogPanel, QuestLog, QuestTracker, questNotices, type OpenDialog } from "./ui/quests.js";
import type { DungeonMessage } from "@mmo-engine/protocol";
import { DungeonHud, DungeonResult, DungeonTransit, type DungeonRun } from "./ui/dungeon.js";
import { treatmentNotice } from "./ui/treatment-notice.js";
import { disarmNotice, disciplineNotices } from "./ui/mastery-notice.js";
import { spellNotice } from "./ui/spell-notice.js";
import { CastBar, nextCast, type CastState } from "./ui/cast-bar.js";
import { MirrorClient, type JoinReply } from "@mmo-engine/mirror";
import { BrowserSocket } from "@mmo-engine/mirror";
import { WorldCanvas, type CombatView, type HudData, type NearDrop } from "./render/world-canvas.js";
import { CombatFeedback } from "./render/combat-feedback.js";
import { QUALITY_TIERS, type QualityTier } from "./render/quality.js";
import { PlaceholderAssets } from "./render/assets.js";
import { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
import { CharacterScreen } from "./ui/character-screen.js";
import { PlayerFrame } from "./ui/player-frame.js";
import { TargetFrame } from "./ui/target-frame.js";
import { ChatPanel } from "./ui/chat-panel.js";
import { PartyFrame } from "./ui/party-frame.js";
import { FriendsFrame } from "./ui/friends-frame.js";
import { GuildFrame } from "./ui/guild-frame.js";
import { parseChatCommand, replyTarget } from "./ui/chat-command.js";
import { CharacterSheet } from "./ui/character-sheet.js";
import { BagPanel } from "./ui/bag-panel.js";
import { SettingsMenu } from "./ui/settings-menu.js";
import { applyUiScale, loadUiScale, type UiScale } from "./ui/ui-scale.js";
import { AudioEngine } from "./audio/engine.js";
import { loadVolumes, saveVolumes, type AudioBus, type Volumes } from "./audio/volumes.js";
import type { Cue } from "./audio/cues.js";
import {
  loadBindings,
  prettyCode,
  resetBindings,
  saveBindings,
  type Bindings,
} from "./input/bindings.js";

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

const QUALITY_CYCLE: ("auto" | QualityTier)[] = ["auto", ...QUALITY_TIERS];

const DEFAULT_URL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "wss://localhost:7777"
    : "ws://localhost:7777";

/** What each settings slider plays when let go (U4 audio). */
const PREVIEW_CUE: Partial<Record<AudioBus, Cue>> = { effects: "hit", interface: "whisper" };
const HIT_CUE: Record<"hit" | "blocked" | "dodged", Cue> = { hit: "hit", blocked: "block", dodged: "dodge" };

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
  // Audio (U4): volumes persisted per browser; the engine starts on the first click or key.
  const [volumes, setVolumesState] = useState<Volumes>(loadVolumes);
  const [audio] = useState(() => new AudioEngine(volumes));
  const setVolumes = useCallback(
    (v: Volumes) => {
      saveVolumes(v);
      audio.setVolumes(v);
      setVolumesState(v);
    },
    [audio],
  );
  const previewBus = useCallback((b: AudioBus) => {
    const cue = PREVIEW_CUE[b];
    if (cue) audio.play(cue);
  }, [audio]);
  useEffect(() => {
    const unlock = (): void => audio.unlock();
    const onVisibility = (): void => audio.setHidden(document.hidden);
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [audio]);
  const [activeQuality, setActiveQuality] = useState<{ active: QualityTier; detected: QualityTier | null } | null>(null);
  const [account, setAccount] = useState<AccountMessage | null>(null);
  const [characterName, setCharacterName] = useState<string | null>(null);
  // Region chat (U6): the last lines plus the sending tab.
  const [chatLines, setChatLines] = useState<ChatBroadcast[]>([]);
  const [party, setParty] = useState<PartyState | null>(null);
  const [guild, setGuild] = useState<GuildState | null>(null);
  const [friends, setFriends] = useState<FriendsState | null>(null);
  const [blocked, setBlocked] = useState<BlocksState["blocked"]>([]);
  const [chatChannel, setChatChannel] = useState<ChatChannel>("say");
  // `/r` (U6): the last character who whispered us; the name ref lets the socket callback tell our echoes apart.
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const characterNameRef = useRef<string | null>(null);
  characterNameRef.current = characterName;
  // Character sheet (U9): the latest stats message lines, plus panel toggle.
  // Also carries hunger and thirst (U3) for the player frame, and skills for the sheet.
  const [sheet, setSheet] = useState<StatsMessage | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The player's body (0x18): injuries on the player frame's doll and the sheet.
  const [body, setBody] = useState<BodyMessage | null>(null);
  // Mana (0x1c) for the player frame, and the player's own cast under way for the cast bar.
  const [mana, setMana] = useState<ManaMessage | null>(null);
  const [cast, setCast] = useState<CastState | null>(null);
  // Items (M3a): the bag, the drop in pickup range, and the last refusal or pickup.
  const [bag, setBag] = useState<InventoryMessage["bag"] | null>(null);
  const [hands, setHands] = useState<{ main: ItemView | null; off: ItemView | null }>({ main: null, off: null });
  const [bagOpen, setBagOpen] = useState(false);
  const [nearDrop, setNearDrop] = useState<NearDrop | null>(null);
  // Quests (U11): the log, the givers, the npc in talk range, the open dialog.
  const [quests, setQuests] = useState<QuestView[] | null>(null);
  const [questsOpen, setQuestsOpen] = useState(false);
  const [npcs, setNpcs] = useState<NpcView[]>([]);
  const [nearNpc, setNearNpc] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const questsRef = useRef<QuestView[] | null>(null);
  // Dungeon runs (D4): where the player is with a run, the entrance they stand in,
  // and the region to come back to (its address and session token) while away.
  const [run, setRun] = useState<DungeonRun | null>(null);
  const runRef = useRef<DungeonRun | null>(null);
  runRef.current = run;
  const [nearEntrance, setNearEntrance] = useState<string | null>(null);
  const regionRef = useRef<{ url: string; token: string } | null>(null);
  // The server and name as of this render, for socket callbacks made in an earlier one
  // (a region hand-off changes the server mid-session).
  const urlRef = useRef(url);
  urlRef.current = url;
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);

  const clientRef = useRef<MirrorClient | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const lastStateAtRef = useRef(0);
  // The last skills message (M4): a discipline new since it is announced.
  const skillsRef = useRef<SkillsMessage | null>(null);
  const [mastery, setMastery] = useState<SkillsMessage | null>(null);
  const [assets] = useState(() => new PlaceholderAssets());
  // Hit feedback (U12a): flashes and the target, written by combat messages.
  const [combat] = useState(() => new CombatFeedback());
  const [combatView, setCombatView] = useState<CombatView | null>(null);

  /** Shared MirrorClient construction with the standard callbacks. */
  const createClient = (): MirrorClient => {
    skillsRef.current = null;
    const c: MirrorClient = new MirrorClient((u) => new BrowserSocket(u), {
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
        // A client we moved away from (into or out of a dungeon) closing is expected.
        if (clientRef.current !== c) return;
        // The dungeon's port closing after the run: back to the world.
        const r = runRef.current;
        if (r && (r.phase === "in" || r.phase === "ended")) {
          void leaveDungeon();
          return;
        }
        // The server sends an error frame before closing on every
        // rejection; keep that reason instead of masking it.
        setError((prev) => prev ?? "connection closed");
        setScreen("login");
      },
      // Crossed into another region (WORLD-SERVER-SPEC §6): reconnects and
      // asset requests go to the server that has the player now.
      onRegionChange: setUrl,
      onChat: (c) => {
        setChatLines((prev) => [...prev.slice(-49), c]);
        setReplyTo((prev) => replyTarget(prev, c, characterNameRef.current));
      },
      onParty: setParty,
      onGuild: setGuild,
      onFriends: setFriends,
      onBlocks: (b) => setBlocked(b.blocked),
      onQuests: (q) => {
        const notices = questNotices(questsRef.current, q.quests);
        questsRef.current = q.quests;
        setQuests(q.quests);
        const text = notices[notices.length - 1];
        if (text) setNotice({ text, at: performance.now() });
      },
      onNpcs: (n) => setNpcs(n.npcs),
      onDialog: (d) => setDialog("closed" in d ? null : d),
      onStats: setSheet,
      onBody: setBody,
      onInventory: (inv) => {
        setBag(inv.bag);
        setHands({ main: inv.main ?? null, off: inv.off ?? null });
      },
      onHit: (h) => {
        const player = clientRef.current?.playerEntity ?? null;
        combat.hit(h, player);
        // Only blows the player gives or takes make a sound, for now.
        if (player !== null && (BigInt(h.source) === player || BigInt(h.target) === player)) audio.play(HIT_CUE[h.outcome]);
        const text = disarmNotice(h, player?.toString() ?? null);
        if (text) setNotice({ text, at: performance.now() });
      },
      onMana: setMana,
      onSpell: (sp) => {
        const me = clientRef.current?.playerEntity?.toString() ?? null;
        setCast((prev) => nextCast(prev, sp, me, performance.now()));
        const text = spellNotice(sp, me);
        if (text) setNotice({ text, at: performance.now() });
      },
      onSkills: (next) => {
        const [text] = disciplineNotices(skillsRef.current, next);
        skillsRef.current = next;
        setMastery(next);
        if (text) setNotice({ text, at: performance.now() });
      },
      onLife: (l) => combat.life(l),
      onTreatment: (t) => {
        const c = clientRef.current;
        const name = c?.body?.parts.find((p) => p.id === t.part)?.name;
        const text = treatmentNotice(t, c?.playerEntity?.toString() ?? null, name);
        if (text) setNotice({ text, at: performance.now() });
      },
      onDungeon: (d) => onDungeon(d),
    });
    return c;
  };

  /** Dungeon messages (D4): a transfer moves the player in; state and the end update the run. */
  const onDungeon = (d: DungeonMessage): void => {
    if (d.op === "transfer") void hop(d.endpoint, d.token, { phase: "entering", dungeon: d.dungeon });
    else if (d.op === "state") setRun((prev) => (prev && prev.phase !== "leaving" ? { phase: "in", dungeon: d.dungeon, state: d, at: performance.now() } : prev));
    else if (d.op === "ended") setRun((prev) => ({ phase: "ended", dungeon: prev?.dungeon ?? "", result: d }));
  };

  /**
   * Move the player's connection to another gateway (a dungeon instance,
   * or back to the region) with a token it already knows: the new client
   * says hello with it and lands straight in the world as the same
   * character. The old client is let go; its close is expected.
   */
  const hop = async (endpoint: string, token: string, transit: Extract<DungeonRun, { phase: "entering" | "leaving" }>): Promise<void> => {
    if (transit.phase === "entering" && !regionRef.current && sessionTokenRef.current) regionRef.current = { url: urlRef.current, token: sessionTokenRef.current };
    setRun(transit);
    setDialog(null);
    setNearDrop(null);
    setNearNpc(null);
    setNearEntrance(null);
    combat.select(null);
    setCombatView(null);
    const old = clientRef.current;
    const next = createClient();
    clientRef.current = next;
    old?.disconnect();
    try {
      await next.join(endpoint, usernameRef.current || "mirror", { token });
      if (transit.phase === "entering") setRun((prev) => (prev?.phase === "entering" ? { phase: "in", dungeon: transit.dungeon, state: null, at: 0 } : prev));
      else {
        regionRef.current = null;
        setRun(null);
      }
      setScreen("world");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (transit.phase === "entering") void leaveDungeon();
      else {
        setRun(null);
        setScreen("login");
      }
    }
  };

  /** Back to the open world from a run, with the region's own token. */
  const leaveDungeon = async (): Promise<void> => {
    const region = regionRef.current;
    const dungeon = runRef.current?.dungeon ?? "";
    if (!region) {
      setRun(null);
      return;
    }
    await hop(region.url, region.token, { phase: "leaving", dungeon });
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
    setReplyTo(null);
    setParty(null);
    setGuild(null);
    setFriends(null);
    setBlocked([]);
    setSheet(null);
    setSheetOpen(false);
    setBody(null);
    setMastery(null);
    setMana(null);
    setCast(null);
    setBag(null);
    setHands({ main: null, off: null });
    setBagOpen(false);
    setNearDrop(null);
    setQuests(null);
    questsRef.current = null;
    setQuestsOpen(false);
    setNpcs([]);
    setNearNpc(null);
    setDialog(null);
    setRun(null);
    regionRef.current = null;
    setNearEntrance(null);
    combat.select(null);
    setCombatView(null);
    setScreen("login");
  };

  // ---- world -------------------------------------------------------------
  const client = screen === "world" ? clientRef.current : null;
  // Audio cues from what the player sees (U4): wind in the world, a chime for whispers to us, a blip for notices.
  useEffect(() => audio.setAmbience(screen === "world"), [audio, screen]);
  useEffect(() => {
    const l = chatLines.at(-1);
    if (l?.channel === "whisper" && l.from.toLowerCase() !== characterName?.toLowerCase()) audio.play("whisper");
  }, [audio, chatLines, characterName]);
  useEffect(() => {
    if (notice) audio.play("notice");
  }, [audio, notice]);
  // PCG assets (trees, …) come from the region's Pcg webrpc service on the game port.
  const pcg = useMemo(
    () => (client ? new PcgRpcClient(httpBaseForGameUrl(url), () => client.sessionToken) : undefined),
    // One service per joined client (the URL it joined with).
    [client],
  );
  const toggleBag = useCallback(() => setBagOpen((o) => !o), []);
  const toggleQuests = useCallback(() => setQuestsOpen((o) => !o), []);
  const onReply = useCallback((index: number) => clientRef.current?.quest({ kind: "quest", op: "reply", index }), []);
  const onCloseDialog = useCallback(() => clientRef.current?.quest({ kind: "quest", op: "close" }), []);
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
  // The sheet's body doll treats the part clicked.
  const onTreatPart = useCallback((part: string) => clientRef.current?.treat(undefined, part), []);
  // G casts Mend on yourself (mana's first spender).
  const onMend = useCallback(() => clientRef.current?.cast("mend"), []);
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

  if (client && (run?.phase === "entering" || run?.phase === "leaving")) {
    return (
      <div className="relative h-full w-full bg-background">
        <DungeonTransit run={run} />
      </div>
    );
  }
  if (client) {
    const entrance = nearEntrance ? client.entrances.find((e) => e.id === nearEntrance) : undefined;
    return (
      <div className="relative h-full w-full">
        <WorldCanvas
          client={client}
          assets={assets}
          pcg={pcg}
          lastStateAt={() => lastStateAtRef.current}
          wireframe={false}
          showcase={false}
          bindings={bindings}
          quality={quality}
          onQuality={onQuality}
          onHud={setHud}
          onBag={toggleBag}
          onStance={onStance}
          onTreat={onTreat}
          onMend={onMend}
          onNearDrop={setNearDrop}
          onQuests={toggleQuests}
          onNearNpc={setNearNpc}
          onNearEntrance={setNearEntrance}
          instance={run !== null}
          combat={combat}
          onCombat={setCombatView}
        />
        {nearDrop && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            pick up <span style={{ color: nearDrop.color }}>{nearDrop.name}</span>
          </div>
        )}
        {!nearDrop && !dialog && nearNpc && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            talk to <span className="text-amber-200">{npcs.find((n) => n.id === nearNpc)?.name ?? nearNpc}</span>
          </div>
        )}
        {!nearDrop && !dialog && !nearNpc && entrance && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            enter <span className="text-violet-300">{entrance.name}</span>
            {party && party.members.length > 1 ? <span className="text-muted-foreground"> with your party</span> : null}
          </div>
        )}
        {run?.phase === "in" && (
          <div className="absolute left-1/2 top-24 z-10 -translate-x-1/2">
            <DungeonHud run={run} />
          </div>
        )}
        {run?.phase === "ended" && (
          <div className="absolute left-1/2 top-[22%] z-20 -translate-x-1/2">
            <DungeonResult run={run} onLeave={() => void leaveDungeon()} />
          </div>
        )}
        {dialog && (
          <div className="absolute left-1/2 top-[18%] z-20 -translate-x-1/2">
            <DialogPanel dialog={dialog} onReply={onReply} onClose={onCloseDialog} />
          </div>
        )}
        {quests && (
          <div className="absolute right-4 top-16 z-10">
            <QuestTracker quests={quests} />
          </div>
        )}
        {notice && <Notice key={notice.at} text={notice.text} onDone={() => setNotice(null)} />}
        {/* Bottom-left stack: friends above the player frame, so neither covers the other. */}
        <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-col items-start gap-2">
          <FriendsFrame
            friends={friends}
            blocked={blocked}
            onBlock={(n) => client?.block(n, true)}
            onUnblock={(n) => client?.block(n, false)}
            onWhisper={(n) => setNotice({ text: `/w ${n} <message>`, at: Date.now() })}
            onRemove={(n) => client?.friend(n, false)}
          />
          <PlayerFrame
            name={characterName}
            hp={combatView?.hp ?? hud.hp}
            maxHp={combatView?.maxHp ?? hud.maxHp}
            sp={hud.sp}
            maxSp={hud.maxSp}
            mana={mana}
            needs={sheet?.needs}
            body={body}
          />
          <CastBar cast={cast} />
        </div>
        <TargetFrame target={combatView?.target ?? null} />
        <SettingsMenu
          quality={quality === "auto" ? `auto (${activeQuality?.active ?? "…"})` : quality}
          onQuality={cycleQuality}
          onDisconnect={disconnect}
          bindings={bindings}
          onBindings={setBindings}
          onResetBindings={onResetBindings}
          uiScale={uiScale}
          onUiScale={setUiScale}
          volumes={volumes}
          onVolumes={setVolumes}
          onPreview={previewBus}
        />
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
        <ChatPanel
          lines={chatLines}
          self={characterName}
          channel={chatChannel}
          onChannel={setChatChannel}
          onSend={(line) => {
            const c = parseChatCommand(line, chatChannel, replyTo);
            if (c.kind === "party") client?.party(c.op, c.name);
            else if (c.kind === "guild") client?.guild(c.op, c);
            else if (c.kind === "friend") client?.friend(c.name, c.on);
            else if (c.kind === "block") client?.block(c.name, c.on);
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
          {questsOpen && quests && <QuestLog quests={quests} onAbandon={(id) => client?.quest({ kind: "quest", op: "abandon", quest: id })} />}
          {sheetOpen && sheet && (
            <CharacterSheet name={characterName} attributes={sheet.attributes} stats={sheet.stats} skills={sheet.skills} skillMax={sheet.skillMax} body={body} onTreat={onTreatPart} mastery={mastery} />
          )}
          <Button size="sm" variant="secondary" onClick={toggleQuests} aria-expanded={questsOpen} title={`Quest log (${prettyCode(bindings.quests[0] ?? "KeyJ")})`}>
            quests
          </Button>
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
