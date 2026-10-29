# Persistence Soak — Results

**Date:** 2026-10-23 (session) · **Code under test:** merged `origin/main` @ `3922c955e44d0d96a6426468b1551cf0979411f2` · **Worktree:** `~/workspace/wt-soak` (fresh worktree of origin/main; nothing committed, pushed, or merged — the only outputs are this document and `soak-chart.png`)
**Chart:** [`soak-chart.png`](soak-chart.png) · **Prior context:** [`DRILL-RESULTS.md`](DRILL-RESULTS.md) (2026-10-20)

## Verdict in one paragraph

The state plane (Tier-1 event ledger + Tier-2 snapshots) is exact under sustained load: every crash-drill cycle recovered the full acked state, and the post-mortem read of the preserved world store shows a complete, gap-free, duplicate-free event stream. The economy plane (Tier-1 atomic ops) is also exact while its regions live — 3,200 settled ops, gold conserved to the unit, no item lost or duplicated. **The soak's headline finding is a failure: character takeover after a region crash does not work at the production character-lock TTL (600 s).** The replacement region's login was refused for its entire 45 s deadline because the dead region's lock had ~550 s of TTL left, and the world's lock acquisition checks expiry only — there is no dead-holder eviction for character locks. Fleet failover at production settings cannot start until the dead holder's lock lapses. Details and evidence below; every number is from this session's runs.

## Configuration and methodology

