# Batched character-state writes — store layer (2026-10-28)

Directive (Joey): "We should be batching OPs to maximize MX ops."
This slice batches the save-sweep write path at the store layer, on
top of the SurrealMX adoption (`docs/SURREALMX-ADOPTION-REPORT.md`).
Branch: `arlo/surreal-mx` (local; not pushed).

## What was wrong

On current main, `putCharacterState` and `putCharacterLock` were
still check-then-write — SELECT, then UPDATE or CREATE: **2 store
round trips per record**. (The single-statement conversion from the
2026-10-27 throughput slice never landed on main.) A region saving
N characters paid 2N queries before any core-side ceremony.

## What changed

- `putCharacterState` / `putCharacterLock`: one `INSERT ... ON
  DUPLICATE KEY UPDATE` statement over the unique characterId index
  (the UPSERT pattern the SurrealDB performance best-practices doc
  prescribes). The update clause rewrites every mutable field, so
  the statement stores the record verbatim — identical semantics,
  one query instead of two.
- New `WorldStore.putCharacterStates(records[])`: the records'
  upserts ride **one `db.query()` per chunk of 256 statements**
  (indexed parameters, the same multi-statement idiom
  `applyPendingCredits` already uses). MemoryWorldStore implements
  it as a loop, so the shared contract covers both stores.
- The SDK's array form (`db.upsert(table, records[])`) was tried
  first and rejected on measurement: it errors against this
  SDK/engine combination ("Cannot execute UPSERT statement using
  value: 'character_state'") — the multi-statement query is also
  the form whose semantics we verified record-by-record.

## Measured [sandbox: 2 vCPU, Node v24.22.1, embedded SurrealMX]

Raw-statement forms, 500 records, realistic character payloads:

| Form | Rate |
|---|---|
| Check-then-write per record (old main) | 825 recs/s |
| Single upsert per record | 1,476 recs/s |
| Batched upserts, one query | 3,278 recs/s |

Through the real store (`bench-batch.mjs`, 500 records):

| Path | Fresh | Repeat |
|---|---|---|
| Sequential `putCharacterState` | 1,504 recs/s | 2,128 recs/s |
| Batched `putCharacterStates` | 4,561 recs/s | 4,737 recs/s |

So the batch is ~2.2–3.0× the (already improved) sequential upsert
and ~5.5× the old main write path. Sandbox numbers are a floor: the
box, not MX, is the ceiling here; MX's headroom shows on hardware.

![Character-state write forms compared](../../docs/batch-writes.png)

## Verification

- New contract file `test/batch-writes.test.ts` (both stores):
  mixed new/existing batch lands verbatim, a 600-record batch
  (crossing the 256 chunk) lands completely, empty batch is a
  no-op, single put/lock create-then-overwrite regression cover.
- World-server suite: **123 tests — 122 pass / 0 fail / 1 skip
  embedded; 123 / 123 against the live SurrealMX 3.3.5 server.**
- Correctness of the batched form was additionally verified
  record-by-record in a standalone probe before implementation
  (insert batch, then a mixed update/insert batch, read back exact).

## Designed next (not in this commit)

The store batch is the engine; routing live saves into it is the
follow-on slice, already designed:

1. Store batch reads (`getCharacterStates` / `getCharacterLocks` /
   `getOpResults` by id list) + batched `storeOpResults`, so the
   core ceremony runs in ~3 round trips per sweep instead of ~6
   per character.
2. `WorldCore.putCharacterStates` bulk op with **per-record
   outcomes** (one fenced record must not sink the batch),
   a `world.putCharacterStates` webrpc method, and the engine-core
   client method to match.
3. A coalescer in `WorldCharacterSync.save`: saves are
   event-driven from the gateway, so prepared puts collect over a
   short window and flush as one bulk op (logout's final commit
   forces an immediate flush). Per the best-practices doc, one
   query uses about one core — the flusher keeps a small bounded
   concurrency of independent batches rather than one serial queue.
