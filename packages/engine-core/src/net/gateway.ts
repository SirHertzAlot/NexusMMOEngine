/**
 * WebSocket gateway (slice 1.3, docs/MESSAGE-CATALOG.md).
 *
 * Multiplayer from the start (decided 2026-09-27): one Gateway owns the
 * authoritative SimWorld and serves N clients, each with its own
 * ClientSession (see ./session.ts).
 *
 * EDA / operating rule 1: the gateway is a PURE EVENT TRANSLATOR — it
 * owns no game logic. Inbound `intent` messages become sim intent events
 * (SimWorld.queueIntent, drained at tick start); the sim's state changes
 * are fanned out as per-tick FlatBuffers deltas. The sim never sees
 * sessions; the gateway never touches components.
 *
 * Broadcast model (Phase 1): every connected client receives the same
 * delta stream each tick. No interest management — documented as the
 * future scaling lever (docs/DECISIONS.md). Per-client state exists so
 * reconnects, slow consumers, and later interest filtering have
 * somewhere to live.
 *
 * Fan-out (Phase 5, Part A): the once-encoded delta is published once
 * per occupied sector topic (see ./sector.ts) instead of one send per
 * socket; snapshot ticks and resyncing sessions stay per-socket. Same
 * bytes, zero client changes.
 *
 * Reconnect semantics (auth slice): the server-issued SESSION TOKEN
 * doubles as the client identity. Reconnecting with the same token inside
 * the disconnect grace period re-attaches the SAME player entity (fresh
 * full snapshot); after the grace period the entity is despawned and the
 * token spawns fresh (the token itself stays valid for its TTL). A token
 * connecting while its session is live takes over (last connection wins;
 * the old socket is superseded).
 *
 * Auth (auth slice, 2026-09-27): `hello` carries either
 * { username, password } (first contact) or { token } (reconnect).
 * Shapes are validated with Zod; passwords are checked with argon2id
 * against a CredentialStore (CSV in dev); success issues an opaque
 * session token. Failed attempts are rate-limited per IP. Tokens,
 * passwords, and hashes are NEVER logged.
 *
 * Characters (protocol v5): a hello or register with `characters: true`
 * authenticates, then answers `account` (0x0c) — the account's
 * characters — and waits: the client creates characters
 * (`create_character`, 0x0d) and enters the world as one (`enter_world`,
 * 0x0e), which spawns its avatar with the character's look (the
 * Appearance component). Without the flag a login joins at once, as the
 * account's first character or with a default look. A character is in
 * the world once: entering it again takes it over from the other session.
 *
 * Tick driving: production calls startTicking() (wall-clock interval);
 * tests drive frame(nowMs) manually with a synthetic clock — pass
 * `clock` in options for deterministic heartbeat/grace math.
 */

import * as crypto from "node:crypto";
import { z } from "zod";
import type { ExtensionPlayer, GatewayExtension } from "./extension.js";
import { TickTimings } from "../tick-timings.js";
import { addComponent, defineQuery, hasComponent } from "bitecs";
import {
  decodeControl,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  encodeDeltaSet,
  DeltaSetKind,
  GLOBAL_SECTOR,
  type DeltaSetEntry,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type AdminCommand,
  type AdminResult,
  type ByeMessage,
  type ChatBroadcast,
  type PartyState,
  type FriendsState,
  type BlocksState,
  type GuildState,
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
  type BodyMessage,
  type TreatmentMessage,
  type SkillsMessage,
  type ManaMessage,
  type SpellMessage,
  type HitMessage,
  type LifeMessage,
  type AbilityMessage,
  type TelegraphMessage,
  type StatusMessage,
  type DuelMessage,
  type TradeMessage,
  type WalletMessage,
  type ResourcesMessage,
  type VendorAction,
  type VendorMessage,
  type AuctionMessage,
  type NamesMessage,
  type StatsMessage,
  type WelcomeMessage,
  type DayClock,
  type WeatherOverride,
  type WorldInfo,
  type TileRequestMessage,
  type TileResponseMessage,
  Ability,
  LocomotionMode,
  encodeTileHeights,
  type ChatChannel,
} from "@mmo-engine/protocol";
import type { SocialRules } from "@mmo-engine/rules";
import * as C from "../components.js";
import { parseWireEntityId } from "../entity-id.js";
import type { DebugSource } from "./debug-source.js";
import { inspectEntity, InspectArgsSchema } from "../admin/inspect.js";
import { applySet, SetArgsSchema } from "../admin/set.js";
import { parseAppearanceArgs, applyAppearanceEdit } from "../admin/appearance.js";
import { ensureAnimation } from "../animation.js";
import { applyFly, applyGod, applyHeal, applyNoclip, applyTeleport, FlyArgsSchema, GodArgsSchema, HealArgsSchema, InjureArgsSchema, NoclipArgsSchema, SkillArgsSchema, TeleportArgsSchema } from "../admin/player.js";
import { parseWeatherCommand, runTimeCommand } from "../admin/world.js";
import { buildSpawn, DespawnArgsSchema, listAssets, SpawnArgsSchema } from "../admin/spawn.js";
import { resolveEntityTarget, resolveSpawnPoint, spawnBasicEntity } from "../admin/author.js";
import { loadScatterContent, spawnScatterEntity } from "../procgen/scatter-spawn.js";
import { parseEntityArg, type ItemService } from "../items/index.js";
import { GatherActionSchema, GatheringSystem } from "../gathering/index.js";
import { describeMatches, ItemActionSchema, ItemPickArgsSchema, LootArgsSchema, pickDef } from "../admin/items.js";
import type { SpawnTable } from "@mmo-engine/scatter";
import { createTransport, type HttpHandler, type Transport, type TransportKind, type WireSocket } from "./transport.js";
import { REGION_TOPIC } from "./sector.js";
import { ChannelTransport, type EdgePlan } from "./channel-transport.js";
import { encodePinned, homeSector, interestSectors, PINNED_SECTOR, SectorIndex, type InterestRadii, type SectorFrame } from "./interest.js";

const EMPTY_BYTES = new Uint8Array(0);
/** How long foes stay pinned after a blow (IM5): 10 s at 30 Hz. */
const COMBAT_PIN_TICKS = 300;
import {
  MAX_QUEUED_DELTAS,
  type ClientSession,
} from "../session.js";
import {
  AdminCommandSchema,
  AuthRateLimiter,
  CsvCredentialStore,
  DUMMY_HASH,
  hashPassword,
  parseHello,
  RegisterSchema,
  SessionManager,
  USERNAME_RE,
  verifyPassword,
  type CredentialStore,
  type SessionStore,
} from "../auth/index.js";
import {
  DeltaTracker,
  encodeDeltaFromSim,
  encodeSnapshotFromSim,
} from "../snapshot.js";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { STEP_MS, TickLoop } from "../tick-loop.js";
import { PartyBook, PartyOpSchema, type PartyResult, type PartyStore } from "../party.js";
import { GuildBook, GuildOpSchema, type GuildResult, type GuildStore } from "../guild.js";
import { FriendBook, FriendSchema } from "../friends.js";
import type { SocialStore } from "../social-store.js";
// Fallback during migration; removed once all bootstraps inject chatRules.
import * as builtInChat from "../chat.js";
import { CHARACTER_CAPSULE, IntentSystem, IntegrateSystem, type SimSystem } from "../systems.js";
import { clearOfStatics } from "../prop-collision.js";
import type { ScaleResolver } from "../scale.js";
import { CombatSystem } from "../combat.js";
import { DeathSystem } from "../death.js";
import { AbilitySystem } from "../abilities.js";
import { StatusSystem } from "../status.js";
import { TelegraphSystem } from "../telegraph.js";
import { DuelSystem } from "../duel.js";
import { WalletSystem } from "../economy/wallet.js";
import { TradeSystem } from "../economy/trade.js";
import { VendorSystem } from "../economy/vendor.js";
import { AuctionSystem } from "../economy/auction.js";
import { StatsSystem } from "../stats/stats-system.js";
import { SimWorld } from "../world.js";
import { decodeIntentMessage, sanitizeIntent } from "./intent.js";
import type { EntityPosition, MigrationHost } from "../world/migration.js";
import type { WorldCharacterSync } from "../world/character-sync.js";
import { itemInstanceId, type WorldAtomicOps } from "../world/atomic-ops.js";
import type { AtomicOpResult, MigrationRecord } from "@mmo-engine/world-server";
import type { MasterySystem } from "../stats/mastery-system.js";
import { Mana, type MagicSystem } from "../magic.js";
import type { BodySystem } from "../body.js";
import { PlayTelemetry } from "../stats/telemetry.js";
import { parseLook, withHeld, withLost, type ModularCatalog } from "@mmo-engine/art/character";
import {
  CharacterRefusedError,
  checkNewLook,
  CreateCharacterSchema,
  DEFAULT_LOOK_JSON,
  DEFAULT_MAX_CHARACTERS,
  EnterWorldSchema,
  MAX_CREATE_PAYLOAD_BYTES,
  MemoryCharacterStore,
  type CharacterRecord,
  type CharacterStore,
} from "../characters/index.js";

/**
 * Cross-region presence (roadmap S2): the world directory behind friends
 * lists elsewhere. The region reports its online character names and
 * asks where names play; merges only ever add online rows, so a slow
 * world delays presence but never flaps it.
 */
export interface PresenceAdapter {
  /** Replace this region's online character names; fire-and-forget. */
  report(names: string[]): void;
  /** Region per name for characters online anywhere; null when nowhere. */
  query(names: string[]): Promise<Record<string, string | null>>;
}

/**
 * Chat rule bundle (complete-modularity slice 1). Everything the gateway
 * needs from the chat module, as an injectable interface. The built-in
 * implementation lives in ../chat.js; modules/chat/server.js re-exports it.
 */
export interface ChatRules {
  ChatSchema: typeof builtInChat.ChatSchema;
  CHAT_COOLDOWN_MS: typeof builtInChat.CHAT_COOLDOWN_MS;
  SAY_RANGE_M: typeof builtInChat.SAY_RANGE_M;
  NOT_ONLINE: typeof builtInChat.NOT_ONLINE;
  BlockList: typeof builtInChat.BlockList;
  BlockSchema: typeof builtInChat.BlockSchema;
  allowAllText: typeof builtInChat.allowAllText;
  TextFilter: builtInChat.TextFilter;
}

export interface GatewayOptions {
  /** Port to bind; 0 = ephemeral (listen() returns the actual port). */
  port?: number;
  /**
   * Chat rules bundle (complete-modularity slice 1). The gateway no longer
   * imports the chat module directly — the server bootstrap loads
   * modules/chat/server.js and injects its exports here. A third-party
   * chat module replaces those exports with its own rules.
   * Default: the built-in rules (backward compat during migration).
   */
  chatRules?: ChatRules;
  /** Heartbeat ping cadence. Default 5000 ms. */
  heartbeatIntervalMs?: number;
  /** Missed heartbeats before the client is dropped. Default 3. */
  maxMissedHeartbeats?: number;
  /** How long a disconnected player entity survives. Default 30000 ms. */
  disconnectGraceMs?: number;
  /** Full snapshot broadcast cadence, in ticks. Default 300. */
  snapshotEveryTicks?: number;
  /** Sim systems; default [StatsSystem, IntentSystem, CombatSystem, IntegrateSystem]. */
  systems?: SimSystem[];
  /** Clock for heartbeat/grace math; default Date.now. Inject in tests. */
  clock?: () => number;
  /**
   * Use this pre-built world instead of a fresh SimWorld (slice 1.4:
   * boot-from-snapshot). The gateway commits it as the delta baseline,
   * so restored clients see restored state with no resync storm.
   */
  world?: SimWorld;
  /**
   * First server tick to run (slice 1.4: resume at restored tick + 1).
   * Must be >= 1. Default 1.
   */
  startTick?: number;
  /**
   * Account lookup boundary. Default: CsvCredentialStore at
   * ./data/users.csv (created 0600 on first use). Inject a temp-path
   * store in tests.
   */
  credentialStore?: CredentialStore;
  /**
   * The accounts' characters. Default: in memory (lost on restart) — the
   * production server passes a SqliteCharacterStore.
   */
  characterStore?: CharacterStore;
  /**
   * Persistence P4: world-tier character records + session locks
   * (fleet mode). When present, a character's login acquires its world
   * session lock and seeds the local store from the world record
   * before the avatar spawns, working saves also write uphill, and
   * logout (grace expiry, shutdown, migration commit) commits finally
   * and releases the lock. Absent: local-only behaviour, unchanged
   * (standalone mode never passes one).
   */
  worldCharacters?: WorldCharacterSync;
  /**
   * Atomic operations (slice A2, fleet mode): the world-tier commit
   * path for the economy trade/vendor/auction settlements and the
   * item grant path. When present, a completing trade accept, a
   * vendor buy/sell, an auction buyout, and an admin `give` route
   * their commit step through the world tier and apply the settled
   * outcome; negotiation, validation, and rate limits stay in the
   * region handlers. A world rejection or outage fails the operation
   * closed (4005, nothing committed locally). Absent: every path is
   * the local one, unchanged (standalone mode never passes one).
   */
  atomicOps?: WorldAtomicOps;
  /** Guild persistence (S4b). Default: in memory; the production server passes a SqliteGuildStore. */
  guildStore?: GuildStore;
  /** Party persistence (S3b). Default: in memory; the production server passes a SqlitePartyStore. */
  partyStore?: PartyStore;
  /** Friends and blocks persistence (S2c). Default: in memory; the production server passes a SqliteSocialStore. */
  socialStore?: SocialStore;
  /**
   * Cross-region presence (S2): the world directory behind friends lists
   * elsewhere. Absent: presence stays local (unit tests, standalone dev).
   */
  presence?: PresenceAdapter;
  /**
   * The modular part catalog new characters' looks are checked against;
   * null/absent = structural checks only (a server without the art).
   */
  characterCatalog?: ModularCatalog | null;
  /** Characters an account may have. Default 8, or social.characters.slots; this option wins over both. */
  maxCharacters?: number;
  /**
   * Party, guild, chat and character slot limits (content/rules/social.json,
   * EG9). Absent: the built-in constants. setSocial replaces them live.
   */
  social?: SocialRules;
  /** Session token TTL. Default 24 h. */
  sessionTtlMs?: number;
  /** Durable session tokens (edge/core split E3); absent = memory only. */
  sessionStore?: SessionStore;
  /** Auth rate limit: { maxFailures, windowMs }. Defaults 5 / 60_000. */
  authRateLimit?: { maxFailures?: number; windowMs?: number };
  /**
   * In-client account creation (protocol 0x0b, `register`). Dev
   * convenience: the login screen can create an account without the
   * `seed:user` CLI. Default true; set MMO_ALLOW_REGISTER=0 (or pass
   * false) to disable — do that before any public deployment, since an
   * open endpoint lets anyone mint accounts.
   */
  allowRegister?: boolean;
  /**
   * Admin console (roadmap A1): usernames that may send admin commands
   * (protocol 0x10). Explicit list only — the credential store keeps
   * exactly username+hash rows, so adminhood lives here, not in the
   * account file. Default: MMO_ADMINS (comma-separated) or empty.
   */
  admins?: string[];
  /**
   * Development server: every account is an admin (roadmap A1: "every
   * account on a development server"). Default: MMO_DEV_SERVER=1.
   * Never set this on a public deployment.
   */
  devServer?: boolean;
  /**
   * Spawn-table archetypes for the admin `spawn` command (roadmap A3).
   * Default: the forest table, loaded once on first use. Inject a small
   * table in tests.
   */
  spawnTable?: SpawnTable;
  /** The global scale for admin-spawned props (default: none). */
  scale?: ScaleResolver;
  /**
   * Region chat text filter (roadmap S1): return false to reject a line.
   * Default allows everything that passes shape limits; a profanity or
   * abuse service plugs in here without gateway changes.
   */
  textFilter?: builtInChat.TextFilter;
  /**
   * Items in the world (roadmap M3a): pickups and drops (0x13), bags
   * (0x14), what lies on the ground (0x15), and the item admin commands.
   * The same instance must also be in `systems` (it expires ground
   * items each tick). Absent: item messages are refused.
   */
  items?: ItemService;
  /**
   * Editor-only read-only debug answers (protocol v3, 0x0a). Injected
   * by the production server via makeDebugSource(); when absent, the
   * `tiles` query answers [] and `waypoints` answers "unknown". The
   * gateway never reaches past this interface into sim internals.
   */
  debugSource?: DebugSource;
  /**
   * Authoritative chunk heightfield source (slice 4.1: terrain-height
   * channel). When present, the gateway attaches 16x16 heights to chunk
   * rows on network snapshots/deltas so the mirror can displace terrain
   * meshes. Absent in tests and anywhere without the native addon.
   * Never used on the persistence path.
   */
  chunkSource?: ChunkDataSource;
  /**
   * World seed for on-demand tile generation (protocol 0x22). Required
   * when chunkSource is present; tiles are generateChunk(seed, cx, cz, 0).
   */
  worldSeed?: bigint;
  /**
   * Ground height at world (x, z): new players spawn standing on it.
   * Default: y = 0 (flat test worlds).
   */
  groundHeightAt?: (x: number, z: number) => number;
  /**
   * The mastery system in the tick list (M1b): characters' skills are saved
   * from and restored into its sheets. Share the one instance. Default: skills
   * are not persisted.
   */
  mastery?: MasterySystem;
  /**
   * The body system in the tick list (M2): each player is sent their own
   * body (0x18) as it changes. Default: no body messages.
   */
  body?: BodySystem;
  /**
   * The magic system in the tick list (mana): each player is sent their
   * mana (0x1c) as it changes, and casts spells through it. Default: none.
   */
  magic?: MagicSystem;
  /**
   * Admin `spawn <creature>`: the creature ids this world knows and a pack
   * spawner (AI1). Default none: only scatter assets spawn.
   */
  creatures?: {
    has(kind: string): boolean;
    spawnPack(sim: SimWorld, kind: string, x: number, z: number): number[];
    /** A creature entity's display name (rides 0x12 names, U12a); undefined if not one. */
    nameOf?(e: number): string | undefined;
    /** Every live creature entity, for a joining player's names. */
    entities?(): Iterable<number>;
  };
  /** Centre of the spawn grid, world units. Default (0, 0). */
  spawnPoint?: { x: number; z: number };
  /**
   * The spawn point was chosen for this run (the editor's Play menu
   * "Start from"): characters enter there instead of where they were
   * saved. Vitals and skills are still restored. Default false.
   */
  spawnOverridden?: boolean;
  /** A baked world's extent and coarse map, sent in every welcome. */
  worldInfo?: WorldInfo;
  /** The world's day clock, sent in every welcome (clients derive the time of day from the tick). */
  dayClock?: DayClock;
  /**
   * What new players can do (protocol Ability bits). Default: swim.
   * Flight is for expansions to grant (MMO_PLAYER_ABILITIES=swim,fly).
   */
  playerAbilities?: number;
  /**
   * HTTP requests on the game port (webrpc services, binary downloads):
   * return true when handled. Everything else gets 404; WebSocket
   * upgrades go to the gateway.
   */
  http?: HttpHandler;
  /**
   * The socket library behind the port (see ./transport.ts): "uws"
   * (uWebSockets.js), "ws", or "auto" (uws when it loads). Default:
   * MMO_TRANSPORT, else auto. A Transport itself serves the port that way
   * (the edge's relay, ChannelTransport).
   */
  transport?: TransportKind | Transport;
  /**
   * Largest inbound WebSocket frame accepted, bytes. Default 64 KiB
   * (see MAX_CLIENT_PAYLOAD_BYTES).
   *
   * Every message a client sends is small: an intent is a few dozen bytes
   * of FlatBuffers, and the largest control frame (a character look) is
   * capped at MAX_CREATE_PAYLOAD_BYTES = 4 KiB. Without a cap, a socket
   * library buffers the whole frame before any handler runs (`ws`
   * defaults to 100 MiB), so one unauthenticated peer could spend tens of
   * MiB of server memory per connection with a single oversized frame.
   * The transports refuse an oversized frame at the protocol layer: the
   * connection closes (ws: 1009) without the payload being buffered, so
   * onMessage never even runs. See the "untrusted input" tests.
   *
   * Operators: keep this above ~8 KiB — a character look alone may be 4
   * KiB plus its envelope. content/rules/ingress.json tunes it without a
   * code change (see GatewayOptions.ingress); this option overrides it.
   */
  maxClientPayloadBytes?: number;
  /**
   * Ingress rate limits (roadmap T1): per-session intent and pickup
   * budgets, tuned in content/rules/ingress.json. Partial: absent fields
   * take the defaults (see DEFAULT_INGRESS). The production server
   * passes `game.rules.ingress` here.
   */
  ingress?: Partial<IngressLimits>;
  /**
   * Features outside the gateway that own a 0x11 `kind` (quests: "quest").
   * Each gets that kind's messages from characters in the world, and hears
   * when they enter and leave (see ./extension.ts).
   */
  extensions?: GatewayExtension[];
  /**
   * Per-tick deltas fan out via sector-topic publish (Phase 5, Part A):
   * one publish per occupied sector topic instead of one send per
   * socket, with identical FlatBuffers bytes. Default true; false keeps
   * the per-socket send loop (e.g. when a transport's publish is
   * suspected). Snapshot ticks and resyncing sessions always use the
   * per-socket path either way.
   */
  sectorBroadcast?: boolean;
  /**
   * Interest management (IM3): each client gets only the sectors near its
   * avatar, as a DeltaSet of shared per-sector bytes. Radii in metres;
   * absent = every client gets the whole region (today's path).
   */
  interest?: InterestRadii;
}

const avatarQuery = defineQuery([C.PlayerIntent]);

/** 0x19 stance (M3): ids are checked against the rules by CombatSystem. */
const StanceSchema = z
  .object({
    kind: z.literal("stance"),
    technique: z.string().min(1).max(32).nullable().optional(),
    aim: z.string().min(1).max(32).nullable().optional(),
  })
  .strict();

/** 0x1d ability trigger (M5): the id is checked by AbilitySystem. */
const AbilityTriggerSchema = z
  .object({
    kind: z.literal("trigger"),
    id: z.string().min(1).max(64),
  })
  .strict();

/** 0x20 duel actions (M5). */
const DuelActionSchema = z
  .object({
    kind: z.literal("duel"),
    action: z.enum(["challenge", "accept", "decline", "yield"]),
    target: z.string().min(1).max(32).optional(),
  })
  .strict();

/** 0x21 trade actions (EC1). */
const TradeActionSchema = z
  .object({
    kind: z.literal("trade"),
    action: z.enum(["open", "offer", "accept", "cancel"]),
    target: z.string().min(1).max(32).optional(),
    id: z.number().int().positive().optional(),
    gold: z.number().int().min(0).max(999999999).optional(),
    addItem: z.number().int().positive().optional(),
    removeItem: z.number().int().positive().optional(),
  })
  .strict();

/** 0x21 vendor actions (EC1). */
const VendorActionSchema = z
  .object({
    kind: z.literal("vendor"),
    action: z.enum(["list", "buy", "sell"]),
    vendor: z.string().min(1).max(32).optional(),
    def: z.number().int().min(0).optional(),
    item: z.number().int().positive().optional(),
  })
  .strict();

/** 0x21 auction actions (EC1). */
const AuctionActionSchema = z
  .object({
    kind: z.literal("auction"),
    action: z.enum(["list", "bid", "buyout", "cancel", "browse"]),
    listing: z.number().int().positive().optional(),
    item: z.number().int().positive().optional(),
    amount: z.number().int().positive().max(999999999).optional(),
    startBid: z.number().int().positive().max(999999999).optional(),
    buyout: z.number().int().min(0).max(999999999).optional(),
    durationMs: z.number().int().positive().max(48 * 3600 * 1000).optional(),
  })
  .strict();

/** Admin `gold` args (A5/EC1). */
const GoldArgsSchema = z
  .object({
    amount: z.number().int().positive().max(999999999),
  })
  .strict();

/** Admin `vendor` args (EC1). */
const VendorArgsSchema = z
  .object({
    sub: z.enum(["define", "stock", "attach", "detach", "spawn", "disable", "enable", "remove", "list"]),
    id: z.string().min(1).max(32).optional(),
    name: z.string().min(1).max(64).optional(),
    buyback: z.number().min(0).max(1).optional(),
    def: z.number().int().min(0).optional(),
    price: z.number().int().positive().optional(),
    qty: z.number().int().optional(),
    target: z.string().min(1).max(32).optional(),
    x: z.number().optional(),
    z: z.number().optional(),
  })
  .strict();

/** 0x1a treat (M4): the part is checked against the rules by BodySystem. */
const TreatSchema = z
  .object({
    kind: z.literal("treat"),
    target: z.string().regex(/^\d{1,20}$/).optional(),
    part: z.string().min(1).max(32).optional(),
    stop: z.boolean().optional(),
  })
  .strict();

/** 0x1c cast: the spell is checked against the rules by MagicSystem. */
const CastSchema = z
  .object({
    kind: z.literal("cast"),
    spell: z.string().min(1).max(32).optional(),
    target: z.string().regex(/^\d{1,20}$/).optional(),
    stop: z.boolean().optional(),
  })
  .strict()
  .refine((m) => m.stop === true || m.spell !== undefined);

/**
 * Despawn login avatars restored from a snapshot. In a gateway-owned
 * world the only PlayerIntent entities are avatars spawned per login,
 * and sessions (with their tokens) live in memory only — after a restart
 * nothing can ever re-attach to or grace-expire a restored avatar, so it
 * would stand in the world forever, one more per restart. Call once
 * after SnapshotStore.restoreInto, before accepting connections.
 * Returns how many were removed.
 */
export function despawnSessionlessAvatars(world: SimWorld): number {
  // Copy: despawning mutates the live query result.
  const eids = Array.from(avatarQuery(world.ecs));
  for (const eid of eids) world.despawn(eid);
  return eids.length;
}