- **Harness:** a soak runner (`soak-runner.mjs`, kept in the worktree) driving the production fleet wiring at service level — the same drill harness as the Oct-20 verification (`packages/engine-core/dist/test/drills/region-child.js` region processes, `WorldClient` over real HTTP to an in-process `WorldCoreImpl` behind the real webrpc router, `SurrealWorldStore` over websockets to a real SurrealDB **2.7.0** on its own port (18041), namespace `mmo_soak`, per-run database). Not a full `server.ts` boot.
- **State load:** one region bursting 600 Tier-1 events + one Tier-2 snapshot per burst, back-to-back, on range `0:100:0:100`, for the whole run.
- **Economy load:** two regions (A: char 1, B: char 2), each seeded 1,000,000 gold. Two fixed item pools of 8 (minted once by `lootGrant`), traded back and forth all run: 32 `tradeCommit`s + reconcile saves per round. Reconcile saves replicate the production save cycle (the region's periodic save is what renews its session lock and heals version drift).
- **Crash cycles:** every 150 s a fresh range gets 600 events; the runner polls the world ledger head until the Tier-1 cap of 512 is acked (that wait is recorded as `timeToAckMs`), then SIGKILLs the region (death verified by exit signal + ESRCH), boots a replacement with a fresh data dir, and asserts the recall imports exactly the acked prefix from the world. Every 3rd cycle also SIGKILLs economy region A mid-load for a takeover test.
- **Locks at production settings:** character `lockTtlMs = 600_000` (the production default, `CHARACTER_LOCK_TTL_MS`) — deliberately unlike the Oct-20 drills' 2 s test TTL, because takeover behaviour is TTL-dependent. This choice is what surfaced the headline finding.
- **Planned run:** 36 min, cycles every 150 s (~14 cycles, ~4 economy kills). **Actual run: 868 s (14 m 28 s), 4 state cycles, 1 economy kill attempt** — see "Early termination" below. Nothing in this document inflates the actual duration or cycle count.

## State plane — measured

| Cycle | Time for 512 events to ack under load | Recovery (SIGKILL → recall complete) | Recall verdict |
|---|---|---|---|
| 1 | 6,983 ms | **4,415 ms** | imported 512 / 512 acked, liveItems 512, source = world |
| 2 | 8,426 ms | **5,419 ms** | imported 512 / 512, exact |
| 3 | 35,002 ms | **12,281 ms** | imported 512 / 512, exact |
| 4 | 9,710 ms | **7,703 ms** | imported 512 / 512, exact |

- Continuous range: 122 bursts launched (73,200 events generated locally); the shipper acks asynchronously, so the durability-relevant number is the world head: **53,248 acked at the last sample (t = 862.6 s)**, mean ack rate **62.2 events/s** across 10 s samples (peak window 143/s).
- **Post-mortem (preserved store, after the run):** final head **54,201** (the state region flushed ~953 more acked events in its final seconds). Full stream read back: **54,201 events, seq-contiguous 1..54,201, no gaps, no duplicates.** Latest Tier-2 snapshot: tick 61,200, 1,176 bytes payload.
- Sampler's world head query under full load: mean 2,230 ms, p50 2,129 ms, max 5,781 ms (this is the in-process core on a contended sandbox — see caveats).
- Peak combined RSS across runner + SurrealDB + 3 region processes: ~1,219 MB.
- Durability failures asserted by any state-plane check: **0**.

## Economy plane — measured

- While both regions lived (t ≈ 14 s → 555 s, ~100 rounds): **3,200 atomic ops settled** per the world ledger — **3,184 `tradeCommit` + 16 `lootGrant`, seq-contiguous 1..3,200** — with **zero op failures, zero rejections, zero grant shortfalls**. Mean settle rate 5.96 ops/s, peak 10 s window 12.8 ops/s (each trade is a round trip through two character records on a loaded box; treat the rate as sandbox-relative).
- **Post-mortem invariants (world records read directly from the preserved store):** gold **1,000,000 + 1,000,000 = exactly 2,000,000** (conserved to the unit across 3,200 ops and a region kill); **16 pool items, each owned exactly once** (char 1: `item-10`…`item-17`; char 2: `item-90`…`item-97` — the round-start configuration); 0 duplicated, 0 missing.
- Char 1's lock in the preserved store: held by `region-a`, epoch 1, `expiresAt` = last renewal + 600 s — i.e. it sat in the store, un-releasable by anyone else, for the full TTL after its holder died (see Finding 1).

## Finding 1 — Character takeover fails at the production lock TTL (the headline)

Timeline (runner clock): cycle 3 requests the economy kill at t = 549.5 s → region A SIGKILLed at t = 555.1 s → replacement region `region-a2` boots and retries char 1's login → **fatal at t = 606.7 s: `login for character 1 refused past deadline: AcquireCharacterLock: character 1 is locked by region region-a`**.

Mechanism (verified in source, `packages/world-server/src/core.ts`, `acquireCharacterLockOnce`): acquisition refuses **purely on `held.expiresAt > now`**. Release is holder-only (graceful logout). The heartbeat/session reaper (`reapStale`) retires region registrations; it does not release character locks. So a crashed region's characters are un-takeover-able until the lock's TTL lapses — at the production default, up to **600 s** from the holder's last renewal (renewal is holder-side on the ~1 s save cycle, so effectively ~600 s from the crash). The replacement's 45 s login deadline never stood a chance.

Consequences, stated plainly:

- The Oct-20 drills could not see this: they ran with a 2 s lock TTL, so a dead holder's lock expired before the replacement finished booting (drill recoveries ~6.5 s).
- This run's state cycles could not see it either: shard recall involves no character lock.
- **Before fleet failover can work at production settings, one of these must change:** takeover must wait/retry beyond the remaining TTL (login budget > 600 s or a retrying login), the TTL must come down (which trades into Finding 3's failure mode), or lock acquisition must learn holder-liveness (e.g. release locks whose region session was reaped). Which tradeoff is right is a design call — the soak's job was to prove the current behaviour, and it is now proven at both TTL ends (see the baseline drills and Finding 3).
- Because the takeover never completed, two planned checks **did not run** in the main run: the post-takeover invariant assertions inside the kill path, and the zombie stale-writer spot-check (gated on the first successful takeover). Their coverage this session comes from the baseline drill 4 (zombie fencing: PASS) and the post-mortem invariant reads above. The harness's economy loop also has no dead-region respawn, so after the failed takeover it retried against the dead handle once a second — **261 incidents total, all downstream of this single failure** (1 takeover throw + 260 retries). That noise is the harness's, not the engine's.

## Finding 2 — A save truncates the world record to the local bag (diag-phase, measured)

Found while shaping the economy load, with a dedicated diagnostic (grant → trade → counterparty report → counterparty save → report → trade back, reading the **world record** at each step):

- After grants + trades, char 2's world record held **30 items**, including the traded item. After char 2's region ran one ordinary reconcile save, the world record held **20 items and the traded item was gone**; the return trade then refused `ITEM_NOT_PRESENT`.
- Mechanism: a save's payload is built from the region's local item-store view. The drill child's bag is 20 slots (`LOOT.bagSlots`); atomic grants settle at the world without consulting local bag capacity, so a world record can legitimately come to hold more than the local store can materialise — and the next save's PUT overwrites the world record with the ≤20-item local view, silently dropping the overflow.
- Scope note (measured, not assumed): single-item flow at production TTL works end to end (the same diagnostic with 1 item passes every step, gold and item verified in the world record at each hop). Production wiring routes grants through the local `ItemService`, which bag-checks before the world op; the drill child's `atomicGrant` path goes straight to `WorldAtomicOps`. So this is a sharp edge where the world tier and the local tier disagree about capacity — worth a decision (reject grants that would overflow the recipient's bag at the world tier, or make saves refuse to shrink a record) before anything drives atomic grants the way the harness did.

## Finding 3 — The TTL is load-bearing at both ends (pilot + baseline evidence, this session)

- **Short TTL under slow ops (pilot, 10 s TTL):** when a 25-op grant round took longer than the TTL on this loaded box (rounds measured 1.5–7.9 s, spiking past 10 s), the holder's lock lapsed mid-stream; renewal raced the expiry, the holder was fenced, and every later op for that character refused `no live world session lock` permanently (the drill child has no re-login path). Pilot totals: 322 op failures — all fail-closed, zero corruption (the same pilot's final invariants were exact: gold 2,000,000, ledger contiguous). Production's defences are the 600 s TTL plus the 1 s save-cycle renewal — which is exactly the configuration Finding 1 shows cannot fail over.
- **Baseline drill 3 (2 s TTL) failed the same way from the other side:** seeding itself (25 sequential grants) outlasted the counterparty's 2 s lock because lock renewal is lazy and holder-side; the first trade refused, fail-closed. Drills 1, 2, 4 passed against live SurrealDB this session (recovery 6,503 ms / 6,539 ms; drill 2 replayed exactly 512 acked events and lost exactly the 88 unacked; drill 4's zombie writes were fenced, loot refused `LOCK_CONFLICT`).
- **Cross-region settlement invalidates the counterparty's version baseline (pilot):** `applySettled` advances only the initiating region's sync versions, so after A settles trades against char 2, region B's next op refuses `VERSION_CONFLICT` until B's save cycle refreshes its baseline (`save()` refreshes before writing and adopts the world version). Deterministic, self-healing via the save cycle — the soak's rounds save before the counterparty initiates, which is the production rhythm. Worth knowing for any future direct-op tooling that skips the save cycle.

