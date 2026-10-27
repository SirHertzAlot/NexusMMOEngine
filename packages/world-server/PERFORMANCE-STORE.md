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
