/**
 * Message catalog types (see docs/MESSAGE-CATALOG.md).
 *
 * Envelope for every message on the wire: `[u8 type][payload bytes]`.
 * Control plane = JSON (debuggable); data plane = FlatBuffers (hot path).
 * u64 ids travel as JSON strings — JS numbers can't hold 64 bits.
 */

import type { DayClock } from "./day-clock.js";
import type { WeatherOverride } from "./sky.js";
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
  /** S→C: the player's own stats (catalog §0x0f), after joining and whenever they change. */
  Stats = 0x0f,
  /**
   * Admin console (catalog §0x10, roadmap A1): authenticated admin
   * commands C→S and their results S→C, JSON like the debug channel.
   * The server answers 4003 to senders that are not admins.
   */
  Admin = 0x10,
  /**
   * Region chat (catalog §0x11, roadmap S1): say/yell/emote C→S, fanned
   * out S→C to sessions in range. JSON; the server answers 4003 to
   * malformed, too-frequent, or out-of-world senders.
   */
  Chat = 0x11,
  /**
   * S→C character names (C3, CHARACTERS-AND-SOCIAL.md §4.4): [[entity,
   * name, guildTag]] for the character entities a snapshot or delta
   * first shows, sent before it (and again when a guild tag changes —
   * tags land with guilds, S4; until then the column is "").
   */
  Names = 0x12,
  /** C→S item actions (catalog §0x13, roadmap M3a): pick up, drop. JSON. */
  Item = 0x13,
  /** S→C the player's bag (catalog §0x14), after joining and every change. JSON. */
  Inventory = 0x14,
  /** S→C what ground items are (catalog §0x15), before the state that first shows them. JSON. */
  Drops = 0x15,
  /** S->C a blow's outcome (catalog 0x16, roadmap M2a). JSON. */
  Hit = 0x16,
  Life = 0x17,
  /** S->C the player's own body parts, injuries and blood (catalog 0x18, roadmap M2). JSON. */
  Body = 0x18,
  /** C->S how the player swings: technique and aim (catalog 0x19, roadmap M3). JSON. */
  Stance = 0x19,
  /** C->S treat a body part (Medicine); S->C how a treatment goes, to healer and patient (catalog 0x1a, roadmap M4). JSON. */
  Treat = 0x1a,
  /** S->C the player's skills, item familiarity and disciplines (catalog 0x1b, roadmap M4). JSON. */
  Skills = 0x1b,
  /** C->S cast a spell; S->C the player's mana and how casts go (catalog 0x1c, roadmap: mana). JSON. */
  Magic = 0x1c,
  /**
   * C->S trigger an ability; S->C how abilities go (catalog 0x1d, roadmap
   * M5). JSON. C->S `{kind:"trigger", id}`; S->C `{kind:"ability", tick,
   * entity, id, state: "casting" | "queued" | "fired" | "interrupted" |
   * "rejected", reason?}`.
   */
  Ability = 0x1d,
  /**
   * S->C telegraphs: warned, resolved, cancelled (catalog 0x1e, roadmap
   * M5). JSON. `{kind:"telegraph", tick, id, source, shape, state,
   * ticksUntilHit?, hits?}` — the client draws the warning; the server
   * decides who is hit.
   */
  Telegraph = 0x1e,
  /**
   * S->C buff/debuff changes (catalog 0x1f, roadmap M5). JSON.
   * `{kind:"status", tick, entity, id, state: "applied" | "removed",
   * stacks?}`.
   */
  Status = 0x1f,
  /**
   * C->S duel challenge/accept/decline/yield; S->C duel events (catalog
   * 0x20, roadmap M5). JSON. C->S `{kind:"duel", action: "challenge" |
   * "accept" | "decline" | "yield", target?}`; S->C `{kind:"duel", tick,
   * state, a, b, reason?, winner?}`.
   */
  Duel = 0x20,
  /**
   * C->S trade actions; S->C trade state and wallet balances (catalog
   * 0x21, roadmap EC1). JSON. C->S `{kind:"trade", action: "open" |
   * "offer" | "accept" | "cancel", target?, id?, gold?, addItem?,
   * removeItem?}`; S->C `{kind:"trade", tick, id, state, a, b, aGold,
   * bGold, aItems, bItems, aAccepted, bAccepted}` and `{kind:"wallet",
   * tick, balance}` (to the owner only).
   */
  Trade = 0x21,
  /**
   * C→S on-demand chunk tile fetch (roadmap: chunk streaming). JSON
   * `{ keys: ["cx,cz", ...] }`, at most 64 keys per request. The server
   * answers 0x23. Rate-limited per session; tiles outside the region's
   * range are omitted from the response.
   */
  TileRequest = 0x22,
  /**
   * S→C answer to 0x22. JSON `{ tiles: [{ cx, cz, heights }] }` where
   * heights is base64 little-endian float32, 256 samples, row-major X
   * inner (the TerrainTile wire form).
   */
  TileResponse = 0x23,
  /**
   * C→S gather from a resource node; S→C the resource nodes and the
   * player's materials pouch (catalog 0x24, gathering). JSON. C→S
   * `{kind:"gather", entity}`; S→C `{kind:"resources", nodes}` (all on
   * joining, then the ones that changed) and `{kind:"pouch", materials,
   * gathered?}` (to the owner only).
   */
  Gather = 0x24,
  /**
   * S->C one tick's world state for this client (catalog 0x25, interest
   * management): length-prefixed entries, each a sector's Delta, full
   * state or leave, applied atomically (deltaset.ts).
   */
  DeltaSet = 0x25,
  /**
   * Cross-region view at borders (catalog 0x26, IM8). JSON. S->C from the
   * home region: `{kind:"border", region, endpoint, ticket, exp}` (open an
   * observer socket to the neighbour; renewed before exp) or
   * `{kind:"border", region, endpoint, leave:true}`. C->S on the observer
   * socket: `{kind:"observe", x, z}`, where the player stands.
   */
  Border = 0x26,
  /**
   * Interactions (catalog 0x27, IX1). JSON. C->S `{kind:"interact", entity}`;
   * S->C `{kind:"chests", chests}` (all on joining, then the ones that changed).
   * See interact.ts.
   */
  Interact = 0x27,
}

