/**
 * Per-client session state — multiplayer from the start (decided 2026-09-27).
 *
 * DESIGN NOTE (slice 1.1 scaffolding — no gateway logic yet; slice 1.3 builds it):
 *
 * The gateway will own one ClientSession per connection. The simulation
 * itself never sees sessions: per EDA, the gateway is a thin event
 * translator — inbound `intent` messages become sim events consumed at tick
 * start, and the sim's state-change events are batched into per-tick deltas
 * the gateway fans out. No game logic in the gateway (skill operating rule 1).
 *
 * Broadcast model for Phase 1: every connected client receives the same
 * delta stream each tick (interest management is explicitly out of scope
 * until load demands it). Per-client state exists so reconnects, slow
 * consumers, and later interest filtering have somewhere to live.
 */

import type { WireSocket } from "./net/transport.js";

export interface ClientSession {
  /** Opaque connection handle, assigned by the gateway. */
  clientId: string;
  /**
   * Server-issued session token (auth slice): the client identity for
   * reconnects inside the grace period. Empty until hello is accepted.
   */
  token: string;
  /** Player entity owned by this client (wire id), once joined. */
  playerEntity: bigint | null;
  /**
   * Last tick whose delta this client has acked. Delivery is implicitly
   * acked by subsequent deltas; a client that falls behind gets a fresh
   * full snapshot instead of an unbounded catch-up queue.
   */
  lastAckedTick: bigint;
  /** Tick of the last full snapshot sent — the baseline deltas apply to. */
  lastSnapshotTick: bigint;
  /**
   * Outbound queue: one entry per tick's delta bytes, drained by the
   * socket writer. Bounded — overflow triggers a snapshot resync, never
   * unbounded memory growth.
   */
  sendQueue: Uint8Array[];
  /** Heartbeats missed in a row; the gateway drops the client after 3. */
  missedHeartbeats: number;
  /** When the last ping was sent (0 = none yet). A heartbeat counts as
   * missed only if nothing arrived from the client since then. */
  lastPingMs: number;
  connectedAtMs: number;
  /** Live socket; null while the session is parked in the disconnect grace period. */
  socket: WireSocket | null;
  /** True once hello is accepted and welcome sent. */
  welcomed: boolean;
  /**
   * True while a hello/register is being checked (argon2 is async). A
   * connection joins once: further hellos are refused while this is set
   * and after `welcomed`.
   */
  joining: boolean;
  /**
   * Highest client_tick applied — older intents are stale, dropped, and
   * counted (never applied out of order).
   */
  lastIntentTick: bigint;
  /** Stale or foreign intents dropped (diagnostic counter). */
  droppedIntents: number;
  /** Clock ms of the last inbound message (heartbeat liveness). */
  lastSeenMs: number;
  /**
   * Clock ms the socket closed; null while connected. The disconnect
   * grace period runs from here — the player entity survives until it
   * elapses so a quick reconnect re-attaches seamlessly.
   */
  disconnectedAtMs: number | null;
  /** Set when the send queue overflowed: the next outbound is a full snapshot. */
  needsResync: boolean;
  /** Remote IP of the connection (auth rate limiting). */
  remoteIp: string;
  /** The account, once authenticated ("" before). */
  username: string;
  /**
   * May send admin commands (protocol 0x10): named in GatewayOptions.admins
   * or every account on a dev server. Decided once at join, from the
   * authenticated username — never from anything the client claims later.
   */
  isAdmin: boolean;
  /**
   * Authenticated and choosing a character (the client asked to): not in
   * the world yet — no entity, no deltas — until enter_world.
   */
  choosingCharacter: boolean;
  /** The character this session plays, once in the world as one. */
  character: { id: number; name: string } | null;
  /**
   * Clock ms of the last chat line per channel (roadmap S1 rate limits).
   * Missing entries never sent on that channel.
   */
  lastChatMs: Partial<Record<"say" | "yell" | "emote", number>>;
}

/** Upper bound on queued per-tick deltas before a snapshot resync. */
export const MAX_QUEUED_DELTAS = 300; // 10 s at 30 Hz
