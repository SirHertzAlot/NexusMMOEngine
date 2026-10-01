# WebSocket Message Catalog

Mirrors Phase 1 plan §2. Envelope for every message: `[u8 type][payload]`.
Control plane = JSON (debuggable); data plane = FlatBuffers (hot path).
u64 ids travel as JSON strings (JS number precision).

**Protocol version: 8** (v2's real auth; v3 adds 0x0a editor debug queries; v4 adds 0x0b in-client registration; v5 adds characters: 0x0c–0x0e, hello/register `characters`, error 4005, and the Appearance component; v6 adds combat: the Action component and the Attack/Block/Dodge intent buttons; v7 adds stats 0x0f; v8 adds the admin console 0x10).

| Type | Name | Dir | Encoding | Fields | Purpose / frequency |
|------|------|-----|----------|--------|---------------------|
| 0x01 | `hello` | C→S | JSON | credentials: `{protocol: 6, client: string, username: string, password: string, want_snapshot: bool, characters?: bool}` · token: `{protocol: 6, client: string, token: "64 hex", want_snapshot: bool, characters?: bool}` — exactly one variant | Authentication. Once per connection. `characters: true`: choose a character before entering the world (answered with `account`, see [Characters](#characters-protocol-v5)). |
| 0x02 | `welcome` | S→C | JSON | `{protocol: 6, player_entity: "u64", server_tick: u64, tick_hz: 30, snapshot_every: 300, session_token: "64 hex", world?: {name, chunkWorldSize, bounds, map, seaLevel?}, character?: {id, name}, day?: {seconds, offset}}` — `character` when the player entered as one; — `world` for baked worlds: the chunk range and a coarse (16 m) map of the whole world, base64 layers: `heights` (u16 over min/maxHeight), `biome` + `biomes` ids, `river`, and `water` (u16 surface of the sea and lakes, 0xffff dry; optional) · `day` — the world's day clock (optional; absent = no day cycle) | Assigns identity, syncs clock/cadence params, issues the session token; the world map draws the far horizon, ground colours and water; the day clock gives every client the same time of day (`timeOfDayAt(day, tick, tick_hz)` = `offset + tick / tick_hz / seconds`, wrapped to 0..1, 0 = midnight). Once per connection. |
| 0x03 | `snapshot` | S→C | FlatBuffers `Snapshot` | tick, SoA component blocks (Transform, Velocity, PlayerIntent, Chunk, Health, Stamina, BodyConfig, AssetRef, Locomotion, Appearance, Action), spawned[], despawned[] | Baseline state. On connect + every 300 ticks. |
| 0x04 | `delta` | S→C | FlatBuffers `Delta` | tick, base_tick, changed component blocks only, spawned[], despawned[] | Per-tick state-change events (EDA: state out as events). 30 Hz. |
| 0x05 | `intent` | C→S | FlatBuffers `IntentMessage` | `{client_tick: u64, entity: u64, intent: PlayerIntent}` | Player input events into the sim (EDA: intents in as events). ≤ 1 per tick per client. |
| 0x06 | `ping` | C↔S | JSON | `{t: client_ms}` | Heartbeat + RTT. Every 5 s. |
| 0x07 | `pong` | C↔S | JSON | `{t: client_ms}` | Heartbeat reply. |
| 0x08 | `error` | S→C | JSON | `{code: int, message: string}` | Protocol/auth/server errors. Codes: 4001 bad-protocol, 4002 auth-failed, 4003 malformed, 4004 server-error, 4005 refused (a well-formed request the server declines — a taken character name, a refused look; the connection stays open). As needed. |
| 0x09 | `bye` | either | JSON | `{reason: string}` | Graceful disconnect notice. |
| 0x0a | `debug` | C→S / S→C | JSON | query: `{kind:"debug", query:"waypoints", entity:"u64"}` or `{kind:"debug", query:"tiles"}` · response: `{kind:"debug", query:"waypoints", entity, status:"active"\|"idle"\|"failed"\|"unknown", waypoints:[[x,y,z]…]}` or `{kind:"debug", query:"tiles", tiles:[[x0,z0,x1,z1]…]}` | **Editor-only, read-only.** Live answers the delta stream doesn't carry (path waypoints live server-side; navmesh tile bounds). Requires a welcomed session; malformed/unknown → 4003. Never touches sim state. |
| 0x0b | `register` | C→S | JSON | `{protocol: 6, client: string, username: string, password: string, characters?: bool}` — username 3–32 chars `[A-Za-z0-9_-]`, password 8–128 chars | **In-client account creation.** Creates the account (argon2id-hashed, never stored/logged in plaintext), mints a session, then joins exactly like a credentials hello: `welcome` + snapshot. Once per connection. Failures: 4002 username-taken / registration-disabled / too-many-attempts, 4003 malformed, 4001 protocol mismatch. Registration attempts share the per-IP auth budget with logins. Disable server-side with `MMO_ALLOW_REGISTER=0` (do this before any public deployment). |
| 0x0c | `account` | S→C | JSON | `{session_token: "64 hex", characters: [{id: int, name: string, look: Look}], max_characters: int, created?: int}` | The account's characters, after a hello/register with `characters: true` and after each `create_character` (`created` = the new one's id). |
| 0x0d | `create_character` | C→S | JSON | `{name: string, look: Look}` — name 3–16 chars `[A-Za-z'-]`, starting with a letter | Creates a character while choosing (answered with `account`). Refusals are 4005 (name taken, account full, look refused); a bad shape is 4003. |
| 0x0e | `enter_world` | C→S | JSON | `{character: int}` | Enters the world as one of the account's characters: `welcome` + snapshot. Someone else's or an unknown id is 4005. |
| 0x10 | `admin` | C→S / S→C | JSON | command: `{kind:"admin", command: string, args?: unknown}` (`help`, `whoami`, `inspect {entity}`, `set {entity, component, field, value}`, `spawnlist`, `spawn {asset, x?, z?, yaw?}`, `despawn {entity}`) · result: `{kind:"admin", command, ok: bool, message: string}` | **Admin console (A1).** Welcomed admins only (named in `MMO_ADMINS`, or every account with `MMO_DEV_SERVER=1`); anything else is answered 4003 and logged. Every answered command lands in the server's command log. |

## Authentication (slice 1.4)

A `hello` carries **exactly one** of two shapes; carrying both, neither,
or any malformed shape is rejected as 4003 (no connection close):

- **Credentials hello** (login): `{protocol, client, want_snapshot,
  username, password}`. Username: 3–32 chars `[A-Za-z0-9_-]`. Password:
  8–128 chars. The server looks up the account and verifies the password
  with argon2id. Unknown users get the same generic 4002 as wrong
  passwords, after a dummy-hash verification so timing is similar.
- **Token hello** (reconnect): `{protocol, client, want_snapshot, token}`,
  where `token` is the 64-lowercase-hex session token from a previous
  `welcome`. A valid, unexpired token skips the password check entirely.

On success the server answers `welcome`, which now includes
`session_token`: a 256-bit opaque token (`crypto.randomBytes(32)` hex).
The client stores it and presents it on the next `hello` to skip login.

**Two different lifetimes — don't confuse them:**

- **Session token TTL** (auth): default 24 h. In-memory only; sessions die
  with the server process (accounts are durable in CSV, sessions are
  not). An expired token is rejected with 4002 and the client must log in
  again with credentials.
- **Player reconnect grace** (gameplay): default 30 s. The player entity
  survives a disconnect for the grace period. A *valid auth token*
  reconnecting inside the grace window re-attaches the SAME player entity;
  after the grace window it spawns a fresh entity — no new login needed
  either way, as long as the auth token is still alive.

**Rate limiting.** Failed auth attempts are counted per remote IP in a
sliding window (default 5 failures per 60 s). A successful login clears the
IP's failure record. When the budget is exhausted the server closes the
connection with a generic 4002 ("too many attempts") — it never says which
credential was wrong.

**Failure semantics.** 4001 (protocol mismatch) and 4002 (auth failed) close
the connection. 4003 (malformed) leaves it open for a retry. Every auth
failure uses the same generic message; passwords, hashes, and tokens are
never logged — only the client label and `via=password|token`.

**Registration (slice 1.4+, protocol v4).** The login screen's "Create
account" sends `register` (0x0b) instead of `hello`: same username/password
rules as the credentials hello, validated by the same Zod discipline
(`RegisterSchema`, strict). The server hashes with argon2id *before* the
credential store sees it, creates the account, mints a session, and runs
the exact same join path as a credentials hello (`joinWithSession` —
welcome + snapshot, entity spawn). A taken username answers 4002
"username is taken" and closes; registration shares the per-IP auth
budget, so probing usernames burns the same budget as probing passwords.
The endpoint is a dev convenience — `MMO_ALLOW_REGISTER=0` (or the
`allowRegister` gateway option) disables it; disable it before any public
deployment. The `seed:user` CLI remains for headless provisioning.

Notes:

- The server applies each client's latest intent to the next tick; delivery
  is implicitly acked by subsequent deltas. Stale intents (older than the
  last applied tick) are dropped and counted.
- Client reconciliation model (interpolation vs prediction) is a Phase 3
  decision; the catalog supports either.
- Schema addition for `intent`: `table IntentMessage { client_tick: uint64;
  entity: uint64; intent: PlayerIntent; }` (slice 1.3, additive, DRY — one
  schema).

## Characters (protocol v5)

A player plays a **character**: a name and a look, owned by the account
(stored in `characters.db`, SQLite, next to `users.csv`). A client that
lets the player choose sends `characters: true` in its `hello` or
`register`. After authenticating, the server answers `account` (0x0c) —
the account's characters — and waits: the session is authenticated but
not in the world (no entity, no deltas). The client then sends:

- `create_character` (0x0d) `{name, look}`: the server checks the name
  (3–16 letters, `'` or `-`, starting with a letter; unique on the
  server, ignoring case), the account's limit (8), and the look, stores
  the character, and answers `account` again with `created` set.
- `enter_world` (0x0e) `{character}`: the server spawns the avatar with
  the character's look and answers `welcome` (with `character`) +
  snapshot, exactly as a join.

**Look** (`@mmo-engine/art` `CharacterLook`): `{gender: "male" |
"female", parts: {slot: partName}, colours: {slot: "#rrggbb"}}`. Parts
are the Modular Fantasy Hero pack's (`Chr_Head_Female_04`, `Chr_Hair_12`,
…); a missing body slot is the starter armour (set 01), a missing detail
slot is empty. A **new** character wears the starter armour and no
attachments; only its appearance is chosen: face (which brings the eyes),
hair, eyebrows, facial hair (men), ears, and the colours of skin, hair,
stubble, scars and body art. The server validates against the pack's part
catalog when it has the art (`MMO_CHARACTER_CATALOG`, default the
converted pack under `assets/`), and structurally otherwise, then stores
the look in canonical JSON.

A **character is in the world once**: entering it while another session
plays it ends that session (4005 "entered the world elsewhere", then
close) and removes its avatar. A session remembers its character, so a
token reconnect after the grace period re-enters as it directly
(`welcome`, no `account`). Without `characters: true` (the editor, tools,
older flows) a login joins at once as the account's first character, or
with a default look when it has none.

**Appearance on the wire.** Every entity with a look carries the
`Appearance` component (ComponentId 10): `{look: string}`, the canonical
look JSON. Configuration, like BodyConfig: in every snapshot, in deltas
only when it changes (the server interns looks, so the diff compares
ids). Clients assemble the modular character from it — players now, enemy
humans later.

## Combat (protocol v6)

Intent buttons (PlayerIntent.buttons): `Attack` 0x02 and `Dodge` 0x08 act
on the press, `Block` 0x04 while held (with `ToggleFlight` 0x01). The
client sends left mouse as Attack, right mouse held as Block, Q as Dodge.

The server's CombatSystem runs each character's move — the moves, their
clips, timings, chain windows and travel are shared data
(`@mmo-engine/protocol` `COMBAT_MOVES`) — and sends it as the **Action**
component (ComponentId 11): `{move: u16, started: u32 tick, seq: u8, yaw:
f32}`. `move` 0 is none; `seq` changes with every new move (the same move
again restarts); `yaw` is the move's facing. Clients play the move's clip
from `started` and face `yaw`; the server alone moves the character (the
walk slowed to the move's `moveScale`, plus its `advance` — a lunge, the
roll's 4.5 m).

The sword combo is three hits: an attack pressed in a hit's chain window
queues the next hit, which starts when the hit lands (facing where the
player then looks); with nothing queued, the hit's recovery plays (and a
press early in it still continues the combo). Block held raises the
guard (walking at 35%); attack while guarding bashes with the shield.
Dodge rolls the way you move (or look). Moves start only on the ground.
Damage and hit reactions are a later step.

## Movement: walking, swimming, flying

- **`Locomotion` component** (`mode: u8, abilities: u8, breath: f32`),
  a SoA block appended to `Snapshot` and `Delta` as `locomotions` (older
  snapshots without it decode with no rows). `mode` is `LocomotionMode`
  (0 ground, 1 swim, 2 fly); `abilities` is a bit set of `Ability`
  (0x01 swim, 0x02 fly); `breath` is the air left, 1 = full lungs.
  Players spawn able to swim; the server grants flight
  (`MMO_PLAYER_ABILITIES=swim,fly`, or the gateway's `playerAbilities`) —
  expansions (mounts, spells, gear) set the bits per entity.
- **`Stamina` component** (`current: f32, max: f32`), a SoA block
  appended to `Snapshot` and `Delta` as `staminas` (older snapshots
  without it decode with no rows, like `locomotions` before them).
  Drained by exertion — dodges (20), attacks (10), jumps (8), swimming
  (10/s) and running (6/s); back at `staminaRegen`/s after a 1 s
  cooldown. Combat move starts spend through it: an unaffordable dodge
  or attack never fires (guards stay free). Climbing has no locomotion
  system yet, so nothing drains for it. `maxStamina` is a stat drive
  (StatsSystem, share-preserving like `maxHealth`).
- **Intent fields.** `my` is the up/down wish (−1..1): swim or fly up and
  down; on the ground it does nothing (jumping is the `jump` flag).
  `buttons` bit `IntentButton.ToggleFlight` (0x01) takes off or lands on
  the press (held across ticks it toggles once). The client binds Space
  (jump / up), C (down) and F (flight).
- **Swimming** (server, CharacterSystem) starts where the water under you
  is at least 1.3 m deep and you are below its surface; the water surface
  comes from the baked world (`water_level` map: sea and lakes). Afloat,
  the head stays above the surface; `my < 0` dives to the bottom. The
  breath drains while the head is under (30 s of air) and comes back 3×
  as fast; with none left the swimmer is pushed up and loses 10 health a
  second. Back in the shallows you stand and walk. Swim speed 3 m/s.
- **Flying** has no gravity: `my` climbs or descends at 6 m/s, up to
  250 m above the ground, at 12 m/s across. Descending onto the ground
  lands; into deep water, swims; toggling off mid-air falls.

## Session & reconnect semantics (slice 1.3, auth updated slice 1.4)

- **Identity.** The server-issued session token is the client identity.
  The first credentials `hello` spawns a player entity (Transform +
  Velocity + PlayerIntent + Health + Locomotion) and binds it to the session; the
  binding is `session_token → player_entity` for the life of the session.
- **Authority.** A client drives ONLY its own player entity. Intents naming
  any other entity are rejected with `error` 4003 and never reach the sim.
  Stale intents (`client_tick` ≤ last accepted) are silently dropped and
  counted (`droppedIntents`), so a client sends at most one intent per
  server tick (the mirror client holds a later change for the next tick).
  Intents carrying a non-finite number are rejected with `error` 4003; the
  horizontal move (`mx`, `mz`) is capped at length 1 and `my` at ±1 (the
  server owns the speed).
- **One join per connection.** A `hello` or `register` on a connection
  that has joined, or while one is still being checked, is refused with
  `error` 4003 and changes nothing.
- **Grace period.** On disconnect the session is parked, not deleted: the
  player entity survives a configurable grace period (default 30 s) so a
  quick reconnect re-attaches seamlessly. Reconnecting with the same
  session token inside the grace window rebinds the socket to the SAME
  session and player entity, then the server sends a fresh `welcome` +
  full `snapshot`.
- **Takeover.** A token connecting while its session is still live takes
  over: last connection wins, the old socket is superseded (closed), the
  player entity is untouched.
- **Expiry.** When the grace period elapses with no reconnect, the player
  entity is despawned and the game session (and its token binding) is
  deleted; the next credentials `hello` spawns a fresh entity. A fresh
  player entity for a still-valid auth token follows the same rule.
- **Heartbeat.** The server pings every 5 s; 3 missed pongs drops the
  socket (the session still gets its grace period). Client→server `ping`
  is echoed as `pong` with the same payload for RTT.
- **Broadcast.** Phase 1 fans every tick's delta to every connected client;
  no interest management (documented scaling lever, not a Phase 1
  feature). Per-client state (send queue, acked tick, resync flag) exists
  so reconnects, slow consumers, and later interest filtering have a home:
  a client whose queue overflows is reset to a full snapshot
  (`needsResync`).
