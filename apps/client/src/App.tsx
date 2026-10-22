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
import type { DungeonLook, DungeonMessage } from "@mmo-engine/protocol";
import type { PouchMaterial } from "@mmo-engine/protocol";
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
import { setMoveSound } from "./render/entity-layer.js";
import { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
import gameFlow from "virtual:game-flow";
import { t } from "./i18n.js";
import { startNode, useFlow } from "./flow.js";
import { CharacterScreen } from "./ui/character-screen.js";
import { PlayerFrame } from "./ui/player-frame.js";
import { HudLayoutProvider, HudSlot, useHudJson } from "./ui/hud-slot.js";
import { TargetFrame } from "./ui/target-frame.js";
import { ChatPanel } from "./ui/chat-panel.js";
import { PartyFrame } from "./ui/party-frame.js";
import { FriendsFrame } from "./ui/friends-frame.js";
import { GuildFrame } from "./ui/guild-frame.js";
import { parseChatCommand, replyTarget } from "./ui/chat-command.js";
import { CharacterSheet } from "./ui/character-sheet.js";
import { BagPanel, EMPTY_WORN, type Worn } from "./ui/bag-panel.js";
import { PouchPanel, tierColor } from "./ui/pouch-panel.js";
import { SettingsMenu } from "./ui/settings-menu.js";
import { applyUiScale, loadUiScale, type UiScale } from "./ui/ui-scale.js";
import { AudioEngine } from "./audio/engine.js";
import { loadVolumes, saveVolumes, type AudioBus, type Volumes } from "./audio/volumes.js";
import audioBankJson from "virtual:audio-events";
import { parseAudioBank, type Listener } from "./audio/sound-logic.js";
import combatMovesDoc from "virtual:combat-moves";
import animationDoc from "virtual:animation-doc";
import materialsDoc from "virtual:materials-doc";
import vfxBudgetsDoc from "virtual:vfx-budgets";
import { applyGameContent } from "./render/game-content.js";
import { setParticleBudgets } from "./render/fx/particle-fx.js";
import {
  loadBindings,
  prettyCode,
  resetBindings,
  saveBindings,
  type Bindings,
} from "./input/bindings.js";

/** Our game's techniques and the aims R and T step through (M3, catalog 0x19). */
// The animation-side content (combat moves, locomotion graph, materials) is applied once, before any world is built.
applyGameContent({ combat: combatMovesDoc, animation: animationDoc, materials: materialsDoc } as Parameters<typeof applyGameContent>[0]);
// Particle tier budgets (EG10): a bad file keeps the built-in budgets.
{
  const problem = setParticleBudgets(vfxBudgetsDoc);
  if (problem) console.warn(`[content] ${problem}`);
}

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

type AuthMode = "login" | "register";

const QUALITY_CYCLE: ("auto" | QualityTier)[] = ["auto", ...QUALITY_TIERS];

const DEFAULT_URL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "wss://localhost:7777"
    : "ws://localhost:7777";

/** What each settings slider plays when let go (U4 audio). */
const PREVIEW_EVENT: Partial<Record<AudioBus, string>> = { effects: "hit", interface: "ui-whisper" };
const HIT_EVENT: Record<"hit" | "blocked" | "dodged", string> = { hit: "hit", blocked: "block", dodged: "dodge" };

export function App(): React.ReactElement {
  // The screen is a node of content/flow/game.flow.json; events move it (flow.ts).
  const { node, screen, fire } = useFlow(gameFlow, gameFlow.start);
  const [mode, setMode] = useState<AuthMode>("login");
  const [url, setUrl] = useState(DEFAULT_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // EA23: widget positions come from content/ui/hud.json (data, not code).
  const hudLayout = useHudJson();
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
    const name = PREVIEW_EVENT[b];
    if (name) audio.playEvent(name);
  }, [audio]);
  // EA24: the events and mixer settings are content/audio/events.json; the camera writes the listener each frame.
  const [listener] = useState<Listener>(() => ({ x: 0, y: 0, z: 0, fx: 0, fz: -1 }));
  useEffect(() => {
    const { bank, errors } = parseAudioBank(audioBankJson);
    for (const e of errors) console.warn(`audio events: ${e}`);
    audio.setBank(bank);
    audio.setListener(listener);
  }, [audio, listener]);
  const onFootstep = useCallback((event: string, at: { x: number; y: number; z: number }) => void audio.playEvent(event, at), [audio]);
  const bagCount = useRef<number | null>(null);
  // Combat move sounds (content/combat/moves.json `sound`): the entity
  // layer plays them at the mover's position through this engine.
  useEffect(() => {
    setMoveSound((event, x, y, z) => {
      audio.playEvent(event, { x, y, z });
    });
    return () => setMoveSound(null);
  }, [audio]);
  useEffect(() => {
    const unlock = (e: Event): void => {
      audio.unlock();
      if (e.type === "pointerdown" && e.target instanceof Element && e.target.closest("button")) audio.playEvent("ui-click");
    };
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
  const [worn, setWorn] = useState<Worn>(EMPTY_WORN);
  const [bagOpen, setBagOpen] = useState(false);
  const [nearDrop, setNearDrop] = useState<NearDrop | null>(null);
  // Gathering (0x24): the resource node in reach (its view re-read when the nodes change) and the materials pouch.
  const [nearResource, setNearResource] = useState<bigint | null>(null);
  const [, setResourcesSeen] = useState(0);
  const [pouch, setPouch] = useState<PouchMaterial[]>([]);
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
  // How the run looks (the server's `look`, sent on entering): the canvas reads it each frame; every hop clears it.
  const lookRef = useRef<DungeonLook | null>(null);
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
  const streamingRef = useRef<{ onRegionChange: (endpoint: string) => void } | null>(null);
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
        else setError(t("net.serverError", { code: e.code, message: e.message }));
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
        setError((prev) => prev ?? t("net.closed"));
        fire("net.closed");
      },
      // Crossed into another region (WORLD-SERVER-SPEC §6): reconnects and
      // asset requests go to the server that has the player now.
      onRegionChange: (endpoint: string) => {
        setUrl(endpoint);
        streamingRef.current?.onRegionChange(endpoint);
      },
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
        // A bigger bag than before is a pickup (the first inventory only sets the baseline).
        const held = inv.bag.filter(Boolean).length;
        if (bagCount.current !== null && held > bagCount.current) audio.playEvent("pickup");
        bagCount.current = held;
        setHands({ main: inv.main ?? null, off: inv.off ?? null });
        setWorn({ ...EMPTY_WORN, ...inv.worn });
      },
      onResources: () => setResourcesSeen((n) => n + 1),
      onPouch: (p) => {
        setPouch(p.materials);
        if (p.gathered) {
          audio.playEvent("pickup");
          setNotice({ text: t("pouch.gathered", { count: p.gathered.count, name: p.gathered.name }), at: performance.now() });
        }
      },
      onHit: (h) => {
        const player = clientRef.current?.playerEntity ?? null;
        combat.hit(h, player);
        // Only blows the player gives or takes make a sound, for now, from where the other party stands.
        if (player !== null && (BigInt(h.source) === player || BigInt(h.target) === player)) {
          const other = BigInt(h.source) === player ? BigInt(h.target) : BigInt(h.source);
          const t = clientRef.current?.state.entities.get(other)?.transform;
          audio.playEvent(HIT_EVENT[h.outcome], t ? { x: t.px, y: t.py, z: t.pz } : null);
        }
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
    else if (d.op === "look") lookRef.current = d.look;
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
    lookRef.current = null;
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
      fire("net.joinReply.ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (transit.phase === "entering") void leaveDungeon();
      else {
        setRun(null);
        fire("net.closed");
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
    /** Runs in the same tick as net.account, so its events land in the same render. */
    onAccount?: (account: Extract<JoinReply, { kind: "account" }>["account"]) => void,
  ): Promise<JoinReply | null> => {
    fire("ui.submit");
    setError(null);
    const client = createClient();
    clientRef.current = client;
    try {
      const reply = await handshake(client);
      if (reply.kind === "account") {
        sessionTokenRef.current = reply.account.session_token;
        setAccount(reply.account);
        fire("net.account");
        onAccount?.(reply.account);
      } else {
        fire("net.welcome");
      }
      return reply;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      fire("net.error");
      clientRef.current = null;
      return null;
    }
  };

  /**
   * Launch the mirror: log in with an existing account, or create the
   * account first (protocol 0x0b `register`) and join with it.
   */
  const launch = async (): Promise<void> => {
    await runHandshake((client) =>
      client.join(
        url,
        username || "mirror",
        mode === "register" ? { register: { username, password } } : { username, password },
      ),
    );
  };

  /** Enter the world as a character (the character screen). */
  const enterWorld = async (id: number): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error(t("net.notConnected"));
    await client.enterWorld(id);
    fire("net.joinReply.ok");
  };

  // The editor's Play from a node (dev): ?start=<node>&server=<ws url>&user=…&pass=… logs in, then
  // takes the flow to the node (character-creation: the create half; world: the first character).
  const autoplay = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const target = startNode(gameFlow, window.location.search);
    const [server, user, pass] = [q.get("server"), q.get("user"), q.get("pass")];
    if (autoplay.current || target === gameFlow.start || !server || !user || !pass) return;
    autoplay.current = true;
    setUrl(server);
    setUsername(user);
    void (async () => {
      const scene = gameFlow.nodes[target]?.scene;
      const reply = await runHandshake(
        (c) => c.join(server, user, { username: user, password: pass }),
        () => scene === "character-creation" && fire("ui.create"),
      );
      if (reply?.kind !== "account") return;
      if (scene === "@assigned") {
        const id = reply.account.characters[0]?.id;
        if (id === undefined) setError(t("net.noCharacter"));
        else await enterWorld(id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

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
    setWorn(EMPTY_WORN);
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
    fire("net.closed");
  };

  // ---- world -------------------------------------------------------------
  const client = screen === "world" ? clientRef.current : null;
  // Audio cues from what the player sees (U4): wind in the world, a chime for whispers to us, a blip for notices.
  useEffect(() => audio.setAmbience(screen === "world"), [audio, screen]);
  useEffect(() => {
    const l = chatLines.at(-1);
    if (l?.channel === "whisper" && l.from.toLowerCase() !== characterName?.toLowerCase()) audio.playEvent("ui-whisper");
  }, [audio, chatLines, characterName]);
  useEffect(() => {
    if (notice) audio.playEvent("ui-notice");
  }, [audio, notice]);
  // PCG assets (trees, a dungeon's shell, …) come from the Pcg webrpc service on the game port of
  // the gateway the client joined: the region, or a dungeon instance's own port after a hop.
  const pcg = useMemo(
    () => (client ? new PcgRpcClient(httpBaseForGameUrl(client.endpoint ?? url), () => client.sessionToken) : undefined),
    // One service per joined client (the gateway it joined).
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
    const label = (id: string | null): string => (id ? id.replace(/([A-Z])/g, " $1").toLowerCase() : t("stance.weapon"));
    setNotice({ text: t("stance.notice", { technique: label(technique), aim: label(aim) }), at: performance.now() });
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
          if (!client) throw new Error(t("net.notConnected"));
          const updated = await client.createCharacter(name, look);
          setAccount(updated);
          if (updated.created !== undefined) await enterWorld(updated.created);
        }}
        onEnter={enterWorld}
        onLeave={disconnect}
        initialMode={gameFlow.nodes[node]?.scene === "character-creation" ? "create" : undefined}
        onModeChange={(m) => fire(m === "create" ? "ui.create" : "ui.select")}
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
    const resource = nearResource !== null ? client.resources.get(nearResource) : undefined;
    return (
      <HudLayoutProvider layout={hudLayout}>
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
          listener={listener}
          onFootstep={onFootstep}
          onBag={toggleBag}
          onStance={onStance}
          onTreat={onTreat}
          onMend={onMend}
          onNearDrop={setNearDrop}
          onNearResource={setNearResource}
          onQuests={toggleQuests}
          onNearNpc={setNearNpc}
          onNearEntrance={setNearEntrance}
          instance={run !== null}
          getLook={() => lookRef.current}
          combat={combat}
          onCombat={setCombatView}
          streamingRef={streamingRef}
          audio={audio}
        />
        {nearDrop && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            {t("interact.pickUp")} <span style={{ color: nearDrop.color }}>{nearDrop.name}</span>
          </div>
        )}
        {!nearDrop && !dialog && resource && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            {t("interact.gather")} <span style={{ color: tierColor(resource.tier) }}>{resource.name}</span>{" "}
            <span className="text-muted-foreground">
              {resource.stock > 0
                ? t("interact.left", { count: resource.stock })
                : `${t("interact.workedOut")}, ${resource.regrowAt === null ? t("interact.goneForGood") : t("interact.backIn", { hours: Math.max(1, Math.ceil((resource.regrowAt - Date.now()) / 3_600_000)) })}`}
            </span>
          </div>
        )}
        {!nearDrop && !dialog && !resource && nearNpc && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            {t("interact.talkTo")} <span className="text-amber-200">{npcs.find((n) => n.id === nearNpc)?.name ?? nearNpc}</span>
          </div>
        )}
        {!nearDrop && !dialog && !resource && !nearNpc && entrance && (
          <div className="pointer-events-none absolute left-1/2 top-[60%] z-10 -translate-x-1/2 rounded-md border bg-card/85 px-3 py-1 text-sm shadow-sm">
            <span className="mr-1 rounded border px-1 text-xs text-muted-foreground">{prettyCode(bindings.interact[0] ?? "KeyE")}</span>
            {t("interact.enter")} <span className="text-violet-300">{entrance.name}</span>
            {party && party.members.length > 1 ? <span className="text-muted-foreground"> {t("interact.withParty")}</span> : null}
          </div>
        )}
        {run?.phase === "in" && (
          <div className="absolute left-1/2 top-24 z-10 -translate-x-1/2">
            <DungeonHud run={run} onOpen={() => clientRef.current?.dungeon({ kind: "dungeon", op: "open" })} />
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
          <HudSlot id="quest-tracker" className="z-10">
            <QuestTracker quests={quests} />
          </HudSlot>
        )}
        {notice && <Notice key={notice.at} text={notice.text} onDone={() => setNotice(null)} />}
        {/* Bottom-left widgets: positions from hud.json (EA23). */}
        <HudSlot id="friends-frame" className="pointer-events-none z-10">
          <FriendsFrame
            friends={friends}
            blocked={blocked}
            onBlock={(n) => client?.block(n, true)}
            onUnblock={(n) => client?.block(n, false)}
            onWhisper={(n) => setNotice({ text: t("friends.whisperHint", { name: n }), at: Date.now() })}
            onRemove={(n) => client?.friend(n, false)}
          />
        </HudSlot>
        <HudSlot id="player-frame" className="pointer-events-none z-10">
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
        </HudSlot>
        <HudSlot id="cast-bar" className="pointer-events-none z-10">
          <CastBar cast={cast} />
        </HudSlot>
        <TargetFrame target={combatView?.target ?? null} />
        <SettingsMenu
          quality={quality === "auto" ? t("settings.qualityAuto", { tier: activeQuality?.active ?? "…" }) : quality}
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
        {bagOpen && bag && (
          <HudSlot id="bag-panel" className="z-10">
            <div>
            <PouchPanel materials={pouch} />
            <BagPanel
              bag={bag}
              hands={hands}
              worn={worn}
              onDrop={(id) => client?.dropItem(id)}
              onEquip={(id) => client?.equip(id)}
              onUnequip={(slot) => client?.unequip(slot)}
            />
            </div>
          </HudSlot>
        )}
        {questsOpen && quests && (
          <HudSlot id="quest-log" className="z-10">
            <QuestLog quests={quests} onAbandon={(id) => client?.quest({ kind: "quest", op: "abandon", quest: id })} />
          </HudSlot>
        )}
        {sheetOpen && sheet && (
          <HudSlot id="character-sheet" className="z-10">
            <CharacterSheet name={characterName} attributes={sheet.attributes} stats={sheet.stats} skills={sheet.skills} skillMax={sheet.skillMax} body={body} onTreat={onTreatPart} mastery={mastery} />
          </HudSlot>
        )}
        <div className="absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
          <Button size="sm" variant="secondary" onClick={toggleQuests} aria-expanded={questsOpen} title={t("hud.questLogTitle", { key: prettyCode(bindings.quests[0] ?? "KeyJ") })}>
            {t("hud.quests")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen} title={t("hud.sheetTitle")}>
            {t("hud.sheet")}
          </Button>
          <Button size="sm" variant="secondary" onClick={toggleBag} aria-expanded={bagOpen} title={t("hud.bagTitle", { key: prettyCode(bindings.bag[0] ?? "KeyB") })}>
            {t("hud.bag")}
          </Button>
        </div>
      </div>
      </HudLayoutProvider>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <Card className="w-[380px]">
        <CardHeader>
          <CardTitle>{t("auth.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {screen === "connecting"
              ? t("auth.connecting")
              : mode === "register"
                ? t("auth.registerIntro")
                : t("auth.loginIntro")}
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
                {t("auth.logIn")}
              </Button>
              <Button
                variant={mode === "register" ? "default" : "outline"}
                className="flex-1"
                onClick={() => {
                  setMode("register");
                  setError(null);
                }}
              >
                {t("auth.createAccount")}
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="url">{t("auth.serverUrl")}</Label>
              <Input
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://localhost:7777"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username">{t("auth.username")}</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("auth.password")}</Label>
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
                <Label htmlFor="confirm-password">{t("auth.confirmPassword")}</Label>
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
                    {t("auth.passwordMismatch")}
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
                ? t("auth.connecting")
                : mode === "register"
                  ? t("auth.createAndConnect")
                  : t("auth.connect")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {mode === "register"
                ? t("auth.registerHint")
                : t("auth.cliHint")}
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
    const timer = setTimeout(onDone, 2500);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <div role="status" className="pointer-events-none absolute left-1/2 top-24 z-10 -translate-x-1/2 rounded-md border bg-card/90 px-3 py-1 text-sm text-amber-200 shadow-sm">
      {text}
    </div>
  );
}
