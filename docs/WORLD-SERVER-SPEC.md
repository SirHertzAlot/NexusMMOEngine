# World Server Spec — region↔world control plane

Status: **spec** (not yet built). Companion to `docs/DECISIONS.md`
("Region/world split" entry) and `docs/MESSAGE-CATALOG.md` (client↔region
protocol, unchanged by this spec).

## 1. Concept

The world server is a **small, durable, separately-deployable Express
service** that acts as the system of record for everything *global* or
*cross-region* — and nothing else. It never simulates, never ticks, never
talks to game clients.

The core design rule: **the core knows nothing about transports.**
Every communication medium terminates in a thin adapter that sanitizes
and validates at the edge (Zod, strict — the same discipline as the
gateway's hello/register path) and then calls the same core functions.
webrpc over HTTP today, a queue consumer tomorrow, an in-process stub
for single-box dev later — adding a transport means writing an adapter,
never touching the core. That is what makes "wire it up to a queue or
embed a stub without much complex work or maintenance" true.

```
 game clients                    regions (engine instances)
     │                                │
     │ WS 0x01..0x0b                   │  transport adapter
     ▼                                ▼
┌──────────┐   ┌──────────────────────────────────────────────┐
│  region  │   │                  WORLD SERVER                 │
│ gateway  │──▶│  Express shell                                │
│ :7777    │   │   ├─ webrpc HTTP adapter      (now)           │
└──────────┘   │   ├─ queue consumer adapter   (later)         │
               │   └─ embedded stub adapter    (later, in-proc)│
               │         │  validated domain ops (WorldCore)   │
               │         ▼                                     │
               │   ┌─────────────┐                             │
               │   │  WorldCore  │──▶ SurrealDB (server binary, ws://)   │
               │   └─────────────┘                             │
               └──────────────────────────────────────────────┘
```

## 2. Goals / non-goals

**Goals**

- Region registry and liveness (who owns which chunk range, who's alive).
- Cross-region entity migration arbitration (the border-handoff problem).
- Durable global data: accounts (moved out of CSV), region topology,
  global services later (chat, mail, auction, leaderboards).
- Single deployable, boring ops: one process, one embedded DB, no
  mandatory external services for the single-box topology.
- Transport-agnostic core: webrpc now, queue or embedded stub later,
  zero core changes.

**Non-goals**

- Not in the 30 Hz tick loop. Regions batch-report asynchronously; a
  slow world server must never stall a region's tick.
- Not a game simulation, not client-facing (clients talk to regions),
  not a general message bus.

## 3. What lives where

| Region (engine instance) | World server |
|---|---|
| 30 Hz ECS tick, chunk data, entities in its range | Region registry (chunk range → region) |
| Connected clients, session *validation* | Session *issuance*/revocation (world-scoped tokens) |
| Local SQLite: snapshots, chunk overrides | Accounts, migration records, op dedup log |
| Border detection (entity near edge) | Migration arbitration (begin/commit/abort) |
| Async reporting (snapshots, stats) | Global services (later slices) |

SQLite stays as the region-local store. SurrealDB is the world-level
store only. This promotes SurrealDB from "distant alternative" to a
defined role without disturbing what's already working.

## 4. The core interface (transport-independent)

`WorldCore` is a plain TypeScript interface. Every adapter translates
its transport into these calls. Nothing in the core imports Express,
webrpc, or any queue client.

```ts
interface WorldCore {
  // --- regions ---
  registerRegion(input: RegisterRegionInput): Promise<RegionLease>;
  heartbeat(input: HeartbeatInput): Promise<HeartbeatAck>;
  deregisterRegion(input: { regionId: string; opId: string }): Promise<void>;

  // --- migration ---
  beginMigration(input: BeginMigrationInput): Promise<{ migrationId: string }>;
  commitMigration(input: { migrationId: string; opId: string }): Promise<void>;
  abortMigration(input: { migrationId: string; opId: string; reason: string }): Promise<void>;

  // --- snapshots / stats (async, lossy-OK) ---
  reportSnapshot(input: SnapshotReportInput): Promise<void>;

  // --- accounts (slice C; CSV stays until then) ---
  getAccount(input: { username: string }): Promise<AccountRecord | null>;
  upsertAccount(input: UpsertAccountInput): Promise<void>;
}
```

**Idempotency.** Every mutating op carries a client-generated `opId`
(UUID). The core keeps an `op_dedup` table (`opId → result`) and
returns the stored result on retry. This is required the moment a
queue adapter exists (at-least-once delivery) and harmless before.

**Auth.** Regions authenticate to the world server with a pre-shared
key (`WORLD_API_KEY`, env-only, never logged). Adapters reject
unauthenticated callers before validation.

## 5. SurrealDB schema (world data)

```surql
-- Liveness: one record per region; stale = now - last_heartbeat > threshold
DEFINE TABLE region SCHEMAFULL;
DEFINE FIELD region_id      ON region TYPE string;
DEFINE FIELD chunk_range    ON region TYPE object;   -- {x0,x1,z0,z1}
DEFINE FIELD endpoint       ON region TYPE string;   -- where to reach it
DEFINE FIELD capacity       ON region TYPE int;
DEFINE FIELD load           ON region TYPE float;
DEFINE FIELD last_heartbeat ON region TYPE datetime;
DEFINE FIELD api_key_hash   ON region TYPE string;   -- argon2, like passwords

-- Migration arbitration log; the source of truth during handoff
DEFINE TABLE migration SCHEMAFULL;
DEFINE FIELD entity_id   ON migration TYPE string;
DEFINE FIELD from_region ON migration TYPE string;
DEFINE FIELD to_region   ON migration TYPE string;
DEFINE FIELD state       ON migration TYPE string;  -- begun|committed|aborted|expired
DEFINE FIELD entity_state ON migration TYPE object;  -- serialized ECS state
DEFINE FIELD created_at ON migration TYPE datetime;
DEFINE FIELD updated_at ON migration TYPE datetime;

-- Idempotency for retried mutating ops
DEFINE TABLE op_dedup SCHEMAFULL;
DEFINE FIELD op_id     ON op_dedup TYPE string;
DEFINE FIELD result    ON op_dedup TYPE object;
DEFINE FIELD created_at ON op_dedup TYPE datetime;

-- Accounts (slice C)
DEFINE TABLE account SCHEMAFULL;
DEFINE FIELD username     ON account TYPE string;
DEFINE FIELD password_hash ON account TYPE string;  -- argon2id, never plaintext
DEFINE FIELD created_at  ON account TYPE datetime;
```

Recovery on restart: reload regions (mark stale until heartbeats
resume); any `migration` in `begun` older than the migration timeout
→ `expired` (origin region resumes authority).

## 6. Border-handoff protocol

The one hard problem. Authority must never be lost or duplicated.

1. Region A detects an entity crossing into B's chunk range (B resolved
   from A's cached copy of the region registry).
2. A → world: `beginMigration({entityId, fromRegion: A, toRegion: B,
   entityState, opId})`. World writes `migration` (`begun`), returns
   `migrationId`. **A retains authority.**
3. A tells the entity's client: "reconnect to B" (client already holds
   a world-scoped session token, so B can validate without the
   password — this also fixes "sessions die with the server process").
4. B instantiates the entity from `entityState`, then → world:
   `commitMigration({migrationId, opId})`. World marks `committed`.
5. A, on seeing `committed` (or on its next heartbeat ack carrying the
   migration outcome), drops the entity. Until then A keeps simulating
   it — brief dual simulation, single authority (A), no loss.
6. Failure paths:
   - B never commits within timeout → world marks `expired`; A resumes
     sole authority, client stays on A.
   - A dies mid-migration → B fetches `entityState` from the world
     record and commits; world is the backstop.
   - Client fails to reach B → reconnects to A; A still has authority.

**As built (slice B2, 2026-10-04).**
- The "reconnect to B" in step 3 is a `bye` with `redirect: {endpoint,
  migration, ticket}` (MESSAGE-CATALOG §0x09). The client answers B with
  a migration `hello`.
- The ticket is a one-time secret the source mints per hand-off. Only its
  hash rides in `entityState`, and B checks it before instantiating.
- B issues its own session token. World-scoped tokens (sessions issued by
  the world, valid in every region) are still to come. Until then, a
  player who drops after crossing reconnects to the region they are in.
- A player's hand-off state covers:
  - account and character identity, look, position;
  - health, stamina, mana and skills.

  It does not cover injuries, bags, parties and guilds. Injuries start
  fresh in the new region. Bags, parties and guilds live in each region's
  own store. Carrying them needs the shared persistence the regions don't
  have yet.

v1 transfers the entity blob *through* the world (correctness first).
If the stress harness shows migration payload size is a bottleneck,
slice B+ switches to direct A→B transfer with the world arbitrating
only begin/commit.

## 7. Region-side client

`engine-core` gains a `WorldClient` with a swappable transport:

```ts
interface WorldTransport {
  call<Op extends WorldOp>(op: Op, input: unknown): Promise<unknown>;
}
class WebrpcWorldTransport implements WorldTransport { /* generated TS client */ }
class EmbeddedWorldTransport implements WorldTransport { /* direct core calls, later */ }
// QueueWorldTransport later.
```

Region boot: construct client → `registerRegion` → start heartbeat
timer (off the tick loop — a `setInterval`, never inside `tick()`).
Region shutdown: `deregisterRegion` (best-effort).

## 8. webrpc IDL (concrete sketch)

```ridl
webrpc = v1

name = world
version = v0.1.0

# Region lifecycle
service World
  - RegisterRegion(input: RegisterRegionInput) => (lease: RegionLease)
  - Heartbeat(input: HeartbeatInput) => (ack: HeartbeatAck)
  - DeregisterRegion(regionId: string, opId: string) => ()

  # Migration arbitration
  - BeginMigration(input: BeginMigrationInput) => (migrationId: string)
  - CommitMigration(migrationId: string, opId: string) => ()
  - AbortMigration(migrationId: string, opId: string, reason: string) => ()

  # Async reporting
  - ReportSnapshot(input: SnapshotReportInput) => ()

struct RegisterRegionInput
  - regionId: string
  - chunkRange: ChunkRange
  - endpoint: string
  - capacity: int32
  - apiKey: string

struct ChunkRange
  - x0: int32
  - x1: int32
  - z0: int32
  - z1: int32

struct RegionLease
  - regionId: string
  - heartbeatIntervalMs: uint64
  - worldTime: uint64

struct HeartbeatInput
  - regionId: string
  - load: float
  - tickJitterMs: float
  - entityCount: uint64

struct HeartbeatAck
  - ok: bool
  - migrations: []MigrationOutcome  # outcomes for this region's pending migrations
  - registryVersion: uint64         # bump to re-fetch chunkRange map

struct BeginMigrationInput
  - opId: string
  - entityId: string
  - fromRegion: string
  - toRegion: string
  - entityState: any                # serialized ECS state (JSON, Zod-validated)
```

To be validated against webrpc codegen (TS client/server) in slice A.

## 9. Validation boundary

Every adapter, without exception:

1. Authenticate the caller (region API key).
2. Parse the transport payload into the Zod schema for the op
   (`.strict()`, bounded lengths — same rules as gateway auth).
3. Sanitize (trim, normalize ranges, reject chunk ranges that overlap
   another live region's range on register).
4. Call the core with the *parsed* value, never the raw payload.

Rate-limit per region (shared with the same limiter discipline as the
gateway). Validation failures are logged without payloads.

## 10. Deployment topologies

- **Single-box dev:** 1 world process + N region processes, webrpc over
  localhost. Or later: embedded stub, world core in-process.
- **Single-box stress:** same as dev, N swept upward (in-memory store
  keeps the DB out of the measurement). The number is the deliverable.
- **Later:** world on its own box, regions elsewhere; the core doesn't
  change — only the SurrealDB connection string.

## 11. Stress harness (acceptance)

Headless regions (in-process gateways or child processes — to be
decided in the slice; child processes are more honest), scripted
clients that wander across borders on purpose, driving migrations.

Measured per N (regions on one box):

- webrpc p50/p99 per op (register, heartbeat, begin/commit migration).
- Migration success rate and end-to-end duration.
- Region tick jitter (does the 30 Hz loop degrade as N grows?).
- World process CPU/mem.

Stop condition: p99 migration > 500 ms sustained, or tick jitter >
8 ms on any region, or world CPU > 80% sustained. The reported result
is "N regions per micro server before degradation."

## 12. Build phases

- **Slice A — core + registry.** `WorldCore`, SurrealDB schema (region,
  op_dedup), Express shell, webrpc adapter (codegen validated), Zod
  edge validation, region API-key auth, `WorldClient` +
  `WebrpcWorldTransport` in engine-core, register/heartbeat/
  deregister, stale-region reaping. No migration yet.
- **Slice B — migration.** `migration` table, begin/commit/abort,
  border detection in the region, client reconnect-to-B flow,
  world-scoped session tokens, failure paths, tests for every path
  (commit, timeout-expiry, region death mid-migration).
- **Slice C — accounts move.** CSV → SurrealDB `account` table,
  gateway validates via world (cached), register/login flows unchanged
  on the wire.
- **Slice D — harness + number.** Build the stress harness, run the
  sweep, publish the number, record it in DECISIONS.
- **Later:** queue consumer adapter, embedded stub adapter, global
  services (chat/mail/auction/leaderboards), remote-SurrealDB
  graduation.

## 13. Open questions (validate early, not late)

1. ~~SurrealDB WASM embedded in Node: confirm file-backed durability
   (not just in-memory) and measure write throughput for the migration
   table before slice B depends on it.~~ **RESOLVED 2026-09-27: WASM is
   a dead end in Node.** The `surrealdb` npm package (2.0.8) is
   remote-only; embedded engines live in `@surrealdb/wasm`, which (a)
   only offers `mem` (memory-only) and `indxdb` (browser-only) — no
   file-backed durability, and (b) doesn't even ship the `.wasm`
   binary (it expects `../wasm/surrealdb_bg.wasm` relative to dist,
   and `connect('mem://')` hangs in Node). Verdict: the world server
   talks to a SurrealDB **server binary** over `ws://`
   (`WORLD_DB_URL`, default `ws://127.0.0.1:8000/rpc`), with an
   in-memory `MemoryWorldStore` (`WORLD_DB_URL=mem:`, the default) for
   zero-config dev and the stress harness. Durable local dev:
   `npm run world:db` (needs the `surreal` binary on PATH —
   SurrealDB v3, `surreal start ... rocksdb:./data/surrealdb`;
   v3 dropped the `file:` backend).

   **SDK result shapes (verified live 2026-09-27, `surrealdb@2.0.8`
   against server v3.2.4 over ws://):** `db.query()` returns one entry
   per statement — NOT a flat row array. Each entry is the statement's
   result: an array of rows normally, or the single unwrapped value for
   `... ONLY ...` (`null` when nothing matched). `src/surreal-store.ts`
   unwraps accordingly (`singleRow` / `rowList`). Also note SurrealQL
   has no `RETURN BEFORE <field>` projection — use `RETURN BEFORE` and
   project in JS.

   **Durability proven live 2026-09-27:** world server on SurrealDB
   (v3.2.4, rocksdb) — register region, kill -9 the world server,
   confirm the region record + token hash still in SurrealDB with no
   server running, restart the world server, heartbeat with the
   pre-restart bearer token → 200, registry version preserved.
   Bearer tokens survive world-server restarts; the stale-region
   reaper (not crashes) is what revokes dead regions.
2. ~~webrpc TS codegen ergonomics: generate once, check the client/server
   shapes fit `WorldTransport` cleanly.~~ **RESOLVED 2026-09-27:** no
   Go toolchain and no npm-distributed webrpc-gen in this environment
   (api.github.com unreachable from the sandbox, so the release binary
   couldn't be fetched either). The adapter pair
   (`src/adapters/webrpc.ts` + engine-core `webrpc-transport.ts`) is
   hand-authored to the documented webrpc JSON wire protocol
   (`POST /rpc/World/<Method>`, `{"code","msg"}` error envelope) and
   `world.ridl` remains the contract source of truth — regenerating
   with `webrpc-gen -schema=world.ridl -target=typescript` must be a
   drop-in replacement.
3. Harness fidelity: child processes vs in-process regions — decide in
   slice D based on how honest the numbers need to be.
4. Chunk-range allocation: static config for slices A–B; dynamic
   rebalancing is explicitly out of scope until the number is known.