/** One answered admin command (roadmap A1: the command log). */
export interface AdminLogEntry {
  /** Clock ms when the command was answered. */
  at: number;
  /** Account that sent it. */
  username: string;
  /** Command name (parsed, so always well-formed). */
  command: string;
  /** Whether it ran (false: rejected — not admin, unknown, malformed). */
  ok: boolean;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;
/** One finished tick, as the gateway hands it to tick listeners (E3). */
export interface GatewayTick {
  tick: number;
  /** The FlatBuffers delta every client got this tick. */
  delta: Uint8Array;
  /** This tick's gameplay events: hits (0x16), deaths/respawns (0x17), abilities (0x1d), telegraphs (0x1e), statuses (0x1f), duels (0x20). */
  events: Array<HitMessage | LifeMessage | AbilityMessage | TelegraphMessage | StatusMessage | DuelMessage | TradeMessage | WalletMessage | VendorMessage | AuctionMessage>;
  /** Encodes a full snapshot of this tick on demand (costly: call on snapshot ticks only). */
  fullState(): Uint8Array;
}

type QueuedIntentFields = Parameters<SimWorld["queueIntent"]>[1];

const DISCONNECT_GRACE_MS = 30000;
const SNAPSHOT_EVERY_TICKS = 300;
const TICK_HZ = 30;
/** How often a player's body is checked for changes to send (catalog 0x18): 5 times a second. */
const BODY_EVERY_TICKS = 6;
/** How often a player's skills are checked for a change worth sending (0x1b, M4). */
const SKILLS_EVERY_TICKS = 30;
/** Admin command log keeps the last N entries (roadmap A1). */
const ADMIN_LOG_SIZE = 200;
/**
 * Largest inbound frame accepted, bytes. 64 KiB is ~16x the largest
 * legitimate client message (a character look, capped at 4 KiB) and ~1000x
 * a typical intent, so it cannot reject valid traffic — but it stops a
 * single unauthenticated frame from costing tens of MiB of buffered
 * memory. The transports close a connection whose frame exceeds this
 * (ws: code 1009) before allocating the payload.
 */
const MAX_CLIENT_PAYLOAD_BYTES = 64 * 1024;

/**
 * Per-session ingress budgets (roadmap T1). The tunable values live in
 * content/rules/ingress.json (see @mmo-engine/rules IngressSchema); the
 * production server passes that file's table as GatewayOptions.ingress.
 * These defaults mirror the schema's, so a gateway without rules behaves
 * the same as one with an empty ingress.json.
 */
export interface IngressLimits {
  /** Largest inbound WebSocket frame accepted, bytes. */
  maxClientPayloadBytes: number;
  /** Intent tokens refilled per second, per session. */
  intentsPerSecond: number;
  /** Most intents a session may burst at once. */
  intentBurst: number;
  /** Pickup tokens refilled per second, per session. */
  pickupsPerSecond: number;
  /** Most pickups a session may burst at once. */
  pickupBurst: number;
  /** Seconds an abuse window spans. */
  abuseWindowSeconds: number;
  /** Excess messages inside one window before the session is disconnected. */
  maxViolations: number;
}

const DEFAULT_INGRESS: IngressLimits = {
  maxClientPayloadBytes: MAX_CLIENT_PAYLOAD_BYTES,
  intentsPerSecond: 40,
  intentBurst: 60,
  pickupsPerSecond: 5,
  pickupBurst: 10,
  abuseWindowSeconds: 10,
  maxViolations: 100,
};

/**
 * Merge a partial ingress table over the defaults, checked the way the
 * rules schema checks the file: positive integers where counting
 * matters, positive rates and windows elsewhere. Throws RangeError —
 * a bad table must fail loudly at construction, never silently unlimit
 * the gateway.
 */
export function resolveIngressLimits(partial: Partial<IngressLimits> | undefined): IngressLimits {
  const merged: IngressLimits = { ...DEFAULT_INGRESS, ...partial };
  const ints: Array<[keyof IngressLimits, number]> = [
    ["maxClientPayloadBytes", merged.maxClientPayloadBytes],
    ["intentBurst", merged.intentBurst],
    ["pickupBurst", merged.pickupBurst],
    ["maxViolations", merged.maxViolations],
  ];
  for (const [name, v] of ints) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new RangeError(`gateway: ingress.${name} must be a positive integer (got ${partial?.[name]})`);
    }
  }
  const nums: Array<[keyof IngressLimits, number]> = [
    ["intentsPerSecond", merged.intentsPerSecond],
    ["pickupsPerSecond", merged.pickupsPerSecond],
    ["abuseWindowSeconds", merged.abuseWindowSeconds],
  ];
  for (const [name, v] of nums) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new RangeError(`gateway: ingress.${name} must be a positive number (got ${partial?.[name]})`);
    }
  }
  return merged;
}

/**
 * Usernames from MMO_ADMINS (comma-separated). Invalid names are dropped
 * — the username charset is shared with the credential store, so only
 * well-formed names can ever match.
 */
const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** A player's hand-off state (Gateway.handoffSerialize), checked on arrival. */
const HandoffStateSchema = z.object({
  username: z.string().regex(USERNAME_RE),
  character: z.object({ id: z.number().int(), name: z.string().max(64), look: z.string().max(4096) }).nullable(),
  pos: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  health: z.number().finite(),
  stamina: z.number().finite(),
  mana: z.number().finite().nullable().optional(),
  skills: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])).nullable(),
  ticketHash: z.string().regex(/^[0-9a-f]{64}$/),
});

function parseHandoffState(state: unknown): z.infer<typeof HandoffStateSchema> | null {
  const r = HandoffStateSchema.safeParse(state);
  return r.success ? r.data : null;
}

/** A discipline's `requires` map as the wire's list (M4). */
function requirements(requires: Readonly<Record<string, number>>): { skill: string; level: number }[] {
  return Object.entries(requires).map(([skill, level]) => ({ skill, level }));
}

function parseAdminList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const name of raw.split(",")) {
    const username = name.trim();
    if (/^[A-Za-z0-9_-]{3,32}$/.test(username) && !out.includes(username)) out.push(username);
  }
  return out;
}

export class Gateway {
  /**
   * The authoritative world. The gateway translates; the world simulates.
   * Injected via opts.world on restore-from-snapshot boots, otherwise a
   * fresh SimWorld.
   */
  readonly world: SimWorld;

  private readonly opts: Required<
    Omit<
      GatewayOptions,
      | "port"
      | "systems"
      | "clock"
      | "world"
      | "credentialStore"
      | "characterStore"
      | "guildStore"
      | "socialStore"
      | "presence"
      | "partyStore"
      | "characterCatalog"
      | "maxCharacters"
      | "social"
      | "sessionTtlMs"
      | "sessionStore"
      | "authRateLimit"
      | "textFilter"
      | "debugSource"
      | "chunkSource"
      | "worldSeed"
      | "chatRules"
      | "maxClientPayloadBytes"
      | "ingress"
      | "groundHeightAt"
      | "mastery"
      | "body"
      | "magic"
      | "creatures"
      | "spawnPoint"
      | "spawnOverridden"
      | "worldInfo"
      | "dayClock"
      | "playerAbilities"
      | "http"
      | "transport"
      | "spawnTable"
      | "scale"
      | "extensions"
      | "items"
      | "sectorBroadcast"
      | "interest"
      | "worldCharacters"
      | "atomicOps"
    >
  > & { port: number };
  private readonly systems: SimSystem[];
  private readonly clock: () => number;
  private readonly loop: TickLoop;
  private readonly tracker = new DeltaTracker();
  private readonly sessions = new Map<string, ClientSession>();
  /** Server-issued session tokens (auth slice) — the client identity. */
  private readonly authSessions: SessionManager;
  /** Per-IP failure budget for auth attempts. */
  private readonly rateLimiter: AuthRateLimiter;
  private readonly credentialStore: CredentialStore;
  private readonly characterStore: CharacterStore;
  /** Persistence P4 world-tier character sync (fleet mode); null standalone. */
  private readonly worldCharacters: WorldCharacterSync | null;
  /** Atomic operations commit path (slice A2, fleet mode); null standalone. */
  private readonly atomicOps: WorldAtomicOps | null;
  private readonly characterCatalog: ModularCatalog | null;
  private maxCharacters: number;
  /** GatewayOptions.maxCharacters was given, so social.json's slots don't apply. */
  private readonly fixedMaxCharacters: boolean;
  /** social.json (EG9), or null for the chat module's own range and cooldowns. */
  private social: SocialRules | null = null;
  /**
   * Editor-only read-only debug answers (protocol v3, 0x0a).
   * Injected by the production server via makeDebugSource(); null →
   * tile queries answer [] and waypoint queries answer "unknown".
   * The gateway never reaches past this interface into sim internals.
   */
  private readonly debugSource: DebugSource | null;
  /**
   * Authoritative heightfield source for the terrain-height channel.
   * Null in tests / when the native addon is unavailable — snapshots
   * then carry chunk metadata without heights, as before.
   */
  private readonly chunkSource: ChunkDataSource | null;
  /** World seed for on-demand tile generation (0x22). */
  private readonly worldSeed: bigint | null;
  private readonly groundHeightAt: ((x: number, z: number) => number) | null;
  private readonly mastery: MasterySystem | null;
  private readonly body: BodySystem | null;
  private readonly magic: MagicSystem | null;
  /** The body message last sent to each session, as its JSON (see sendBody). */
  private readonly bodySent = new WeakMap<ClientSession, string>();
  private readonly skillsSent = new WeakMap<ClientSession, string>();
  private readonly manaSent = new WeakMap<ClientSession, string>();
  /** Play counters and tick timing (T2); read by the admin `stats` command. */
  readonly telemetry = new PlayTelemetry();
  private readonly creatures: GatewayOptions["creatures"] | null;
  private readonly spawnPoint: { x: number; z: number };
  private readonly spawnOverridden: boolean;
  private readonly worldInfo: WorldInfo | null;
  private readonly dayClock: DayClock | null;
  /** Forced weather (`weather` command); auto follows the sky. Resets on restart. */
  private weatherOverride: WeatherOverride = "auto";
  private readonly playerAbilities: number;
  /** Who blocks whom, by account (S2). */
  private readonly blocks: InstanceType<ChatRules["BlockList"]>;
  private readonly friends: FriendBook;
  /** Cross-region presence adapter (S2); null: presence stays local. */
  private readonly presence: PresenceAdapter | null;
  /** Parties, in memory (S3). */
  private readonly parties: PartyBook;
  private readonly guilds: GuildBook;
  /** Region chat text filter (GatewayOptions.textFilter). */
  private readonly textFilter: builtInChat.TextFilter;
  /** Chat rules bundle (GatewayOptions.chatRules; slice 1: injectable module). */
  private readonly chatRules: ChatRules;
  private readonly extensions = new Map<string, GatewayExtension>();
  /** Items (see GatewayOptions.items); shared with the systems list. */
  private readonly items: ItemService | null;
  /** Bag owners for sessions that play no character: one negative id per account. */
  private readonly accountHolders = new Map<string, number>();
  /** Largest inbound frame accepted, bytes (see GatewayOptions). */
  private readonly maxClientPayloadBytes: number;
  /** Per-session intent/pickup budgets (roadmap T1; see GatewayOptions.ingress). */
  private ingress: IngressLimits;
  /** Excess messages dropped by the rate limiter, all sessions (diagnostic totals). */
  private droppedByRateLimitIntents = 0;
  private droppedByRateLimitPickups = 0;
  /** Sessions disconnected for sustained abuse (diagnostic total). */
  private abuseDisconnects = 0;
  /** Identity map, now keyed by session token: token -> clientId. */
  private readonly tokenToClient = new Map<string, string>();
  /** Region migration (B2): hand-off tickets by entity, between serialize and redirect. */
  private readonly handoffTickets = new Map<string, string>();
  /** Region migration (B2): arrived players waiting for their client, by clientId. */
  private readonly handoffArrivals = new Map<string, { migrationId: string; ticketHash: string }>();
  private acceptMigration: ((migrationId: string, verify: (m: MigrationRecord) => boolean) => Promise<boolean>) | null = null;
  /** The stats version last sent to each session (see sendStats). */
  private readonly statsSent = new WeakMap<ClientSession, string>();
  /** Usernames allowed admin commands (GatewayOptions.admins). */
  private readonly admins: Set<string>;
  /** Development server: every account is an admin (GatewayOptions.devServer). */
  private readonly devServer: boolean;
  /** Recent admin commands, oldest first (roadmap A1: the command log). */
  private readonly adminLog: AdminLogEntry[] = [];
  /**
   * Spawn-table archetypes for the admin `spawn` command (roadmap A3).
   * Injected for tests; otherwise the forest table, loaded once on
   * first use so addon-less boots never pay for it.
   */
  private spawnTable: SpawnTable | null = null;
  private readonly scale: ScaleResolver | undefined;

  private readonly transportKind: TransportKind | Transport | undefined;
  private transport: Transport | null = null;
  /** Per-tick deltas fan out via sector-topic publish (Phase 5, Part A). Default true. */
  private readonly sectorBroadcast: boolean;
  /** Interest radii, or null when every client sees the whole region. */
  private readonly interest: InterestRadii | null;
  private readonly sectorIndex = new SectorIndex();
  private httpHandler: HttpHandler | null;
  private tickTimer: NodeJS.Timeout | null = null;
  private clientSeq = 0;
  private playerSeq = 0;
  /** Last completed server tick (0 before the first tick). */
  private tick = 0;
  private lastHeartbeatMs = 0;

  constructor(opts: GatewayOptions = {}) {
    this.opts = {
      port: opts.port ?? 0,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      maxMissedHeartbeats: opts.maxMissedHeartbeats ?? MAX_MISSED_HEARTBEATS,
      disconnectGraceMs: opts.disconnectGraceMs ?? DISCONNECT_GRACE_MS,
      snapshotEveryTicks: opts.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS,
      startTick: opts.startTick ?? 1,
      allowRegister:
        opts.allowRegister ?? process.env.MMO_ALLOW_REGISTER !== "0",
      admins: opts.admins ?? parseAdminList(process.env.MMO_ADMINS),
      devServer: opts.devServer ?? process.env.MMO_DEV_SERVER === "1",
    };
    if (!Number.isInteger(this.opts.startTick) || this.opts.startTick < 1) {
      throw new RangeError(
        `gateway: startTick must be an integer >= 1 (got ${opts.startTick})`,
      );
    }
    this.world = opts.world ?? new SimWorld();
    this.ingress = resolveIngressLimits(opts.ingress);
    this.maxClientPayloadBytes =
      opts.maxClientPayloadBytes ?? this.ingress.maxClientPayloadBytes;
    if (
      !Number.isInteger(this.maxClientPayloadBytes) ||
      this.maxClientPayloadBytes <= 0
    ) {
      throw new RangeError(
        `gateway: maxClientPayloadBytes must be a positive integer (got ${opts.maxClientPayloadBytes})`,
      );
    }
    this.systems = opts.systems ?? [new StatsSystem(), new IntentSystem(), new CombatSystem(TICK_HZ), new IntegrateSystem()];
    this.clock = opts.clock ?? Date.now;
    this.guilds = new GuildBook(() => this.clock(), opts.guildStore);
    this.parties = new PartyBook(() => this.clock(), opts.partyStore);
    this.chatRules = opts.chatRules ?? (builtInChat as unknown as ChatRules);
    this.blocks = new this.chatRules.BlockList(opts.socialStore);
    this.friends = new FriendBook(opts.socialStore);
    this.presence = opts.presence ?? null;
    this.credentialStore = opts.credentialStore ?? new CsvCredentialStore();
    this.characterStore = opts.characterStore ?? new MemoryCharacterStore();
    this.worldCharacters = opts.worldCharacters ?? null;
    this.atomicOps = opts.atomicOps ?? null;
    this.characterCatalog = opts.characterCatalog ?? null;
    this.maxCharacters = opts.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.fixedMaxCharacters = opts.maxCharacters !== undefined;
    if (opts.social) this.setSocial(opts.social);
    this.debugSource = opts.debugSource ?? null;
    this.chunkSource = opts.chunkSource ?? null;
    this.worldSeed = opts.worldSeed ?? null;
    this.groundHeightAt = opts.groundHeightAt ?? null;
    this.mastery = opts.mastery ?? null;
    this.body = opts.body ?? null;
    this.magic = opts.magic ?? null;
    this.creatures = opts.creatures ?? null;
    this.spawnPoint = opts.spawnPoint ?? { x: 0, z: 0 };
    this.spawnOverridden = opts.spawnOverridden ?? false;
    this.worldInfo = opts.worldInfo ?? null;
    this.dayClock = opts.dayClock ?? null;
    this.playerAbilities = opts.playerAbilities ?? Ability.Swim;
    this.admins = new Set(this.opts.admins);
    this.devServer = this.opts.devServer;
    this.spawnTable = opts.spawnTable ?? null;
    this.scale = opts.scale;
    this.textFilter = opts.textFilter ?? this.chatRules.allowAllText;
    for (const ext of opts.extensions ?? []) this.extensions.set(ext.kind, ext);
    this.items = opts.items ?? null;
    this.httpHandler = opts.http ?? null;
    this.transportKind = opts.transport;
    this.sectorBroadcast = opts.sectorBroadcast ?? true;
    this.interest = opts.interest ?? null;
    this.authSessions = new SessionManager({
      ttlMs: opts.sessionTtlMs,
      clock: this.clock,
      store: opts.sessionStore,
    });
    this.rateLimiter = new AuthRateLimiter({
      ...opts.authRateLimit,
      clock: this.clock,
    });
    // Server ticks start at startTick (loop tick + startTick) so the
    // first delta is tick=startTick/base_tick=startTick-1, mirroring
    // the slice-1.2 sim driver exactly. On a restore boot, startTick =
    // restored tick + 1.
    const startTick = this.opts.startTick;
    this.loop = new TickLoop((i) => this.onTick(i + startTick));
    this.tracker.commit(this.world); // baseline: empty world
  }

  /** Last completed server tick. */
  get serverTick(): number {
    return this.tick;
  }

  /** Number of sessions (connected + in grace period). */
  clientCount(): number {
    return this.sessions.size;
  }

  /**
   * Replace the ingress budgets live (a rules reload applies between
   * ticks through here; the production server wires it in server.ts).
   * Checked like the constructor's table; live token balances are kept
   * but clamped to the new bursts.
   */
  updateIngress(partial: Partial<IngressLimits>): void {
    this.ingress = resolveIngressLimits(partial);
    for (const s of this.sessions.values()) {
      if (s.intentTokens > this.ingress.intentBurst) s.intentTokens = this.ingress.intentBurst;
      if (s.pickupTokens > this.ingress.pickupBurst) s.pickupTokens = this.ingress.pickupBurst;
    }
  }

  /** Rate-limiter diagnostics: dropped excess and abuse disconnects. */
  ingressStats(): { droppedIntents: number; droppedPickups: number; abuseDisconnects: number } {
    return {
      droppedIntents: this.droppedByRateLimitIntents,
      droppedPickups: this.droppedByRateLimitPickups,
      abuseDisconnects: this.abuseDisconnects,
    };
  }

  /** Bind the port (WebSocket + HTTP). Does NOT start the tick driver. */
  async listen(): Promise<number> {
    if (this.transport) throw new Error("gateway: already listening");
    const transport = typeof this.transportKind === "object" ? this.transportKind : createTransport(this.transportKind);
    this.transport = transport;
    return transport.listen(this.opts.port, {
      connection: (socket) => this.onConnection(socket),
      http: this.httpHandler,
      // Refuse an oversized frame at the protocol layer: the transports
      // close the connection (ws: 1009) instead of buffering the payload.
      maxMessageBytes: this.maxClientPayloadBytes,
    });
  }

  /** Fleet mode (PL3c): another region changed guilds, parties, friends or blocks, and the store holds them now. */
  reloadSocial(kind: "guild" | "party" | "friends" | "blocks"): void {
    if (kind === "guild") this.guilds.reload();
    else if (kind === "party") this.parties.reload();
    else if (kind === "friends") this.friends.reload();
    else this.blocks.reload();
  }

  /** Fleet mode (PL3c): new guilds and parties take world-wide ids from `next` (null: none on hand). */
  socialIds(kind: "guild" | "party", next: () => number | null): void {
    (kind === "guild" ? this.guilds : this.parties).ids = next;
  }

  /** Which socket library serves the port ("uws" or "ws"), once listening. */
  get transportName(): string | null {
    return this.transport?.kind ?? null;
  }

  /** Admin pause: the wall-clock driver skips ticks (step still runs one). */
  private paused = false;

