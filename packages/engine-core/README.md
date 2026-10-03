# @mmo-engine/engine-core

The authoritative server core. **Slice 1.4-auth**: real authentication
replaces the dev-token stub (protocol v2) — CSV credential store with
argon2id hashes, strict Zod hello validation, opaque in-memory sessions
(24 h TTL), per-IP failed-auth rate limiting. SQLite persistence (1.4)
builds on this.

## Modules

- `src/auth/passwords.ts` — argon2id `hashPassword` / `verifyPassword`
  (malformed hashes verify as `false`); `DUMMY_HASH` for unknown-user
  timing ballast.
- `src/auth/credentials.ts` — `CredentialStore` interface
  (`findUser`/`createUser`) + `CsvCredentialStore` (default
  `./data/users.csv`, created/tightened to mode `0600`, gitignored).
  Swappable later for a SQLite store behind the same interface.
- `src/auth/schemas.ts` — strict Zod hello shapes: exactly one of
  credentials `{protocol, client, want_snapshot, username, password}` or
  token `{protocol, client, want_snapshot, token}`. Validation only —
  authentication is argon2/session logic.
- `src/auth/sessions.ts` — `SessionManager`: opaque 256-bit session
  tokens, configurable TTL (default 24 h), lazy expiry + periodic sweep.
- `src/auth/rate-limit.ts` — `AuthRateLimiter`: per-IP sliding-window
  failed-attempt budget (default 5 / 60 s); success clears the record.
- `src/auth/seed-user.ts` — server-side account provisioning:
  `MMO_DEV_PASSWORD='<password>' npm run seed:user -- <username>`
  (never prints the password or hash). No public self-registration.
- `src/entity-id.ts` — wire entity-id mapping: `u64 = (generation << 32) |
  slot` (architecture brief §2). Single implementation shared by world, net,
  and persist code (DRY).
- `src/session.ts` — `ClientSession`: per-client session state shape for
  multiplayer-from-the-start (last acked tick, delta send queue, heartbeat
  tracking, reconnect/grace fields). Owned by the gateway (1.3).
- `src/net/gateway.ts` — `Gateway`: the `ws` multiplayer gateway. Pure
  event translator (operating rule 1): owns sockets, protocol, sessions,
  heartbeat, and queues — no game logic. Authenticates every `hello`
  (credentials via argon2id against the `CredentialStore`, or a session
  token) with per-IP rate limiting; `welcome` issues the 64-hex session
  token. Inbound `intent` messages are validated (own-entity authority,
  stale-tick drop) and queued as sim events via `SimWorld.queueIntent()`;
  each tick's delta is broadcast to every connected client. Session-token
  reconnect: same token inside the grace period re-attaches the same
  player entity (fresh snapshot); after expiry the entity is despawned.
  Live same-token connection takes over (last wins). Production:
  `listen()` + `startTicking()`; tests drive `frame(nowMs)` with a
  synthetic clock.
- `src/net/intent.ts` — `IntentMessage` FlatBuffers codec:
  `encodeIntentMessage` / `decodeIntentMessage`, returning a plain
  `QueuedIntent` ready for `SimWorld.queueIntent()`.
- `src/tick-loop.ts` — `TickLoop`: fixed-step (30 Hz) accumulator with
  frame-delta clamping, a 5-step catch-up cap, and spiral-of-death
  accounting (`spiralEvents`/`droppedMs`). A 1 ns epsilon on the step
  boundary keeps exact-multiple timestamps (tests, replays) from losing
  ticks to float dust.
- `src/components.ts` — the five slice-1 bitECS components as SoA typed
  arrays (Transform, Velocity, PlayerIntent, Chunk, Health), plus
  `COMPONENT_IDS` registry order and u64 hi/lo helpers for Chunk's
  uint64 fields (bitECS has no u64 store type).
- `src/world.ts` — `SimWorld`: owns the bitECS world and the slot→wire-id
  mapping. Eager slot recycling (bounded eid space) with a generation
  counter per slot (ABA guard). Per-tick spawned/despawned wire-id lists,
  an intent-event queue drained at `beginTick` (EDA), and a minimal
  `spawned`/`despawned`/`tick` event emitter for the 1.3 gateway.
  Player entities are just entities carrying PlayerIntent — N of them,
  no singleton.
- `src/systems.ts` — `SimSystem` (`name` + `step(sim, dt)`): the narrow
  interface a future C++ addon implements to replace a system in place.
  `IntentSystem` (wish-move → velocity) and `IntegrateSystem`
  (`position += velocity * dt`) are the slice-1.2 placeholders.
- `src/snapshot.ts` — FlatBuffers codecs over the schema bindings:
  `collectFullState` / `encodeSnapshot`, `collectDeltaState` /
  `encodeDelta`, plus `decodeSnapshot` / `decodeDelta` for verification.
  `DeltaTracker` diffs tracked fields against a Float64 baseline for
  changed-only deltas (spawned slots always fully included).
- `src/delta-apply.ts` — client-side `WorldState` (wire id → rows),
  `applyDelta` (despawn removes, block rows upsert), and `compareStates`
  with exact float equality: every value originates in an f32 store and
  survives the wire bit-identically, so any diff is a real bug.
- `src/sim.ts` — headless benchmark driver (see below).
- `test/net/headless-client.ts` — scriptable WebSocket test client
  (no browser): drives the real wire protocol for the gateway tests.
  `hello()` takes `{username, password}` or `{token}`; the returned
  `welcome` carries the session token. `test/net/gateway.test.ts` runs
  10 end-to-end scenarios against a `Gateway` on a synthetic clock:
  hello→welcome→snapshot→deltas, intent moves own player, 3 concurrent
  clients with no cross-talk, foreign-intent rejection, stale-intent
  drop, grace-period re-attach (via session token), grace expiry,
  same-token takeover, heartbeat drop, bad-hello rejection
  (protocol/auth-failed/malformed).

