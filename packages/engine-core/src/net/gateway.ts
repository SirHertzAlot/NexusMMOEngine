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
 * Tick driving: production calls startTicking() (wall-clock interval);
 * tests drive frame(nowMs) manually with a synthetic clock — pass
 * `clock` in options for deterministic heartbeat/grace math.
 */

import { addComponent, defineQuery } from "bitecs";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import {
  decodeControl,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
  type WelcomeMessage,
} from "@mmo-engine/protocol";
import * as C from "../components.js";
import { parseWireEntityId } from "../entity-id.js";
import type { DebugSource } from "./debug-source.js";
import {
  MAX_QUEUED_DELTAS,
  type ClientSession,
} from "../session.js";
import {
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
import { SimWorld } from "../world.js";
import { decodeIntentMessage } from "./intent.js";

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
  /** Sim systems; default [IntentSystem, IntegrateSystem]. */
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

const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;
const DISCONNECT_GRACE_MS = 30000;
const SNAPSHOT_EVERY_TICKS = 300;
const TICK_HZ = 30;

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Uint8Array) return data; // Buffer extends Uint8Array
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("gateway: unsupported ws frame type");
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
      | "sessionTtlMs"
      | "authRateLimit"
      | "debugSource"
      | "chunkSource"
      | "groundHeightAt"
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
  /** Identity map, now keyed by session token: token -> clientId. */
  private readonly tokenToClient = new Map<string, string>();

  private wss: WebSocketServer | null = null;
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
    };
    if (!Number.isInteger(this.opts.startTick) || this.opts.startTick < 1) {
      throw new RangeError(
        `gateway: startTick must be an integer >= 1 (got ${opts.startTick})`,
      );
    }
    this.world = opts.world ?? new SimWorld();
    this.systems = opts.systems ?? [new IntentSystem(), new IntegrateSystem()];
    this.clock = opts.clock ?? Date.now;
    this.credentialStore = opts.credentialStore ?? new CsvCredentialStore();
    this.debugSource = opts.debugSource ?? null;
    this.chunkSource = opts.chunkSource ?? null;
    this.groundHeightAt = opts.groundHeightAt ?? null;
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

  /** Bind the WebSocket server. Does NOT start the tick driver. */
  async listen(): Promise<number> {
    if (this.wss) throw new Error("gateway: already listening");
    this.wss = new WebSocketServer({ port: this.opts.port });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) =>
      this.onConnection(socket, req),
    );
    await new Promise<void>((resolve) => this.wss!.once("listening", resolve));
    const addr = this.wss.address() as AddressInfo | null;
    return addr ? addr.port : 0;
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
        s.socket?.removeAllListeners();
        s.socket?.close(1000, "server shutdown");
      } catch {
        /* ignore teardown errors */
      }
      s.socket = null;
    }
    this.sessions.clear();
    this.tokenToClient.clear();
    this.authSessions.clear();
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  // ------------------------------------------------------------ tick

  private onTick(tick: number): void {
    this.tick = tick;
    const sim = this.world;
    sim.beginTick(); // drain intent events into PlayerIntent components
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
    }
  }

  /** Queue-or-send one enveloped message, preserving order, bounded. */
  private deliver(s: ClientSession, env: Uint8Array, tick: number): void {
    if (s.socket && s.socket.readyState === WebSocket.OPEN) {
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

  private onConnection(socket: WebSocket, req?: IncomingMessage): void {
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
      lastIntentTick: 0n,
      droppedIntents: 0,
      lastSeenMs: now,
      disconnectedAtMs: null,
      needsResync: false,
      remoteIp: req?.socket?.remoteAddress ?? "unknown",
    };
    this.sessions.set(s.clientId, s);
    socket.on("message", (data: WebSocket.RawData) => this.onMessage(s, data));
    socket.on("close", () => {
      // Ignore closes from a superseded socket after takeover.
      if (s.socket === socket) this.onClose(s);
    });
    socket.on("error", () => {
      /* close handler does the cleanup */
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

  private onMessage(s: ClientSession, data: WebSocket.RawData): void {
    s.lastSeenMs = this.clock();
    let buf: Uint8Array;
    try {
      buf = toBytes(data);
    } catch {
      this.sendError(s, 4003, "unreadable frame");
      return;
    }
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
   * Authenticate a hello (auth slice). Async because password verification
   * is async; failures are contained — auth never throws out of the
   * message pump.
   */
  private onHello(s: ClientSession, payload: Uint8Array): void {
    void this.authenticate(s, payload).catch((err: unknown) => {
      // Defense in depth: a store/argon2 failure must not kill the pump.
      // eslint-disable-next-line no-console
      console.error(
        `[gateway] auth error: ${err instanceof Error ? err.message : err}`,
      );
      this.sendErrorAndClose(s, 4004, "internal auth error");
    });
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

    this.joinWithSession(s, sessionToken);
  }

  /**
   * Shared join tail for hello and register: with a valid session token
   * in hand, re-attach/take over the existing session for that token, or
   * spawn a fresh player entity — then welcome + snapshot. Split out of
   * authenticate() so register() reuses the exact same join semantics.
   */
  private joinWithSession(s: ClientSession, sessionToken: string): void {
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
      return;
    }

    // Fresh join: either a brand-new login, or a token whose session
    // outlived its grace-period binding (entity was despawned; spawn new).
    s.token = sessionToken;
    this.authSessions.rebind(sessionToken, s.clientId);
    s.playerEntity = this.spawnPlayerEntity();
    s.welcomed = true;
    s.lastSeenMs = this.clock();
    this.tokenToClient.set(s.token, s.clientId);
    this.sendWelcome(s);
    this.sendFreshSnapshot(s);
  }

  /**
   * In-client account creation (protocol 0x0b, `register`). Creates the
   * user, mints a session, and joins exactly like a credentials hello.
   * Async and contained like authenticate(): a store/argon2 failure must
   * not kill the message pump.
   */
  private onRegister(s: ClientSession, payload: Uint8Array): void {
    void this.registerAccount(s, payload).catch((err: unknown) => {
      // Defense in depth: a store/argon2 failure must not kill the pump.
      // eslint-disable-next-line no-console
      console.error(
        `[gateway] register error: ${err instanceof Error ? err.message : err}`,
      );
      this.sendErrorAndClose(s, 4004, "internal auth error");
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
    const { protocol, client, username, password } = parsed.data;
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
    this.joinWithSession(s, sessionToken);
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
  private attachSocket(s: ClientSession, socket: WebSocket): void {
    const old = s.socket;
    s.socket = socket;
    s.disconnectedAtMs = null;
    s.missedHeartbeats = 0;
    s.lastPingMs = 0; // pings sent to the old socket don't count against this one
    s.lastSeenMs = this.clock();
    s.sendQueue.length = 0;
    s.needsResync = false;
    // The socket arrived with listeners bound to a discarded pending
    // session — rewire them to the re-attached session.
    socket.removeAllListeners();
    socket.on("message", (data: WebSocket.RawData) => this.onMessage(s, data));
    socket.on("close", () => {
      if (s.socket === socket) this.onClose(s);
    });
    socket.on("error", () => {
      /* close handler does the cleanup */
    });
    if (old && old.readyState === WebSocket.OPEN) {
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
      intent = msg.intent;
    } catch {
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
    if (s.socket && s.socket.readyState === WebSocket.OPEN) {
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
   * Spawn a player entity: Transform + Velocity + PlayerIntent + Health.
   * Spawn points spread on a grid so N players don't stack. Player
   * entities are ordinary entities — the sim treats N of them identically
   * (multiplayer by construction, no singleton).
   */
  private spawnPlayerEntity(): bigint {
    const sim = this.world;
    const eid = sim.spawn();
    addComponent(sim.ecs, C.Transform, eid);
    addComponent(sim.ecs, C.Velocity, eid);
    addComponent(sim.ecs, C.PlayerIntent, eid);
    addComponent(sim.ecs, C.Health, eid);
    const T = C.Transform;
    const i = this.playerSeq++;
    T.px[eid] = (i % 8) * 4 - 14;
    T.pz[eid] = Math.floor(i / 8) * 4 - 14;
    T.py[eid] = this.groundHeightAt?.(T.px[eid], T.pz[eid]) ?? 0;
    T.qx[eid] = 0; T.qy[eid] = 0; T.qz[eid] = 0; T.qw[eid] = 1;
    T.sx[eid] = 1; T.sy[eid] = 1; T.sz[eid] = 1;
    C.Health.current[eid] = 100;
    C.Health.max[eid] = 100;
    return sim.wireId(eid);
  }
}
