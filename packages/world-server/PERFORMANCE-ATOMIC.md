# Atomic-op dedup fold — op-result dedup inside the fn transaction (2026-10-27)

Branch: `arlo/atomic-dedup-fold` (stacked on `arlo/surreal-store-throughput`
and `arlo/persist-ledger-perf`; local, not pushed)
Chart: `docs/atomic-dedup.png`
Reproduce: `npm run build && node bench-atomic.mjs` in this package
(embedded engine; `WORLD_BENCH_URL=ws://127.0.0.1:8000 node bench-atomic.mjs`
against a live server). Race proof: `node verify-dedup-race.mjs` against a
live SurrealDB 2.7.0 (`surreal start --user root --pass root --bind
127.0.0.1:8000 memory`).
Slices 1–2: `PERFORMANCE-LEDGER.md`, `PERFORMANCE-STORE.md`.

## Diagnosis

Every atomic op (tradeCommit, vendorTransact, auctionSettle, craftExecute,
lootGrant, inventoryMutate) paid for its idempotency **outside** the
operation: the core wrapped each store call in a dedup bracket —
`getOpResult(opId)` before, `storeOpResult(opId, outcome)` after — for
**4 store round trips per op** end-to-end (plus the fn invocation and
runAtomic's read batch). Slice 2 measured that bracket at ~2.2 ms/op.

Worse than the cost, the bracket was a **correctness gap**:

- The dedup record was written *after* the op committed, in a separate
  call. A crash between commit and record left a committed op with no
  dedup row; a retry then re-applied it (or died on a version fence
  instead of replaying the outcome).
- `storeOpResult` was CREATE-only with **no unique index** on
  `op_dedup.opId`, while `getOpResult` read with `SELECT ... ONLY`.
  Two concurrent submissions of the same opId could both miss the
  pre-check, double-apply, and double-record — after which every
  later `ONLY` read on that opId errors.

## Fix

Dedup moved **into** the atomic functions, restoring the persistence
design rule *one op = one WorldStore call = one DB transaction*:

- The six functions are versioned by name (`fn::<op>_v2`) — `DEFINE
  FUNCTION IF NOT EXISTS` would keep the old 5-parameter bodies on
  existing databases — and take `$op_id` / `$op_name` parameters.
- Inside its own transaction, the fn first checks `op_dedup` for the
  opId and returns the recorded envelope if present; otherwise it
  applies the effects and **inserts the outcome envelope into
  `op_dedup` in the same transaction**. Commit and dedup record are
  now atomic: there is no crash window and no double-record.
- `runAtomic`'s dedup read rides its existing read batch (no extra
  round trip on the success path: **2 round trips per op**, down
  from 4). On an fn abort, the store re-reads dedup and replays the
  winner's outcome; only a genuine conflict is recorded as one.
  Rejections are recorded on their cold path, preserving the old
  stored-rejection replay semantics exactly.
- A UNIQUE index `idx_op_dedup_op` on `op_dedup.opId` is defined
  best-effort in `connect()` (warn, never block boot) so a legacy
  database already holding duplicate opIds cannot fail startup.
- The core's bracket is gone (six call sites); the fake store
  self-dedups via its ops map so contract tests exercise the same
  semantics on both stores. The ~10 non-atomic core procedures that
  also used get/storeOpResult (migrations, locks, credits, dungeon)
  are untouched — they keep the old helpers.

## Measured

`tradeCommit` through the full core → store → fn path, gold ping-pong
on one character pair, fences tracked locally. Before =
`arlo/surreal-store-throughput` (52099641), after = this branch,
same window, same sandbox (2 vCPU).

| Workload | Before | After | Gain |
|---|---|---|---|
| Fresh op, sequential — embedded 3.x (mem://) | 111–115 ops/s (8.7–9.0 ms/op) | 207–212 ops/s (4.7–4.8 ms/op) | **~1.9×** |
| Replay, same opId — embedded | 146–160 ops/s (6.2–6.9 ms/op) | 540–618 ops/s (1.6–1.9 ms/op) | **~3.8×** |
| Fresh op, sequential — live SurrealDB 2.7.0 | 140 ops/s (7.12 ms/op) | 209 ops/s (4.79 ms/op) | **~1.5×** |
| Replay, same opId — live 2.7.0 | 274 ops/s (3.65 ms/op) | 521 ops/s (1.92 ms/op) | **~1.9×** |

Embedded figures are ranges across four runs per side; live figures
are one run per side. The replay path gains most: a retry no longer
pays a standalone pre-check round trip plus a parse of the full
stored envelope through a separate call — and under a retry storm,
replays are the traffic that matters.

## Verified

- Contract tests (atomic-ops + define-functions): **29 pass / 0 fail /
  1 skip** embedded (the skip is the live-DB rollback test); **30/30**
  against live 2.7.0, including *THROW inside fn::trade_commit_v2
  rolls back the whole invocation*.
- Full world-server suite: **120 pass / 0 fail / 1 skip** (embedded,
  identical to the pre-fold baseline) and **121 pass / 0 fail /
  0 skip** against live SurrealDB 2.7.0 — slices 1 and 2 included,
  which closes their owed live re-verification at the contract level.
- Race script vs live 2.7.0 (**12/12 checks**): a sequential duplicate
  replays byte-identically with exactly one `op_dedup` row; **16
  concurrent submissions of one opId apply exactly once** — all 16
  callers receive the winner's identical outcome, gold conserved,
  the item moves once, one dedup row, ledger exact (4 + 2 entries).

## Caveats and the honest limits

- All numbers are this sandbox (2 vCPU, loopback / in-process). They
  compare the two code paths against each other; they are not a
  production throughput claim. The store-level write ceiling measured
  in slice 2 (~2.7k writes/s on this box) is unchanged by this slice.
- **Concurrent independent op streams still serialize.** Every atomic
  op takes a contiguous range from one shared ledger sequence
  counter, so parallel trade streams against one store abort each
  other with VERSION_CONFLICT faster than callers can retry (observed
  while building this bench: 8 pairs × 25 ops starved a caller past
  100 jittered retries, identically before and after the fold). The
  fold does not touch sequence allocation, and production regions
  serialize op submission per region, so nothing regressed — but the
  global sequence is a real serialization point for value-moving ops
  across regions sharing a store, and it is the next honest target if
  cross-region op concurrency ever becomes the bottleneck (candidate
  shapes: per-range sequence spaces, or batched sequence allocation).
- Embedded-engine numbers come from SurrealDB 3.x; production runs
  2.7.0, which is why both are reported.