## Processes (edge/core split)

Plan: [`docs/EDGE-CORE-SPLIT.md`](../../docs/EDGE-CORE-SPLIT.md). The edge
(`apps/edge`) is the players' front door; this package is the simulation
behind it. Slice E3 is built **additively**: the server serves the edge's
internal channel (`src/channel-server.ts`, `CORE_CHANNEL_PORT`, default
4000, loopback only) beside the gateway, and players still connect to the
gateway on `MMO_PORT`. Moving the client onto the edge (and dropping the
player listener here) is a later step.

Channel packets the core answers:

| Type | Payload → answer |
|---|---|
| `player.intent` | `{ token, intent: { mx, my, mz, lookYaw, lookPitch, jump, buttons } }` → `{ accepted: true, tick }`; queued for the player that session is in the world as, sanitized like a socket intent; refused (`error`) without a player |
| `auth.login` | `{ username, password }` → `{ ok: true, token, playerId }` or `{ ok: false, reason }`; the gateway's own password check and rate limit |
| `session.validate` | `{ token }` → `{ valid }` |
| `core.sync` | `{}` → `{ tick, sessionIds }` (every live token) |
| `mythic.grant_item` | `{ playerId, itemId, instanceId, stats }` → `{ ok: true }`; answers an error until Q9 wires it |
| `mythic.spawn_boss` | `{ bossId, instanceId, placeId, stats }` → `{ ok: true, instanceId }`; answers an error until Q9 wires it |
| `metrics.get` | `{}` → Prometheus text (tick and channel counters until E6's registry) |
| anything else | `error: "unknown packet type <type>"` |

Pushes to every connected edge, every tick: `tick.events`
(`{ tick, events }`, that tick's hit and life messages, sent even when
empty) and `tick.delta` (`{ tick, delta }`, the same FlatBuffers delta the
clients get, base64). On ticks where `isSnapshotTick(n)` (`n % 300 === 0`)
also `snapshot` (`{ tick, snapshot }`, base64).

Sessions: tokens live in `world.db`'s `sessions` table
(`token, playerId, createdAt, expiresAt`), so a core restart keeps them.
Expiry is unchanged (24 h wall-clock TTL), which is why the columns are
milliseconds rather than the plan's ticks. The character a session last
entered as is not stored.

## Commands

```sh
npm run build         # schema bindings -> tsc -> dist/
npm test              # build + node:test (67 tests)
npm run test:gateway  # build + gateway/net tests only (14 tests)
npm run sim           # build + headless benchmark: 1000 entities x 300 ticks
```

## Persistence (Slice 1.4)

`src/persist/store.ts` — `SnapshotStore`: SQLite (better-sqlite3, WAL mode)
persistence for full world snapshots.

- **Schema**: `snapshots(id, tick, taken_at TEXT ISO-8601, bytes BLOB)` stores
  the FlatBuffers snapshot bytes; `meta(key, value)` tracks
  `latest_tick`/`entity_count`; per-slot generations are stored alongside
  (needed for ABA-safe identity across reboots).
- **API**:
  - `saveSnapshotBytes(tick, bytes, generations, entityCount)` — the
    production hot path: persists pre-encoded snapshot bytes (reused from
    the gateway's 300-tick broadcast). p95 **0.3 ms** at 1,000 entities.
  - `saveWorld(tick, sim)` — convenience: drains the intent queue,
    collects, encodes (reused builder), and persists. Used for shutdown
    saves and tests.
  - `loadLatest()` / `restoreInto(sim)` — restore entities, components,
    and generations; resume at `restoredTick + 1`.
  - `shouldSave(tick)` — true every 300 ticks (never tick 0).
- **Tuning**: `synchronous=NORMAL` (safe under WAL; only the latest commit
  is at risk on power loss) + `wal_checkpoint(PASSIVE)` after each save
  (avoids autocheckpoint latency spikes). p95 persist latency < 5 ms
  at 1,000 entities (measured in `test/persist/store.test.ts`).
- **Shutdown**: `installShutdownHook(store, sim, getTick)` in
  `src/persist/shutdown.ts` — saves on SIGTERM/SIGINT before exit.
- **Gateway integration**: `Gateway` accepts `{ world, startTick }` —
  boot from a restored world and serve it transparently (see
  `test/net/gateway-restore.test.ts`).
- **Testing note**: `SimWorld.resetEntityCursorForTesting()` resets the
  process-global bitECS cursor. Production runs one world per process
  (fresh globals); in-process tests must call this between the source
  world and the restored world.

`npm run sim` drives the world through the `TickLoop` with synthetic
timestamps, builds a changed-only delta per tick, and writes parseable
artifacts to `sim-artifacts/` (gitignored, reproducible via the seeded
PRNG):

- `snapshot-0.bin`, `snapshot-300.bin` — full snapshots
- `deltas.bin` — u32-LE length-prefixed delta stream (300 deltas)

It then verifies from disk: snapshot-0 round-trips, snapshot-300 matches
live state exactly, and applying deltas 1..300 onto snapshot-0 **exactly**
reproduces snapshot-300 (the multiplayer replication invariant). It prints
mean/p95/max tick time, the systems-vs-encode split, and headroom against
the 33.333 ms budget.

Measured 2026-09-27 (1000 entities: 600 movers, 300 players, 100 props):
mean tick **7.38 ms**, p95 **10.88 ms** — **67% p95 headroom**. Systems cost
0.29 ms; FlatBuffers delta encode+commit dominates at 7.08 ms and is the
first optimization target for slice 1.5 (builder reuse).
