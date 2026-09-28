# WebSocket Message Catalog

Mirrors Phase 1 plan §2. Envelope for every message: `[u8 type][payload]`.
Control plane = JSON (debuggable); data plane = FlatBuffers (hot path).
u64 ids travel as JSON strings (JS number precision).

**Protocol version: 4** (v2's real auth; v3 adds 0x0a editor debug queries; v4 adds 0x0b in-client registration).

| Type | Name | Dir | Encoding | Fields | Purpose / frequency |
|------|------|-----|----------|--------|---------------------|
| 0x01 | `hello` | C→S | JSON | credentials: `{protocol: 4, client: string, username: string, password: string, want_snapshot: bool}` · token: `{protocol: 4, client: string, token: "64 hex", want_snapshot: bool}` — exactly one variant | Authentication. Once per connection. |
| 0x02 | `welcome` | S→C | JSON | `{protocol: 4, player_entity: "u64", server_tick: u64, tick_hz: 30, snapshot_every: 300, session_token: "64 hex"}` | Assigns identity, syncs clock/cadence params, issues the session token. Once per connection. |
| 0x03 | `snapshot` | S→C | FlatBuffers `Snapshot` | tick, 5 SoA component blocks, spawned[], despawned[] | Baseline state. On connect + every 300 ticks. |
| 0x04 | `delta` | S→C | FlatBuffers `Delta` | tick, base_tick, changed component blocks only, spawned[], despawned[] | Per-tick state-change events (EDA: state out as events). 30 Hz. |
| 0x05 | `intent` | C→S | FlatBuffers `IntentMessage` | `{client_tick: u64, entity: u64, intent: PlayerIntent}` | Player input events into the sim (EDA: intents in as events). ≤ 1 per tick per client. |
| 0x06 | `ping` | C↔S | JSON | `{t: client_ms}` | Heartbeat + RTT. Every 5 s. |
| 0x07 | `pong` | C↔S | JSON | `{t: client_ms}` | Heartbeat reply. |
| 0x08 | `error` | S→C | JSON | `{code: int, message: string}` | Protocol/auth/server errors. Codes: 4001 bad-protocol, 4002 auth-failed, 4003 malformed, 4004 server-error. As needed. |
| 0x09 | `bye` | either | JSON | `{reason: string}` | Graceful disconnect notice. |
| 0x0a | `debug` | C→S / S→C | JSON | query: `{kind:"debug", query:"waypoints", entity:"u64"}` or `{kind:"debug", query:"tiles"}` · response: `{kind:"debug", query:"waypoints", entity, status:"active"\|"idle"\|"failed"\|"unknown", waypoints:[[x,y,z]…]}` or `{kind:"debug", query:"tiles", tiles:[[x0,z0,x1,z1]…]}` | **Editor-only, read-only.** Live answers the delta stream doesn't carry (path waypoints live server-side; navmesh tile bounds). Requires a welcomed session; malformed/unknown → 4003. Never touches sim state. |
| 0x0b | `register` | C→S | JSON | `{protocol: 4, client: string, username: string, password: string}` — username 3–32 chars `[A-Za-z0-9_-]`, password 8–128 chars | **In-client account creation.** Creates the account (argon2id-hashed, never stored/logged in plaintext), mints a session, then joins exactly like a credentials hello: `welcome` + snapshot. Once per connection. Failures: 4002 username-taken / registration-disabled / too-many-attempts, 4003 malformed, 4001 protocol mismatch. Registration attempts share the per-IP auth budget with logins. Disable server-side with `MMO_ALLOW_REGISTER=0` (do this before any public deployment). |

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

## Session & reconnect semantics (slice 1.3, auth updated slice 1.4)

- **Identity.** The server-issued session token is the client identity.
  The first credentials `hello` spawns a player entity (Transform +
  Velocity + PlayerIntent + Health) and binds it to the session; the
  binding is `session_token → player_entity` for the life of the session.
- **Authority.** A client drives ONLY its own player entity. Intents naming
  any other entity are rejected with `error` 4003 and never reach the sim.
  Stale intents (`client_tick` ≤ last accepted) are silently dropped and
  counted (`droppedIntents`).
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