  /**
   * Begin the wall-clock tick driver (production). Tests skip this and
   * drive frame() manually with a synthetic clock instead.
   */
  startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      if (this.paused) this.loop.rearm(this.clock());
      else this.loop.frame(this.clock());
    }, STEP_MS / 2);
    this.tickTimer.unref();
  }

  /**
   * A way in for a character arriving from another world (a dungeon
   * instance, roadmap D4): a session token for `username`, already entered
   * as `character`. The client says hello with `{token}` and lands here as
   * that character, at the spawn point; nothing is asked of the account's
   * password. Tokens last as long as any session's (sessionTtlMs).
   */
  admit(username: string, character: { id: number; name: string; look: string }): string {
    const token = this.authSessions.create(`admit-${character.id}`, username);
    const auth = this.authSessions.get(token);
    if (auth) auth.character = { ...character };
    return token;
  }

  /** The character names in `name`'s party, `name` included (just `[name]` without a party). */
  partyOf(name: string): string[] {
    const members = this.parties.partyOf(name);
    return members.length > 0 ? members : [name];
  }

  /** Advance the fixed-timestep loop manually (tests). Returns ticks run. */
  frame(nowMs: number): number {
    return this.loop.frame(nowMs);
  }

  async close(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Fleet mode (P4): shutdown is a logout for every character in
    // the world — final commit uphill + lock release, awaited but
    // never blocking teardown on a dead world (the sync logs and the
    // lock expires on its own). Standalone closes are unchanged.
    if (this.worldCharacters) {
      const departing: Promise<boolean>[] = [];
      for (const s of this.sessions.values()) {
        if (s.playerEntity === null || !s.character) continue;
        // A hand-off arrival not yet arrived holds no lock here and
        // its state is not ours to commit.
        if (this.handoffArrivals.has(s.clientId)) continue;
        this.saveAvatar(this.world.resolveWireId(s.playerEntity));
        departing.push(this.worldCharacters.logout(s.character.id));
      }
      await Promise.allSettled(departing);
    }
    for (const s of this.sessions.values()) {
      try {
        s.socket?.listen({ message() {}, close() {} });
        s.socket?.close(1000, "server shutdown");
      } catch {
        /* ignore teardown errors */
      }
      s.socket = null;
    }
    this.sessions.clear();
    this.tokenToClient.clear();
    this.authSessions.clear();
    // Sockets that never joined (no session) and HTTP keep-alives go with the port.
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }

  /**
   * Set the HTTP handler (see GatewayOptions.http) before listen(): for
   * services that authenticate through this gateway's sessions.
   */
  /**
   * Apply social.json (EG9): party and guild sizes and timeouts, the block
   * limit, chat reach, line length and cooldowns, and character slots. Takes
   * effect on the next action; parties, guilds and blocks already over a
   * lowered limit stay as they are.
   */
  setSocial(rules: SocialRules): void {
    this.social = rules;
    this.parties.setRules(rules.party);
    this.guilds.setRules(rules.guild);
    if ("limit" in this.blocks) (this.blocks as { limit: number }).limit = rules.chat.blockLimit;
    if (!this.fixedMaxCharacters) this.maxCharacters = rules.characters.slots;
  }

  /** Milliseconds between two lines on `channel` from one session. */
  private chatCooldownMs(channel: ChatChannel): number {
    const s = this.social?.chat.cooldownSeconds[channel];
    return s === undefined ? this.chatRules.CHAT_COOLDOWN_MS[channel] : s * 1000;
  }

  setHttpHandler(handler: HttpHandler): void {
    if (this.transport) throw new Error("gateway: set the HTTP handler before listen()");
    this.httpHandler = handler;
  }

  /**
   * The current HTTP handler (null: none). Services that mount after
   * construction (PCG, health) compose with it instead of replacing it.
   */
  getHttpHandler(): HttpHandler | null {
    return this.httpHandler;
  }

  /**
   * The account behind a live session token (the welcome's
   * session_token), or null: how HTTP services authenticate callers.
   */
  sessionUser(token: string): { username: string } | null {
    const session = this.authSessions.get(token);
    return session ? { username: session.username } : null;
  }

  // ------------------------------------------------------------ edge channel (E3)
  //
  // What the core's channel server (src/channel-server.ts) needs from the
  // gateway: the tick stream, password login, session lookups and intents
  // addressed by session token. Players still connect here directly until
  // the edge serves the client protocol.

  private readonly tickListeners: Array<(t: GatewayTick) => void> = [];

  /** Called after every tick's broadcast. */
  addTickListener(cb: (t: GatewayTick) => void): void {
    this.tickListeners.push(cb);
  }

  private readonly tickTimeListeners: Array<(ms: number) => void> = [];
  /** Per-tick durations and system costs, served to the editor's Debug workspace. */
  private readonly tickTimings = new TickTimings();

  /** Called with each tick's wall time in ms, once the tick is done (E6). */
  addTickTimeListener(cb: (ms: number) => void): void {
    this.tickTimeListeners.push(cb);
  }

  /**
   * Password login for a caller that is not a socket (the edge). Same
   * credential check and per-caller rate limit as a hello; the session is
   * not bound to a connection until a client presents its token.
   */
  async channelLogin(username: string, password: string, caller = "channel"): Promise<{ ok: true; token: string; playerId: string } | { ok: false; reason: string }> {
    if (this.rateLimiter.isLimited(caller)) return { ok: false, reason: "too many attempts, try again later" };
    if (!(await this.checkPassword(username, password))) {
      this.rateLimiter.recordFailure(caller);
      return { ok: false, reason: "auth failed" };
    }
    this.rateLimiter.recordSuccess(caller);
    return { ok: true, token: this.authSessions.create("", username), playerId: username };
  }

  /** Every live session token. */
  liveSessionTokens(): string[] {
    return this.authSessions.tokens();
  }

  /**
   * Queue an intent for the player a session token is in the world as.
   * Sanitized like a socket's intent; refused when the token has no player.
   */
  queueTokenIntent(token: string, intent: QueuedIntentFields): "ok" | "no_session" | "no_player" | "bad_intent" {
    if (!this.authSessions.get(token)) return "no_session";
    const clientId = this.tokenToClient.get(token);
    const s = clientId ? this.sessions.get(clientId) : undefined;
    if (!s || !s.welcomed || s.playerEntity === null) return "no_player";
    const clean = sanitizeIntent(intent);
    if (clean === null) return "bad_intent";
    this.world.queueIntent(parseWireEntityId(s.playerEntity).slot, clean);
    return "ok";
  }

  // ------------------------------------------------------------ tick

  private onTick(tick: number): void {
    const t0 = performance.now();
    this.runTick(tick);
    const ms = performance.now() - t0;
    this.telemetry.tickMs(ms);
    for (const l of this.tickTimeListeners) l(ms);
    this.tickTimings.endTick(ms);
  }

  /** Snapshot for the editor's Debug workspace (via the debug API). */
  getTickTimings(): ReturnType<TickTimings["snapshot"]> {
    return this.tickTimings.snapshot();
  }

  private runTick(tick: number): void {
    this.tick = tick;
    const sim = this.world;
    sim.beginTick(tick); // drain intent events into PlayerIntent components
    const dt = STEP_MS / 1000;
    // Each system's cost feeds the editor's Debug workspace (tick timings).
    const timings = this.tickTimings;
    for (const s of this.systems) {
      const t0 = performance.now();
      s.step(sim, dt);
      timings.recordSystem(s.name, performance.now() - t0);
    }
    sim.emitTick(tick);
    const events: Array<HitMessage | LifeMessage | AbilityMessage | TelegraphMessage | StatusMessage | DuelMessage | TradeMessage | WalletMessage | VendorMessage | AuctionMessage> = [
      ...this.sendHits(sim, tick),
      ...this.sendLife(sim, tick),
      ...this.sendAbilities(sim, tick),
      ...this.sendTelegraphs(sim, tick),
      ...this.sendStatuses(sim, tick),
      ...this.sendDuels(sim, tick),
      ...this.sendTrades(sim, tick),
      ...this.sendWallets(sim, tick),
      ...this.sendAuctions(sim, tick),
    ];
    this.sendResources(sim);
    this.dropFromUselessHands(sim);
    this.showLostParts(sim);
    this.sendTreatments(sim);
    this.sendSpells(sim);

    // Names for newly spawned character entities ride before the delta
    // that first shows them (catalog §0x12).
    const spawned = sim.spawnedWireIds();
    const namesEnv = this.namesFor(spawned);
    const dropsEnv = this.dropsFor(spawned);
    // Phase 3: the delta encodes directly from the SAB-backed stores —
    // no intermediate CollectedState row copy. Read-only w.r.t. the
    // tracker: commit() still runs below, as on the row path.
    const frame = this.interest ? this.sectorIndex.frame(sim, tick, this.tracker, this.chunkSource) : null;
    // With interest on, the global delta is only for tick listeners.
    const deltaBytes = frame === null || this.tickListeners.length > 0
      ? encodeDeltaFromSim(sim, tick, tick - 1, this.tracker, this.chunkSource)
      : EMPTY_BYTES;
    this.tracker.commit(sim);
    sim.endTick();

    this.broadcast(tick, deltaBytes, namesEnv, dropsEnv, frame);
    for (const l of this.tickListeners) {
      l({ tick, delta: deltaBytes, events, fullState: () => encodeSnapshotFromSim(this.world, tick, { chunkSource: this.chunkSource }) });
    }
    this.sweepGracePeriods();
    this.maybeHeartbeat();
  }

  /** Tell every welcomed player about the blows struck this tick (catalog 0x16). */
  private sendHits(sim: SimWorld, tick: number): HitMessage[] {
    const all: HitMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof CombatSystem)) continue;
      const hits = s.drainHits();
      if (hits.length === 0) continue;
      for (const h of hits) {
        if (h.outcome !== "hit") continue;
        if (hasComponent(sim.ecs, C.PlayerIntent, h.source)) this.telemetry.damageDealt(h.amount);
        if (hasComponent(sim.ecs, C.PlayerIntent, h.target)) this.telemetry.damageTaken(h.amount);
      }
      const msgs = hits.map((h): HitMessage => ({
            kind: "hit",
            tick,
            source: String(sim.wireId(h.source)),
            target: String(sim.wireId(h.target)),
            outcome: h.outcome,
            amount: h.amount,
            health: C.Health.current[h.target],
            max: C.Health.max[h.target],
            ...(h.part !== undefined ? { part: h.part, state: h.state } : {}),
            ...(h.lost ? { lost: h.lost } : {}),
            ...(h.disarmed ? { disarmed: true } : {}),
      }));
      this.dropDisarmed(sim, hits);
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (let i = 0; i < msgs.length; i++) {
          const h = hits[i];
          if (this.interest) {
            // Foes pin each other for 10 s (IM5): an attacker out of its victim's view stays visible.
            const foe = sim.wireId(h.source) === r.playerEntity ? h.target : sim.wireId(h.target) === r.playerEntity ? h.source : -1;
            if (foe >= 0) (r.combatPins ??= new Map()).set(sim.wireId(foe), this.tick + COMBAT_PIN_TICKS);
          }
          if (this.sees(r, h.source, h.target)) this.sendEnvelope(r, MessageType.Hit, encodeControl(msgs[i]));
        }
      }
      all.push(...msgs);
    }
    return all;
  }

  /** The session belonging to `charId`, if they're online. */
  private sessionOf(charId: number): ClientSession | undefined {
    for (const s of this.sessions.values()) {
      if (!s.welcomed || s.playerEntity === null) continue;
      if (this.holderOf(s) === charId) return s;
    }
    return undefined;
  }

  /** Wire id string for a character, "0" when they're not in the world. */
  private wireIdOf(charId: number): string {
    const session = this.sessionOf(charId);
    return session?.playerEntity != null ? session.playerEntity.toString() : "0";
  }

  /**
   * Fan out trade state changes (catalog 0x21, EC1). Trades are private:
   * only the two parties hear them.
   */
  private sendTrades(_sim: SimWorld, tick: number): TradeMessage[] {
    const all: TradeMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof TradeSystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      for (const e of events) {
        const m: TradeMessage = {
          kind: "trade",
          tick,
          id: e.id,
          state: e.state,
          a: this.wireIdOf(e.a),
          b: this.wireIdOf(e.b),
          aGold: e.aGold,
          bGold: e.bGold,
          aItems: e.aItems,
          bItems: e.bItems,
          aAccepted: e.aAccepted,
          bAccepted: e.bAccepted,
        };
        for (const charId of [e.a, e.b]) {
          const session = this.sessionOf(charId);
          if (session) this.sendEnvelope(session, MessageType.Trade, encodeControl(m));
        }
        all.push(m);
      }
    }
    return all;
  }

  /** Tell a character their gold balance changed (catalog 0x21, EC1). */
  private sendWallets(_sim: SimWorld, tick: number): WalletMessage[] {
    const all: WalletMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof WalletSystem)) continue;
      const changes = s.drainChanges();
      if (changes.length === 0) continue;
      for (const c of changes) {
        const session = this.sessionOf(c.charId);
        if (!session) continue;
        const m: WalletMessage = { kind: "wallet", tick, balance: c.balance };
        this.sendEnvelope(session, MessageType.Trade, encodeControl(m));
        all.push(m);
      }
    }
    return all;
  }

  /**
   * Fan out auction events (catalog 0x21, EC1): expiry, sales, and bids go
   * to the parties involved only.
   */
  private sendAuctions(_sim: SimWorld, tick: number): AuctionMessage[] {
    const all: AuctionMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof AuctionSystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      for (const e of events) {
        const m: AuctionMessage = {
          kind: "auction",
          tick,
          state: e.state,
          ...(e.view ? { listing: e.view } : {}),
        };
        for (const charId of e.parties) {
          const session = this.sessionOf(charId);
          if (session) this.sendEnvelope(session, MessageType.Trade, encodeControl(m));
        }
        all.push(m);
      }
    }
    return all;
  }

  /**
   * Tell every welcomed player about deaths and respawns this tick (catalog
   * 0x17), and write a dying character's death record when the rules ask.
   */
  private sendLife(sim: SimWorld, tick: number): LifeMessage[] {
    const all: LifeMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof DeathSystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      const msgs: LifeMessage[] = [];
      for (const ev of events) {
        const m: LifeMessage = { kind: "life", tick, target: String(sim.wireId(ev.target)), state: ev.state };
        if (ev.state === "dead") {
          if (hasComponent(sim.ecs, C.PlayerIntent, ev.target)) this.telemetry.death();
          if (ev.killer !== undefined && hasComponent(sim.ecs, C.PlayerIntent, ev.killer)) this.telemetry.kill();
          if (ev.killer !== undefined) m.killer = String(sim.wireId(ev.killer));
          if (ev.cause) {
            m.cause = ev.cause.cause;
            if (ev.cause.part !== undefined) m.part = ev.cause.part;
          }
          m.respawnAt = ev.outcome && ev.outcome.respawnInSeconds >= 0 ? ev.respawnAt : 0;
          const id = this.characterIdOf(ev.target);
          if (id !== null && ev.outcome?.record) {
            const killer = ev.killer !== undefined ? this.characterIdOf(ev.killer) : null;
            void Promise.resolve(this.characterStore.recordDeath?.(id, { at: Date.now(), x: ev.x ?? 0, z: ev.z ?? 0, killer })).catch(() => undefined);
          }
        }
        msgs.push(m);
      }
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (let i = 0; i < msgs.length; i++) {
          if (this.sees(r, events[i].target, events[i].killer ?? -1)) this.sendEnvelope(r, MessageType.Life, encodeControl(msgs[i]));
        }
      }
      all.push(...msgs);
    }
    return all;
  }

  /** Fan out ability events this tick (catalog 0x1d, M5). */
  private sendAbilities(sim: SimWorld, tick: number): AbilityMessage[] {
    const all: AbilityMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof AbilitySystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      const msgs = events.map((e): AbilityMessage => ({
        kind: "ability",
        tick,
        entity: String(sim.wireId(e.entity)),
        id: e.id,
        state: e.state,
        ...(e.reason ? { reason: e.reason } : {}),
      }));
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (let i = 0; i < msgs.length; i++) if (this.sees(r, events[i].entity)) this.sendEnvelope(r, MessageType.Ability, encodeControl(msgs[i]));
      }
      all.push(...msgs);
    }
    return all;
  }

  /** Fan out telegraph warnings, resolutions and cancellations (catalog 0x1e, M5). */
  private sendTelegraphs(sim: SimWorld, tick: number): TelegraphMessage[] {
    const all: TelegraphMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof TelegraphSystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      const msgs = events.map((e): TelegraphMessage => ({
        kind: "telegraph",
        tick,
        id: e.id,
        source: String(sim.wireId(e.source)),
        shape: e.shape,
        state: e.state,
        ...(e.ticksUntilHit !== undefined ? { ticksUntilHit: e.ticksUntilHit } : {}),
        ...(e.hits ? { hits: e.hits.map((h) => ({ target: String(sim.wireId(h.target)), amount: h.amount })) } : {}),
      }));
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (let i = 0; i < msgs.length; i++) {
          if (this.sees(r, events[i].source, ...(events[i].hits ?? []).map((h) => h.target))) this.sendEnvelope(r, MessageType.Telegraph, encodeControl(msgs[i]));
        }
      }
      all.push(...msgs);
    }
    return all;
  }

  /** Fan out buff/debuff changes (catalog 0x1f, M5). */
  private sendStatuses(sim: SimWorld, tick: number): StatusMessage[] {
    const all: StatusMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof StatusSystem)) continue;
      const changes = s.drainChanges();
      if (changes.length === 0) continue;
      const msgs = changes.map((c): StatusMessage => ({
        kind: "status",
        tick,
        entity: String(sim.wireId(c.entity)),
        id: c.id,
        state: c.state,
        ...(c.stacks !== undefined ? { stacks: c.stacks } : {}),
      }));
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (let i = 0; i < msgs.length; i++) if (this.sees(r, changes[i].entity)) this.sendEnvelope(r, MessageType.Status, encodeControl(msgs[i]));
      }
      all.push(...msgs);
    }
    return all;
  }

  /** Fan out duel events (catalog 0x20, M5). */
  private sendDuels(sim: SimWorld, tick: number): DuelMessage[] {
    const all: DuelMessage[] = [];
    for (const s of this.systems) {
      if (!(s instanceof DuelSystem)) continue;
      const events = s.drainEvents();
      if (events.length === 0) continue;
      const msgs = events.map((e): DuelMessage => ({
        kind: "duel",
        tick,
        state: e.state,
        a: String(sim.wireId(e.a)),
        b: String(sim.wireId(e.b)),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.winner !== undefined ? { winner: String(sim.wireId(e.winner)) } : {}),
      }));
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (const m of msgs) this.sendEnvelope(r, MessageType.Duel, encodeControl(m));
      }
      all.push(...msgs);
    }
    return all;
  }

  /**
   * A player's hand maimed or cut off (M3): what it held falls at their
   * feet, and their look and bag are brought up to date.
   */
  private dropFromUselessHands(sim: SimWorld): void {
    if (!this.body || !this.items) return;
    const lost = this.body.drainDropped();
    if (lost.length === 0) return;
    for (const s of this.sessions.values()) {
      if (s.playerEntity === null) continue;
      const avatar = sim.resolveWireId(s.playerEntity);
      let changed = false;
      for (const l of lost) if (l.e === avatar && this.items.dropHeld(sim, this.holderOf(s), avatar, l.hand)) changed = true;
      if (!changed) continue;
      this.refreshAvatarLook(avatar, this.holderOf(s));
      this.sendInventory(s);
    }
  }

  /** A parry took a player's weapon (M4): it falls at their feet, and their look and bag follow. */
  private dropDisarmed(sim: SimWorld, hits: readonly { source: number; disarmed?: boolean }[]): void {
    if (!this.items) return;
    for (const h of hits) {
      if (!h.disarmed) continue;
      for (const s of this.sessions.values()) {
        if (s.playerEntity === null || sim.resolveWireId(s.playerEntity) !== h.source) continue;
        if (!this.items.dropHeld(sim, this.holderOf(s), h.source, "main")) continue;
        this.refreshAvatarLook(h.source, this.holderOf(s));
        this.sendInventory(s);
      }
    }
  }

  /**
   * Parts cut off, or grown back (M3): the look every client draws hides
   * the slots of what is gone (`lost` in the appearance JSON, next to `held`).
   */
  private showLostParts(sim: SimWorld): void {
    if (!this.body) return;
    for (const e of this.body.drainLooks()) {
      if (!hasComponent(sim.ecs, C.Appearance, e)) continue;
      sim.setLook(e, withLost(sim.lookJson(C.Appearance.look[e]), this.body.lostSlots(e)));
    }
  }

  /** Tell healers and patients how their treatments go (catalog 0x1a, M4). */
  private sendTreatments(sim: SimWorld): void {
    if (!this.body) return;
    const events = this.body.drainTreatments();
    if (events.length === 0) return;
    for (const r of this.sessions.values()) {
      if (!r.welcomed || r.playerEntity === null) continue;
      const avatar = sim.resolveWireId(r.playerEntity);
      for (const ev of events) {
        if (ev.healer !== avatar && ev.patient !== avatar) continue;
        const m: TreatmentMessage = {
          kind: "treatment",
          healer: String(sim.wireId(ev.healer)),
          patient: String(sim.wireId(ev.patient)),
          part: ev.part,
          treatment: ev.treatment,
          state: ev.state,
          ...(ev.seconds !== undefined ? { seconds: Math.round(ev.seconds * 10) / 10 } : {}),
        };
        this.sendEnvelope(r, MessageType.Treat, encodeControl(m));
      }
    }
  }

  /** Save one character avatar's position and vitals (no-op for bots, or without a store that keeps state). */
  private saveAvatar(eid: number): void {
    if (eid < 0 || !this.characterStore.saveState) return;
    const id = this.characterIdOf(eid);
    if (id === null) return;
    if (this.mastery) this.characterStore.saveSkills?.(id, this.mastery.sheetOf(eid).save());
    const T = C.Transform;
    this.characterStore.saveState(id, {
      x: T.px[eid],
      y: T.py[eid],
      z: T.pz[eid],
      health: C.Health.current[eid],
      stamina: C.Stamina.current[eid],
    });
  }

  /**
   * Save every live character's state (the server's save timer and
   * shutdown call this; leaving the world saves just that avatar).
   * Returns how many were saved.
   */
  saveCharacters(): number {
    if (!this.characterStore.saveState) return 0;
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.playerEntity === null || !s.character) continue;
      this.saveAvatar(this.world.resolveWireId(s.playerEntity));
      n++;
      // Persistence P4: the same cadence writes uphill to the world
      // tier, fenced by the session lock. Fire-and-forget: the sync
      // never throws, and a fenced or failed write only degrades
      // durability (logged there), never this save cycle.
      if (this.worldCharacters) void this.worldCharacters.save(s.character.id);
    }
    return n;
  }

  // ---------------------------------------------- region migration (B2)
  //
  // WORLD-SERVER-SPEC §6: the gateway is the ECS side of a border hand-off
  // (MigrationHost). A player is the migrating entity `player:<username>`;
  // the region's MigrationCoordinator decides when and where. The source
  // sends the client a `bye` redirect with a one-time ticket whose hash
  // rides in the migration record; the target spawns the avatar without a
  // socket and lets in the client whose migration hello carries that ticket.

  /** Where each player in the world stands, for MigrationCoordinator.observe. */
  migrationPositions(): EntityPosition[] {
    const out: EntityPosition[] = [];
    for (const s of this.sessions.values()) {
      if (!s.welcomed || s.playerEntity === null || this.handoffArrivals.has(s.clientId)) continue;
      const eid = this.world.resolveWireId(s.playerEntity);
      if (eid < 0) continue;
      out.push({ entityId: `player:${s.username}`, x: C.Transform.px[eid], z: C.Transform.pz[eid] });
    }
    return out;
  }

  /** The gateway's side of a hand-off, for this region's MigrationCoordinator. */
  migrationHost(): MigrationHost {
    return {
      serialize: (id) => this.handoffSerialize(id),
      instantiate: (id, state, migrationId) => this.handoffInstantiate(id, state, migrationId),
      drop: (id) => this.handoffDrop(id),
      has: (id) => this.handoffSession(id) !== undefined,
      redirect: (id, endpoint, migrationId) => this.handoffRedirect(id, endpoint, migrationId),
    };
  }

  /**
   * How a migration hello is let in: the region's coordinator accepts the
   * migration (`MigrationCoordinator.accept`), checking the record with
   * `verify` first. Unset, a migration hello is refused.
   */
  setMigrationAcceptor(accept: (migrationId: string, verify: (m: MigrationRecord) => boolean) => Promise<boolean>): void {
    this.acceptMigration = accept;
  }

  private handoffSession(entityId: string): ClientSession | undefined {
    if (!entityId.startsWith("player:")) return undefined;
    const username = entityId.slice("player:".length);
    for (const s of this.sessions.values()) {
      if (s.username === username && s.playerEntity !== null) return s;
    }
    return undefined;
  }

  private handoffSerialize(entityId: string): Record<string, unknown> | null {
    const s = this.handoffSession(entityId);
    if (!s || s.playerEntity === null) return null;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0) return null;
    const ticket = crypto.randomBytes(32).toString("hex");
    this.handoffTickets.set(entityId, ticket);
    const auth = this.authSessions.get(s.token);
    const T = C.Transform;
    return {
      username: s.username,
      character: auth?.character ?? null,
      pos: [T.px[eid], T.py[eid], T.pz[eid]],
      health: C.Health.current[eid],
      stamina: C.Stamina.current[eid],
      mana: hasComponent(this.world.ecs, Mana, eid) ? Mana.current[eid] : null,
      skills: this.mastery ? this.mastery.sheetOf(eid).save() : null,
      ticketHash: sha256Hex(ticket),
    };
  }

  private handoffRedirect(entityId: string, endpoint: string, migrationId: string): void {
    const s = this.handoffSession(entityId);
    const ticket = this.handoffTickets.get(entityId);
    this.handoffTickets.delete(entityId);
    if (!s || !ticket) return;
    const bye: ByeMessage = { reason: "redirect", redirect: { endpoint, migration: migrationId, ticket } };
    this.sendEnvelope(s, MessageType.Bye, encodeControl(bye));
  }

  /**
   * The target region took the player: remove the avatar here. (The
   * entity state itself travels in the migration record.) In fleet
   * mode (P4) this is also the migration commit point for the
   * character's session lock: the avatar's final state is staged
   * into the local store, committed uphill, and the lock releases
   * here — so the destination can acquire it (fresh epoch) before
   * the character is playable there. Fire-and-forget like the rest
   * of the commit path; a failed release leaves the lock to expire.
   */
  private handoffDrop(entityId: string): void {
    const s = this.handoffSession(entityId);
    if (!s || s.playerEntity === null) return;
    if (this.worldCharacters && s.character) {
      this.saveAvatar(this.world.resolveWireId(s.playerEntity));
      void this.worldCharacters.logout(s.character.id);
    }
    const eid = this.world.resolveWireId(s.playerEntity);
    this.mastery?.forget(eid);
    this.world.despawn(parseWireEntityId(s.playerEntity).slot);
    s.playerEntity = null;
    this.handoffArrivals.delete(s.clientId);
    if (this.tokenToClient.get(s.token) === s.clientId) this.tokenToClient.delete(s.token);
    this.authSessions.revoke(s.token);
    this.sessions.delete(s.clientId);
    if (s.socket) {
      try {
        s.socket.close(4000, "moved to another region");
      } catch {
        /* ignore */
      }
      s.socket = null;
    }
  }

  /**
   * Spawn an arriving player from its handed-over state, as a session
   * waiting for its client (the disconnect grace period applies: a client
   * that never comes is despawned like any other).
   */
  private handoffInstantiate(entityId: string, state: Record<string, unknown> | null, migrationId: string): void {
    const st = parseHandoffState(state);
    if (!st || `player:${st.username}` !== entityId) return;
    const now = this.clock();
    const s: ClientSession = {
      clientId: `c${++this.clientSeq}`,
      token: this.authSessions.create("", st.username),
      playerEntity: null,
      lastAckedTick: 0n,
      lastSnapshotTick: 0n,
      sendQueue: [],
      missedHeartbeats: 0,
      lastPingMs: 0,
      connectedAtMs: now,
      socket: null,
      welcomed: true,
      joining: false,
      lastIntentTick: 0n,
      droppedIntents: 0,
      intentTokens: this.ingress.intentBurst,
      intentRefillMs: now,
      pickupTokens: this.ingress.pickupBurst,
      pickupRefillMs: now,
      droppedPickups: 0,
      violations: 0,
      violationWindowStartMs: now,
      lastSeenMs: now,
      disconnectedAtMs: now,
      needsResync: false,
      remoteIp: "",
      username: st.username,
      choosingCharacter: false,
      character: st.character ? { id: st.character.id, name: st.character.name } : null,
      isAdmin: this.devServer || this.admins.has(st.username),
      lastChatMs: {},
      sectorTopic: null,
    };
    this.authSessions.rebind(s.token, s.clientId);
    const auth = this.authSessions.get(s.token);
    if (auth && st.character) auth.character = st.character;
    if (st.character) this.evictCharacter(st.character.id, s);
    s.playerEntity = this.spawnPlayerEntity(st.character?.look ?? DEFAULT_LOOK_JSON, st.character?.id ?? null);
    const eid = this.world.resolveWireId(s.playerEntity);
    const T = C.Transform;
    [T.px[eid], T.py[eid], T.pz[eid]] = st.pos;
    C.Health.current[eid] = Math.min(st.health, C.Health.max[eid]);
    C.Stamina.current[eid] = Math.min(st.stamina, C.Stamina.max[eid]);
    if (st.mana != null && this.magic) {
      this.magic.ensure(this.world, eid);
      Mana.current[eid] = Math.min(st.mana, Mana.max[eid]);
    }
    if (st.skills && this.mastery) this.mastery.sheetOf(eid).load(st.skills);
    this.sessions.set(s.clientId, s);
    this.tokenToClient.set(s.token, s.clientId);
    this.handoffArrivals.set(s.clientId, { migrationId, ticketHash: st.ticketHash });
  }

  /**
   * A migration hello: the coordinator accepts the migration (checking the
   * ticket against the record before anything spawns), then the client
   * takes over the session `handoffInstantiate` made, like a token
   * reconnect. Returns that session's token, or null to refuse.
   */
  private async handoffArrive(migrationId: string, ticket: string): Promise<string | null> {
    if (!this.acceptMigration) return null;
    const hash = sha256Hex(ticket);
    const verify = (m: MigrationRecord): boolean => (m.entityState as { ticketHash?: unknown } | null)?.ticketHash === hash;
    if (!(await this.acceptMigration(migrationId, verify))) return null;
    for (const s of this.sessions.values()) {
      const a = this.handoffArrivals.get(s.clientId);
      if (!a || a.migrationId !== migrationId) continue;
      if (a.ticketHash !== hash) return null;
      // Fleet mode (P4): the lock moves with the character. The
      // destination acquires it (fresh epoch) and seeds its local
      // cache from the world record here — after the migration
      // commit, before the character is playable (this hello is what
      // makes it playable). Refused (the source's release has not
      // landed yet, or the world is unreachable): the hello fails
      // like any other auth failure and the arrival stays parked,
      // so a retry can complete the move.
      if (this.worldCharacters && s.character) {
        const res = await this.worldCharacters.login(s.character.id);
        if (!res.ok) return null;
      }
      this.handoffArrivals.delete(s.clientId);
      return s.token;
    }
    return null;
  }

  /**
   * Put a freshly spawned avatar where its character last was, with the
   * health and stamina it had. A character saved dead (or never saved)
   * keeps the ordinary spawn: death and respawn are the rules' business.
   * With spawnOverridden the position is not restored (the run asked for
   * a spawn point), only the vitals.
   */
  private restoreCharacterState(eid: number, characterId: number): void {
    const saved = this.mastery && eid >= 0 ? this.characterStore.loadSkills?.(characterId) : null;
    if (saved && this.mastery) {
      const sheet = this.mastery.sheetOf(eid);
      sheet.load(saved);
      sheet.applyDecay(this.clock());
    }
    const st = eid >= 0 ? this.characterStore.loadState?.(characterId) : null;
    if (!st || !(st.health > 0)) return;
    if (!this.spawnOverridden) {
      const T = C.Transform;
      const at = clearOfStatics(this.world, st.x, st.z, CHARACTER_CAPSULE.radius);
      T.px[eid] = at.x;
      T.pz[eid] = at.z;
      T.py[eid] = this.groundHeightAt?.(at.x, at.z) ?? st.y;
    }
    C.Health.current[eid] = Math.min(st.health, C.Health.max[eid]);
    C.Stamina.current[eid] = Math.min(st.stamina, C.Stamina.max[eid]);
  }

  /** The character id an entity carries, or null (bots, creatures). */
  private characterIdOf(eid: number): number | null {
    if (!hasComponent(this.world.ecs, C.CharacterRef, eid)) return null;
    return C.CharacterRef.idHi[eid] * 4294967296 + C.CharacterRef.idLo[eid];
  }

  /**
   * Put a respawning player at the world spawn point (rules `nearestVisited`
   * has no visited-anchor tracking yet, so it falls back here). Returns false
   * for entities without a character (bots), which rise where they fell.
   */
  respawnPlayer(sim: SimWorld, eid: number): boolean {
    if (!hasComponent(sim.ecs, C.CharacterRef, eid)) return false;
    const x = this.spawnPoint.x;
    const z = this.spawnPoint.z;
    const r = applyTeleport(sim, sim.wireId(eid), x, z, this.groundHeightAt ?? null);
    return r.ok;
  }

  /** Fan one tick's state out to every connected session (broadcast). */
  private broadcast(tick: number, deltaBytes: Uint8Array, namesEnv: Uint8Array | null, dropsEnv: Uint8Array | null = null, frame: SectorFrame | null = null): void {
    const isSnapshotTick = tick % this.opts.snapshotEveryTicks === 0;
    // IM2: every tick goes out as a DeltaSet; one global entry until
    // interest management splits it per sector (IM3).
    const deltaEnv = encodeEnvelope(
      MessageType.DeltaSet,
      encodeDeltaSet({ tick, replace: false, entries: [{ kind: DeltaSetKind.Delta, sector: GLOBAL_SECTOR, bytes: deltaBytes }] }),
    );
    let snapshotEnv: Uint8Array | undefined;
    const snapshotFor = (): Uint8Array =>
      (snapshotEnv ??= encodeEnvelope(
        MessageType.Snapshot,
        encodeSnapshotFromSim(this.world, tick, { chunkSource: this.chunkSource }),
      ));

    // Phase 5, Part A: on delta ticks, sessions with a sector
    // subscription get the once-encoded delta via one publish per
    // occupied sector topic instead of one send per socket. Snapshot
    // ticks and resyncing sessions stay on the per-socket path: a
    // snapshot is a per-session baseline, and a resyncing session must
    // not receive a delta it has no baseline for. Without a live
    // transport (tests driving frame() before listen()) there is no
    // publish target, so everything falls back to per-socket sends.
    const usePublish = !isSnapshotTick && this.sectorBroadcast && this.transport !== null;
    const edge = frame && this.transport instanceof ChannelTransport ? this.transport : null;
    const edgeBytes = new Map<string, Uint8Array>();
    const edgePlans: EdgePlan[] = [];
    const publishSectors = new Map<string, ClientSession[]>();

    for (const s of this.sessions.values()) {
      if (!s.welcomed || !s.socket) continue; // pending or in grace period
      if (namesEnv) this.deliver(s, namesEnv, tick);
      if (dropsEnv) this.deliver(s, dropsEnv, tick);
      if (frame) {
        const replace = isSnapshotTick || s.needsResync || !s.interestSet;
        const entries = this.interestEntries(s, frame, replace);
        const sid = edge && s.socket.isOpen && s.sendQueue.length === 0 ? (s.socket as { sid?: string }).sid : undefined;
        if (sid !== undefined) {
          // IM4: the edge assembles this session's DeltaSet from the tick's shared bytes.
          const plan: Array<[number, string, string]> = [];
          for (const e of entries) {
            const key = `${e.kind}:${e.sector}`;
            if (e.kind !== DeltaSetKind.Leave) edgeBytes.set(key, e.bytes);
            plan.push([e.kind, e.sector, key]);
          }
          edgePlans.push({ sid, replace, entries: plan });
          if (replace) {
            s.needsResync = false;
            s.lastSnapshotTick = BigInt(tick);
          }
          s.lastAckedTick = BigInt(tick);
        } else {
          const env = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick, replace, entries }));
          if (replace) this.deliverSnapshot(s, env, tick);
          else this.deliver(s, env, tick);
        }
      } else if (isSnapshotTick || s.needsResync) {
        // Leave the sector topic while resyncing: the next delta tick
        // re-subscribes once the snapshot baseline is in place.
        this.clearSectorSubscription(s);
        this.deliverSnapshot(s, snapshotFor(), tick);
      } else if (usePublish) {
        this.syncSectorSubscription(s);
        if (s.sectorTopic) {
          const members = publishSectors.get(s.sectorTopic);
          if (members) members.push(s);
          else publishSectors.set(s.sectorTopic, [s]);
        } else {
          // No sector (no player entity yet): per-socket, as before.
          this.deliver(s, deltaEnv, tick);
        }
      } else {
        this.deliver(s, deltaEnv, tick);
      }
      this.sendStats(s, tick);
      if (tick % BODY_EVERY_TICKS === 0) this.sendBody(s, tick);
      if (tick % BODY_EVERY_TICKS === 0) this.sendMana(s, tick);
      if (tick % SKILLS_EVERY_TICKS === 0) this.sendSkills(s, tick);
    }

    if (edge && edgePlans.length > 0) edge.sendSectors(tick, edgeBytes, edgePlans);

    // One publish per occupied sector topic. Per-session messages
    // (names/drops above) already flushed each member's queue through
    // deliver(), so the published delta cannot overtake them.
    for (const [topic, members] of publishSectors) {
      this.transport!.publish(topic, deltaEnv);
      for (const s of members) s.lastAckedTick = BigInt(tick);
    }
  }

  /** IM5: the wire ids a session always sees: its party in this region and recent foes. */
  private pinsOf(s: ClientSession): bigint[] {
    const out: bigint[] = [];
    const me = s.character?.name ?? s.username;
    const mates = this.parties.partyOf(me);
    if (mates.length > 0) {
      const names = new Set(mates.map((n) => n.toLowerCase()));
      for (const r of this.sessions.values()) {
        if (r === s || r.playerEntity === null) continue;
        if (names.has((r.character?.name ?? r.username).toLowerCase())) out.push(r.playerEntity);
      }
    }
    if (s.combatPins) {
      for (const [wid, until] of s.combatPins) {
        if (until < this.tick) s.combatPins.delete(wid);
        else out.push(wid);
      }
    }
    return out;
  }

  /**
   * Whether a session is told about events of these entities (IM5): with
   * interest on, when one stands in its interest sectors or is pinned.
   */
  private sees(s: ClientSession, ...eids: number[]): boolean {
    if (!this.interest || !s.interestSet) return true;
    for (const eid of eids) {
      if (eid < 0 || !hasComponent(this.world.ecs, C.Transform, eid)) continue;
      if (s.interestSet.has(homeSector(this.world, eid))) return true;
      const wid = this.world.wireId(eid);
      if (wid === s.playerEntity || s.pinnedOut?.has(wid)) return true;
    }
    return false;
  }

  /**
   * One session's DeltaSet this tick (interest management): its interest
   * sectors' shared bytes, full state for sectors it just entered (or all of
   * them on a replace), and a leave for each it dropped.
   */
  private interestEntries(s: ClientSession, frame: SectorFrame, replace: boolean): DeltaSetEntry[] {
    const prev = replace ? null : (s.interestSet ?? null);
    const eid = s.playerEntity === null ? -1 : this.world.resolveWireId(s.playerEntity);
    const next = s.interestAll && s.isAdmin
      ? frame.occupied()
      : eid >= 0 && hasComponent(this.world.ecs, C.Transform, eid)
      ? interestSectors(C.Transform.px[eid], C.Transform.pz[eid], this.interest!, prev)
      : new Set([GLOBAL_SECTOR]);
    const entries: DeltaSetEntry[] = [];
    for (const sector of next) {
      if (!prev?.has(sector)) entries.push({ kind: DeltaSetKind.Full, sector, bytes: frame.full(sector) });
      else {
        const d = frame.delta(sector);
        if (d) entries.push({ kind: DeltaSetKind.Delta, sector, bytes: d });
      }
    }
    if (prev) for (const sector of prev) if (!next.has(sector)) entries.push({ kind: DeltaSetKind.Leave, sector, bytes: EMPTY_BYTES });
    s.interestSet = next;
    // Pinned (IM5): party members and recent foes, wherever they are.
    const was = replace ? new Set<bigint>() : (s.pinnedOut ?? new Set<bigint>());
    const out = new Set<bigint>();
    const fresh: number[] = [], kept: number[] = [];
    for (const wid of this.pinsOf(s)) {
      const pe = this.world.resolveWireId(wid);
      if (pe < 0 || next.has(homeSector(this.world, pe))) continue;
      out.add(wid);
      (was.has(wid) ? kept : fresh).push(pe);
    }
    const left: bigint[] = [];
    for (const wid of was) {
      if (out.has(wid)) continue;
      const pe = this.world.resolveWireId(wid);
      if (pe < 0 || !next.has(homeSector(this.world, pe))) left.push(wid);
    }
    s.pinnedOut = out;
    if (fresh.length + kept.length + left.length > 0) {
      entries.push({ kind: DeltaSetKind.Pinned, sector: PINNED_SECTOR, bytes: encodePinned(this.world, frame.tick, fresh, kept, left) });
    }
    return entries;
  }

  /**
   * The topic a session's deltas are published on, or null when the session
   * has no avatar in the world yet (its deltas go per-socket). While the delta
   * is global every session shares one region topic, so a tick is one publish
   * (IM1: through the edge, a publish per occupied sector was a channel copy
   * each). Per-sector content comes with interest management (IM3).
   */
  private sectorTopicOf(s: ClientSession): string | null {
    if (s.playerEntity === null) return null;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0 || !hasComponent(this.world.ecs, C.Transform, eid)) return null;
    return REGION_TOPIC;
  }

  /**
   * Move a session's subscription onto its avatar's current sector
   * (no-op when it hasn't crossed a boundary). Called on delta ticks
   * only — snapshot ticks and resyncs go through deliverSnapshot.
   */
  private syncSectorSubscription(s: ClientSession): void {
    if (!s.socket || !s.socket.isOpen) return;
    const topic = this.sectorTopicOf(s);
    if (topic === s.sectorTopic) return;
    if (s.sectorTopic) s.socket.unsubscribe(s.sectorTopic);
    s.sectorTopic = topic;
    if (topic) s.socket.subscribe(topic);
  }

  /** Leave the subscribed sector topic, if any, and forget it. */
  private clearSectorSubscription(s: ClientSession): void {
    if (s.sectorTopic) {
      try {
        s.socket?.unsubscribe(s.sectorTopic);
      } catch {
        /* a dying socket's subscription dies with it */
      }
      s.sectorTopic = null;
    }
  }

  /**
   * The player's own body (catalog 0x18, M2), when it changed since it was
   * last sent to this session (checked every BODY_EVERY_TICKS); `force`
   * sends it regardless (on joining or re-attaching).
   */
  private sendBody(s: ClientSession, tick: number, force = false): void {
    if (!this.body || s.playerEntity === null) return;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0 || !this.body.has(this.world, eid)) return;
    const v = this.body.view(eid);
    // Display values: hp to a hundredth, blood to a tenth, so healing ticks don't resend every check.
    const msg: BodyMessage = {
      kind: "body",
      entity: s.playerEntity.toString(),
      parts: v.parts.map((p) => ({ ...p, hp: Math.round(p.hp * 100) / 100 })),
      blood: Math.round(v.blood * 10) / 10,
      bloodMax: v.bloodMax,
    };
    const json = JSON.stringify(msg);
    if (!force && this.bodySent.get(s) === json) return;
    this.bodySent.set(s, json);
    this.deliver(s, encodeEnvelope(MessageType.Body, encodeControl(msg)), tick);
  }

  /**
   * The player's own mana (catalog 0x1c), when it changed (to a whole
   * point) since last sent; `force` sends it regardless (joining, re-attaching).
   */
  private sendMana(s: ClientSession, tick: number, force = false): void {
    if (!this.magic || s.playerEntity === null) return;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0) return;
    this.magic.ensure(this.world, eid);
    const msg: ManaMessage = { kind: "mana", current: Math.floor(Mana.current[eid]), max: Math.round(Mana.max[eid]) };
    const json = JSON.stringify(msg);
    if (!force && this.manaSent.get(s) === json) return;
    this.manaSent.set(s, json);
    this.deliver(s, encodeEnvelope(MessageType.Magic, encodeControl(msg)), tick);
  }

  /** Tell casters and targets how their casts go (catalog 0x1c). */
  private sendSpells(sim: SimWorld): void {
    if (!this.magic) return;
    const events = this.magic.drainEvents();
    if (events.length === 0) return;
    for (const r of this.sessions.values()) {
      if (!r.welcomed || r.playerEntity === null) continue;
      const avatar = sim.resolveWireId(r.playerEntity);
      for (const ev of events) {
        if (ev.caster !== avatar && ev.target !== avatar) continue;
        const m: SpellMessage = {
          kind: "spell",
          caster: String(sim.wireId(ev.caster)),
          target: String(sim.wireId(ev.target)),
          spell: ev.spell,
          state: ev.state,
          ...(ev.seconds !== undefined ? { seconds: Math.round(ev.seconds * 10) / 10 } : {}),
          ...(ev.amount !== undefined ? { amount: Math.round(ev.amount * 10) / 10 } : {}),
        };
        this.sendEnvelope(r, MessageType.Magic, encodeControl(m));
      }
    }
  }

  /**
   * The player's own skills, item familiarity and disciplines (catalog
   * 0x1b, M4), when they changed (to a tenth) since last sent; `force`
   * sends them regardless (on joining or re-attaching).
   */
  private sendSkills(s: ClientSession, tick: number, force = false): void {
    if (!this.mastery || s.playerEntity === null) return;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0) return;
    const sheet = this.mastery.sheetOf(eid);
    const rules = this.mastery.index.rules;
    const tenth = (v: number): number => Math.round(v * 10) / 10;
    const msg: SkillsMessage = {
      kind: "skills",
      max: rules.max,
      skills: rules.skills.map((k, i) => ({ id: k.id, name: k.name, value: tenth(sheet.value[i]), peak: tenth(sheet.peak[i]) })),
      familiarity: sheet.families().map(([family, value]) => ({ family, value: Math.round(value * 1000) / 1000 })),
      disciplines: this.mastery.disciplinesOf(eid).map((d) => {
        const rule = this.mastery!.discipline(d.id);
        return { id: d.id, name: d.name, active: d.active, unlocks: [...d.unlocks], ...(rule ? { requires: requirements(rule.requires) } : {}) };
      }),
      toward: this.mastery.goalsOf(eid).map((d) => ({ id: d.id, name: d.name, unlocks: [...d.unlocks], requires: requirements(d.requires) })),
    };
    const json = JSON.stringify(msg);
    if (!force && this.skillsSent.get(s) === json) return;
    this.skillsSent.set(s, json);
    this.deliver(s, encodeEnvelope(MessageType.Skills, encodeControl(msg)), tick);
  }

  /**
   * The player's own stats (catalog §0x0f): attributes and derived stats,
   * hunger and thirst (U3) and skills (U9), when any of them changed since
   * they were last sent to this session at display precision; `force`
   * sends them regardless (on joining or re-attaching, the client has none
   * yet). Meters move by whole points and skills by tenths, so a steady
   * drain or a training session costs a message every few seconds, not
   * every tick.
   */
  private sendStats(s: ClientSession, tick: number, force = false): void {
    if (s.playerEntity === null) return;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0) return;
    const version = this.world.stats.version(eid);
    if (version === 0) return;
    const needs = this.needsLine(eid);
    const skills = this.skillLines(eid);
    const key = `${version}|${needs ? `${needs.hunger},${needs.hungerMax},${needs.thirst},${needs.thirstMax}` : ""}|${skills ? skills.map((k) => `${k.value}/${k.peak}`).join(",") : ""}`;
    if (!force && this.statsSent.get(s) === key) return;
    this.statsSent.set(s, key);
    const sheet = this.world.stats.sheet(eid)!;
    // Display values: 4 decimals is plenty, and keeps float noise off the wire.
    const round = (v: number): number => Math.round(v * 1e4) / 1e4;
    const line = (l: (typeof sheet)[number]) => ({ id: l.id, name: l.name, value: round(l.value), base: round(l.base) });
    const msg: StatsMessage = {
      entity: s.playerEntity.toString(),
      attributes: sheet.filter((l) => l.attribute).map(line),
      stats: sheet.filter((l) => !l.attribute).map(line),
      ...(needs ? { needs } : {}),
      ...(skills && this.mastery ? { skills, skillMax: this.mastery.index.rules.max } : {}),
    };
    this.deliver(s, encodeEnvelope(MessageType.Stats, encodeControl(msg)), tick);
  }

  /** Hunger and thirst in whole points (U3), or undefined without the Needs component. */
  private needsLine(eid: number): StatsMessage["needs"] {
    if (!hasComponent(this.world.ecs, C.Needs, eid)) return undefined;
    // Ceil, so a meter reads 0 only when it is empty and hurting.
    return {
      hunger: Math.ceil(C.Needs.hunger[eid]),
      hungerMax: Math.round(C.Needs.hungerMax[eid]),
      thirst: Math.ceil(C.Needs.thirst[eid]),
      thirstMax: Math.round(C.Needs.thirstMax[eid]),
    };
  }

  /** Every skill to a tenth (U9), or undefined when this server runs no mastery. */
  private skillLines(eid: number): StatsMessage["skills"] {
    if (!this.mastery) return undefined;
    const sheet = this.mastery.sheetOf(eid);
    const tenth = (v: number): number => Math.round(v * 10) / 10;
    return this.mastery.index.rules.skills.map((k, i) => ({
      id: k.id,
      name: k.name,
      family: k.family,
      value: tenth(sheet.value[i]),
      peak: tenth(sheet.peak[i]),
    }));
  }

  /** Queue-or-send one enveloped message, preserving order, bounded. */
  private deliver(s: ClientSession, env: Uint8Array, tick: number): void {
    if (s.socket && s.socket.isOpen) {
      for (const q of s.sendQueue) s.socket.send(q);
      s.sendQueue.length = 0;
      s.socket.send(env);
    } else {
      s.sendQueue.push(env);
      if (s.sendQueue.length > MAX_QUEUED_DELTAS) {
        // Slow consumer: drop the backlog, resync with a snapshot next.
        s.sendQueue.length = 0;
        s.needsResync = true;
      }
    }
    // Delivery is implicitly acked by subsequent deltas (catalog).
    s.lastAckedTick = BigInt(tick);
  }

  private deliverSnapshot(
    s: ClientSession,
    env: Uint8Array,
    tick: number,
  ): void {
    s.sendQueue.length = 0;
    s.needsResync = false;
    this.deliver(s, env, tick);
    s.lastSnapshotTick = BigInt(tick);
  }

  /** Despawn player entities whose grace period has elapsed. */
  private sweepGracePeriods(): void {
    const now = this.clock();
    for (const s of this.sessions.values()) {
      if (s.disconnectedAtMs === null || s.socket !== null) continue;
      if (now - s.disconnectedAtMs < this.opts.disconnectGraceMs) continue;
      if (s.playerEntity !== null) {
        const { slot } = parseWireEntityId(s.playerEntity);
        const eid = this.world.resolveWireId(s.playerEntity);
        this.saveAvatar(eid);
        this.mastery?.forget(eid);
        this.world.despawn(slot);
      }
      // The grace period is over: this is the logout. Fleet mode
      // (P4) commits the just-saved state uphill and releases the
      // character's session lock — fire-and-forget, never blocking
      // the sweep (an unreachable world leaves the local record as
      // the fallback truth and the lock to expire on its own).
      if (this.worldCharacters && s.character) {
        void this.worldCharacters.logout(s.character.id);
      }
      this.tokenToClient.delete(s.token);
      this.sessions.delete(s.clientId);
    }
  }

  private maybeHeartbeat(): void {
    const now = this.clock();
    const interval = this.opts.heartbeatIntervalMs;
    if (now - this.lastHeartbeatMs < interval) return;
    this.lastHeartbeatMs = now;
    this.authSessions.sweep(); // drop expired session tokens
    for (const n of this.parties.sweep()) this.pushParty(n);
    this.guilds.sweep();
    for (const s of this.sessions.values()) {
      if (!s.welcomed || !s.socket) continue;
      // Missed = nothing from the client (pong, intent, anything) since
      // the previous ping. Comparing against a fixed window instead
      // ("silent for > interval") dropped idle-but-healthy clients: their
      // only traffic is the pong a few ms after each ping, and the check
      // runs on the tick clock a few ms past the interval, so the gap was
      // routinely just over it — 3 in a row and a live client was kicked.
      if (s.lastPingMs !== 0 && s.lastSeenMs < s.lastPingMs) s.missedHeartbeats += 1;
      else s.missedHeartbeats = 0;
      if (s.missedHeartbeats >= this.opts.maxMissedHeartbeats) {
        this.dropSession(s, "heartbeat timeout");
        continue;
      }
      s.lastPingMs = now;
      this.sendEnvelope(s, MessageType.Ping, encodeControl({ t: now }));
    }
  }

  // ------------------------------------------------------------ sessions

  private onConnection(socket: WireSocket): void {
    const now = this.clock();
    const s: ClientSession = {
      clientId: `c${++this.clientSeq}`,
      token: "",
      playerEntity: null,
      lastAckedTick: 0n,
      lastSnapshotTick: 0n,
      sendQueue: [],
      missedHeartbeats: 0,
      lastPingMs: 0,
      connectedAtMs: now,
      socket,
      welcomed: false,
      joining: false,
      lastIntentTick: 0n,
      droppedIntents: 0,
      intentTokens: this.ingress.intentBurst,
      intentRefillMs: now,
      pickupTokens: this.ingress.pickupBurst,
      pickupRefillMs: now,
      droppedPickups: 0,
      violations: 0,
      violationWindowStartMs: now,
      lastSeenMs: now,
      disconnectedAtMs: null,
      needsResync: false,
      remoteIp: socket.remoteIp,
      username: "",
      choosingCharacter: false,
      character: null,
      isAdmin: false,
      lastChatMs: {},
      sectorTopic: null,
    };
    this.sessions.set(s.clientId, s);
    this.route(s, socket);
  }

  /** Send `socket`'s events to session `s` (replacing any earlier routing). */
  private route(s: ClientSession, socket: WireSocket): void {
    socket.listen({
      message: (data) => this.onMessage(s, data),
      close: () => {
        // Ignore closes from a superseded socket after takeover.
        if (s.socket === socket) this.onClose(s);
      },
    });
  }

  private onClose(s: ClientSession): void {
    if (!s.welcomed) {
      // Never said hello: nothing to keep.
      this.sessions.delete(s.clientId);
      return;
    }
    // Park the session: the player entity survives the grace period so a
    // quick reconnect re-attaches seamlessly.
    this.clearSectorSubscription(s); // the closing socket's subscription dies with it
    s.socket = null;
    s.sendQueue.length = 0;
    s.disconnectedAtMs = this.clock();
    this.partyOffline(s);
    this.guildOffline(s);
    this.friendPresence(s);
    this.extensionsLeave(s);
  }

  /** Drop a live session (heartbeat timeout). Grace period still applies. */
  private dropSession(s: ClientSession, reason: string): void {
    try {
      s.socket?.close(4000, reason);
    } catch {
      /* ignore */
    }
    // The close event fires async; mark it now so a slow close can't
    // keep the session looking live.
    if (s.socket) {
      const sock = s.socket;
      s.socket = null;
      s.disconnectedAtMs = this.clock();
      this.partyOffline(s);
      this.guildOffline(s);
      this.friendPresence(s);
      this.extensionsLeave(s);
      // Re-arm: if the close event never arrives, the session is still
      // correctly parked. If it does arrive, the guard ignores it.
      void sock;
    }
  }

  private onMessage(s: ClientSession, buf: Uint8Array): void {
    s.lastSeenMs = this.clock();
    let type: MessageType;
    let payload: Uint8Array;
    try {
      ({ type, payload } = decodeEnvelope(buf));
    } catch {
      this.sendError(s, 4003, "bad envelope");
      return;
    }
    switch (type) {
      case MessageType.Hello:
        this.onHello(s, payload);
        break;
      case MessageType.Register:
        this.onRegister(s, payload);
        break;
      case MessageType.Intent:
        this.onIntent(s, payload);
        break;
      case MessageType.Ping:
        // Echo the payload back as pong (heartbeat + RTT).
        this.sendEnvelope(s, MessageType.Pong, payload);
        break;
      case MessageType.Pong:
        break; // liveness already recorded above
      case MessageType.Bye:
        try {
          s.socket?.close(1000, "bye");
        } catch {
          /* ignore */
        }
        break;
      case MessageType.Debug:
        this.onDebug(s, payload);
        break;
      case MessageType.Admin:
        this.onAdmin(s, payload);
        break;
      case MessageType.Chat:
        this.onChat(s, payload);
        break;
      case MessageType.Item:
        this.onItem(s, payload);
        break;
      case MessageType.Stance:
        this.onStance(s, payload);
        break;
      case MessageType.Treat:
        this.onTreat(s, payload);
        break;
      case MessageType.Magic:
        this.onCast(s, payload);
        break;
      case MessageType.Ability:
        this.onAbility(s, payload);
        break;
      case MessageType.Duel:
        this.onDuel(s, payload);
        break;
      case MessageType.Trade:
        this.onTradeOrVendor(s, payload);
        break;
      case MessageType.TileRequest:
        this.onTileRequest(s, payload);
        break;
      case MessageType.Gather:
        this.onGather(s, payload);
        break;
      case MessageType.CreateCharacter:
        this.contain(s, "create character", this.onCreateCharacter(s, payload));
        break;
      case MessageType.EnterWorld:
        this.contain(s, "enter world", this.onEnterWorld(s, payload));
        break;
      default:
        this.sendError(s, 4003, `unexpected message type 0x${type.toString(16)}`);
    }
  }

  /**
   * Editor-only read-only debug queries (0x0a). The gateway is a pure
   * event translator here: it validates the query, requires a welcomed
   * session, and encodes whatever the injected DebugSource answers.
   * It never touches component stores or hunts for systems — all sim
   * knowledge lives behind the DebugSource interface.
   */
  private onDebug(s: ClientSession, payload: Uint8Array): void {
    if (!s.welcomed) {
      this.sendError(s, 4003, "debug before hello");
      return;
    }
    let q: DebugQuery;
    try {
      q = decodeControl<DebugQuery>(payload);
    } catch {
      this.sendError(s, 4003, "malformed debug query");
      return;
    }
    if (q == null || q.kind !== "debug") {
      this.sendError(s, 4003, "malformed debug query");
      return;
    }
    let res: DebugResponse;
    if (q.query === "waypoints") {
      res =
        this.debugSource?.waypoints(q.entity) ??
        ({
          kind: "debug",
          query: "waypoints",
          entity: q.entity,
          status: "unknown",
          waypoints: [],
        } satisfies DebugResponse);
    } else if (q.query === "tiles") {
      res = {
        kind: "debug",
        query: "tiles",
        tiles: this.debugSource?.tiles() ?? [],
      };
    } else if (q.query === "timings") {
      const t = this.getTickTimings();
      res = {
        kind: "debug",
        query: "timings",
        ticks: t.ticks,
        p50: t.p50,
        p99: t.p99,
        systems: t.systems,
      };
    } else {
      this.sendError(s, 4003, "unknown debug query");
      return;
    }
    this.sendEnvelope(s, MessageType.Debug, encodeControl(res));
  }

  /**
   * Admin console (protocol 0x10, roadmap A1). Welcomed admins only:
   * anything earlier, any non-admin, and any malformed command is
   * answered 4003 and logged. Every answered command — ran or rejected —
   * goes in the command log; A2+ adds world-editing commands here.
   */
  private onAdmin(s: ClientSession, payload: Uint8Array): void {
    if (!s.welcomed) {
      this.sendError(s, 4003, "admin before hello");
      return;
    }
    let cmd: AdminCommand;
    try {
      const raw = decodeControl<unknown>(payload);
      const parsed = AdminCommandSchema.safeParse(raw);
      if (!parsed.success) throw new Error("bad shape");
      cmd = parsed.data;
    } catch {
      this.logAdmin(s.username, "(malformed)", false);
      this.sendError(s, 4003, "malformed admin command");
      return;
    }
    if (!s.isAdmin) {
      this.logAdmin(s.username, cmd.command, false);
      this.sendError(s, 4003, "admin only");
      return;
    }
    let res: AdminResult;
    if (cmd.command === "help") {
      res = {
        kind: "admin",
        command: cmd.command,
        ok: true,
        message: "commands: help, whoami, stats, interest, inspect, set, spawnlist, spawn, despawn, teleport, heal, injure, skill, fly, god, noclip, items, give, drop, loot, gold, vendor, time, weather, pause, resume, step",
      };
    } else if (cmd.command === "stats") {
      const t = this.telemetry.snapshot();
      res = { kind: "admin", command: cmd.command, ok: true, message: JSON.stringify(t) };
    } else if (cmd.command === "whoami") {
      res = {
        kind: "admin",
        command: cmd.command,
        ok: true,
        message: `admin ${s.username}${this.devServer ? " (dev server)" : ""}`,
      };
    } else if (cmd.command === "inspect") {
      res = this.runInspect(s, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "set") {
      res = this.runSet(s, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "appearance") {
      res = this.runAppearance(s, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "spawnlist" || cmd.command === "spawn" || cmd.command === "despawn") {
      res = this.runSpawnCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "give" && this.atomicOps) {
      // Slice A2 (fleet mode): the grant's commit is async (world
      // tier); the handler answers and logs like the sync path does.
      this.contain(s, "give", this.runItemGiveFleet(s, cmd.args));
      return;
    } else if (cmd.command === "items" || cmd.command === "give" || cmd.command === "drop" || cmd.command === "loot" || cmd.command === "gold") {
      res = this.runItemCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "vendor") {
      res = this.runVendorCommand(s, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "teleport" || cmd.command === "heal" || cmd.command === "fly" || cmd.command === "injure" || cmd.command === "skill") {
      res = this.runPlayerCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "god") {
      res = this.runGodCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "interest") {
      // IM6: the play-mode debugger's "show everything / show what the player sees".
      const mode = (cmd.args as { mode?: unknown } | undefined)?.mode;
      if (mode !== "all" && mode !== "near") {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, "interest: args.mode must be \"all\" or \"near\"");
        return;
      }
      s.interestAll = mode === "all";
      s.interestSet = null; // a full replace of the new view next tick
      res = { kind: "admin", command: cmd.command, ok: true, message: `interest ${mode}${this.interest ? "" : " (interest management is off: every client sees everything)"}` };
    } else if (cmd.command === "noclip") {
      const parsed = NoclipArgsSchema.safeParse(cmd.args ?? {});
      if (!parsed.success) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, "usage: noclip {on, entity?}");
        return;
      }
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, target.error);
        return;
      }
      res = { kind: "admin", command: cmd.command, ...applyNoclip(this.world, target.wireId, parsed.data.on) };
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "time") {
      const r = runTimeCommand(this.dayClock, this.serverTick, TICK_HZ, cmd.args);
      res = { kind: "admin", command: cmd.command, ok: r.ok, message: r.message };
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
      if (r.changed && this.dayClock) {
        const day = { seconds: this.dayClock.seconds, offset: this.dayClock.offset };
        for (const other of this.sessions.values()) {
          if (!other.welcomed || other.playerEntity === null) continue;
          this.sendEnvelope(other, MessageType.Chat, encodeControl({ kind: "time", day }));
        }
      }
    } else if (cmd.command === "pause" || cmd.command === "resume") {
      this.paused = cmd.command === "pause";
      res = { kind: "admin", command: cmd.command, ok: true, message: this.paused ? "paused" : "running" };
    } else if (cmd.command === "step") {
      if (this.paused) this.loop.step();
      res = {
        kind: "admin",
        command: cmd.command,
        ok: this.paused,
        message: this.paused ? `tick ${this.loop.stats().ticks}` : "step needs a paused server",
      };
    } else if (cmd.command === "weather") {
      const r = parseWeatherCommand(this.weatherOverride, cmd.args);
      res = { kind: "admin", command: cmd.command, ok: r.ok, message: r.message };
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
      if (r.weather !== undefined) {
        this.weatherOverride = r.weather;
        for (const other of this.sessions.values()) {
          if (!other.welcomed || other.playerEntity === null) continue;
          this.sendEnvelope(other, MessageType.Chat, encodeControl({ kind: "weather", weather: r.weather }));
        }
      }
    } else {
      this.logAdmin(s.username, cmd.command, false);
      this.sendError(s, 4003, `unknown admin command ${JSON.stringify(cmd.command)}`);
      return;
    }
    this.logAdmin(s.username, cmd.command, true);
    this.sendEnvelope(s, MessageType.Admin, encodeControl(res));
  }

  /**
   * Resolve an inspect/set entity arg to a wire id: "me" is the caller's
   * own avatar, otherwise a decimal u64. Errors read as messages, never
   * throw — except a missing avatar, which the callers phrase per command.
   */
  private resolveTarget(s: ClientSession, entity: string): { wireId: bigint } | { error: string } {
    if (entity === "me") {
      if (s.playerEntity === null) return { error: "no player entity (not in the world)" };
      return { wireId: s.playerEntity };
    }
    let wireId: bigint;
    try {
      wireId = BigInt(entity);
    } catch {
      return { error: `unknown entity ${JSON.stringify(entity)}` };
    }
    if (wireId < 0n || wireId > 0xffffffffffffffffn) return { error: `unknown entity ${JSON.stringify(entity)}` };
    return { wireId };
  }

  /**
   * `inspect` (roadmap A2, read path): dump one entity's components.
   * `{entity: "<u64>"}` or `{entity: "me"}` (the caller's own avatar).
   * Unknown entities and bad args read as errors, never throws.
   */
  private runInspect(s: ClientSession, args: unknown): AdminResult {
    const parsed = InspectArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command: "inspect", ok: false, message: "usage: inspect {entity: <u64> | me}" };
    }
    const target = this.resolveTarget(s, parsed.data.entity);
    if ("error" in target) {
      return { kind: "admin", command: "inspect", ok: false, message: target.error };
    }
    const dump = inspectEntity(this.world, target.wireId);
    if (dump === null) {
      return { kind: "admin", command: "inspect", ok: false, message: `unknown entity ${parsed.data.entity}` };
    }
    return { kind: "admin", command: "inspect", ok: true, message: dump };
  }

  /**
   * `set` (roadmap A2, write path): change one numeric component field.
   * Args: {entity: "<u64>" | "me", component, field, value}. Unknown
   * entities, components, fields, and values read as errors, never throw.
   */
  private runSet(s: ClientSession, args: unknown): AdminResult {
    const parsed = SetArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command: "set", ok: false, message: "usage: set {entity, component, field, value}" };
    }
    const target = this.resolveTarget(s, parsed.data.entity);
    if ("error" in target) {
      return { kind: "admin", command: "set", ok: false, message: target.error };
    }
    const r = applySet(this.world, target.wireId, parsed.data.component, parsed.data.field, parsed.data.value);
    if (!r.ok) return { kind: "admin", command: "set", ok: false, message: r.message };
    return { kind: "admin", command: "set", ok: true, message: r.message };
  }

  /**
   * `appearance` (roadmap A6): view and edit a character's look live.
   * Args: {entity: "<u64>" | "me", args: string[]}. Parts and colours are
   * validated against the character catalog; the change applies via
   * sim.setLook and syncs like any appearance update.
   */
  private runAppearance(s: ClientSession, args: unknown): AdminResult {
    const parsed = z.object({
      entity: z.string().default("me"),
      args: z.array(z.string()).default([]),
    }).safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command: "appearance", ok: false, message: "usage: appearance {entity?: \"me\"|<id>, args?: string[]}" };
    }
    const target = this.resolveTarget(s, parsed.data.entity);
    if ("error" in target) {
      return { kind: "admin", command: "appearance", ok: false, message: target.error };
    }
    const edit = parseAppearanceArgs(parsed.data.args);
    if (!edit.ok) {
      return { kind: "admin", command: "appearance", ok: false, message: edit.message };
    }
    const r = applyAppearanceEdit(this.world, target.wireId, edit.edit, this.characterCatalog ?? null);
    if (!r.ok) return { kind: "admin", command: "appearance", ok: false, message: r.message ?? "appearance failed" };
    // Equipment overlays (held models) still apply on top.
    const eid = this.world.resolveWireId(target.wireId);
    if (eid >= 0) this.refreshAvatarLook(eid, this.holderOf(s));
    return { kind: "admin", command: "appearance", ok: true, message: r.message ?? "appearance updated" };
  }

  /**
   * Spawn commands (roadmap A3): `spawnlist` names the plantable
   * archetypes; `spawn` plants one at the caller's avatar (or at x/z);
   * `despawn` removes any entity that isn't a live session's avatar.
   * Args schemas live in admin/spawn.ts; failures read as errors.
   */
  private runSpawnCommand(s: ClientSession, command: string, args: unknown): AdminResult {
    if (this.spawnTable === null) {
      try {
        this.spawnTable = loadScatterContent().table;
      } catch {
        return { kind: "admin", command, ok: false, message: "no spawn table on this server" };
      }
    }
    const table = this.spawnTable;
    if (command === "spawnlist") {
      const names = listAssets(table);
      return { kind: "admin", command, ok: true, message: names.length > 0 ? names.join(" ") : "(empty)" };
    }
    if (command === "despawn") {
      const parsed = DespawnArgsSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return { kind: "admin", command, ok: false, message: "usage: despawn {entity: <u64> | me}" };
      }
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
      if (this.world.resolveWireId(target.wireId) < 0) {
        return { kind: "admin", command, ok: false, message: `unknown entity ${parsed.data.entity}` };
      }
      for (const other of this.sessions.values()) {
        if (other.playerEntity === target.wireId) {
          return { kind: "admin", command, ok: false, message: "that is a live session's avatar" };
        }
      }
      this.world.despawn(parseWireEntityId(target.wireId).slot);
      return { kind: "admin", command, ok: true, message: `despawned ${parsed.data.entity}` };
    }
    const parsed = SpawnArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command, ok: false, message: "usage: spawn {asset, x?, z?, yaw?}" };
    }
    const point = resolveSpawnPoint(this.world, s, this.groundHeightAt, parsed.data.x, parsed.data.z);
    if ("error" in point) return { kind: "admin", command, ok: false, message: point.error };
    const { x, y, z } = point;
    if (this.creatures?.has(parsed.data.asset)) {
      const ids = this.creatures.spawnPack(this.world, parsed.data.asset, x, z);
      return { kind: "admin", command, ok: true, message: `spawned a pack of ${ids.length} ${parsed.data.asset}` };
    }
    const built = buildSpawn(table, parsed.data.asset, x, y, z, parsed.data.yaw ?? 0);
    if ("error" in built) return { kind: "admin", command, ok: false, message: built.error };
    const eid = spawnScatterEntity(this.world, built, undefined, this.scale);
    return { kind: "admin", command, ok: true, message: `spawned ${parsed.data.asset} as ${this.world.wireId(eid)}` };
  }

  /**
   * Player tweaks (roadmap A4, first slice): teleport (ground snap),
   * heal (fill from max), fly (the Fly ability bit). Args schemas live
   * in admin/player.ts; failures read as errors.
   */
  private runPlayerCommand(s: ClientSession, command: string, args: unknown): AdminResult {
    if (command === "teleport") {
      const parsed = TeleportArgsSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return { kind: "admin", command, ok: false, message: "usage: teleport {x, z, entity?}" };
      }
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
      const r = applyTeleport(this.world, target.wireId, parsed.data.x, parsed.data.z, this.groundHeightAt ?? null);
      if (!r.ok) return { kind: "admin", command, ok: false, message: r.message };
      return { kind: "admin", command, ok: true, message: r.message };
    }
    if (command === "heal") {
      const parsed = HealArgsSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return { kind: "admin", command, ok: false, message: "usage: heal {entity?}" };
      }
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
      const r = applyHeal(this.world, target.wireId);
      if (!r.ok) return { kind: "admin", command, ok: false, message: r.message };
      const healed = this.world.resolveWireId(target.wireId);
      if (this.magic && healed >= 0) this.magic.refill(this.world, healed);
      return { kind: "admin", command, ok: true, message: r.message };
    }
    if (command === "injure") {
      const parsed = InjureArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return { kind: "admin", command, ok: false, message: "usage: injure {part, kind?: cut|blunt|thrust, amount?, entity?}" };
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
      const eid = this.world.resolveWireId(target.wireId);
      if (!this.body || eid < 0 || !hasComponent(this.world.ecs, C.Health, eid)) return { kind: "admin", command, ok: false, message: "no body to injure" };
      if (!this.body.parts.includes(parsed.data.part)) return { kind: "admin", command, ok: false, message: `no body part "${parsed.data.part}" (parts: ${this.body.parts.join(", ")})` };
      const r = this.body.applyBlow(this.world, eid, parsed.data.part, parsed.data.kind, parsed.data.amount ?? C.Health.max[eid]);
      return { kind: "admin", command, ok: true, message: `${r.part} ${r.state}${r.lost.length > 0 ? ` (lost ${r.lost.join(", ")})` : ""}` };
    }
    if (command === "skill") {
      const parsed = SkillArgsSchema.safeParse(args ?? {});
      if (!parsed.success) return { kind: "admin", command, ok: false, message: "usage: skill {id, value, entity?}" };
      const target = this.resolveTarget(s, parsed.data.entity);
      if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
      const eid = this.world.resolveWireId(target.wireId);
      const i = this.mastery?.index.of(parsed.data.id) ?? -1;
      if (!this.mastery || eid < 0) return { kind: "admin", command, ok: false, message: "no skills there" };
      if (i < 0) return { kind: "admin", command, ok: false, message: `no skill "${parsed.data.id}" (skills: ${this.mastery.index.ids.join(", ")})` };
      const sheet = this.mastery.sheetOf(eid);
      const v = Math.min(this.mastery.index.rules.max, parsed.data.value);
      sheet.value[i] = v;
      sheet.peak[i] = Math.max(sheet.peak[i], v);
      return { kind: "admin", command, ok: true, message: `${parsed.data.id} ${v}` };
    }
    const parsed = FlyArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command, ok: false, message: "usage: fly {on, entity?}" };
    }
    const target = this.resolveTarget(s, parsed.data.entity);
    if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
    const r = applyFly(this.world, target.wireId, parsed.data.on);
    if (!r.ok) return { kind: "admin", command, ok: false, message: r.message };
    return { kind: "admin", command, ok: true, message: r.message };
  }

  private runGodCommand(s: ClientSession, command: string, args: unknown): AdminResult {
    const parsed = GodArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { kind: "admin", command, ok: false, message: "usage: god {on, entity?}" };
    }
    const target = this.resolveTarget(s, parsed.data.entity);
    if ("error" in target) return { kind: "admin", command, ok: false, message: target.error };
    const r = applyGod(this.world, target.wireId, parsed.data.on);
    if (!r.ok) return { kind: "admin", command, ok: false, message: r.message };
    // Godhood peaks every skill (value and peak), like a lifetime of use
    // at once; switching it off keeps what was learned.
    if (parsed.data.on && this.mastery) {
      const eid = this.world.resolveWireId(target.wireId);
      if (eid >= 0) {
        const sheet = this.mastery.sheetOf(eid);
        const max = this.mastery.index.rules.max;
        for (let i = 0; i < sheet.value.length; i++) {
          sheet.value[i] = max;
          sheet.peak[i] = max;
        }
      }
    }
    return { kind: "admin", command, ok: true, message: r.message };
  }

  /** Record one answered admin command (ring: the last ADMIN_LOG_SIZE). */
  private logAdmin(username: string, command: string, ok: boolean): void {
    this.adminLog.push({ at: this.clock(), username, command, ok });
    if (this.adminLog.length > ADMIN_LOG_SIZE) {
      this.adminLog.splice(0, this.adminLog.length - ADMIN_LOG_SIZE);
    }
    // eslint-disable-next-line no-console
    console.log(`[admin] ${username} ${command} -> ${ok ? "ok" : "rejected"}`);
  }

  /** Recent admin commands, oldest first (a copy). */
  adminLogEntries(): AdminLogEntry[] {
    return [...this.adminLog];
  }

  /**
   * Region chat (protocol 0x11, roadmap S1). Welcomed, in-world senders
   * only; shape-checked, filtered, and per-channel rate-limited. Say and
   * emote reach avatars within SAY_RANGE_M, yell reaches every welcomed
   * session in the world. Rejections are 4003, never silent.
   */
  private onChat(s: ClientSession, payload: Uint8Array): void {
    if (!s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "chat outside the world");
      return;
    }
    let text: string;
    let channel: "say" | "yell" | "emote" | "whisper" | "party" | "guild";
    let to: string | undefined;
    try {
      const raw = decodeControl<unknown>(payload);
      const ext = typeof raw === "object" && raw !== null ? this.extensions.get(String((raw as { kind?: unknown }).kind)) : undefined;
      if (ext) {
        ext.onMessage(this.extensionPlayer(s), raw);
        return;
      }
      if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "block") {
        this.onBlock(s, raw);
        return;
      }
      if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "party") {
        this.onParty(s, raw);
        return;
      }
      if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "friend") {
        this.onFriend(s, raw);
        return;
      }
      if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "guild") {
        this.onGuild(s, raw);
        return;
      }
      const parsed = this.chatRules.ChatSchema.safeParse(raw);
      if (!parsed.success) throw new Error("bad shape");
      if (this.social && parsed.data.text.length > this.social.chat.textMax) throw new Error("too long");
      text = parsed.data.text;
      channel = parsed.data.channel;
      to = parsed.data.to;
    } catch {
      this.sendError(s, 4003, "malformed chat");
      return;
    }
    if (!this.textFilter(text)) {
      this.sendError(s, 4003, "chat rejected");
      return;
    }
    const now = this.clock();
    const cooldown = this.chatCooldownMs(channel);
    const last = s.lastChatMs[channel] ?? -cooldown - 1;
    if (now - last < cooldown) {
      this.sendError(s, 4003, "chat too fast");
      return;
    }
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0 || !hasComponent(this.world.ecs, C.Transform, eid)) {
      this.sendError(s, 4003, "avatar is gone");
      return;
    }
    s.lastChatMs[channel] = now;
    const msg: ChatBroadcast = {
      kind: "chat",
      channel,
      text,
      from: s.character?.name ?? s.username,
      entity: s.playerEntity.toString(),
    };
    if (channel === "whisper" && to !== undefined) {
      msg.to = to;
      const key = to.toLowerCase();
      let target: ClientSession | undefined;
      for (const r of this.sessions.values()) {
        if (r !== s && r.welcomed && (r.character?.name ?? r.username).toLowerCase() === key) target = r;
      }
      // Unknown, offline and blocking all get the same answer.
      if (!target || this.blocks.isBlocked(target.username, s.username)) {
        this.sendSystem(s, this.chatRules.NOT_ONLINE);
        return;
      }
      msg.to = target.character?.name ?? target.username;
      const shown = encodeControl(msg);
      this.sendEnvelope(target, MessageType.Chat, shown);
      this.sendEnvelope(s, MessageType.Chat, shown);
      return;
    }
    const body = encodeControl(msg);
    if (channel === "party") {
      const me = s.character?.name ?? s.username;
      const mates = new Set(this.parties.partyOf(me).map((n) => n.toLowerCase()));
      if (!mates.has(me.toLowerCase())) {
        this.sendSystem(s, "not in a party");
        return;
      }
      for (const r of this.sessions.values()) {
        if (!r.welcomed || !r.socket) continue;
        if (!mates.has((r.character?.name ?? r.username).toLowerCase())) continue;
        if (r !== s && this.blocks.isBlocked(r.username, s.username)) continue;
        this.sendEnvelope(r, MessageType.Chat, body);
      }
      return;
    }
    if (channel === "guild") {
      const me = s.character?.name ?? s.username;
      const mates = new Set(this.guilds.guildOf(me).map((n) => n.toLowerCase()));
      if (!mates.has(me.toLowerCase())) {
        this.sendSystem(s, "not in a guild");
        return;
      }
      for (const r of this.sessions.values()) {
        if (!r.welcomed || !r.socket) continue;
        if (!mates.has((r.character?.name ?? r.username).toLowerCase())) continue;
        if (r !== s && this.blocks.isBlocked(r.username, s.username)) continue;
        this.sendEnvelope(r, MessageType.Chat, body);
      }
      return;
    }
    if (channel === "yell") {
      for (const r of this.sessions.values()) {
        if (r.welcomed && r.playerEntity !== null && !this.blocks.isBlocked(r.username, s.username)) {
          this.sendEnvelope(r, MessageType.Chat, body);
        }
      }
      return;
    }
    const sx = C.Transform.px[eid];
    const sz = C.Transform.pz[eid];
    const range = this.social?.chat.sayRangeM ?? this.chatRules.SAY_RANGE_M;
    const range2 = range * range;
    for (const r of this.sessions.values()) {
      if (!r.welcomed || r.playerEntity === null) continue;
      const reid = this.world.resolveWireId(r.playerEntity);
      if (reid < 0 || !hasComponent(this.world.ecs, C.Transform, reid)) continue;
      const dx = C.Transform.px[reid] - sx;
      const dz = C.Transform.pz[reid] - sz;
      if (dx * dx + dz * dz <= range2 && !this.blocks.isBlocked(r.username, s.username)) {
        this.sendEnvelope(r, MessageType.Chat, body);
      }
    }
  }

  /** The live welcomed session for a character name, if any. */
  private findOnline(name: string): ClientSession | undefined {
    const key = name.toLowerCase();
    for (const r of this.sessions.values()) {
      if (r.welcomed && r.socket && (r.character?.name ?? r.username).toLowerCase() === key) return r;
    }
    return undefined;
  }

  private partyOffline(s: ClientSession): void {
    if (!s.welcomed) return;
    const me = s.character?.name ?? s.username;
    this.parties.setOnline(me, false);
    for (const n of this.parties.partyOf(me)) this.pushParty(n);
  }

  /** Send a character their current party and any pending invite (S3). */
  private pushParty(name: string): void {
    const r = this.findOnline(name);
    if (!r) return;
    const members = this.parties.members(name);
    const invite = this.parties.pendingInvite(name);
    const msg: PartyState = { kind: "party", members, ...(invite ? { invite } : {}) };
    this.sendEnvelope(r, MessageType.Chat, encodeControl(msg));
  }

  /**
   * A party op (S3). Only the leader invites, kicks and promotes; invites to
   * anyone offline, unknown or blocking get the same "not online" notice.
   */
  private onParty(s: ClientSession, raw: unknown): void {
    const parsed = PartyOpSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed party op");
      return;
    }
    const { op, name } = parsed.data;
    const me = s.character?.name ?? s.username;
    let result: PartyResult;
    if (op === "invite") {
      const target = this.findOnline(name as string);
      if (!target || target === s || this.blocks.isBlocked(target.username, s.username)) {
        this.sendSystem(s, target === s ? "cannot invite yourself" : this.chatRules.NOT_ONLINE);
        return;
      }
      result = this.parties.invite(me, target.character?.name ?? target.username);
    } else if (op === "accept") {
      result = this.parties.accept(me);
    } else if (op === "leave") {
      result = this.parties.leave(me);
    } else if (op === "kick") {
      result = this.parties.kick(me, name as string);
    } else {
      result = this.parties.promote(me, name as string);
    }
    if (!result.ok) {
      this.sendSystem(s, result.reason);
      return;
    }
    for (const n of new Set(result.notify)) this.pushParty(n);
  }

  private guildOffline(s: ClientSession): void {
    if (!s.welcomed) return;
    const me = s.character?.name ?? s.username;
    this.guilds.setOnline(me, false);
    for (const n of this.guilds.guildOf(me)) this.pushGuild(n);
  }

  /** Send a character their current guild and any pending invite (S4). */
  private pushGuild(name: string): void {
    const r = this.findOnline(name);
    if (!r) return;
    const invite = this.guilds.pendingInvite(name);
    const msg: GuildState = {
      kind: "guild",
      name: this.guilds.guildName(name) ?? "",
      tag: this.guilds.tagOf(name),
      motd: this.guilds.motd(name),
      rank: this.guilds.rankOf(name),
      members: this.guilds.members(name),
      log: this.guilds.logFor(name),
      ...(invite ? { invite } : {}),
    };
    this.sendEnvelope(r, MessageType.Chat, encodeControl(msg));
  }

  /** Re-send the names rows (with guild tags) of these characters to everyone in the world. */
  private pushTags(names: readonly string[]): void {
    const keys = new Set(names.map((n) => n.toLowerCase()));
    const wire: bigint[] = [];
    for (const r of this.sessions.values()) {
      if (r.playerEntity !== null && r.welcomed && keys.has((r.character?.name ?? r.username).toLowerCase())) {
        wire.push(r.playerEntity);
      }
    }
    if (wire.length === 0) return;
    const env = this.namesFor(wire);
    if (!env) return;
    for (const r of this.sessions.values()) {
      if (r.welcomed && r.socket) this.deliver(r, env, this.tick);
    }
  }

  /**
   * A guild op (S4). Rank rules live in GuildBook; invites to anyone offline,
   * unknown or blocking get the same "not online" notice, as in parties.
   */
  private onGuild(s: ClientSession, raw: unknown): void {
    const parsed = GuildOpSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed guild op");
      return;
    }
    const { op, name, tag, rank, text } = parsed.data;
    const me = s.character?.name ?? s.username;
    const before = this.guilds.guildOf(me);
    let result: GuildResult;
    if (op === "create") {
      result = this.guilds.create(me, name as string, tag as string);
    } else if (op === "invite") {
      const target = this.findOnline(name as string);
      if (!target || target === s || this.blocks.isBlocked(target.username, s.username)) {
        this.sendSystem(s, target === s ? "cannot invite yourself" : this.chatRules.NOT_ONLINE);
        return;
      }
      result = this.guilds.invite(me, target.character?.name ?? target.username);
    } else if (op === "accept") {
      result = this.guilds.accept(me);
    } else if (op === "leave") {
      result = this.guilds.leave(me);
    } else if (op === "kick") {
      result = this.guilds.kick(me, name as string);
    } else if (op === "setRank") {
      result = this.guilds.setRank(me, name as string, rank as NonNullable<typeof rank>);
    } else {
      result = this.guilds.setMotd(me, text as string);
    }
    if (!result.ok) {
      this.sendSystem(s, result.reason);
      return;
    }
    const touched = new Set([...result.notify, ...before, ...this.guilds.guildOf(me)]);
    for (const n of touched) this.pushGuild(n);
    this.pushTags([...touched]);
  }

  /** A server notice in the sender's chat (S2). */
  private sendSystem(s: ClientSession, text: string): void {
    const msg: ChatBroadcast = { kind: "chat", channel: "system", text, from: "", entity: "" };
    this.sendEnvelope(s, MessageType.Chat, encodeControl(msg));
  }

  /** Character names playing here (welcomed, connected): the presence report. */
  private onlineNames(): string[] {
    const out: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.welcomed && s.socket) out.push(s.character?.name ?? s.username);
    }
    return out;
  }

  /** Tell everyone who lists this character as a friend that its presence changed (S2b). */
  private friendPresence(s: ClientSession): void {
    if (!s.welcomed) return;
    this.presence?.report(this.onlineNames());
    for (const w of this.friends.watchers(s.character?.name ?? s.username)) this.pushFriends(w);
  }

  /** Last friends list sent, per viewer: cross-region refreshes only re-push on change. */
  private readonly lastFriendsPush = new Map<string, string>();

  /** A viewer's friends with local presence (S2b). */
  private friendRows(name: string, elsewhere: Record<string, string | null> = {}): { name: string; online: boolean }[] {
    const r = this.findOnline(name);
    return this.friends.list(name).map((f) => {
      const o = this.findOnline(f);
      if (o !== undefined) {
        // A friend who blocks you looks offline, so presence never leaks past a block.
        return { name: f, online: !this.blocks.isBlocked(o.username, r?.username ?? "") };
      }
      // Cross-region (S2): no username to check blocks against, so a
      // blocked player elsewhere still shows online (documented gap).
      return { name: f, online: elsewhere[f] != null };
    });
  }

  /** Send a character their friends list with presence (S2b). */
  private pushFriends(name: string): void {
    const r = this.findOnline(name);
    if (!r) return;
    const friends = this.friendRows(name);
    const msg: FriendsState = { kind: "friends", friends };
    this.sendEnvelope(r, MessageType.Chat, encodeControl(msg));
    this.lastFriendsPush.set(name.toLowerCase(), JSON.stringify(friends));
  }

  /**
   * Refresh friends lists from the world directory (S2 cross-region
   * presence): report our names, then ask where each online viewer's
   * locally-offline friends play and re-push lists that gain rows.
   * Called on a timer by the server; tests drive it directly.
   */
  async syncPresence(): Promise<void> {
    const adapter = this.presence;
    if (!adapter) return;
    adapter.report(this.onlineNames());
    for (const s of this.sessions.values()) {
      if (!s.welcomed || !s.socket) continue;
      const name = s.character?.name ?? s.username;
      const missing = this.friends.list(name).filter((f) => !this.findOnline(f));
      if (missing.length === 0) continue;
      let elsewhere: Record<string, string | null>;
      try {
        elsewhere = await adapter.query(missing);
      } catch {
        continue;
      }
      if (this.findOnline(name) !== s) continue;
      const friends = this.friendRows(name, elsewhere);
      if (this.lastFriendsPush.get(name.toLowerCase()) === JSON.stringify(friends)) continue;
      const msg: FriendsState = { kind: "friends", friends };
      this.sendEnvelope(s, MessageType.Chat, encodeControl(msg));
      this.lastFriendsPush.set(name.toLowerCase(), JSON.stringify(friends));
    }
  }

  /** Add or remove a friend (S2b). Adding resolves only online characters, like blocking. */
  private onFriend(s: ClientSession, raw: unknown): void {
    const parsed = FriendSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed friend");
      return;
    }
    const me = s.character?.name ?? s.username;
    if (!parsed.data.on) {
      const gone = this.friends.list(me).find((f) => f.toLowerCase() === parsed.data.name.toLowerCase());
      if (gone !== undefined) this.friends.remove(me, gone);
      this.pushFriends(me);
      return;
    }
    const target = this.findOnline(parsed.data.name);
    if (!target || this.blocks.isBlocked(target.username, s.username)) {
      this.sendSystem(s, this.chatRules.NOT_ONLINE);
      return;
    }
    const res = this.friends.add(me, target.character?.name ?? target.username);
    if (res === "self") this.sendSystem(s, "cannot add yourself");
    else if (res === "full") this.sendSystem(s, "friends list is full");
    else if (res === "exists") this.sendSystem(s, "already a friend");
    else this.sendSystem(s, `added ${target.character?.name ?? target.username}`);
    this.pushFriends(me);
  }

  /**
   * Block or unblock a character by name (S2). Blocks are per account and
   * silent to the blocked side; the blocker gets a notice.
   */
  private onBlock(s: ClientSession, raw: unknown): void {
    const parsed = this.chatRules.BlockSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed block");
      return;
    }
    const key = parsed.data.name.toLowerCase();
    // Unblocking matches the block list first, so a character who is offline can still come off it (U8).
    if (!parsed.data.on) {
      const listed = this.blocks.accountNamed(s.username, parsed.data.name);
      if (listed !== undefined) {
        this.blocks.remove(s.username, listed);
        this.sendSystem(s, `unblocked ${parsed.data.name}`);
        this.pushBlocks(s);
        return;
      }
    }
    let target: ClientSession | undefined;
    for (const r of this.sessions.values()) {
      if ((r.character?.name ?? r.username).toLowerCase() === key) target = r;
    }
    // Blocking resolves only online characters until the character store is asked by name.
    if (target === undefined) {
      this.sendSystem(s, this.chatRules.NOT_ONLINE);
      return;
    }
    const account = target.username;
    if (!parsed.data.on) {
      this.blocks.remove(s.username, account);
      this.sendSystem(s, `unblocked ${parsed.data.name}`);
    } else if (this.blocks.add(s.username, account, target.character?.name ?? target.username)) {
      this.sendSystem(s, `blocked ${parsed.data.name}`);
    } else {
      this.sendSystem(s, "cannot block");
    }
    this.pushBlocks(s);
  }

  /** Send a session its block list (U8). */
  private pushBlocks(s: ClientSession): void {
    const msg: BlocksState = { kind: "blocks", blocked: this.blocks.names(s.username) };
    this.sendEnvelope(s, MessageType.Chat, encodeControl(msg));
  }

  /**
   * Authenticate a hello (auth slice). Async because password verification
   * is async; failures are contained — auth never throws out of the
   * message pump.
   */
  private onHello(s: ClientSession, payload: Uint8Array): void {
    if (!this.beginJoin(s)) return;
    void this.authenticate(s, payload)
      .catch((err: unknown) => {
        // Defense in depth: a store/argon2 failure must not kill the pump.
        // eslint-disable-next-line no-console
        console.error(
          `[gateway] auth error: ${err instanceof Error ? err.message : err}`,
        );
        this.sendErrorAndClose(s, 4004, "internal auth error");
      })
      .finally(() => {
        s.joining = false;
      });
  }

  /**
   * A connection joins once. Another hello or register after the welcome
   * would run the fresh-join path again and spawn a second avatar for the
   * same client (orphaning the first); one sent while the first is still
   * being checked would start another argon2 hash. Both are refused.
   */
  private beginJoin(s: ClientSession): boolean {
    if (s.welcomed || s.joining || s.choosingCharacter) {
      this.sendError(s, 4003, s.joining ? "join already in progress" : "already joined");
      return false;
    }
    s.joining = true;
    return true;
  }

  private async authenticate(
    s: ClientSession,
    payload: Uint8Array,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed hello");
      return;
    }
    // Zod: shape/lengths/formats only — NOT the auth decision.
    const parsed = parseHello(raw);
    if (!parsed) {
      this.sendError(s, 4003, "malformed hello");
      return;
    }
    if (parsed.value.protocol !== PROTOCOL_VERSION) {
      this.sendErrorAndClose(
        s,
        4001,
        `protocol mismatch: server speaks ${PROTOCOL_VERSION}`,
      );
      return;
    }

    // Only failed attempts consume the per-IP budget; a success clears it.
    if (this.rateLimiter.isLimited(s.remoteIp)) {
      this.sendErrorAndClose(
        s,
        4002,
        "auth failed: too many attempts, try again later",
      );
      return;
    }

    // Narrowed by parsed.kind: credentials vs token variant.
    const clientLabel = JSON.stringify(parsed.value.client);
    let sessionToken: string;
    if (parsed.kind === "credentials") {
      const { username, password } = parsed.value;
      if (!(await this.checkPassword(username, password))) {
        this.rateLimiter.recordFailure(s.remoteIp);
        this.sendErrorAndClose(s, 4002, "auth failed");
        return;
      }
      this.rateLimiter.recordSuccess(s.remoteIp);
      sessionToken = this.authSessions.create(s.clientId, username);
      // eslint-disable-next-line no-console
      console.log(`[gateway] hello client=${clientLabel} via=password`);
    } else if (parsed.kind === "migration") {
      const token = await this.handoffArrive(parsed.value.migration, parsed.value.ticket);
      if (!token) {
        this.rateLimiter.recordFailure(s.remoteIp);
        this.sendErrorAndClose(s, 4002, "auth failed");
        return;
      }
      this.rateLimiter.recordSuccess(s.remoteIp);
      sessionToken = token;
      // eslint-disable-next-line no-console
      console.log(`[gateway] hello client=${clientLabel} via=migration`);
    } else {
      const sess = this.authSessions.get(parsed.value.token);
      if (!sess) {
        this.rateLimiter.recordFailure(s.remoteIp);
        this.sendErrorAndClose(s, 4002, "auth failed");
        return;
      }
      this.rateLimiter.recordSuccess(s.remoteIp);
      sessionToken = sess.token;
      // eslint-disable-next-line no-console
      console.log(`[gateway] hello client=${clientLabel} via=token`);
    }

    await this.joinWithSession(s, sessionToken, parsed.value.characters === true);
  }

  /**
   * Shared join tail for hello and register: with a valid session token
   * in hand, re-attach/take over the existing session for that token, or
   * spawn a fresh player entity — then welcome + snapshot. Split out of
   * authenticate() so register() reuses the exact same join semantics.
   */
  private async joinWithSession(s: ClientSession, sessionToken: string, choose: boolean): Promise<void> {
    // The client may have disconnected while async auth work ran — the
    // close handler already reaped the pending session.
    if (!this.sessions.has(s.clientId)) return;

    const knownId = this.tokenToClient.get(sessionToken);
    const known = knownId ? this.sessions.get(knownId) : undefined;
    if (known && known !== s) {
      // Re-attach (grace period) or takeover (live session): the pending
      // session is discarded; the known session gets the new socket.
      this.sessions.delete(s.clientId);
      this.authSessions.rebind(sessionToken, known.clientId);
      this.attachSocket(known, s.socket!);
      this.sendWelcome(known);
      this.sendFreshSnapshot(known);
      this.sendStats(known, this.tick, true);
      this.sendBody(known, this.tick, true);
      this.sendSkills(known, this.tick, true);
      this.sendMana(known, this.tick, true);
      this.sendInventory(known);
      return;
    }

    // Fresh join: either a brand-new login, or a token whose session
    // outlived its grace-period binding (entity was despawned; spawn new).
    s.token = sessionToken;
    this.authSessions.rebind(sessionToken, s.clientId);
    const auth = this.authSessions.get(sessionToken);
    if (!auth) {
      this.sendErrorAndClose(s, 4002, "auth failed");
      return;
    }
    s.username = auth.username;
    // Adminhood is decided once here, from the authenticated username —
    // never from anything the client claims later. Re-attached sessions
    // keep the flag they were given at join.
    s.isAdmin = this.devServer || this.admins.has(auth.username);
    // A session that already entered as a character re-enters as it.
    if (auth.character) {
      if (!(await this.prepareCharacterEntry(auth.character))) {
        this.sendErrorAndClose(s, 4002, "auth failed");
        return;
      }
      this.enterWorld(s, auth.character);
      return;
    }
    if (choose) {
      s.choosingCharacter = true;
      await this.sendAccount(s);
      return;
    }
    // No choice asked for: the account's first character, if any.
    const [first] = await this.characterStore.list(s.username);
    if (!this.sessions.has(s.clientId)) return;
    const chosen = first ? this.remember(s, first) : null;
    if (!(await this.prepareCharacterEntry(chosen))) {
      this.sendErrorAndClose(s, 4002, "auth failed");
      return;
    }
    this.enterWorld(s, chosen);
  }

  /** Record `c` as the character of the session's token (see AuthSession.character). */
  private remember(s: ClientSession, c: CharacterRecord): { id: number; name: string; look: string } {
    const character = { id: c.id, name: c.name, look: c.look };
    const auth = this.authSessions.get(s.token);
    if (auth) auth.character = character;
    return character;
  }

  /**
   * Persistence P4 (fleet mode): acquire the character's world
   * session lock and seed the local store from the world record —
   * both BEFORE the character is playable (enterWorld). True when
   * the character may enter (always true standalone, and for sessions
   * without a character). On refusal the caller answers through the
   * join path's existing error semantics (4002 on a hello, 4005 on
   * enter_world) — there is no parallel auth path.
   */
  private async prepareCharacterEntry(character: { id: number } | null): Promise<boolean> {
    if (!character || !this.worldCharacters) return true;
    const res = await this.worldCharacters.login(character.id);
    return res.ok;
  }

  /**
   * Spawn the session's avatar (with the character's look, or the
   * default) and welcome it into the world.
   */
  private enterWorld(s: ClientSession, character: { id: number; name: string; look: string } | null): void {
    if (character) this.evictCharacter(character.id, s);
    s.choosingCharacter = false;
    s.character = character ? { id: character.id, name: character.name } : null;
    s.playerEntity = this.spawnPlayerEntity(character?.look ?? DEFAULT_LOOK_JSON, character?.id ?? null);
    if (character) this.restoreCharacterState(this.world.resolveWireId(s.playerEntity), character.id);
    s.welcomed = true;
    // Starter weapon (M3b): once per character per run, then show it.
    if (this.items) {
      const avatar = this.world.resolveWireId(s.playerEntity);
      if (avatar >= 0) {
        this.items.outfit(this.holderOf(s));
        this.refreshAvatarLook(avatar, this.holderOf(s));
      }
    }
    s.lastSeenMs = this.clock();
    this.tokenToClient.set(s.token, s.clientId);
    this.sendWelcome(s);
    this.sendFreshSnapshot(s);
    this.sendStats(s, this.tick, true);
    this.sendBody(s, this.tick, true);
    this.sendSkills(s, this.tick, true);
    this.sendMana(s, this.tick, true);
    this.sendInventory(s);
  }

  /**
   * A character is in the world once: another session playing it (live
   * or in its grace period) is ended and its avatar removed.
   */
  private evictCharacter(id: number, except: ClientSession): void {
    for (const other of [...this.sessions.values()]) {
      if (other === except || other.character?.id !== id) continue;
      if (other.playerEntity !== null) {
        const eid = this.world.resolveWireId(other.playerEntity);
        this.saveAvatar(eid);
        this.mastery?.forget(eid);
        this.world.despawn(parseWireEntityId(other.playerEntity).slot);
      }
      other.playerEntity = null;
      if (this.tokenToClient.get(other.token) === other.clientId) this.tokenToClient.delete(other.token);
      this.sessions.delete(other.clientId);
      if (other.socket) {
        this.sendError(other, 4005, "this character entered the world elsewhere");
        try {
          other.socket.close(4000, "superseded by new connection");
        } catch {
          /* ignore */
        }
        other.socket = null;
      }
    }
  }

  /** Tell a choosing session its account's characters. */
  private async sendAccount(s: ClientSession, created?: number): Promise<void> {
    const records = await this.characterStore.list(s.username);
    if (!this.sessions.has(s.clientId)) return;
    const msg: AccountMessage = {
      session_token: s.token,
      characters: records.map((r) => ({
        id: r.id,
        name: r.name,
        look: parseLook(r.look) ?? parseLook(DEFAULT_LOOK_JSON)!,
      })),
      max_characters: this.maxCharacters,
      ...(created !== undefined ? { created } : {}),
    };
    this.sendEnvelope(s, MessageType.Account, encodeControl(msg));
  }

  /** Run an async handler; a store failure answers 4004 and never kills the pump. */
  private contain(s: ClientSession, what: string, work: Promise<void>): void {
    void work.catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[gateway] ${what} error: ${err instanceof Error ? err.message : err}`);
      this.sendError(s, 4004, `internal error (${what})`);
    });
  }

  /** create_character (0x0d): check the name and look, store, answer with the account. */
  private async onCreateCharacter(s: ClientSession, payload: Uint8Array): Promise<void> {
    if (!s.choosingCharacter) {
      this.sendError(s, 4003, "create_character outside character selection");
      return;
    }
    let raw: unknown;
    try {
      if (payload.length > MAX_CREATE_PAYLOAD_BYTES) throw new Error("too large");
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed create_character");
      return;
    }
    const parsed = CreateCharacterSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed create_character (name: 3-16 letters, ' or -)");
      return;
    }
    const checked = checkNewLook(this.characterCatalog, parsed.data.look);
    if ("problems" in checked) {
      this.sendError(s, 4005, `look refused: ${checked.problems.slice(0, 3).join("; ")}`);
      return;
    }
    let record: CharacterRecord;
    try {
      record = await this.characterStore.create(s.username, parsed.data.name, checked.json, this.maxCharacters);
    } catch (err) {
      if (err instanceof CharacterRefusedError) {
        this.sendError(s, 4005, err.message);
        return;
      }
      throw err;
    }
    // eslint-disable-next-line no-console
    console.log(`[gateway] character created user=${JSON.stringify(s.username)} name=${JSON.stringify(record.name)}`);
    await this.sendAccount(s, record.id);
  }

  /** enter_world (0x0e): spawn as one of the account's characters. */
  private async onEnterWorld(s: ClientSession, payload: Uint8Array): Promise<void> {
    if (!s.choosingCharacter) {
      this.sendError(s, 4003, s.welcomed ? "already in the world" : "enter_world before hello");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed enter_world");
      return;
    }
    const parsed = EnterWorldSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed enter_world");
      return;
    }
    const record = await this.characterStore.get(s.username, parsed.data.character);
    if (!this.sessions.has(s.clientId) || !s.choosingCharacter) return;
    if (!record) {
      this.sendError(s, 4005, "no such character");
      return;
    }
    // Fleet mode (P4): the world session lock gates entry; a live
    // holder elsewhere refuses here, in character selection, so the
    // player can pick another character.
    if (!(await this.prepareCharacterEntry(record))) {
      this.sendError(s, 4005, "that character is already in the world elsewhere");
      return;
    }
    if (!this.sessions.has(s.clientId) || !s.choosingCharacter) return;
    this.enterWorld(s, this.remember(s, record));
  }

  /**
   * In-client account creation (protocol 0x0b, `register`). Creates the
   * user, mints a session, and joins exactly like a credentials hello.
   * Async and contained like authenticate(): a store/argon2 failure must
   * not kill the message pump.
   */
  private onRegister(s: ClientSession, payload: Uint8Array): void {
    if (!this.beginJoin(s)) return;
    void this.registerAccount(s, payload)
      .catch((err: unknown) => {
        // Defense in depth: a store/argon2 failure must not kill the pump.
        // eslint-disable-next-line no-console
        console.error(
          `[gateway] register error: ${err instanceof Error ? err.message : err}`,
        );
        this.sendErrorAndClose(s, 4004, "internal auth error");
      })
      .finally(() => {
        s.joining = false;
      });
  }

  private async registerAccount(
    s: ClientSession,
    payload: Uint8Array,
  ): Promise<void> {
    if (!this.opts.allowRegister) {
      this.sendErrorAndClose(s, 4002, "registration disabled");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed register");
      return;
    }
    // Zod: shape/lengths/formats only — NOT the account decision.
    const parsed = RegisterSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed register");
      return;
    }
    const { protocol, client, username, password, characters } = parsed.data;
    if (protocol !== PROTOCOL_VERSION) {
      this.sendErrorAndClose(
        s,
        4001,
        `protocol mismatch: server speaks ${PROTOCOL_VERSION}`,
      );
      return;
    }

    // Registration attempts share the per-IP auth budget with logins:
    // minting accounts must not be a free oracle.
    if (this.rateLimiter.isLimited(s.remoteIp)) {
      this.sendErrorAndClose(
        s,
        4002,
        "auth failed: too many attempts, try again later",
      );
      return;
    }

    if (await this.credentialStore.findUser(username)) {
      this.rateLimiter.recordFailure(s.remoteIp);
      this.sendErrorAndClose(s, 4002, "username is taken");
      return;
    }
    // Hash BEFORE the store ever sees it: plaintext never persists,
    // and the password/hash are never logged.
    try {
      await this.credentialStore.createUser(
        username,
        await hashPassword(password),
      );
    } catch (err) {
      // Lost a concurrent-register race: the username appeared between
      // findUser and createUser.
      if (
        err instanceof Error &&
        err.message.includes("already exists")
      ) {
        this.rateLimiter.recordFailure(s.remoteIp);
        this.sendErrorAndClose(s, 4002, "username is taken");
        return;
      }
      throw err;
    }
    this.rateLimiter.recordSuccess(s.remoteIp);
    const sessionToken = this.authSessions.create(s.clientId, username);
    // eslint-disable-next-line no-console
    console.log(
      `[gateway] register client=${JSON.stringify(client)} user=${JSON.stringify(username)}`,
    );
    await this.joinWithSession(s, sessionToken, characters === true);
  }

  /**
   * Constant-time password check. Unknown users verify against a dummy
   * hash so the timing doesn't reveal whether the username exists.
   */
  private async checkPassword(
    username: string,
    password: string,
  ): Promise<boolean> {
    const rec = await this.credentialStore.findUser(username);
    const ok = await verifyPassword(
      rec ? rec.passwordHash : DUMMY_HASH,
      password,
    );
    return ok && rec !== null;
  }

  /**
   * Move a live socket onto an existing session (re-attach or takeover).
   * The old socket, if any, is superseded — its close event is ignored
   * by the guard in onConnection.
   */
  private attachSocket(s: ClientSession, socket: WireSocket): void {
    const old = s.socket;
    // The old socket holds the sector subscription (if any): leave the
    // topic before it is replaced, so the new socket re-subscribes
    // cleanly on the next delta tick.
    if (old) this.clearSectorSubscription(s);
    s.socket = socket;
    s.disconnectedAtMs = null;
    s.missedHeartbeats = 0;
    s.lastPingMs = 0; // pings sent to the old socket don't count against this one
    s.lastSeenMs = this.clock();
    s.sendQueue.length = 0;
    s.needsResync = false;
    // The socket arrived routed to a discarded pending session — rewire
    // it to the re-attached session.
    this.route(s, socket);
    if (old && old.isOpen) {
      try {
        old.close(4000, "superseded by new connection");
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Token buckets (roadmap T1): refill pro-rata from the clock, take one.
   * Scalar math on the session's fields only — no allocation per
   * message. A legit client never notices: it sends at most one intent
   * per tick and pickups on key presses, far under either budget.
   */
  private takeToken(s: ClientSession, kind: "intent" | "pickup"): boolean {
    const now = this.clock();
    const rate = kind === "intent" ? this.ingress.intentsPerSecond : this.ingress.pickupsPerSecond;
    const burst = kind === "intent" ? this.ingress.intentBurst : this.ingress.pickupBurst;
    const tokens = kind === "intent" ? s.intentTokens : s.pickupTokens;
    const at = kind === "intent" ? s.intentRefillMs : s.pickupRefillMs;
    const refilled = Math.min(burst, tokens + ((now - at) / 1000) * rate);
    if (kind === "intent") {
      s.intentTokens = refilled;
      s.intentRefillMs = now;
    } else {
      s.pickupTokens = refilled;
      s.pickupRefillMs = now;
    }
    if (refilled < 1) return false;
    if (kind === "intent") s.intentTokens = refilled - 1;
    else s.pickupTokens = refilled - 1;
    return true;
  }

  /**
   * Count one excess message; past the budget inside the window the live
   * session is disconnected (grace parking still applies, like a
   * heartbeat timeout). Silent: answering every dropped message would
   * let an attacker trade one inbound frame for one outbound frame.
   */
  private noteViolation(s: ClientSession): void {
    const now = this.clock();
    if (now - s.violationWindowStartMs >= this.ingress.abuseWindowSeconds * 1000) {
      s.violations = 0;
      s.violationWindowStartMs = now;
    }
    s.violations += 1;
    if (s.violations >= this.ingress.maxViolations && s.socket !== null) {
      this.abuseDisconnects += 1;
      s.violations = 0; // one disconnect per window, not one per message
      this.dropSession(s, "too many requests");
    }
  }

  private onIntent(s: ClientSession, payload: Uint8Array): void {
    // The bucket gates every intent — valid, malformed, or foreign — so
    // a flood costs one counter check whether or not it would decode.
    if (!this.takeToken(s, "intent")) {
      s.droppedIntents += 1;
      this.droppedByRateLimitIntents += 1;
      this.noteViolation(s);
      return;
    }
    if (!s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "intent before hello");
      return;
    }
    let clientTick: bigint;
    let entity: bigint;
    let intent: Parameters<SimWorld["queueIntent"]>[1];
    try {
      const msg = decodeIntentMessage(payload);
      clientTick = msg.clientTick;
      entity = msg.entity;
      const clean = sanitizeIntent(msg.intent);
      if (clean === null) throw new Error("non-finite intent");
      intent = clean;
    } catch {
      s.droppedIntents += 1;
      this.sendError(s, 4003, "malformed intent");
      return;
    }
    // Authority: a client drives ONLY its own player entity. Anything
    // else is rejected, never applied.
    if (entity !== s.playerEntity) {
      s.droppedIntents += 1;
      this.sendError(s, 4003, "intent for foreign entity");
      return;
    }
    // Stale intents (out of order / duplicates) are dropped and counted.
    if (clientTick <= s.lastIntentTick) {
      s.droppedIntents += 1;
      return;
    }
    s.lastIntentTick = clientTick;
    const { slot } = parseWireEntityId(entity);
    this.world.queueIntent(slot, intent);
  }

  // ------------------------------------------------------------ outbound

  private sendEnvelope(
    s: ClientSession,
    type: MessageType,
    payload: Uint8Array,
  ): void {
    if (s.socket && s.socket.isOpen) {
      s.socket.send(encodeEnvelope(type, payload));
    }
  }

  private sendError(s: ClientSession, code: ErrorMessage["code"], message: string): void {
    this.sendEnvelope(
      s,
      MessageType.Error,
      encodeControl({ code, message } satisfies ErrorMessage),
    );
  }

  private sendErrorAndClose(
    s: ClientSession,
    code: ErrorMessage["code"],
    message: string,
  ): void {
    this.sendError(s, code, message);
    try {
      s.socket?.close(4000, message);
    } catch {
      /* ignore */
    }
  }

  private sendWelcome(s: ClientSession): void {
    const welcome: WelcomeMessage = {
      protocol: PROTOCOL_VERSION,
      player_entity: (s.playerEntity as bigint).toString(),
      server_tick: this.tick,
      tick_hz: TICK_HZ,
      snapshot_every: this.opts.snapshotEveryTicks,
      session_token: s.token,
      ...(this.worldInfo ? { world: this.worldInfo } : {}),
      ...(this.dayClock ? { day: this.dayClock } : {}),
      weather: this.weatherOverride,
      ...(s.character ? { character: s.character } : {}),
    };
    this.sendEnvelope(s, MessageType.Welcome, encodeControl(welcome));
    this.parties.setOnline(s.character?.name ?? s.username, true);
    for (const n of this.parties.partyOf(s.character?.name ?? s.username)) this.pushParty(n);
    this.pushParty(s.character?.name ?? s.username);
    const who = s.character?.name ?? s.username;
    this.guilds.setOnline(who, true);
    for (const n of this.guilds.guildOf(who)) this.pushGuild(n);
    this.pushGuild(who);
    this.pushFriends(who);
    this.pushBlocks(s);
    this.friendPresence(s);
    for (const ext of this.extensions.values()) ext.onEnter?.(this.extensionPlayer(s));
  }

  /** The session as an extension sees it (see ./extension.ts). */
  private extensionPlayer(s: ClientSession): ExtensionPlayer {
    return {
      characterId: s.character?.id ?? null,
      username: s.username,
      name: s.character?.name ?? s.username,
      entity: () => (s.playerEntity === null ? -1 : this.world.resolveWireId(s.playerEntity)),
      send: (msg) => this.sendEnvelope(s, MessageType.Chat, encodeControl(msg)),
      refreshInventory: () => this.sendInventory(s),
    };
  }

  private extensionsLeave(s: ClientSession): void {
    if (!s.welcomed) return;
    for (const ext of this.extensions.values()) ext.onLeave?.(this.extensionPlayer(s));
  }

  /** Full baseline snapshot, e.g. on join or re-attach. */
  private sendFreshSnapshot(s: ClientSession): void {
    // Names first: the snapshot shows every entity, so every character
    // entity is first-shown here (catalog §0x12).
    const names = this.namesFor(null);
    if (names) this.deliver(s, names, this.tick);
    const drops = this.dropsFor(null);
    if (drops) this.deliver(s, drops, this.tick);
    // What the resource nodes are and hold, and the player's pouch (catalog 0x24).
    const gathering = this.gathering;
    if (gathering && gathering.size > 0) this.sendEnvelope(s, MessageType.Gather, encodeControl({ kind: "resources", nodes: gathering.views(this.world) } satisfies ResourcesMessage));
    if (gathering && s.playerEntity !== null) this.sendEnvelope(s, MessageType.Gather, encodeControl(gathering.pouchMessage(this.holderOf(s))));
    if (this.interest) {
      // Interest management: the next tick sends a full replace of what this session sees.
      s.interestSet = null;
      return;
    }
    this.deliverSnapshot(
      s,
      encodeEnvelope(
        MessageType.Snapshot,
        encodeSnapshotFromSim(this.world, this.tick, { chunkSource: this.chunkSource }),
      ),
      this.tick,
    );
  }

  /**
   * The player's stance (catalog 0x19, M3): the technique and aim of their
   * blows. In-world sessions only; shares the pickup bucket (key presses).
   * A bad shape is 4003, an unknown technique or part 4005.
   */
  private onStance(s: ClientSession, payload: Uint8Array): void {
    const combat = this.systems.find((x): x is CombatSystem => x instanceof CombatSystem);
    if (!combat || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "stance outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed stance");
      return;
    }
    const parsed = StanceSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed stance");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) return;
    const err = combat.setStance(avatar, parsed.data.technique, parsed.data.aim);
    if (err) this.sendError(s, 4005, err);
  }

  /**
   * Trigger an ability (catalog 0x1d, M5). The AbilitySystem decides
   * whether it fires now, queues, or rejects; the outcome drains as an
   * `ability` event next tick.
   */
  private onAbility(s: ClientSession, payload: Uint8Array): void {
    const abilities = this.systems.find((x): x is AbilitySystem => x instanceof AbilitySystem);
    if (!abilities || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "ability outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed ability");
      return;
    }
    const parsed = AbilityTriggerSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed ability");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) return;
    abilities.trigger(avatar, parsed.data.id, this.tick);
  }

  /**
   * Duel actions (catalog 0x20, M5): challenge/accept/decline/yield. The
   * DuelSystem owns the flow; its events drain next tick.
   */
  private onDuel(s: ClientSession, payload: Uint8Array): void {
    const duels = this.systems.find((x): x is DuelSystem => x instanceof DuelSystem);
    if (!duels || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "duel outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed duel");
      return;
    }
    const parsed = DuelActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed duel");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) return;
    const tick = this.tick;
    switch (parsed.data.action) {
      case "challenge": {
        if (parsed.data.target === undefined) {
          this.sendError(s, 4003, "challenge needs a target");
          return;
        }
        let target: number;
        try {
          target = this.world.resolveWireId(BigInt(parsed.data.target));
        } catch {
          this.sendError(s, 4003, "bad target");
          return;
        }
        if (target < 0) {
          this.sendError(s, 4005, "no such target");
          return;
        }
        if (!duels.challenge(avatar, target, tick)) this.sendError(s, 4005, "cannot challenge now");
        break;
      }
      case "accept":
        if (!duels.accept(avatar, tick)) this.sendError(s, 4005, "nothing to accept");
        break;
      case "decline":
        if (!duels.decline(avatar, tick)) this.sendError(s, 4005, "nothing to decline");
        break;
      case "yield":
        if (!duels.yield(avatar, tick)) this.sendError(s, 4005, "not dueling");
        break;
    }
  }

  /** The session whose avatar has this wire id, if they're online. */
  private sessionByEntity(wireId: string): ClientSession | undefined {
    let entity: bigint;
    try {
      entity = BigInt(wireId);
    } catch {
      return undefined;
    }
    for (const r of this.sessions.values()) {
      if (r.welcomed && r.playerEntity === entity) return r;
    }
    return undefined;
  }

  /**
   * Trade with another player (catalog 0x21, EC1): open, offer gold or
   * bag items, accept, cancel. In-world sessions only; shares the pickup
   * rate-limit bucket. A bad shape is 4003, a refusal 4005; trade state
   * comes back as `trade` events, gold as `wallet`.
   */
  private onTrade(s: ClientSession, payload: Uint8Array): void {
    const trade = this.systems.find((x): x is TradeSystem => x instanceof TradeSystem);
    if (!trade || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "trade outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed trade");
      return;
    }
    const parsed = TradeActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed trade");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const me = this.holderOf(s);
    const tick = this.tick;
    switch (parsed.data.action) {
      case "open": {
        if (parsed.data.target === undefined) {
          this.sendError(s, 4003, "trade needs a target");
          return;
        }
        const targetSession = this.sessionByEntity(parsed.data.target);
        if (!targetSession) {
          this.sendError(s, 4005, "no such target");
          return;
        }
        const other = this.holderOf(targetSession);
        if (other === me) {
          this.sendError(s, 4005, "cannot trade with that");
          return;
        }
        if (trade.open(me, other, tick) === null) this.sendError(s, 4005, "cannot trade now");
        break;
      }
      case "offer": {
        if (parsed.data.id === undefined) {
          this.sendError(s, 4003, "offer needs a trade id");
          return;
        }
        const id = parsed.data.id;
        let ok = true;
        if (parsed.data.gold !== undefined) ok = trade.offerGold(id, me, parsed.data.gold, tick) && ok;
        if (parsed.data.addItem !== undefined) ok = trade.offerItem(id, me, parsed.data.addItem, tick) && ok;
        if (parsed.data.removeItem !== undefined) ok = trade.removeItem(id, me, parsed.data.removeItem, tick) && ok;
        if (!ok) this.sendError(s, 4005, "offer refused");
        break;
      }
      case "accept":
        if (parsed.data.id === undefined || !trade.accept(parsed.data.id, me, tick)) {
          this.sendError(s, 4005, "nothing to accept");
        }
        break;
      case "cancel":
        if (parsed.data.id === undefined || !trade.cancel(parsed.data.id, me, tick)) {
          this.sendError(s, 4005, "nothing to cancel");
        }
        break;
    }
  }

  /** 0x21 carries trade, vendor, and auction actions; route by kind. */
  private onTradeOrVendor(s: ClientSession, payload: Uint8Array): void {
    let kind: unknown;
    try {
      kind = (decodeControl<{ kind?: unknown }>(payload)).kind;
    } catch {
      this.sendError(s, 4003, "malformed trade");
      return;
    }
    // Slice A2 (fleet mode): the commit actions (a completing trade
    // accept, a vendor buy/sell, an auction buyout) go through the
    // async world-tier handlers; every other action is handled by
    // the ordinary synchronous handlers, exactly as standalone.
    if (kind === "vendor") {
      if (this.atomicOps) this.contain(s, "vendor", this.onVendorFleet(s, payload));
      else this.onVendor(s, payload);
    } else if (kind === "auction") {
      if (this.atomicOps) this.contain(s, "auction", this.onAuctionFleet(s, payload));
      else this.onAuction(s, payload);
    } else {
      if (this.atomicOps) this.contain(s, "trade", this.onTradeFleet(s, payload));
      else this.onTrade(s, payload);
    }
  }

  /**
   * The refusal text for a settled world rejection (slice A2): the
   * typed rejection surfaces through the gateway's existing 4005
   * refusal semantics, in the vocabulary the local paths use where
   * one exists.
   */
  private atomicRefusal(result: AtomicOpResult & { ok: false }): string {
    switch (result.rejection) {
      case "INSUFFICIENT_FUNDS":
        return "not enough gold";
      case "ITEM_NOT_PRESENT":
        return "that item is not there";
      default:
        return `refused by the world (${result.rejection}: ${result.message})`;
    }
  }

  /**
   * Trade in fleet mode (slice A2): open/offer/cancel and a
   * non-completing accept are region-side negotiation and run
   * through the ordinary handler. A COMPLETING accept routes the
   * settlement through the world-tier `tradeCommit`: on success the
   * trade closes as settled (its event and the wallet changes drain
   * on the next tick as usual) with the local caches already
   * reconciled to the world records; on a rejection or an outage
   * the trade cancels — the existing failed-settlement semantics —
   * and nothing has moved anywhere.
   */
  private async onTradeFleet(s: ClientSession, payload: Uint8Array): Promise<void> {
    const trade = this.systems.find((x): x is TradeSystem => x instanceof TradeSystem);
    if (!trade || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "trade outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed trade");
      return;
    }
    const parsed = TradeActionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action !== "accept" || parsed.data.id === undefined) {
      this.onTrade(s, payload);
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const me = this.holderOf(s);
    const tick = this.tick;
    const id = parsed.data.id;
    const t = trade.pending(id);
    if (!t || (me !== t.a && me !== t.b)) {
      this.sendError(s, 4005, "nothing to accept");
      return;
    }
    const otherAccepted = me === t.a ? t.bAccepted : t.aAccepted;
    if (!otherAccepted) {
      // Not the completing accept: record it locally, as standalone.
      trade.accept(id, me, tick);
      return;
    }
    let result: AtomicOpResult;
    try {
      result = await this.atomicOps!.trade({
        a: t.a,
        b: t.b,
        aGivesGold: t.aGold,
        bGivesGold: t.bGold,
        aGivesItems: t.aItems.map(itemInstanceId),
        bGivesItems: t.bItems.map(itemInstanceId),
      });
    } catch {
      trade.failSettlement(id, tick);
      this.sendError(s, 4005, "trade refused: the world tier is unreachable");
      return;
    }
    if (!result.ok) {
      trade.failSettlement(id, tick);
      this.sendError(s, 4005, this.atomicRefusal(result));
      return;
    }
    trade.settleFromWorld(id, tick);
    this.sendInventory(s);
    const other = this.sessionOf(me === t.a ? t.b : t.a);
    if (other) this.sendInventory(other);
  }

  /**
   * Vendor in fleet mode (slice A2): `list` is region-side and runs
   * through the ordinary handler. Buy and sell validate region-side
   * (the system's terms checks, the wallet balance, bag room), then
   * route the value movement through the world-tier
   * `vendorTransact`; the settled outcome reconciles the buyer's
   * gold and bag before the usual vendor/inventory messages go out.
   * A rejection or an outage refuses with 4005 and moves nothing —
   * the pre-allocated purchase item is destroyed, never bagged.
   */
  private async onVendorFleet(s: ClientSession, payload: Uint8Array): Promise<void> {
    const vendor = this.systems.find((x): x is VendorSystem => x instanceof VendorSystem);
    if (!vendor || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "vendor outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed vendor");
      return;
    }
    const parsed = VendorActionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action === "list") {
      this.onVendor(s, payload);
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const sim = this.world;
    const me = sim.resolveWireId(s.playerEntity);
    if (me < 0) return;
    const meChar = this.holderOf(s);
    const tick = this.tick;
    if (parsed.data.vendor === undefined) {
      this.sendError(s, 4003, "vendor action needs a vendor");
      return;
    }
    let vEntity = -1;
    try {
      vEntity = sim.resolveWireId(BigInt(parsed.data.vendor));
    } catch {
      vEntity = -1;
    }
    if (vEntity < 0) {
      this.sendError(s, 4005, "no such vendor");
      return;
    }
    const wire = parsed.data.vendor;
    const wallet = this.systems.find((x): x is WalletSystem => x instanceof WalletSystem);
    if (parsed.data.action === "buy") {
      if (parsed.data.def === undefined) {
        this.sendError(s, 4003, "buy needs a def");
        return;
      }
      const def = parsed.data.def;
      const terms = vendor.buyTerms(sim, me, vEntity, def);
      if ("error" in terms) {
        this.sendError(s, 4005, terms.error);
        return;
      }
      if (!wallet || wallet.balanceOf(meChar) < terms.price) {
        this.sendError(s, 4005, "not enough gold");
        return;
      }
      if (!this.items || !this.items.store.hasRoom(meChar)) {
        this.sendError(s, 4005, "your bag is full");
        return;
      }
      // Allocate the purchased item's identity locally (Free state,
      // in no bag): the world grant and the local item share it, and
      // a failed commit destroys it without ever bagging it.
      const item = this.items.store.create(def, this.items.defs.durability[def]);
      let result: AtomicOpResult;
      try {
        result = await this.atomicOps!.vendor({
          character: meChar,
          vendorId: terms.vendorId,
          direction: "buy",
          def,
          price: terms.price,
          instanceId: itemInstanceId(item),
        });
      } catch {
        this.items.store.destroy(item);
        this.sendError(s, 4005, "vendor refused: the world tier is unreachable");
        return;
      }
      if (!result.ok) {
        this.items.store.destroy(item);
        this.sendError(s, 4005, this.atomicRefusal(result));
        return;
      }
      vendor.commitBuyStock(terms.vendorId, def);
      const m: VendorMessage = {
        kind: "vendor",
        tick,
        vendor: wire,
        state: "bought",
        def,
        price: terms.price,
      };
      this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
      this.sendInventory(s);
      return;
    }
    // sell
    if (parsed.data.item === undefined) {
      this.sendError(s, 4003, "sell needs an item");
      return;
    }
    const item = parsed.data.item;
    const terms = vendor.sellTerms(sim, me, vEntity, item);
    if ("error" in terms) {
      this.sendError(s, 4005, terms.error);
      return;
    }
    if (!this.items || !this.items.store.inBagOf(meChar, item)) {
      this.sendError(s, 4005, "you don't have that");
      return;
    }
    let result: AtomicOpResult;
    try {
      result = await this.atomicOps!.vendor({
        character: meChar,
        vendorId: terms.vendorId,
        direction: "sell",
        def: terms.def,
        price: terms.price,
        instanceId: itemInstanceId(item),
      });
    } catch {
      this.sendError(s, 4005, "vendor refused: the world tier is unreachable");
      return;
    }
    if (!result.ok) {
      this.sendError(s, 4005, this.atomicRefusal(result));
      return;
    }
    const m: VendorMessage = {
      kind: "vendor",
      tick,
      vendor: wire,
      state: "sold",
      item,
    };
    this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
    this.sendInventory(s);
  }

  /**
   * Auction in fleet mode (slice A2): browse/list/bid/cancel are
   * region-side negotiation and run through the ordinary handler.
   * A buyout validates region-side, then routes the settlement
   * through the world-tier `auctionSettle` (buyer pays the full
   * price, seller receives it net of the same 5% house cut a local
   * settle takes — fleet auction parity). When the buyer is their own top bidder,
   * their escrow is first released locally and the made-whole
   * balance uploaded, so the world charges the full price exactly
   * once. A rejection or an outage refuses with 4005; the listing
   * stays live and no value has moved.
   */
  private async onAuctionFleet(s: ClientSession, payload: Uint8Array): Promise<void> {
    const auction = this.systems.find((x): x is AuctionSystem => x instanceof AuctionSystem);
    if (!auction || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "auction outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed auction");
      return;
    }
    const parsed = AuctionActionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action !== "buyout") {
      this.onAuction(s, payload);
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const me = this.holderOf(s);
    const tick = this.tick;
    if (parsed.data.listing === undefined) {
      this.sendError(s, 4003, "buyout needs a listing");
      return;
    }
    const terms = auction.buyoutTerms(me, parsed.data.listing, tick);
    if ("error" in terms) {
      this.sendError(s, 4005, terms.error);
      return;
    }
    const l = terms.listing;
    if (l.topBidder === me && l.topBid > 0) {
      auction.releaseEscrow(l.id, tick);
      if (this.worldCharacters) await this.worldCharacters.save(me);
    }
    let result: AtomicOpResult;
    try {
      result = await this.atomicOps!.auction({
        buyer: me,
        seller: l.seller,
        instanceId: itemInstanceId(l.item),
        price: l.buyout,
      });
    } catch {
      this.sendError(s, 4005, "auction refused: the world tier is unreachable");
      return;
    }
    if (!result.ok) {
      this.sendError(s, 4005, this.atomicRefusal(result));
      return;
    }
    auction.settleFromWorld(l.id, me, tick);
    const tell = (m: AuctionMessage): void => {
      this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
    };
    tell({ kind: "auction", tick, state: "sold", listing: undefined });
    this.sendInventory(s);
    const seller = this.sessionOf(l.seller);
    if (seller) this.sendInventory(seller);
  }

  /**
   * Buy from and sell to an NPC vendor (catalog 0x21, EC1). In-world
   * sessions only; shares the pickup rate-limit bucket. A bad shape is
   * 4003, a refusal (not a vendor, too far, broke, full bag) 4005;
   * results come back as `vendor` events, gold as `wallet`.
   */
  private onVendor(s: ClientSession, payload: Uint8Array): void {
    const vendor = this.systems.find((x): x is VendorSystem => x instanceof VendorSystem);
    if (!vendor || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "vendor outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed vendor");
      return;
    }
    const parsed = VendorActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed vendor");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const sim = this.world;
    const me = sim.resolveWireId(s.playerEntity);
    if (me < 0) return;
    const meChar = this.holderOf(s);
    const tick = this.tick;
    if (parsed.data.vendor === undefined) {
      this.sendError(s, 4003, "vendor action needs a vendor");
      return;
    }
    // The vendor is any world entity (usually an NPC), not a session.
    let vEntity = -1;
    try {
      vEntity = sim.resolveWireId(BigInt(parsed.data.vendor));
    } catch {
      vEntity = -1;
    }
    if (vEntity < 0) {
      this.sendError(s, 4005, "no such vendor");
      return;
    }
    const wire = parsed.data.vendor;
    switch (parsed.data.action) {
      case "list": {
        const view = vendor.list(vEntity);
        if (!view) {
          this.sendError(s, 4005, "not a vendor");
          return;
        }
        const m: VendorMessage = {
          kind: "vendor",
          tick,
          vendor: wire,
          state: "listed",
          name: view.name,
          stock: view.stock.map((l) => ({ ...l, name: l.name ?? "" })),
          buybackRate: view.buybackRate,
        };
        this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
        break;
      }
      case "buy": {
        if (parsed.data.def === undefined) {
          this.sendError(s, 4003, "buy needs a def");
          return;
        }
        const err = vendor.buy(sim, meChar, me, vEntity, parsed.data.def, tick);
        if (err) {
          this.sendError(s, 4005, err);
          return;
        }
        const view = vendor.list(vEntity)!;
        const line = view.stock.find((l) => l.def === parsed.data.def);
        const m: VendorMessage = {
          kind: "vendor",
          tick,
          vendor: wire,
          state: "bought",
          def: parsed.data.def,
          price: line?.price ?? 0,
        };
        this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
        this.sendInventory(s);
        break;
      }
      case "sell": {
        if (parsed.data.item === undefined) {
          this.sendError(s, 4003, "sell needs an item");
          return;
        }
        const err = vendor.sell(sim, meChar, me, vEntity, parsed.data.item, tick);
        if (err) {
          this.sendError(s, 4005, err);
          return;
        }
        const m: VendorMessage = {
          kind: "vendor",
          tick,
          vendor: wire,
          state: "sold",
          item: parsed.data.item,
        };
        this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
        this.sendInventory(s);
        break;
      }
    }
  }

  /**
   * Auction house (catalog 0x21, EC1): list, bid, buy out, cancel, browse.
   * In-world sessions only; shares the pickup rate-limit bucket. A bad
   * shape is 4003, a refusal 4005; results come back as `auction` events,
   * gold as `wallet`. Expiry and outbid refunds are announced to the
   * parties involved.
   */
  private onAuction(s: ClientSession, payload: Uint8Array): void {
    const auction = this.systems.find((x): x is AuctionSystem => x instanceof AuctionSystem);
    if (!auction || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "auction outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed auction");
      return;
    }
    const parsed = AuctionActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed auction");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const me = this.holderOf(s);
    const tick = this.tick;
    const tell = (m: AuctionMessage): void => {
      this.sendEnvelope(s, MessageType.Trade, encodeControl(m));
    };
    switch (parsed.data.action) {
      case "browse": {
        tell({ kind: "auction", tick, state: "browse", listings: auction.browse() });
        break;
      }
      case "list": {
        if (parsed.data.item === undefined || parsed.data.startBid === undefined) {
          this.sendError(s, 4003, "list needs an item and a starting bid");
          return;
        }
        const id = auction.list(
          me,
          parsed.data.item,
          parsed.data.startBid,
          parsed.data.buyout ?? 0,
          parsed.data.durationMs ?? 24 * 3600 * 1000,
          tick,
        );
        if (id === null) {
          this.sendError(s, 4005, "can't list that item");
          return;
        }
        const view = auction.browse().find((l) => l.id === id);
        tell({ kind: "auction", tick, state: "listed", listing: view });
        this.sendInventory(s);
        break;
      }
      case "bid": {
        if (parsed.data.listing === undefined || parsed.data.amount === undefined) {
          this.sendError(s, 4003, "bid needs a listing and an amount");
          return;
        }
        const err = auction.bid(me, parsed.data.listing, parsed.data.amount, tick);
        if (err) {
          this.sendError(s, 4005, err);
          return;
        }
        const view = auction.browse().find((l) => l.id === parsed.data.listing);
        tell({ kind: "auction", tick, state: "bid", listing: view });
        break;
      }
      case "buyout": {
        if (parsed.data.listing === undefined) {
          this.sendError(s, 4003, "buyout needs a listing");
          return;
        }
        const err = auction.buyout(me, parsed.data.listing, tick);
        if (err) {
          this.sendError(s, 4005, err);
          return;
        }
        tell({ kind: "auction", tick, state: "sold", listing: undefined });
        this.sendInventory(s);
        break;
      }
      case "cancel": {
        if (parsed.data.listing === undefined) {
          this.sendError(s, 4003, "cancel needs a listing");
          return;
        }
        const err = auction.cancel(me, parsed.data.listing, tick);
        if (err) {
          this.sendError(s, 4005, err);
          return;
        }
        tell({ kind: "auction", tick, state: "cancelled", listing: undefined });
        this.sendInventory(s);
        break;
      }
    }
  }

  /**
   * On-demand chunk tiles (protocol 0x22/0x23, chunk streaming). The client
   * asks for "cx,cz" tiles; the gateway generates each from the
   * authoritative ChunkDataSource and answers with base64 heights.
   * Rate-limited per session (10/s); at most 64 keys per request; keys
   * outside the region's range are omitted. Tiles are always LOD 0 —
   * the client derives coarser LODs locally.
   */
  private onTileRequest(s: ClientSession, payload: Uint8Array): void {
    if (!s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "tiles outside the world");
      return;
    }
    if (this.chunkSource === null || this.worldSeed === null) {
      this.sendError(s, 4003, "tile streaming unavailable");
      return;
    }
    // Simple per-session rate limit: 10 tile requests per second.
    const now = this.clock();
    const last = (s as { lastTileReq?: number }).lastTileReq ?? 0;
    if (now - last < 100) {
      this.sendError(s, 4003, "tiles too frequent");
      return;
    }
    (s as { lastTileReq?: number }).lastTileReq = now;

    let msg: TileRequestMessage;
    try {
      msg = decodeControl<TileRequestMessage>(payload);
    } catch {
      this.sendError(s, 4003, "malformed tile request");
      return;
    }
    if (!Array.isArray(msg.keys) || msg.keys.length === 0 || msg.keys.length > 64) {
      this.sendError(s, 4003, "tile request wants 1..64 keys");
      return;
    }
    if (!Number.isSafeInteger(msg.reqId)) {
      this.sendError(s, 4003, "tile request needs an integer reqId");
      return;
    }
    const tiles: TileResponseMessage["tiles"] = [];
    const seen = new Set<string>();
    for (const key of msg.keys) {
      if (typeof key !== "string" || seen.has(key)) continue;
      seen.add(key);
      const m = /^(-?\d+),(-?\d+)$/.exec(key);
      if (!m) continue;
      const cx = Number(m[1]), cz = Number(m[2]);
      if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) continue;
      if (Math.abs(cx) > 1e6 || Math.abs(cz) > 1e6) continue;
      const out = new Float32Array(this.chunkSource.chunkSamples);
      try {
        this.chunkSource.generateChunk(this.worldSeed, cx, cz, 0, out);
      } catch {
        continue; // generation failed: omit the tile (lossy-OK)
      }
      tiles.push({ cx, cz, heights: encodeTileHeights(out) });
    }
    const res: TileResponseMessage = { reqId: msg.reqId, tiles };
    this.sendEnvelope(s, MessageType.TileResponse, encodeControl(res));
  }

  /**
   * Treat a body part (catalog 0x1a, M4): yourself or a character in reach.
   * In-world sessions only; shares the pickup bucket. A bad shape is 4003,
   * a refusal (too far, nothing to treat, no usable hand) 4005; how it goes
   * comes back as `treatment` events.
   */
  private onTreat(s: ClientSession, payload: Uint8Array): void {
    if (!this.body || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "treat outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed treat");
      return;
    }
    const parsed = TreatSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed treat");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const sim = this.world;
    const healer = sim.resolveWireId(s.playerEntity);
    if (healer < 0) return;
    if (parsed.data.stop) {
      this.body.stop(healer);
      return;
    }
    const patient = parsed.data.target === undefined ? healer : sim.resolveWireId(BigInt(parsed.data.target));
    if (patient < 0) {
      this.sendError(s, 4005, "no one to treat");
      return;
    }
    const err = this.body.treat(sim, healer, patient, parsed.data.part);
    if (err) this.sendError(s, 4005, err);
  }

  /**
   * Cast a spell (catalog 0x1c): on yourself or a character in reach. In-world
   * sessions only; shares the pickup bucket. A bad shape is 4003, a refusal
   * (unknown spell, too far, cooling down, not enough mana) 4005; how it
   * goes comes back as `spell` events.
   */
  private onCast(s: ClientSession, payload: Uint8Array): void {
    if (!this.magic || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "cast outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed cast");
      return;
    }
    const parsed = CastSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed cast");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const sim = this.world;
    const caster = sim.resolveWireId(s.playerEntity);
    if (caster < 0) return;
    if (parsed.data.stop) {
      this.magic.stop(caster);
      return;
    }
    const target = parsed.data.target === undefined ? caster : sim.resolveWireId(BigInt(parsed.data.target));
    if (target < 0) {
      this.sendError(s, 4005, "no one to cast on");
      return;
    }
    const err = this.magic.cast(sim, caster, parsed.data.spell!, target);
    if (err) this.sendError(s, 4005, err);
  }

  /**
   * Item actions (catalog §0x13, roadmap M3a): pick a ground item up, or
   * drop one from the bag. In-world sessions only; a bad shape is 4003, a
   * refusal (too far, someone else's, bag full) 4005. Every change answers
   * with the whole bag (0x14).
   */
  private onItem(s: ClientSession, payload: Uint8Array): void {
    if (!this.items || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "items outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed item action");
      return;
    }
    const parsed = ItemActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed item action");
      return;
    }
    // Pickup requests share the session's pickup bucket (roadmap T1):
    // past it the request is dropped and counted, never reaching the
    // item service. Other bag actions are bag-local and stay unthrottled.
    if (parsed.data.action === "pickup" && !this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) {
      this.sendError(s, 4005, "no avatar");
      return;
    }
    const holder = this.holderOf(s);
    const a = parsed.data;
    let result;
    if (a.action === "pickup") {
      const entity = parseEntityArg(a.entity);
      result = entity === null ? { ok: false as const, error: "nothing to pick up there" } : this.items.pickup(this.world, holder, avatar, entity);
    } else if (a.action === "drop") {
      result = this.items.dropFromBag(this.world, holder, avatar, a.item);
    } else if (a.action === "equip") {
      // A maimed or lost hand (M3) can't take hold of anything.
      const hands = this.body?.has(this.world, avatar) ? this.items.handsFor(holder, a.item) : null;
      result = hands?.some((h) => this.body!.armFactor(this.world, avatar, h) === 0)
        ? { ok: false as const, error: "that hand can't hold anything" }
        : this.items.equip(holder, a.item);
    } else {
      result = this.items.unequip(holder, "hand" in a ? a.hand : a.slot);
    }
    if (!result.ok) {
      this.sendError(s, 4005, result.error);
      return;
    }
    if (a.action === "pickup") this.telemetry.pickup();
    else if (a.action === "drop") this.telemetry.drop();
    this.refreshAvatarLook(avatar, holder);
    this.sendInventory(s);
  }

  /**
   * Rewrite the avatar's Appearance from its look plus what its hands
   * hold (M3b): clients that read heldOf() draw the weapon. No-op when
   * the avatar has no Appearance row (never for players).
   */
  private refreshAvatarLook(avatar: number, holder: number): void {
    if (!this.items || !hasComponent(this.world.ecs, C.Appearance, avatar)) return;
    const look = this.world.lookJson(C.Appearance.look[avatar]);
    this.world.setLook(avatar, withHeld(look, this.items.heldModels(holder)));
  }

  /** Who owns a session's bag: its character, or (no character) one id per account. */
  private holderOf(s: ClientSession): number {
    if (s.character) return s.character.id;
    let id = this.accountHolders.get(s.username);
    if (id === undefined) this.accountHolders.set(s.username, (id = -(this.accountHolders.size + 1)));
    return id;
  }

  /** The session's whole bag (catalog §0x14), when the server has items. */
  private sendInventory(s: ClientSession): void {
    if (!this.items || !s.welcomed) return;
    this.sendEnvelope(s, MessageType.Inventory, encodeControl(this.items.inventoryOf(this.holderOf(s))));
  }

  /** The server's gathering system (resource nodes and pouches), if it runs one. */
  private get gathering(): GatheringSystem | undefined {
    return this.systems.find((g): g is GatheringSystem => g instanceof GatheringSystem);
  }

  /** Tell every player in the world about the resource nodes that changed this tick (catalog 0x24). */
  private sendResources(sim: SimWorld): void {
    const nodes = this.gathering?.drainChanges(sim) ?? [];
    if (nodes.length === 0) return;
    const bytes = encodeControl({ kind: "resources", nodes } satisfies ResourcesMessage);
    for (const r of this.sessions.values()) if (r.welcomed && r.playerEntity !== null) this.sendEnvelope(r, MessageType.Gather, bytes);
  }

  /**
   * Gather once from a resource node (catalog 0x24): in-world sessions
   * only; a bad shape is 4003, a refusal (too far, worked out, still
   * gathering, pouch full) 4005. Shares the pickup rate limit. A gather
   * answers with the whole pouch, naming what was added.
   */
  private onGather(s: ClientSession, payload: Uint8Array): void {
    const gathering = this.gathering;
    if (!gathering || !s.welcomed || s.playerEntity === null) {
      this.sendError(s, 4003, "gathering outside the world");
      return;
    }
    let raw: unknown;
    try {
      raw = decodeControl<unknown>(payload);
    } catch {
      this.sendError(s, 4003, "malformed gather");
      return;
    }
    const parsed = GatherActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed gather");
      return;
    }
    if (!this.takeToken(s, "pickup")) {
      s.droppedPickups += 1;
      this.droppedByRateLimitPickups += 1;
      this.noteViolation(s);
      return;
    }
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) {
      this.sendError(s, 4005, "no avatar");
      return;
    }
    const wire = parseEntityArg(parsed.data.entity);
    const holder = this.holderOf(s);
    const result = wire === null ? { ok: false as const, error: "nothing to gather there" } : gathering.gather(this.world, holder, avatar, this.world.resolveWireId(wire));
    if (!result.ok) {
      this.sendError(s, 4005, result.error);
      return;
    }
    this.sendEnvelope(s, MessageType.Gather, encodeControl(gathering.pouchMessage(holder, { material: result.material, name: result.name, count: result.count })));
  }

  /** What these ground items are (catalog §0x15; null: all), enveloped, or null. */
  private dropsFor(only: readonly bigint[] | null): Uint8Array | null {
    if (!this.items) return null;
    const msg = this.items.dropsFor(this.world, only);
    return msg ? encodeEnvelope(MessageType.Drops, encodeControl(msg)) : null;
  }

  /**
   * Item admin commands (roadmap A5, first slice): items, give, drop, loot
   * (see admin/items.ts). Failures read as errors, never throw.
   */
  private runItemCommand(s: ClientSession, command: string, args: unknown): AdminResult {
    const fail = (message: string): AdminResult => ({ kind: "admin", command, ok: false, message });
    const items = this.items;
    if (!items) return fail("no items on this server");
    if (command === "items") {
      const a = ItemPickArgsSchema.safeParse(args ?? {});
      if (!a.success) return fail("usage: items {base?, rank?, source?}");
      return { kind: "admin", command, ok: true, message: describeMatches(items.defs, a.data) };
    }
    if (s.playerEntity === null) return fail("no player entity (not in the world)");
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) return fail("avatar is gone");
    const x = C.Transform.px[avatar];
    const z = C.Transform.pz[avatar];
    const seed = (this.tick * 2654435761 + items.store.size * 40503) >>> 0;
    if (command === "gold") {
      const wallet = this.systems.find((w): w is WalletSystem => w instanceof WalletSystem);
      if (!wallet) return fail("no economy on this server");
      const a = GoldArgsSchema.safeParse(args ?? {});
      if (!a.success) return fail("usage: gold {amount}");
      if (!wallet.grant(this.holderOf(s), a.data.amount, this.tick)) return fail("bad amount");
      return { kind: "admin", command, ok: true, message: `granted ${a.data.amount} gold (balance ${wallet.balanceOf(this.holderOf(s))})` };
    }
    if (command === "loot") {
      const a = LootArgsSchema.safeParse(args ?? {});
      if (!a.success) return fail("usage: loot {count?}");
      const count = a.data.count ?? 5;
      const holder = this.holderOf(s);
      let dropped = 0;
      for (let i = 0; i < count; i++) {
        const def = pickDef(items.defs, { source: "mob" }, seed + i * 7919);
        if (def < 0) break;
        const ang = (i / count) * Math.PI * 2;
        const r = 1.5 + (i % 3) * 0.6;
        items.spawnDrop(this.world, def, x + Math.sin(ang) * r, z + Math.cos(ang) * r, holder);
        dropped++;
      }
      return dropped > 0
        ? { kind: "admin", command, ok: true, message: `dropped ${dropped} mob drop${dropped === 1 ? "" : "s"} around you` }
        : fail("no mob drops in the pool");
    }
    const a = ItemPickArgsSchema.safeParse(args ?? {});
    if (!a.success) return fail(`usage: ${command} {def? | base?, rank?, source?}`);
    const def = pickDef(items.defs, a.data, seed);
    if (def < 0) return fail("no items match");
    if (command === "give") {
      const r = items.give(this.holderOf(s), def);
      if (!r.ok) return fail(r.error);
      this.sendInventory(s);
      return { kind: "admin", command, ok: true, message: r.message };
    }
    const { item, eid } = items.spawnDrop(this.world, def, x + 1, z, 0);
    return { kind: "admin", command, ok: true, message: `dropped ${items.defs.names[def]} (item ${item}) as ${this.world.wireId(eid)}` };
  }

  /**
   * The admin `give` command in fleet mode (slice A2): same pick and
   * answers as the sync path, but the grant itself routes through
   * ItemService.giveGranted — the world-tier `lootGrant` commits it,
   * and a refusal or outage answers 4003 having granted nothing.
   */
  private async runItemGiveFleet(s: ClientSession, args: unknown): Promise<void> {
    const fail = (message: string): void => {
      this.logAdmin(s.username, "give", false);
      this.sendError(s, 4003, message);
    };
    const items = this.items;
    if (!items) return fail("no items on this server");
    if (s.playerEntity === null) return fail("no player entity (not in the world)");
    const avatar = this.world.resolveWireId(s.playerEntity);
    if (avatar < 0) return fail("avatar is gone");
    const a = ItemPickArgsSchema.safeParse(args ?? {});
    if (!a.success) return fail("usage: give {def? | base?, rank?, source?}");
    const seed = (this.tick * 2654435761 + items.store.size * 40503) >>> 0;
    const def = pickDef(items.defs, a.data, seed);
    if (def < 0) return fail("no items match");
    const r = await items.giveGranted(this.holderOf(s), def);
    if (!r.ok) return fail(r.error);
    this.sendInventory(s);
    this.logAdmin(s.username, "give", true);
    const res: AdminResult = { kind: "admin", command: "give", ok: true, message: r.message };
    this.sendEnvelope(s, MessageType.Admin, encodeControl(res));
  }

  /**
   * Vendor admin commands (roadmap EC1): define a vendor template, stock
   * it, attach it to a world entity, or list templates. Failures read as
   * errors, never throw.
   *
   *   vendor {sub: "define", id, name?, buyback?}
   *   vendor {sub: "stock", id, def|name, price, qty?}   (qty -1: infinite; name looks the def up)
   *   vendor {sub: "attach", id, target}            (target: wire id)
   *   vendor {sub: "detach", target}                (target: wire id)
   *   vendor {sub: "spawn", id, asset?, x?, z?}     (spawns the NPC and attaches in one step)
   *   vendor {sub: "disable", id} / {sub: "enable", id}
   *   vendor {sub: "remove", id}                    (deletes the template, detaches everywhere)
   *   vendor {sub: "list"}
   */
  private runVendorCommand(s: ClientSession, args: unknown): AdminResult {
    const fail = (message: string): AdminResult => ({ kind: "admin", command: "vendor", ok: false, message });
    const vendor = this.systems.find((x): x is VendorSystem => x instanceof VendorSystem);
    if (!vendor) return fail("no vendors on this server");
    const a = VendorArgsSchema.safeParse(args ?? {});
    if (!a.success) return fail('usage: vendor {sub: "define"|"stock"|"attach"|"detach"|"spawn"|"disable"|"enable"|"remove"|"list", ...}');
    const d = a.data;
    switch (d.sub) {
      case "define": {
        if (!d.id) return fail('define needs {id, name?}');
        if (!vendor.create(d.id, d.name ?? d.id, d.buyback ?? 0.3)) return fail("bad id or already defined");
        return { kind: "admin", command: "vendor", ok: true, message: `vendor "${d.id}" defined` };
      }
      case "stock": {
        if (!d.id || !d.price) return fail('stock needs {id, def|name, price, qty?}');
        let def: number | undefined = d.def;
        if (def === undefined && d.name) {
          const found = this.lookupItemDef(d.name);
          if (found === null) return fail(`no item named "${d.name}" (try: admin items {base?})`);
          def = found;
        }
        if (def === undefined) return fail('stock needs {id, def|name, price, qty?}');
        if (!vendor.setStock(d.id, def, d.price, d.qty ?? -1)) return fail("unknown vendor or bad price");
        const label = this.items?.defs.names[def] ?? `def ${def}`;
        return { kind: "admin", command: "vendor", ok: true, message: `stocked ${label} at ${d.price}g` };
      }
      case "attach": {
        if (!d.id || !d.target) return fail('attach needs {id, target}');
        const entity = resolveEntityTarget(this.world, d.target);
        if (entity < 0) return fail("no such target");
        if (!vendor.attach(entity, d.id)) return fail("unknown vendor template");
        return { kind: "admin", command: "vendor", ok: true, message: `vendor "${d.id}" attached to ${d.target}` };
      }
      case "detach": {
        if (!d.target) return fail('detach needs {target}');
        const entity = resolveEntityTarget(this.world, d.target);
        if (entity < 0) return fail("no such target");
        if (!vendor.detach(entity)) return fail("that entity is not a vendor");
        return { kind: "admin", command: "vendor", ok: true, message: `vendor detached from ${d.target}` };
      }
      case "spawn": {
        if (!d.id) return fail('spawn needs {id, x?, z?}');
        if (!vendor.templateIds().includes(d.id)) return fail("unknown vendor template (define it first)");
        const spawned = this.spawnVendorNpc(s, d.x, d.z);
        if ("error" in spawned) return fail(spawned.error);
        vendor.attach(spawned.entity, d.id);
        return {
          kind: "admin",
          command: "vendor",
          ok: true,
          message: `vendor "${d.id}" spawned as ${spawned.wireId} at (${Math.round(spawned.x)}, ${Math.round(spawned.z)})`,
        };
      }
      case "disable": {
        if (!d.id) return fail('disable needs {id}');
        if (!vendor.setEnabled(d.id, false)) return fail("unknown vendor template");
        return { kind: "admin", command: "vendor", ok: true, message: `vendor "${d.id}" closed` };
      }
      case "enable": {
        if (!d.id) return fail('enable needs {id}');
        if (!vendor.setEnabled(d.id, true)) return fail("unknown vendor template");
        return { kind: "admin", command: "vendor", ok: true, message: `vendor "${d.id}" open` };
      }
      case "remove": {
        if (!d.id) return fail('remove needs {id}');
        const n = vendor.attachedTo(d.id).length;
        if (!vendor.remove(d.id)) return fail("unknown vendor template");
        return {
          kind: "admin",
          command: "vendor",
          ok: true,
          message: `vendor "${d.id}" removed${n > 0 ? ` (detached from ${n} entit${n === 1 ? "y" : "ies"})` : ""}`,
        };
      }
      case "list": {
        const ids = vendor.templateIds();
        return {
          kind: "admin",
          command: "vendor",
          ok: true,
          message: ids.length > 0 ? `vendors: ${ids.join(", ")}` : "no vendors defined",
        };
      }
    }
  }

  /**
   * Find an item def by (case-insensitive) name; null when there's no
   * single match. Used by `vendor stock {name}`.
   */
  private lookupItemDef(name: string): number | null {
    const defs = this.items?.defs;
    if (!defs) return null;
    const want = name.toLowerCase();
    let found = -1;
    for (let i = 0; i < defs.count; i++) {
      if (defs.names[i]?.toLowerCase() === want) {
        if (found >= 0) return null; // ambiguous
        found = i;
      }
    }
    return found >= 0 ? found : null;
  }

  /**
   * Spawn a vendor NPC: a minimal world entity at (x, z) or at the
   * admin's feet, ready for the vendor template to attach. Returns the
   * entity and wire id, or an error.
   */
  private spawnVendorNpc(
    s: ClientSession,
    x: number | undefined,
    z: number | undefined,
  ): { entity: number; wireId: string; x: number; z: number } | { error: string } {
    const point = resolveSpawnPoint(this.world, s, this.groundHeightAt, x, z);
    if ("error" in point) return { error: point.error };
    const entity = spawnBasicEntity(this.world, point.x, point.y, point.z);
    return { entity, wireId: this.world.wireId(entity).toString(), x: point.x, z: point.z };
  }

  /**
   * Character names for fan-out (C3, catalog §0x12): wire id -> name for
   * every live session avatar and creature (U12a). `only`: restrict to these wire ids (delta
   * spawned lists); null means all. Returns the enveloped message, or
   * null when no rows apply. Rows carry the character's guild tag (S4).
   */
  private namesFor(only: readonly bigint[] | null): Uint8Array | null {
    const rows: Array<[string, string, string]> = [];
    for (const other of this.sessions.values()) {
      if (other.playerEntity === null) continue;
      if (only !== null && !only.includes(other.playerEntity)) continue;
      rows.push([
        other.playerEntity.toString(),
        other.character?.name ?? other.username,
        this.guilds.tagOf(other.character?.name ?? other.username),
      ]);
    }
    const creatures = this.creatures;
    if (creatures?.nameOf) {
      const sim = this.world;
      if (only === null) {
        for (const e of creatures.entities?.() ?? []) {
          const name = creatures.nameOf(e);
          if (name) rows.push([sim.wireId(e).toString(), name, ""]);
        }
      } else {
        for (const w of only) {
          const e = sim.resolveWireId(w);
          const name = e < 0 ? undefined : creatures.nameOf(e);
          if (name) rows.push([w.toString(), name, ""]);
        }
      }
    }
    if (rows.length === 0) return null;
    const msg: NamesMessage = { kind: "names", names: rows };
    return encodeEnvelope(MessageType.Names, encodeControl(msg));
  }

  /**
   * Spawn a player entity: Transform + Velocity + PlayerIntent + Health +
   * Stamina (full; StatsSystem sets the maxima from the rules next tick) +
   * Locomotion (on foot, with the gateway's player abilities, full breath)
   * + Appearance (the character's look, canonical JSON) + Action (no move)
   * + CharacterRef (the character id, when entering as one — C3),
   * and stats at the rules' bases when the game has any (StatsSystem then
   * sets Health.max from them on the next tick).
   * Spawn points spread on a grid so N players don't stack. Player
   * entities are ordinary entities — the sim treats N of them identically
   * (multiplayer by construction, no singleton).
   */
  private spawnPlayerEntity(look: string, characterId: number | null): bigint {
    const sim = this.world;
    const eid = sim.spawn();
    addComponent(sim.ecs, C.Transform, eid);
    addComponent(sim.ecs, C.Velocity, eid);
    addComponent(sim.ecs, C.PlayerIntent, eid);
    addComponent(sim.ecs, C.Health, eid);
    addComponent(sim.ecs, C.Stamina, eid);
    addComponent(sim.ecs, C.Needs, eid);
    addComponent(sim.ecs, C.Locomotion, eid);
    C.Locomotion.mode[eid] = LocomotionMode.Ground;
    C.Locomotion.abilities[eid] = this.playerAbilities;
    C.Locomotion.breath[eid] = 1;
    const T = C.Transform;
    const i = this.playerSeq++;
    // Clear of baked buildings: the spawn point can sit inside a generated town.
    const at = clearOfStatics(sim, this.spawnPoint.x + (i % 8) * 4 - 14, this.spawnPoint.z + Math.floor(i / 8) * 4 - 14, CHARACTER_CAPSULE.radius);
    T.px[eid] = at.x;
    T.pz[eid] = at.z;
    T.py[eid] = this.groundHeightAt?.(T.px[eid], T.pz[eid]) ?? 0;
    T.qx[eid] = 0; T.qy[eid] = 0; T.qz[eid] = 0; T.qw[eid] = 1;
    T.sx[eid] = 1; T.sy[eid] = 1; T.sz[eid] = 1;
    C.Health.current[eid] = 100;
    C.Health.max[eid] = 100;
    C.Stamina.current[eid] = 100;
    C.Stamina.max[eid] = 100;
    // Full meters (NeedsSystem sets the maxima from the rules next tick).
    C.Needs.hunger[eid] = C.Needs.hungerMax[eid] = 100;
    C.Needs.thirst[eid] = C.Needs.thirstMax[eid] = 100;
    sim.setLook(eid, look);
    addComponent(sim.ecs, C.Action, eid);
    C.Action.move[eid] = 0;
    ensureAnimation(sim, eid);
    if (characterId !== null) {
      addComponent(sim.ecs, C.CharacterRef, eid);
      C.CharacterRef.idHi[eid] = Math.floor(characterId / 4294967296);
      C.CharacterRef.idLo[eid] = characterId % 4294967296;
    }
    if (!sim.stats.empty) sim.stats.attach(eid);
    return sim.wireId(eid);
  }
}
