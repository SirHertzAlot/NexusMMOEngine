# World-store write throughput — slice 2: single-statement puts (2026-10-27)

Branch: `arlo/surreal-store-throughput` (stacked on
`arlo/persist-ledger-perf`; local, not pushed)
Chart: `docs/store-throughput.png`
Reproduce: `npm run build && node bench-store.mjs 500` in this package.
Slice 1 (ledger appends + head counter): `PERFORMANCE-LEDGER.md`.

## Diagnosis

After the ledger fix, the store's remaining write paths all shared
one shape: **check-then-write**. Every put first SELECTed the row to
learn whether it existed, then issued a CREATE or an UPDATE — two
round trips where one statement suffices, on tables that already
carry a UNIQUE index on exactly the key being checked:

- `putCharacterState` (per character, per world-tier save)
- `putCharacterLock`, `putShardSnapshot` (per snapshot cycle)
- `putSocialRecord` (three round trips — it reused the getter)
- `upsertRegion`, `upsertHostReport` (SCHEMAFULL tables)
- `issueEpoch` (read-modify-write counter behind range/lock epochs
  and social id allocation)

## Fix

Each put is now **one statement**: `INSERT INTO t $row ON DUPLICATE
KEY UPDATE <mutable fields>` — the unique index routes a repeat put
to the update clause, which sets exactly the fields the old UPDATE
set. `issueEpoch` uses `ON DUPLICATE KEY UPDATE value += 1` and reads
the issued value from the statement's returned row (both forms
verified empirically against the embedded engine before use,
including that a duplicate insert returns the post-update row).

The host-report NONE rule survives intact: the insert row omits
`shardLoad` when undefined, and the update clause writes
`shardLoad=NONE` — never SQL NULL (the v2 SCHEMAFULL trap).

Untouched on purpose: `recordDungeonRun` (its boolean "was new"
return cannot be recovered from an upsert without a marker read),
`applyPendingCredits` (real read-fold-write logic, not a blind put),
and `op_dedup` (no unique index on `opId` today — adding one is a
schema decision, see next steps).

## Measured (embedded SurrealDB via @surrealdb/node, mem://, shared
2-vCPU sandbox; 500 sequential ops per method, before/after minutes
apart on the same box)

| Method | Before | After | Gain |
|---|---|---|---|
| putCharacterState (distinct) | 394 ops/s · 2.54 ms | 1,012 ops/s · 0.99 ms | 2.6× |
| putCharacterState (repeat) | 422 ops/s · 2.37 ms | 1,200 ops/s · 0.83 ms | 2.8× |
| putShardSnapshot (repeat) | 520 ops/s · 1.92 ms | 1,348 ops/s · 0.74 ms | 2.6× |
| putCharacterLock (repeat) | 693 ops/s · 1.44 ms | 1,434 ops/s · 0.70 ms | 2.1× |
| putSocialRecord (repeat) | 663 ops/s · 1.51 ms | 1,245 ops/s · 0.80 ms | 1.9× |
| issueCharacterLockEpoch | 654 ops/s · 1.53 ms | 1,495 ops/s · 0.67 ms | 2.3× |
| upsertHostReport (repeat) | 610 ops/s · 1.64 ms | 1,212 ops/s · 0.83 ms | 2.0× |
| storeOpResult + getOpResult (control, unchanged) | 427 ops/s · 2.34 ms | 448 ops/s · 2.23 ms | — |

The floor is now ~0.7–1.0 ms per statement on this engine — the
per-statement cost itself. What this buys at scale: a 1,000-character
world-tier save sweep costs ~0.8 s of store time instead of ~2.4 s
(serialized equivalent), and snapshot/lock writes stop competing with
ledger appends for the same round-trip budget.

## Verification

World-server suite: **121 tests, 120 pass, 0 fail, 1 skip** —
identical to the pre-change baseline, including the state-plane and
host-report store contracts (both stores), the atomic-ops suite, and
the SCHEMAFULL host-report cases that guard the NONE rule.

## Next steps (measured, not yet built)

- **Op-idempotency tax:** every core atomic op pays a
  `getOpResult` + `storeOpResult` pair around the op itself —
  ~2.2 ms/op measured above. The principled fix folds the result
  record INTO the op's own transaction (the `fn::*` invocation), which
  is also a correctness improvement: today a crash between the op
  commit and `storeOpResult` loses the dedup record. That touches the
  live-proven function layer, so it gets its own slice and its own
  2.7.0 verification.
- **Live SurrealDB 2.7.0 re-verification** of slices 1 + 2 (all
  numbers here are the embedded 3.x engine).
- **Recall under load (B2)** and **network fan-out (B3)** remain the
  open measurements from the roadmap.

## Addendum (2026-10-27): the concurrency curve, and the road from ~2.6k to real headroom

Sequential numbers above are latency, not throughput. A concurrency
probe (putCharacterState, distinct characters, 2,000 ops per level,
embedded engine, quiet box) scales then saturates:

| Writers | Throughput |
|---|---|
| 1 | 1,215 ops/s |
| 4 | 2,586 ops/s |
| 8 | 2,648 ops/s |
| 16 | 2,315 ops/s |
| 32 | 2,179 ops/s |

The embedded instance itself serializes writes internally past ~8
writers — client behavior is no longer the limit there. What is
still missing, in expected-value order:

1. **Deployment shape.** All numbers here are the embedded `mem://`
   engine in a shared sandbox — the floor configuration. Production
   is an external SurrealDB server (own process, RocksDB, many
   connections, several world-core processes). Unmeasured so far;
   the 2.7.0 re-verification doubles as this measurement.
2. **Statement count per logical op.** An atomic op still pays ~4–6
   engine round trips (dedup pair + reads + fn invocation). The
   fn-transaction fold (see Next steps) cuts it to ~1–2.
3. **SQL-string overhead.** The store issues 59 `db.query()` sites
   and zero SDK record-method calls; every statement pays SurrealQL
   parse/plan. Hot puts could use the SDK's direct record RPCs.
4. **Sweep batching.** Character saves can ride one multi-statement
   request per sweep instead of one request per character.

Reality check on the 100,000 mark: that figure (SpacetimeDB's) is an
in-memory engine executing logic in-process with no SQL layer and no
IPC — a different architecture, not a tuning target. Single-node
SurrealDB does not reach 100k durable writes/s under any client
behavior. Our realistic peak demand (1,000 players: saves, Tier-1
bursts, atomic ops) is ~1–3k writes/s — roughly where the embedded
floor already sits, with items 1–4 as the headroom. If a single lane
ever truly needs 100k-class appends, the WorldStore interface is the
seam that lets the Tier-1 ledger alone move to a log-optimized store
while SurrealDB keeps world state.
