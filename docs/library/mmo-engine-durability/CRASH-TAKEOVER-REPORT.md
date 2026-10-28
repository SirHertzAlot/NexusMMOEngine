# Crash Takeover — Dead-Region Character-Lock Release

**Date:** 2026-10-25 · **Branch:** `arlo/dead-region-lock-release` (LOCAL only — not pushed, no PR) · **Base:** `origin/main` @ `11d4384051406943bc806a98142345f4d2950beb`
**Commits:** `5fc2743f` "Release dead regions' character locks on reap" · `f90690a5` "Prove crash takeover at production lock timing"
**Prior finding:** [`SOAK-RESULTS.md`](SOAK-RESULTS.md) Finding 1 (2026-10-23)

## Verdict in one paragraph

Character takeover after a region crash now works at the production 600 s lock TTL. When the world server's stale-region reaper confirms a region is dead, it releases exactly that region's character locks in the same sweep, so a replacement takes over at the heartbeat-timeout timescale (~15 s) instead of waiting out the lock (~600 s). Measured end-to-end below on three store setups — in-memory, embedded SurrealDB, and a real external SurrealDB 2.7.0 server: crash → takeover completed in **15.0–15.4 s** in every run, with the stranded lock still holding **>599.7 s** of TTL at the moment of the crash. Live regions' locks are provably untouched (control case in the same test).

## What was broken

From the 2026-10-23 soak (Finding 1, verified in source at the time): `acquireCharacterLockOnce` refuses purely on `held.expiresAt > now`; character-lock release is holder-only; and `reapStale()` retired dead region registrations without releasing their character locks. A crashed region's characters were therefore un-takeover-able until the lock TTL lapsed — at the production default, up to 600 s from the holder's last renewal. The soak's replacement login was refused for its entire 45 s deadline with ~550 s of TTL remaining. The Oct-20 drills could not see this because they ran at a 2 s lock TTL.

## The fix (commit `5fc2743f`, `packages/world-server` only)

- **`WorldStore.deleteCharacterLocksByRegion(regionId): Promise<number[]>`** — new store-interface method (src/types.ts): delete every character lock held by the named region, return the released character ids.
  - `MemoryWorldStore` (src/fake-store.ts): scans the lock map, deletes only entries whose `regionId` matches, returns the ids sorted.
  - `SurrealWorldStore` (src/surreal-store.ts): one statement — `DELETE character_lock WHERE regionId = $region RETURN BEFORE` — returning the deleted ids sorted.
- **`WorldCoreImpl.reapStale()`** (src/core.ts): after `reapStaleRegions` returns the regions it confirmed stale, the core calls `deleteCharacterLocksByRegion` for each reaped region, in the same sweep (before the host-report reap and the registry-version bump).
- **Nothing else changed.** `acquireCharacterLockOnce` (expiry-only refusal for live holders), holder-only `releaseCharacterLock`, epoch issuance/fencing, and the TTL itself are byte-identical to before. No character state, inventory, gold, or any other player data is touched — the only rows deleted are the dead region's lock rows.

Safety shape: the release is keyed off the reaper's output list, not off lock age or holder identity, so there is no path by which a live region's lock can be released by this code — a region only appears in that list after its heartbeat has been silent past the timeout and its registration has been deleted.

## The proof (commit `f90690a5`, `packages/world-server/test/crash-takeover.test.ts`)

A repo test at **production timing — no shortened values**:

| Setting | Value | Source |
|---|---|---|
| Character-lock TTL | **600,000 ms** | production `CHARACTER_LOCK_TTL_MS` |
| Heartbeat timeout (dead-region detection) | **15,000 ms** | production `WORLD_HEARTBEAT_TIMEOUT_MS` default |
| Reaper sweep interval | **5,000 ms** | production server formula `max(1000, timeout/3)` |