## The 54,201-event recall — an open scale question

Post-mortem, a fresh region's recall of the full continuous-range stream **did not complete within 900 s** (the child was still waiting at timeout; its world server had exited with the timed-out script, so its end-state CPU tells us nothing about its progress during the window). Completed recalls this session bound the working range: 512 events ×4 in-run (4.4–12.3 s each, under load), and full-stream recalls of **10,752** and **13,824** events in the pilot runs (imported == head, source = world, diverged = false). Whether recall between ~14 k and 54 k events merely gets slow or stalls somewhere is uncharacterised — flagged here rather than smoothed over. The world-side stream itself is verified complete and contiguous (above), so this is a recall-path scale question, not a durability loss.

## Early termination — disclosed

The run was planned for 36 min and **ended at 868 s when the sandbox runtime killed the detached process group** (the same behaviour the preview server's watchdog exists to absorb; the runner's last log lines are routine, no engine process crashed, and SurrealDB's on-disk state survived intact — which is what made the post-mortem verification possible). Rather than silently restart and stitch two runs together, the results above are reported for the 868 s that actually ran: 4 of ~14 planned state cycles and 1 of ~4 planned economy kills. A longer re-run with a watchdog-supervised runner would add more cycles of the state-plane result; it would not change Finding 1, which is deterministic at the production TTL.

Two earlier attempts were stopped by me, not by the engine: attempt 1 (no mid-round reconcile saves → the Finding 3 version-baseline refusals) and attempts 2–3 (unbounded inventory growth → the Finding 2 truncation). Their measurements are used above only as labelled pilot/diag evidence.

## Caveats

- **Shared, virtualised sandbox.** Other tasks' workloads ran concurrently at times; the box is ~2 vCPU class. Absolute timings (recovery seconds, ops/s, the sampler's 2.1 s p50 head query) are inflated and sandbox-relative — the invariants, orderings, and failure modes are the durable results, not the wall-clock figures.
- **Service-level wiring.** Regions are the drill-harness children against an in-process world core (real router, real store, real SurrealDB) — not a full production `server.ts` fleet boot. Live two-region character **migration** (handoff between two live regions) remains explicitly out of scope and unproven; this run tested crash takeover, which failed for the lock reason in Finding 1.
- The economy load used fixed pools inside the drill child's 20-slot bag (production geometry per Finding 2) and one item definition; it does not exercise vendor/auction/craft op types (covered by the atomic-ops test suites, not by this soak).
- Prior context, for comparison only — **not** this run's numbers: on 2026-10-20 the crash drills passed 4/4 and the world-server suite passed 105/105 against live SurrealDB 2.7.0 (`DRILL-RESULTS.md`).

## Raw data

- Run artefacts (samples, events, logs, preserved SurrealDB data dir): `~/workspace/.jarvis/idea-executions/0e692bb4-d5af-42e4-913e-d8c613d19aa8/scratch/soak-main/` (aborted attempts alongside as `soak-aborted-1/2/3`).
- Harness: `~/workspace/wt-soak/soak-runner.mjs` (+ `diag.mjs`, `diag2.mjs`, `postmortem*.mjs`) — untracked files in the soak worktree, left in place for re-runs.
