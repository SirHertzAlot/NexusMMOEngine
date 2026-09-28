/**
 * Message catalog types (see docs/MESSAGE-CATALOG.md).
 *
 * Envelope for every message on the wire: `[u8 type][payload bytes]`.
 * Control plane = JSON (debuggable); data plane = FlatBuffers (hot path).
 * u64 ids travel as JSON strings — JS numbers can't hold 64 bits.
 */

/** Message type byte. Values are the catalog contract — never renumber. */
export enum MessageType {
  Hello = 0x01,
  Welcome = 0x02,
  Snapshot = 0x03,
  Delta = 0x04,
  Intent = 0x05,
  Ping = 0x06,
  Pong = 0x07,
  Error = 0x08,
  Bye = 0x09,
  /** Editor-only read-only debug queries (catalog §0x0a). */
  Debug = 0x0a,
  /** In-client account creation (catalog §0x0b). Creates the user, then
   * joins exactly like a credentials hello (welcome + snapshot). */
  Register = 0x0b,
}

/**
 * C→S, once per connection. Two variants (docs/MESSAGE-CATALOG.md):
 * - credentials: { username, password } — first contact / login
 * - token:       { token }              — reconnect with a session token
 * Carrying both (or neither) is malformed. Server-side Zod schemas
 * (@mmo-engine/engine-core auth) enforce the shapes.
 */
export interface HelloMessage {
  protocol: number; // must be PROTOCOL_VERSION
  client: string;
  want_snapshot: boolean;
  username?: string; // credentials variant
  password?: string; // credentials variant
  token?: string; // session-token variant (64 hex chars)
}

/** S→C, once per connection. Hands the client its identity + cadence. */
export interface WelcomeMessage {
  protocol: number;
  player_entity: string; // u64 wire id, as string
  server_tick: number;
  tick_hz: number; // 30 — the fixed sim rate (architecture brief §2)
  snapshot_every: number; // 300 — full-snapshot broadcast cadence, in ticks
  session_token: string; // opaque token: reconnect identity from here on
}

/** S→C on protocol/auth/server errors. */
export interface ErrorMessage {
  code: 4001 | 4002 | 4003 | 4004;
  message: string;
}

/**
 * C→S, once per connection (catalog §0x0b). Creates an account, then the
 * server joins it exactly like a credentials hello: welcome + snapshot.
 * The envelope type is the discriminator (no `kind` field, like hello).
 * Server-side the Zod RegisterSchema (@mmo-engine/engine-core auth)
 * enforces the shape; the password is argon2-hashed before it touches
 * the credential store. Registration can be disabled server-side
 * (MMO_ALLOW_REGISTER=0 → 4002 "registration disabled").
 */
export interface RegisterMessage {
  protocol: number; // must be PROTOCOL_VERSION
  client: string;
  username: string;
  password: string;
}

/** Increment when the catalog gains a message or changes a shape. */
export const PROTOCOL_VERSION = 4; // v4 (2026-09-27): 0x0b register —
// in-client account creation (username + password), then a normal join.

/**
 * Editor-only read-only debug query (0x0a, C→S, JSON).
 * Never touches simulation state; the gateway answers from a live read.
 * - `{kind:"debug", query:"waypoints", entity:"<u64>"}` — active path
 *   waypoints for one entity (from the server WaypointStore).
 * - `{kind:"debug", query:"tiles"}` — loaded navmesh tile bounds
 *   `[{x0,z0,x1,z1}]` in world units.
 */
export type DebugQuery =
  | { kind: "debug"; query: "waypoints"; entity: string }
  | { kind: "debug"; query: "tiles" };

/** S→C answer to a DebugQuery (0x0a, JSON). */
export type DebugResponse =
  | {
      kind: "debug";
      query: "waypoints";
      entity: string;
      status: "active" | "idle" | "failed" | "unknown";
      waypoints: Array<[number, number, number]>;
    }
  | { kind: "debug"; query: "tiles"; tiles: Array<[number, number, number, number]> };
