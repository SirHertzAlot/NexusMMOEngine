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

import { addComponent, defineQuery, hasComponent } from "bitecs";
import {
  decodeControl,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type AdminCommand,
  type AdminResult,
  type ChatBroadcast,
  type PartyState,
  type FriendsState,
  type GuildState,
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
  type BodyMessage,
  type HitMessage,
  type LifeMessage,
  type NamesMessage,
  type StatsMessage,
  type WelcomeMessage,
  type DayClock,
  type WorldInfo,
  Ability,
  LocomotionMode,
} from "@mmo-engine/protocol";
import * as C from "../components.js";
import { parseWireEntityId } from "../entity-id.js";
import type { DebugSource } from "./debug-source.js";
import { inspectEntity, InspectArgsSchema } from "../admin/inspect.js";
import { applySet, SetArgsSchema } from "../admin/set.js";
import { applyFly, applyHeal, applyTeleport, FlyArgsSchema, HealArgsSchema, InjureArgsSchema, TeleportArgsSchema } from "../admin/player.js";
import { buildSpawn, DespawnArgsSchema, listAssets, SpawnArgsSchema } from "../admin/spawn.js";
import { loadScatterContent, spawnScatterEntity } from "../procgen/scatter-spawn.js";
import { parseEntityArg, type ItemService } from "../items/index.js";
import { describeMatches, ItemActionSchema, ItemPickArgsSchema, LootArgsSchema, pickDef } from "../admin/items.js";
import type { SpawnTable } from "@mmo-engine/scatter";
import { createTransport, type HttpHandler, type Transport, type TransportKind, type WireSocket } from "./transport.js";
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
  verifyPassword,
  type CredentialStore,
} from "../auth/index.js";
import {
  attachChunkHeights,
  collectDeltaState,
  collectFullState,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  type CollectedState,
} from "../snapshot.js";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { STEP_MS, TickLoop } from "../tick-loop.js";
import { PartyBook, PartyOpSchema, type PartyResult } from "../party.js";
import { GuildBook, GuildOpSchema, type GuildResult, type GuildStore } from "../guild.js";
import { FriendBook, FriendSchema } from "../friends.js";
import { allowAllText, BlockList, BlockSchema, CHAT_COOLDOWN_MS, ChatSchema, NOT_ONLINE, SAY_RANGE_M, type TextFilter } from "../chat.js";
import { IntentSystem, IntegrateSystem, type SimSystem } from "../systems.js";
import { CombatSystem } from "../combat.js";
import { DeathSystem } from "../death.js";
import { StatsSystem } from "../stats/stats-system.js";
import { SimWorld } from "../world.js";
import { decodeIntentMessage, sanitizeIntent } from "./intent.js";
import type { MasterySystem } from "../stats/mastery-system.js";
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

export interface GatewayOptions {
  /** Port to bind; 0 = ephemeral (listen() returns the actual port). */
  port?: number;
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
  /** Guild persistence (S4b). Default: in memory; the production server passes a SqliteGuildStore. */
  guildStore?: GuildStore;
  /**
   * The modular part catalog new characters' looks are checked against;
   * null/absent = structural checks only (a server without the art).
   */
  characterCatalog?: ModularCatalog | null;
  /** Characters an account may have. Default 8. */
  maxCharacters?: number;
  /** Session token TTL. Default 24 h. */
  sessionTtlMs?: number;
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
  /**
   * Region chat text filter (roadmap S1): return false to reject a line.
   * Default allows everything that passes shape limits; a profanity or
   * abuse service plugs in here without gateway changes.
   */
  textFilter?: TextFilter;
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
   * MMO_TRANSPORT, else auto.
   */
  transport?: TransportKind;
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
}