/**
 * C→S, once per connection. Three variants (docs/MESSAGE-CATALOG.md):
 * - credentials: { username, password } — first contact / login
 * - token:       { token }              — reconnect with a session token
 * - migration:   { migration, ticket }  — arrive from another region after
 *   a `bye` redirect (WORLD-SERVER-SPEC §6)
 * Carrying more than one (or none) is malformed. Server-side Zod schemas
 * (@mmo-engine/engine-core auth) enforce the shapes.
 */
export interface HelloMessage {
  protocol: number; // must be PROTOCOL_VERSION
  client: string;
  want_snapshot: boolean;
  username?: string; // credentials variant
  password?: string; // credentials variant
  token?: string; // session-token variant (64 hex chars)
  migration?: string; // migration variant: the redirect's migration id
  ticket?: string; // migration variant: the redirect's one-time ticket (64 hex chars)
  /**
   * The client chooses a character before entering the world: the server
   * answers with `account` (0x0c) instead of joining, and the client
   * sends `enter_world` (0x0e). Without it the server joins at once, as
   * the account's first character (or a default look).
   */
  characters?: boolean;
  /** Observer variant (IM8): read-only view of this region from a neighbour's border, with the home region's ticket. */
  observe?: BorderTicket;
}

/** A home region's permission to observe a neighbour (IM8): HMAC of `border|region|from|account|exp`. */
export interface BorderTicket {
  /** The neighbour to observe. */
  region: string;
  /** The home region issuing it (where the player stands). */
  from: string;
  account: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  ticket: string;
}

/** 0x26 (IM8): see MessageType.Border. */
export type BorderMessage =
  | ({ kind: "border"; endpoint: string; leave?: false } & BorderTicket)
  | { kind: "border"; region: string; endpoint: string; leave: true }
  | { kind: "observe"; x: number; z: number };

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
  /** The weather override (see sky.ts); absent: auto. */
  weather?: WeatherOverride;
  /** The character this connection plays, when it entered as one. */
  character?: { id: number; name: string };
}

