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

import { addComponent, defineQuery } from "bitecs";
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
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
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
import { IntentSystem, IntegrateSystem, type SimSystem } from "../systems.js";
import { CombatSystem } from "../combat.js";
import { StatsSystem } from "../stats/stats-system.js";
import { SimWorld } from "../world.js";
import { decodeIntentMessage, sanitizeIntent } from "./intent.js";
import { parseLook, type ModularCatalog } from "@mmo-engine/art/character";
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
/** Admin command log keeps the last N entries (roadmap A1). */
const ADMIN_LOG_SIZE = 200;

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
      | "characterCatalog"
      | "maxCharacters"
      | "sessionTtlMs"
      | "authRateLimit"
      | "debugSource"
      | "chunkSource"
      | "groundHeightAt"
      | "spawnPoint"
      | "worldInfo"
      | "dayClock"
      | "playerAbilities"
      | "http"
      | "transport"
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
  private readonly spawnPoint: { x: number; z: number };
  private readonly worldInfo: WorldInfo | null;
  private readonly dayClock: DayClock | null;
  private readonly playerAbilities: number;
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
    this.systems = opts.systems ?? [new StatsSystem(), new IntentSystem(), new CombatSystem(TICK_HZ), new IntegrateSystem()];
    this.clock = opts.clock ?? Date.now;
    this.credentialStore = opts.credentialStore ?? new CsvCredentialStore();
    this.characterStore = opts.characterStore ?? new MemoryCharacterStore();
    this.characterCatalog = opts.characterCatalog ?? null;
    this.maxCharacters = opts.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.debugSource = opts.debugSource ?? null;
    this.chunkSource = opts.chunkSource ?? null;
    this.groundHeightAt = opts.groundHeightAt ?? null;
    this.spawnPoint = opts.spawnPoint ?? { x: 0, z: 0 };
    this.worldInfo = opts.worldInfo ?? null;
    this.dayClock = opts.dayClock ?? null;
    this.playerAbilities = opts.playerAbilities ?? Ability.Swim;
    this.admins = new Set(this.opts.admins);
    this.devServer = this.opts.devServer;
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

  /** Bind the port (WebSocket + HTTP). Does NOT start the tick driver. */
  async listen(): Promise<number> {
    if (this.transport) throw new Error("gateway: already listening");
    const transport = createTransport(this.transportKind);
    this.transport = transport;
    return transport.listen(this.opts.port, {
      connection: (socket) => this.onConnection(socket),
      http: this.httpHandler,
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
    this.tick = tick;
    const sim = this.world;
    sim.beginTick(tick); // drain intent events into PlayerIntent components
    const dt = STEP_MS / 1000;
    for (const s of this.systems) s.step(sim, dt);
    sim.emitTick(tick);

    const deltaBytes = encodeDelta(
      this.withHeights(collectDeltaState(sim, tick, tick - 1, this.tracker)),
    );
    this.tracker.commit(sim);
    sim.endTick();

    this.broadcast(tick, deltaBytes);
    this.sweepGracePeriods();
    this.maybeHeartbeat();
  }

  /** Fan one tick's state out to every connected session (broadcast). */
  private broadcast(tick: number, deltaBytes: Uint8Array): void {
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
      if (isSnapshotTick || s.needsResync) {
        this.deliverSnapshot(s, snapshotFor(), tick);
      } else {
        this.deliver(s, deltaEnv, tick);
      }
      this.sendStats(s, tick);
    }
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
      lastSeenMs: now,
      disconnectedAtMs: null,
      needsResync: false,
      remoteIp: socket.remoteIp,
      username: "",
      choosingCharacter: false,
      character: null,
      isAdmin: false,
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
        message: "commands: help, whoami, inspect, set",
      };
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
    s.playerEntity = this.spawnPlayerEntity(character?.look ?? DEFAULT_LOOK_JSON);
    s.welcomed = true;
    s.lastSeenMs = this.clock();
    this.tokenToClient.set(s.token, s.clientId);
    this.sendWelcome(s);
    this.sendFreshSnapshot(s);
    this.sendStats(s, this.tick, true);
  }

  /**
   * A character is in the world once: another session playing it (live
   * or in its grace period) is ended and its avatar removed.
   */
  private evictCharacter(id: number, except: ClientSession): void {
    for (const other of [...this.sessions.values()]) {
      if (other === except || other.character?.id !== id) continue;
      if (other.playerEntity !== null) this.world.despawn(parseWireEntityId(other.playerEntity).slot);
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

  private onIntent(s: ClientSession, payload: Uint8Array): void {
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
  }

  /** Full baseline snapshot, e.g. on join or re-attach. */
  private sendFreshSnapshot(s: ClientSession): void {
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
   * Spawn a player entity: Transform + Velocity + PlayerIntent + Health +
   * Stamina (full; StatsSystem sets the maxima from the rules next tick) +
   * Locomotion (on foot, with the gateway's player abilities, full breath)
   * + Appearance (the character's look, canonical JSON) + Action (no move),
   * and stats at the rules' bases when the game has any (StatsSystem then
   * sets Health.max from them on the next tick).
   * Spawn points spread on a grid so N players don't stack. Player
   * entities are ordinary entities — the sim treats N of them identically
   * (multiplayer by construction, no singleton).
   */
  private spawnPlayerEntity(look: string): bigint {
    const sim = this.world;
    const eid = sim.spawn();
    addComponent(sim.ecs, C.Transform, eid);
    addComponent(sim.ecs, C.Velocity, eid);
    addComponent(sim.ecs, C.PlayerIntent, eid);
    addComponent(sim.ecs, C.Health, eid);
    addComponent(sim.ecs, C.Stamina, eid);
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
    sim.setLook(eid, look);
    addComponent(sim.ecs, C.Action, eid);
    C.Action.move[eid] = 0;
    if (!sim.stats.empty) sim.stats.attach(eid);
    return sim.wireId(eid);
  }
}