const avatarQuery = defineQuery([C.PlayerIntent]);

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
const DISCONNECT_GRACE_MS = 30000;
const SNAPSHOT_EVERY_TICKS = 300;
const TICK_HZ = 30;
/** How often a player's body is checked for changes to send (catalog 0x18): 5 times a second. */
const BODY_EVERY_TICKS = 6;
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
      | "characterCatalog"
      | "maxCharacters"
      | "sessionTtlMs"
      | "authRateLimit"
      | "textFilter"
      | "debugSource"
      | "chunkSource"
      | "maxClientPayloadBytes"
      | "ingress"
      | "groundHeightAt"
      | "mastery"
      | "body"
      | "creatures"
      | "spawnPoint"
      | "worldInfo"
      | "dayClock"
      | "playerAbilities"
      | "http"
      | "transport"
      | "spawnTable"
      | "items"
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
  private readonly characterCatalog: ModularCatalog | null;
  private readonly maxCharacters: number;
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
  private readonly groundHeightAt: ((x: number, z: number) => number) | null;
  private readonly mastery: MasterySystem | null;
  private readonly body: BodySystem | null;
  /** The body message last sent to each session, as its JSON (see sendBody). */
  private readonly bodySent = new WeakMap<ClientSession, string>();
  /** Play counters and tick timing (T2); read by the admin `stats` command. */
  readonly telemetry = new PlayTelemetry();
  private readonly creatures: GatewayOptions["creatures"] | null;
  private readonly spawnPoint: { x: number; z: number };
  private readonly worldInfo: WorldInfo | null;
  private readonly dayClock: DayClock | null;
  private readonly playerAbilities: number;
  /** Who blocks whom, by account (S2). */
  private readonly blocks = new BlockList();
  private readonly friends = new FriendBook();
  /** Parties, in memory (S3). */
  private readonly parties = new PartyBook(() => this.clock());
  private readonly guilds: GuildBook;
  /** Region chat text filter (GatewayOptions.textFilter). */
  private readonly textFilter: TextFilter;
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
  /** The stats version last sent to each session (see sendStats). */
  private readonly statsSent = new WeakMap<ClientSession, number>();
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

  private readonly transportKind: TransportKind | undefined;
  private transport: Transport | null = null;
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
    this.credentialStore = opts.credentialStore ?? new CsvCredentialStore();
    this.characterStore = opts.characterStore ?? new MemoryCharacterStore();
    this.characterCatalog = opts.characterCatalog ?? null;
    this.maxCharacters = opts.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.debugSource = opts.debugSource ?? null;
    this.chunkSource = opts.chunkSource ?? null;
    this.groundHeightAt = opts.groundHeightAt ?? null;
    this.mastery = opts.mastery ?? null;
    this.body = opts.body ?? null;
    this.creatures = opts.creatures ?? null;
    this.spawnPoint = opts.spawnPoint ?? { x: 0, z: 0 };
    this.worldInfo = opts.worldInfo ?? null;
    this.dayClock = opts.dayClock ?? null;
    this.playerAbilities = opts.playerAbilities ?? Ability.Swim;
    this.admins = new Set(this.opts.admins);
    this.devServer = this.opts.devServer;
    this.spawnTable = opts.spawnTable ?? null;
    this.textFilter = opts.textFilter ?? allowAllText;
    this.items = opts.items ?? null;
    this.httpHandler = opts.http ?? null;
    this.transportKind = opts.transport;
    this.authSessions = new SessionManager({
      ttlMs: opts.sessionTtlMs,
      clock: this.clock,
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

  /**
   * Terrain-height channel: fill authoritative heights on chunk rows
   * when a chunk source is configured. Identity when absent (tests,
   * addon-less environments) — snapshots then carry metadata only.
   */
  private withHeights(state: CollectedState): CollectedState {
    if (this.chunkSource !== null) {
      attachChunkHeights(state, this.chunkSource);
    }
    return state;
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
    const transport = createTransport(this.transportKind);
    this.transport = transport;
    return transport.listen(this.opts.port, {
      connection: (socket) => this.onConnection(socket),
      http: this.httpHandler,
      // Refuse an oversized frame at the protocol layer: the transports
      // close the connection (ws: 1009) instead of buffering the payload.
      maxMessageBytes: this.maxClientPayloadBytes,
    });
  }

  /** Which socket library serves the port ("uws" or "ws"), once listening. */
  get transportName(): string | null {
    return this.transport?.kind ?? null;
  }

  /**
   * Begin the wall-clock tick driver (production). Tests skip this and
   * drive frame() manually with a synthetic clock instead.
   */
  startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.loop.frame(this.clock());
    }, STEP_MS / 2);
    this.tickTimer.unref();
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
  setHttpHandler(handler: HttpHandler): void {
    if (this.transport) throw new Error("gateway: set the HTTP handler before listen()");
    this.httpHandler = handler;
  }

  /**
   * The account behind a live session token (the welcome's
   * session_token), or null: how HTTP services authenticate callers.
   */
  sessionUser(token: string): { username: string } | null {
    const session = this.authSessions.get(token);
    return session ? { username: session.username } : null;
  }

  // ------------------------------------------------------------ tick

  private onTick(tick: number): void {
    const t0 = performance.now();
    this.runTick(tick);
    this.telemetry.tickMs(performance.now() - t0);
  }

  private runTick(tick: number): void {
    this.tick = tick;
    const sim = this.world;
    sim.beginTick(tick); // drain intent events into PlayerIntent components
    const dt = STEP_MS / 1000;
    for (const s of this.systems) s.step(sim, dt);
    sim.emitTick(tick);
    this.sendHits(sim, tick);
    this.sendLife(sim, tick);
    this.dropFromUselessHands(sim);
    this.showLostParts(sim);

    const state = this.withHeights(collectDeltaState(sim, tick, tick - 1, this.tracker));
    // Names for newly spawned character entities ride before the delta
    // that first shows them (catalog §0x12).
    const namesEnv = this.namesFor(state.spawned);
    const dropsEnv = this.dropsFor(state.spawned);
    const deltaBytes = encodeDelta(state);
    this.tracker.commit(sim);
    sim.endTick();

    this.broadcast(tick, deltaBytes, namesEnv, dropsEnv);
    this.sweepGracePeriods();
    this.maybeHeartbeat();
  }

  /** Tell every welcomed player about the blows struck this tick (catalog 0x16). */
  private sendHits(sim: SimWorld, tick: number): void {
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
      }));
      for (const r of this.sessions.values()) {
        if (!r.welcomed || r.playerEntity === null) continue;
        for (const m of msgs) this.sendEnvelope(r, MessageType.Hit, encodeControl(m));
      }
    }
  }

  /**
   * Tell every welcomed player about deaths and respawns this tick (catalog
   * 0x17), and write a dying character's death record when the rules ask.
   */
  private sendLife(sim: SimWorld, tick: number): void {
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
        for (const m of msgs) this.sendEnvelope(r, MessageType.Life, encodeControl(m));
      }
    }
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
    }
    return n;
  }

  /**
   * Put a freshly spawned avatar where its character last was, with the
   * health and stamina it had. A character saved dead (or never saved)
   * keeps the ordinary spawn: death and respawn are the rules' business.
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
    const T = C.Transform;
    T.px[eid] = st.x;
    T.pz[eid] = st.z;
    T.py[eid] = this.groundHeightAt?.(st.x, st.z) ?? st.y;
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
    const r = applyTeleport(sim, sim.wireId(eid), x, z, this.groundHeightAt ? this.groundHeightAt(x, z) : null);
    return r.ok;
  }

  /** Fan one tick's state out to every connected session (broadcast). */
  private broadcast(tick: number, deltaBytes: Uint8Array, namesEnv: Uint8Array | null, dropsEnv: Uint8Array | null = null): void {
    const isSnapshotTick = tick % this.opts.snapshotEveryTicks === 0;
    const deltaEnv = encodeEnvelope(MessageType.Delta, deltaBytes);
    let snapshotEnv: Uint8Array | undefined;
    const snapshotFor = (): Uint8Array =>
      (snapshotEnv ??= encodeEnvelope(
        MessageType.Snapshot,
        encodeSnapshot(this.withHeights(collectFullState(this.world, tick))),
      ));

    for (const s of this.sessions.values()) {
      if (!s.welcomed || !s.socket) continue; // pending or in grace period
      if (namesEnv) this.deliver(s, namesEnv, tick);
      if (dropsEnv) this.deliver(s, dropsEnv, tick);
      if (isSnapshotTick || s.needsResync) {
        this.deliverSnapshot(s, snapshotFor(), tick);
      } else {
        this.deliver(s, deltaEnv, tick);
      }
      this.sendStats(s, tick);
      if (tick % BODY_EVERY_TICKS === 0) this.sendBody(s, tick);
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
   * The player's own stats (catalog §0x0f), when they changed since they
   * were last sent to this session; `force` sends them regardless (on
   * joining or re-attaching, the client has none yet).
   */
  private sendStats(s: ClientSession, tick: number, force = false): void {
    if (s.playerEntity === null) return;
    const eid = this.world.resolveWireId(s.playerEntity);
    if (eid < 0) return;
    const version = this.world.stats.version(eid);
    if (version === 0 || (!force && this.statsSent.get(s) === version)) return;
    this.statsSent.set(s, version);
    const sheet = this.world.stats.sheet(eid)!;
    // Display values: 4 decimals is plenty, and keeps float noise off the wire.
    const round = (v: number): number => Math.round(v * 1e4) / 1e4;
    const line = (l: (typeof sheet)[number]) => ({ id: l.id, name: l.name, value: round(l.value), base: round(l.base) });
    const msg: StatsMessage = {
      entity: s.playerEntity.toString(),
      attributes: sheet.filter((l) => l.attribute).map(line),
      stats: sheet.filter((l) => !l.attribute).map(line),
    };
    this.deliver(s, encodeEnvelope(MessageType.Stats, encodeControl(msg)), tick);
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
    s.socket = null;
    s.sendQueue.length = 0;
    s.disconnectedAtMs = this.clock();
    this.partyOffline(s);
    this.guildOffline(s);
    this.friendPresence(s);
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
        message: "commands: help, whoami, stats, inspect, set, spawnlist, spawn, despawn, teleport, heal, injure, fly, items, give, drop, loot",
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
    } else if (cmd.command === "spawnlist" || cmd.command === "spawn" || cmd.command === "despawn") {
      res = this.runSpawnCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "items" || cmd.command === "give" || cmd.command === "drop" || cmd.command === "loot") {
      res = this.runItemCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
      }
    } else if (cmd.command === "teleport" || cmd.command === "heal" || cmd.command === "fly" || cmd.command === "injure") {
      res = this.runPlayerCommand(s, cmd.command, cmd.args);
      if (!res.ok) {
        this.logAdmin(s.username, cmd.command, false);
        this.sendError(s, 4003, res.message);
        return;
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
    let x = parsed.data.x;
    let z = parsed.data.z;
    let y: number;
    if (x === undefined || z === undefined) {
      if (s.playerEntity === null) {
        return { kind: "admin", command, ok: false, message: "no player entity (not in the world)" };
      }
      const eid = this.world.resolveWireId(s.playerEntity);
      if (eid < 0) return { kind: "admin", command, ok: false, message: "avatar is gone" };
      x = C.Transform.px[eid];
      z = C.Transform.pz[eid];
      y = C.Transform.py[eid];
    } else {
      y = this.groundHeightAt?.(x, z) ?? 0;
    }
    if (this.creatures?.has(parsed.data.asset)) {
      const ids = this.creatures.spawnPack(this.world, parsed.data.asset, x, z);
      return { kind: "admin", command, ok: true, message: `spawned a pack of ${ids.length} ${parsed.data.asset}` };
    }
    const built = buildSpawn(table, parsed.data.asset, x, y, z, parsed.data.yaw ?? 0);
    if ("error" in built) return { kind: "admin", command, ok: false, message: built.error };
    const eid = spawnScatterEntity(this.world, built);
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
      const ground = this.groundHeightAt ? this.groundHeightAt(parsed.data.x, parsed.data.z) : null;
      const r = applyTeleport(this.world, target.wireId, parsed.data.x, parsed.data.z, ground);
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
      const parsed = ChatSchema.safeParse(raw);
      if (!parsed.success) throw new Error("bad shape");
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
    const last = s.lastChatMs[channel] ?? -CHAT_COOLDOWN_MS[channel] - 1;
    if (now - last < CHAT_COOLDOWN_MS[channel]) {
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
        this.sendSystem(s, NOT_ONLINE);
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
    const range2 = SAY_RANGE_M * SAY_RANGE_M;
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
        this.sendSystem(s, target === s ? "cannot invite yourself" : NOT_ONLINE);
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
        this.sendSystem(s, target === s ? "cannot invite yourself" : NOT_ONLINE);
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

  /** Tell everyone who lists this character as a friend that its presence changed (S2b). */
  private friendPresence(s: ClientSession): void {
    if (!s.welcomed) return;
    for (const w of this.friends.watchers(s.character?.name ?? s.username)) this.pushFriends(w);
  }

  /** Send a character their friends list with presence (S2b). */
  private pushFriends(name: string): void {
    const r = this.findOnline(name);
    if (!r) return;
    const friends = this.friends.list(name).map((f) => {
      const o = this.findOnline(f);
      // A friend who blocks you looks offline, so presence never leaks past a block.
      return { name: f, online: o !== undefined && !this.blocks.isBlocked(o.username, r.username) };
    });
    const msg: FriendsState = { kind: "friends", friends };
    this.sendEnvelope(r, MessageType.Chat, encodeControl(msg));
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
      this.sendSystem(s, NOT_ONLINE);
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
    const parsed = BlockSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(s, 4003, "malformed block");
      return;
    }
    const key = parsed.data.name.toLowerCase();
    let account: string | undefined;
    for (const r of this.sessions.values()) {
      if ((r.character?.name ?? r.username).toLowerCase() === key) account = r.username;
    }
    // Only online characters resolve until the character store is asked by name.
    if (account === undefined) {
      this.sendSystem(s, NOT_ONLINE);
      return;
    }
    if (!parsed.data.on) {
      this.blocks.remove(s.username, account);
      this.sendSystem(s, `unblocked ${parsed.data.name}`);
    } else if (this.blocks.add(s.username, account)) {
      this.sendSystem(s, `blocked ${parsed.data.name}`);
    } else {
      this.sendSystem(s, "cannot block");
    }
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
    this.enterWorld(s, first ? this.remember(s, first) : null);
  }

  /** Record `c` as the character of the session's token (see AuthSession.character). */
  private remember(s: ClientSession, c: CharacterRecord): { id: number; name: string; look: string } {
    const character = { id: c.id, name: c.name, look: c.look };
    const auth = this.authSessions.get(s.token);
    if (auth) auth.character = character;
    return character;
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
    this.friendPresence(s);
  }

  /** Full baseline snapshot, e.g. on join or re-attach. */
  private sendFreshSnapshot(s: ClientSession): void {
    // Names first: the snapshot shows every entity, so every character
    // entity is first-shown here (catalog §0x12).
    const names = this.namesFor(null);
    if (names) this.deliver(s, names, this.tick);
    const drops = this.dropsFor(null);
    if (drops) this.deliver(s, drops, this.tick);
    this.deliverSnapshot(
      s,
      encodeEnvelope(
        MessageType.Snapshot,
        encodeSnapshot(
          this.withHeights(collectFullState(this.world, this.tick)),
        ),
      ),
      this.tick,
    );
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
      result = this.items.unequip(holder, a.hand);
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
    T.px[eid] = this.spawnPoint.x + (i % 8) * 4 - 14;
    T.pz[eid] = this.spawnPoint.z + Math.floor(i / 8) * 4 - 14;
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
    if (characterId !== null) {
      addComponent(sim.ecs, C.CharacterRef, eid);
      C.CharacterRef.idHi[eid] = Math.floor(characterId / 4294967296);
      C.CharacterRef.idLo[eid] = characterId % 4294967296;
    }
    if (!sim.stats.empty) sim.stats.attach(eid);
    return sim.wireId(eid);
  }
}
