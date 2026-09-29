/**
 * Message catalog types (see docs/MESSAGE-CATALOG.md).
 *
 * Envelope for every message on the wire: `[u8 type][payload bytes]`.
 * Control plane = JSON (debuggable); data plane = FlatBuffers (hot path).
 * u64 ids travel as JSON strings — JS numbers can't hold 64 bits.
 */

import type { DayClock } from "./day-clock.js";
import type { WorldInfo } from "./world-info.js";

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
  /** S→C: the account's characters (catalog §0x0c), for a client that asked. */
  Account = 0x0c,
  /** C→S: create a character (catalog §0x0d); answered with a new account message. */
  CreateCharacter = 0x0d,
  /** C→S: enter the world as a character (catalog §0x0e); answered with welcome + snapshot. */
  EnterWorld = 0x0e,
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
  /**
   * The client chooses a character before entering the world: the server
   * answers with `account` (0x0c) instead of joining, and the client
   * sends `enter_world` (0x0e). Without it the server joins at once, as
   * the account's first character (or a default look).
   */
  characters?: boolean;
}

/** S→C, once per connection. Hands the client its identity + cadence. */
export interface WelcomeMessage {
  protocol: number;
  player_entity: string; // u64 wire id, as string
  server_tick: number;
  tick_hz: number; // 30 — the fixed sim rate (architecture brief §2)
  snapshot_every: number; // 300 — full-snapshot broadcast cadence, in ticks
  session_token: string; // opaque token: reconnect identity from here on
  /** A baked world's extent and coarse map (see world-info.ts); absent for legacy worlds. */
  world?: WorldInfo;
  /** The world's day clock (see day-clock.ts); absent: no day cycle. */
  day?: DayClock;
  /** The character this connection plays, when it entered as one. */
  character?: { id: number; name: string };
}

/** S→C on protocol/auth/server errors. */
export interface ErrorMessage {
  /**
   * 4001 bad protocol, 4002 auth failed, 4003 malformed, 4004 server
   * error, 4005 refused (a well-formed request the server declines, e.g.
   * a character name that is taken; the connection stays open).
   */
  code: 4001 | 4002 | 4003 | 4004 | 4005;
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
  /** As in hello: choose a character before entering the world. */
  characters?: boolean;
}

/**
 * A character's look on the wire (see @mmo-engine/art CharacterLook):
 * gender, a part name per slot, an sRGB hex colour per colour slot.
 * Receivers parse it with parseLook; the server validates it against the
 * part catalog.
 */
export interface WireLook {
  gender: string;
  parts: Record<string, string | null | undefined>;
  colours: Record<string, string | undefined>;
}

/** A character's name: 3–16 letters, apostrophes or hyphens, starting with a letter. */
export const CHARACTER_NAME_RE = /^[A-Za-z][A-Za-z'-]{2,15}$/;

/** One of an account's characters. */
export interface CharacterEntry {
  id: number;
  name: string;
  look: WireLook;
}

/**
 * S→C (catalog §0x0c): the account's characters, after a hello or
 * register that asked for them, and again after each create.
 */
export interface AccountMessage {
  session_token: string;
  characters: CharacterEntry[];
  /** How many characters an account may have. */
  max_characters: number;
  /** The character just created, when this answers a create. */
  created?: number;
}

/**
 * C→S (catalog §0x0d): create a character. A new character wears the
 * starter armour; only its appearance is chosen. Name: 3–16 letters,
 * apostrophes or hyphens, starting with a letter; unique on the server
 * (case-insensitive). Refusals are 4005, and the connection stays open.
 */
export interface CreateCharacterMessage {
  name: string;
  look: WireLook;
}

/** C→S (catalog §0x0e): enter the world as one of the account's characters. */
export interface EnterWorldMessage {
  character: number;
}

/** Increment when the catalog gains a message or changes a shape. */
export const PROTOCOL_VERSION = 6; // v6 (2026-09-28): combat — the Action
// component on the wire and the Attack/Block/Dodge intent buttons.
// v5: characters — 0x0c account, 0x0d create_character, 0x0e enter_world,
// hello/register `characters`, error 4005, the Appearance component.

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
