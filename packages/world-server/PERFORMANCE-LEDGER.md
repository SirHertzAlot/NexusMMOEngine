# Ledger path performance — diagnosis and fix (2026-10-26)

Branch: `arlo/persist-ledger-perf` (local; not pushed)
Chart: `docs/ledger-perf.png`
Reproduce: `npm run build && node bench-ledger.mjs 20000` in this package.

## Diagnosis

The Tier-1 ledger path in `SurrealWorldStore` had three O(stream-length)
or O(batch × round-trips) shapes, which together explain the 2026-10-23
soak's numbers (mean ack ~62 events/s; world-head query p50 ~2.1 s under
load):

1. **`appendLedgerEvents` — 2 round trips PER EVENT.** Each event cost a
   point SELECT (idempotency check) plus a CREATE, sequentially. A
   shipper batch of 512 events = 1,024 queries, plus the head scan below.
2. **`getLedgerHead` — full-stream scan per call.** It SELECTed every
   seq in the range and walked contiguity in JS. The shipper polls the
   head every save cycle, so the world tier paid O(stream) per poll —
   and append paid it again per batch. Total work grew quadratically
   over a soak.
3. **`getLedgerEvents` — fine at read time, but the only read shape.**
   Single equality fetch + JS filter (kept deliberately; see "Rejected"
   below). Its cost is the row transfer itself.

## Fix

- `appendLedgerEvents`: one statement per batch —
  `INSERT INTO ledger_event $rows ON DUPLICATE KEY UPDATE seq = seq`.
  The (rangeKey, seq) unique index makes re-appended events no-ops, so
  first-written-wins semantics are preserved (verified: duplicate
  payloads never overwrite) and a seq repeated inside a batch counts once.
- Head: a per-range counter row (`ledger_head` table) advanced by append
  (batch seqs consumed first; earlier out-of-order seqs probed in bounded
  256-wide equality-set chunks — never a range scan, so the SurrealDB
  2.7.0 compound-scan row-drop bug is not reintroduced). `getLedgerHead`
  is a point read; a missing counter is backfilled once by the original
  scan. The fake store already kept its head this way — the two stores
  are now structurally identical here.
- `getLedgerEvents`: unchanged semantics and query shape.

## Measured (embedded SurrealDB via @surrealdb/node, mem://, shared
2-vCPU sandbox; 20,000 events in shipper-sized batches of 512)

| Operation | Before (origin/main) | After (this branch) |
|---|---|---|
| Append throughput | 214–338 ev/s, batch latency growing with stream length (p50 1,485–2,341 ms, last batch 3,253 ms) | 537–919 ev/s, batch latency flat vs stream length within a run |
| Head read @ 20k | 1,133–1,944 ms | 1.1–1.6 ms |
| Re-append duplicate 512-batch | 1,495–2,664 ms | 23.5 ms (quiet-box run) |
| Full recall, 20k events | 642–1,134 ms | ~1,056 ms (unchanged shape) |

Ranges span repeated runs under varying sandbox load; the same-window
A/B pair (baseline re-run with the fix stashed, minutes before the
fixed run) was 214 ev/s vs 537–919 ev/s and head 1,850 ms vs 1.4 ms.
The durable result is structural, not the absolute rate: per-batch cost
no longer scales with stream length, and head reads are O(1). The
remaining append floor is the single multi-row INSERT itself
(~0.25 ms/row including unique-index maintenance on this engine).

## Rejected on measurement

**Paged recall** (`ORDER BY seq` + `LIMIT`/`START`, 500-row pages):
20,000 rows took ~22 s paged vs ~1.3 s single-fetch on the embedded
engine — `START` re-scans the sorted stream per page. Reverted; the
single-fetch form stays. A tail read therefore still transfers the
stream prefix; at 54k events that is a ~2–4 s one-shot at boot, which
the head/append fixes make affordable. Revisit only against a real
2.7.0 server if recall becomes hot.

## Verification

- State-plane store contract extended with a shipper-scale case:
  5,000 events in 512-batches, per-batch head assertions, a duplicate
  batch re-append, full read-back exactly-once and in order — run
  against both the memory and Surreal stores.
- World-server suite: 121 tests, 120 pass, 0 fail (1 skip), including
  state-plane 20/20 with the gap-hold and idempotency cases that
  exercise the head-advance probe path.
- One full-suite assignment failure was observed once mid-work and did
  not reproduce (standalone 16/16; full suite green on re-run) —
  attributed to sandbox load, not this change.

## Caveats / owed

- All numbers are the **embedded 3.x engine**, not the production
  soak's SurrealDB 2.7.0 server. The fix uses only equality predicates
  and the upsert form; re-verification against a live 2.7.0 server is
  owed before this is called production-proven (same posture as the
  soak itself).
- Not yet addressed (next IO candidates): the atomic-op path's per-op
  round trips through core (`getOpResult`/`storeOpResult` plus the
  `fn::*` invocation), and network fan-out, which has never been
  measured with real clients.