/**
 * Either direction (catalog §0x09): a graceful disconnect notice. From the
 * server it can carry `redirect`: the player crossed into another region
 * (WORLD-SERVER-SPEC §6). The client closes this socket and sends that
 * region a migration hello; if it can't get in, it reconnects here with
 * its session token, and this region still has the player.
 */
export interface ByeMessage {
  reason: string;
  redirect?: {
    endpoint: string; // the target region's gateway URL
    migration: string; // the world's migration id
    ticket: string; // one-time, 64 hex chars; the target checks its hash
  };
}

/** C→S on-demand tile fetch (0x22). */
export interface TileRequestMessage {
  /** Client-chosen correlation id, echoed in the 0x23 response. */
  reqId: number;
  /** "cx,cz" keys, at most 64 per request. */
  keys: string[];
}

/** One tile in a 0x23 response. */
export interface TileWire {
  cx: number;
  cz: number;
  /** Base64 little-endian float32, 256 samples, row-major X inner. */
  heights: string;
}

/** S→C answer to 0x22. Tiles outside the region's range are omitted. */
export interface TileResponseMessage {
  /** Echo of the request's reqId. */
  reqId: number;
  tiles: TileWire[];
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

/** One line of a character sheet (catalog §0x0f). */
export interface StatLineMessage {
  id: string;
  name: string;
  /** With every modifier (buffs, debuffs, items, injuries). */
  value: number;
  /** Without any: the difference is what modifiers add or take away. */
  base: number;
}

/**
 * S→C (catalog §0x0f): the player's own stats, owner only. Sent after the
 * welcome and snapshot, then at most once per tick while they change.
 * Attributes are the broad umbrellas (strength, agility, …); stats are
 * derived from them. The lists are whatever the game's stats.json defines.
 */
export interface StatsMessage {
  entity: string;
  attributes: StatLineMessage[];
  stats: StatLineMessage[];
  /** Hunger and thirst meters (U3), when the player has them. Whole numbers. */
  needs?: NeedsLine;
  /** Every skill in rules order with its value and peak, 0..`skillMax`, to 0.1 (U9). */
  skills?: SkillLineMessage[];
  skillMax?: number;
}

export interface NeedsLine {
  hunger: number;
  hungerMax: number;
  thirst: number;
  thirstMax: number;
}

export interface SkillLineMessage {
  id: string;
  name: string;
  /** The rules' family (weapon, defence, body, survival, work), for grouping. */
  family: string;
  value: number;
  /** The highest the skill has been; above `value` it relearns faster. */
  peak: number;
}

/**
 * C→S (catalog §0x10): one admin-console command. The server answers on
 * the same envelope with an AdminResult. A1 commands: `help` (list what
 * this server offers) and `whoami` (the caller's admin identity).
 * A2+ adds the world-editing commands behind this same channel.
 */
export interface AdminCommand {
  kind: "admin";
  command: string;
  /** Command arguments (per-command shape; absent for help/whoami). */
  args?: unknown;
}

/** S→C (catalog §0x10): the result of one AdminCommand. */
export interface AdminResult {
  kind: "admin";
  command: string;
  /** The command ran. */
  ok: boolean;
  /** Human-readable outcome (help text, identity, or an error). */
  message: string;
}

/**
 * C→S (catalog §0x11): one chat line. The server trims it, checks it,
 * rate-limits it, and fans it out; see S1 in docs/ROADMAP.md.
 */
export interface ChatMessage {
  kind: "chat";
  channel: ChatChannel;
  text: string;
  /** Whisper target: a character name (S2). */
  to?: string;
}

/**
 * C→S (0x11, S2): block or unblock a character by name. Blocks are per
 * account: the blocked account is silenced for all the blocker's characters.
 */
export interface BlockMessage {
  kind: "block";
  name: string;
  on: boolean;
}

/** C→S (0x11, S2b): add or remove a character (by name) on your friends list. */
export interface FriendMessage {
  kind: "friend";
  name: string;
  on: boolean;
}

/**
 * S→C (0x11, S2b): the receiver's friends list with presence, sent on
 * login and whenever the list or a friend's presence changes. A friend who
 * blocks you always shows offline.
 */
export interface FriendsState {
  kind: "friends";
  friends: Array<{ name: string; online: boolean }>;
}

/**
 * S→C (0x11, U8): the receiver's block list, by the character names the
 * blocks were made under, in block order. Sent on login and after every
 * block or unblock.
 */
export interface BlocksState {
  kind: "blocks";
  blocked: string[];
}

/**
 * Chat channels: say and emote reach nearby players, yell reaches all,
 * whisper reaches one named character (S2), party reaches your party (S3).
 */
export type ChatChannel = "say" | "yell" | "emote" | "whisper" | "party" | "guild";

/**
 * S→C (catalog §0x11): a fanned-out chat line. `from` is the speaker's
 * character name (or account name outside a character); `entity` is
 * their avatar's wire id, for future nameplates and click-to-reply.
 */
export interface ChatBroadcast {
  kind: "chat";
  /** `system` is server-only: notices such as "not online". */
  channel: ChatChannel | "system";
  text: string;
  from: string;
  entity: string;
  /** Whispers: the target's character name, so a sender's echo shows who it went to. */
  to?: string;
}

/**
 * C→S (0x11, S3): a party op. `invite`, `kick` and `promote` name a character;
 * `accept` takes the pending invite; `leave` leaves. Only the leader invites,
 * kicks and promotes.
 */
export interface PartyMessage {
  kind: "party";
  op: "invite" | "accept" | "leave" | "kick" | "promote";
  name?: string;
}

/** One party member as the party list shows them. */
export interface PartyMemberInfo {
  name: string;
  leader: boolean;
  online: boolean;
}

/**
 * S→C (0x11, S3): the receiver's party, sent whenever it changes. `members`
 * is empty when in no party; `invite` is a pending invite (60 s) from `from`.
 */
export interface PartyState {
  kind: "party";
  members: PartyMemberInfo[];
  invite?: { from: string };
}

export type GuildRank = "leader" | "officer" | "member" | "recruit";

/**
 * C→S (0x11, S4): a guild op. `create` takes `name` (3-24) and `tag` (2-5
 * letters); `invite`, `kick` and `setRank` name a character (`setRank` also
 * `rank`); `motd` takes `text`; `accept` takes the pending invite; `leave`
 * leaves. Officers and the leader invite, kick lower ranks and edit the MOTD.
 */
export interface GuildMessage {
  kind: "guild";
  op: "create" | "invite" | "accept" | "leave" | "kick" | "setRank" | "motd";
  name?: string;
  tag?: string;
  rank?: GuildRank;
  text?: string;
}

export interface GuildMemberInfo {
  name: string;
  rank: GuildRank;
  online: boolean;
}

/**
 * S→C (0x11, S4): the receiver's guild, sent whenever it changes. `name` is
 * "" (and `members` empty) when in none; `log` is the change log, for
 * officers and the leader only; `invite` is a pending invite (60 s).
 */
export interface GuildState {
  kind: "guild";
  name: string;
  tag: string;
  motd: string;
  rank: GuildRank | null;
  members: GuildMemberInfo[];
  log: Array<{ at: number; text: string }>;
  invite?: { from: string; guild: string };
}

/**
 * S→C character names (C3, CHARACTERS-AND-SOCIAL.md §4.4): one row per
 * character entity the accompanying snapshot or delta first shows.
 * Tuples, spec-literal: [entity wire id, character name, guild tag].
 * The tag column is "" for a character in no guild; a later row for the
 * same entity updates it when they join or leave one (S4).
 */
export interface NamesMessage {
  kind: "names";
  names: Array<[string, string, string]>;
}

/** Increment when the catalog gains a message or changes a shape. */
export const PROTOCOL_VERSION = 28; // v28 (2026-10-24): 0x27 interact, world chests. v27 (2026-10-23): 0x26 border, cross-region view (observer hello). v26 v26 (2026-10-23): 0x25 DeltaSet, interest management (per-tick deltas arrive as sector entries). v25 (2026-10-17): 0x24 gather, resource nodes and the materials pouch. v24 (2026-10-14): chunk-streaming tile request/response on 0x22/0x23 (0x21 was already EC1 trade). v23 (2026-10-08): EC1 economy — 0x21 trade and wallet. v22 (2026-10-08): M5 combat abilities — 0x1d ability, 0x1e telegraph, 0x1f status, 0x20 duel. v21 (2026-10-03): 0x1c magic, mana and spells. v20 (2026-10-03): 0x1b skills, disarmed on 0x16 hit (M4). v19 (2026-10-03): 0x1a treat, Medicine (M4). v18 (2026-10-03): 0x19 stance, the player's technique and aim (M3). v17: 0x18 body, body parts on 0x16 hit and causes on 0x17 life (M2).
// v15 (2026-10-03): guild chat channel, guild ops and state on 0x11, names tag column filled (S4).
// v14 (2026-10-03): party chat channel, party ops and state on 0x11 (S3).
// v13 (2026-10-02): 0x17 life (death/respawn, M2b).
// v12: 0x16 hit (M2a).
// v11 (2026-10-01): items — 0x13 item
// actions, 0x14 inventory, 0x15 drops (roadmap M3a).
// v10 (2026-10-01): C3 identity —
// CharacterRef wire block + 0x12 names (roadmap C3).
// v9 (2026-10-01): region chat — 0x11, say/yell/emote (roadmap S1).
// v8 (2026-09-30): admin console — 0x10 (roadmap A1).
// v7 (2026-09-29): stats — 0x0f, the
// player's own attributes and derived stats.
// v6: combat — the Action component on the wire and the
// Attack/Block/Dodge intent buttons.
// v5: characters — 0x0c account, 0x0d create_character, 0x0e enter_world,
// hello/register `characters`, error 4005, the Appearance component.

/**
 * Editor-only read-only debug query (0x0a, C→S, JSON).
 * Never touches simulation state; the gateway answers from a live read.
 * - `{kind:"debug", query:"waypoints", entity:"<u64>"}` — active path
 *   waypoints for one entity (from the server WaypointStore).
 * - `{kind:"debug", query:"tiles"}` — loaded navmesh tile bounds
 *   `[{x0,z0,x1,z1}]` in world units.
 * - `{kind:"debug", query:"colliders", x, z, radius}` — static boxes and
 *   spheres plus kinematic capsules near (x, z) (editor Colliders overlay).
 */
export type DebugQuery =
  | { kind: "debug"; query: "waypoints"; entity: string }
  | { kind: "debug"; query: "tiles" }
  | { kind: "debug"; query: "timings" }
  /** Collision bodies whose centre lies within `radius` metres of (x, z). */
  | { kind: "debug"; query: "colliders"; x: number; z: number; radius: number };

/**
 * One collision body of a `colliders` answer. Boxes and spheres are
 * centred on (x, y, z); a capsule's (x, y, z) is its feet.
 * `shape`: 0 box (hx/hy/hz half extents, `yaw` about +Y), 1 sphere (r),
 * 2 capsule (r, hy = half the straight section). `motion`: 0 static,
 * 1 kinematic, 2 dynamic. `asset` is the AssetRef hash (0: none).
 */
export interface DebugCollider {
  id: string;
  shape: 0 | 1 | 2;
  motion: 0 | 1 | 2;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  r: number;
  yaw: number;
  asset: number;
}

/** S→C answer to a DebugQuery (0x0a, JSON). */
export type DebugResponse =
  | {
      kind: "debug";
      query: "colliders";
      /** The bodies in range up to the server's cap; `total` counts every match. */
      colliders: DebugCollider[];
      total: number;
    }
  | {
      kind: "debug";
      query: "waypoints";
      entity: string;
      status: "active" | "idle" | "failed" | "unknown";
      waypoints: Array<[number, number, number]>;
    }
  | { kind: "debug"; query: "tiles"; tiles: Array<[number, number, number, number]> }
  | {
      kind: "debug";
      query: "timings";
      ticks: number;
      p50: number;
      p99: number;
      systems: Array<{ name: string; avg: number; max: number }>;
    };