Scenario per store: `region-dead` holds character 101 and `region-live` holds character 202, both at 600 s TTL, both with character state written. `region-replacement` is registered and live. Then region-dead "crashes" — it simply stops heartbeating, which is exactly the input dead-region detection consumes (this is a core-level test: no separate region process is SIGKILLed; the soak already proved the process-crash side). While the dead region is merely silent, the replacement's takeover attempt on 101 is **refused 409**, and its attempt on the live region's 202 is **refused 409**; a foreign release attempt on 202 is **refused 403**. The live and replacement regions keep heartbeating; the test sweeps `reapStale()` every 5 s until it reaps exactly `["region-dead"]`, then asserts the dead lock is gone, the live lock is byte-identical, a further takeover attempt on 202 is still **409**, and the replacement's takeover of 101 succeeds with the lock epoch bumped by 1. Both character records are deep-equal compared before/after: unchanged.

### Measured timelines (actual runs)

| Run | Lock TTL remaining at crash | Crash → detection (reap) | Detection → release (upper bound¹) | Takeover call | Crash → takeover complete |
|---|---|---|---|---|---|
| Memory store (full-suite serial run) | 599,997 ms | 15,004 ms | ≤ 1 ms | 0 ms² | **15,005 ms** |
| Embedded SurrealDB (full-suite serial run) | 599,939 ms | 15,020 ms | ≤ 4 ms | 7 ms | **15,035 ms** |
| External SurrealDB 2.7.0 server (targeted run) | 599,705 ms | 15,168 ms | ≤ 71 ms | 94 ms | **15,350 ms** |

¹ Release happens inside the reap call, so the bound is the final reap call's duration plus the immediate read-back observation. ² Below the 1 ms resolution of the clock used; recorded as 0 ms.

Detection lands at ~15 s because that is the production heartbeat timeout doing its job — the fix removes the *additional* ~585 s of lock-TTL wait that used to follow it. Takeover completes ≈ 40× faster than the old behaviour's best case (~600 s).

### Control case

In every run: the live region's lock survived the reap byte-identical; takeover attempts against it were refused 409 both before and after the dead region was reaped; a non-holder release attempt was refused 403; the live region's registration and character record were untouched; the reaped list contained exactly the dead region. Store-contract assertions for `deleteCharacterLocksByRegion` (only the named region's locks deleted, ids returned, second call returns `[]`) were also added to the existing state-plane store contract, which runs against both stores.

## Suite results

World-server suite (`packages/world-server`), measured before and after on this branch:

| Run | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Before (fresh branch, `npm test`) | 121 | 120 | 0 | 1 |
| After, serialized full run (`node --test --test-concurrency=1`) | 123 | 122 | 0 | 1 |

The +2 are the new crash-takeover tests; the failure set is unchanged (empty) and the single skip is unchanged (the live-only define-functions test, gated on an external DB URL in the default suite; the crash-takeover SurrealDB case itself was additionally run against a real external SurrealDB 2.7.0 server process — fresh RocksDB database, ws://127.0.0.1:18042 — and passed, timeline above). Engine-core was not touched and was not re-run.

### Disclosed run notes (not smoothed over)

- **First targeted run of the new test failed on both stores** — a bug in the test, not the fix: the replacement region never heartbeated, so the reaper correctly reaped *it* too, and its later calls failed "unknown region." The test was corrected to heartbeat the live and replacement regions each sweep (as real regions do); all runs above are with the corrected test.
- **Two default-parallelism (`npm test`) full-suite runs after the change showed 3 and then 1 failures**, all in `assignment.test.ts` host-report cases (e.g. "no double-assignment"). These are timing-sensitive pre-existing tests: they use a 1 s host-report freshness window with Argon2 verification on the call path, and under full parallel load the small host's report crosses the freshness boundary mid-scenario. Evidence it is load, not this change: the assignment file passes standalone (16/16), the failures vary between runs (3 → 1 → 0), the failing assertions are all assignment widths, and the full suite passes clean serialized (above). The dead-region change does not touch assignment, host reports, or registration.

## Scope / what this does not claim

- **Local only.** Both commits sit on `arlo/dead-region-lock-release` in `~/workspace/wt-lockfix`; nothing was pushed, no PR was opened or merged, nothing published.
- Takeover still waits for dead-region detection (~15 s at production settings) — by design; this fix removes the lock-TTL wait after detection, it does not make detection instant.
- Live two-region character **migration** (live handoff) is a different path and remains as unproven as the soak left it; this test covers crash takeover only.
- A region that is partitioned but still alive (heartbeating to the world server while unreachable to players) is not "confirmed dead" and its locks are not released — unchanged, deliberate.
