# Durability-verification drill results

Slice: V1 live-SurrealDB + V2 crash drills · branch `arlo/durability-verification` · worktree `~/workspace/wt-verify` · started 2026-10-20 after "Keep working."

Status: **results landed 2026-10-20 ~17:31 UTC** (reported in-chat by the main agent; filed here the same day so they persist with sources instead of living only in a chat message). Integration prep: the new main (`ef0ce1f`, persistence + atomic-operations merge) has been merged into the verification branch as `82b58c8` — origin/main is an ancestor of the verification tip. Landing on main awaits Joey's word (widget pending at 17:54 UTC).

## V1 — live SurrealDB

Results reported 2026-10-20 17:31 UTC.

| Check | Verdict | Evidence |
|---|---|---|
| Real SurrealDB binary runs in the sandbox | ✅ PASS | SurrealDB **2.7.0** ran locally in the sandbox — first live run, not the in-memory fake store. |
| Full world-server suite against the actual Surreal store (P1 contracts, P4 locks, A1 transaction bodies — previously fake-store only) | ✅ **105/105** | The 4 contract suites that used to skip (101 pass / 4 skip on the fake baseline) now execute and pass against live Surreal. P1 state plane, P4 locks, A1 transactions, P5 assignment verified live. |
| New bugs surfaced, with failing contract test as cover | ✅ 1 found, fixed | `185d1cd`: host reports wrote SQL NULL into an `option<float>` SCHEMAFULL field (`shardLoad`), which Surreal v2 rejects outright. Now written as NONE. P5's sidecar reports would have failed against any real deployment. |
| If binary can't run here: documented with evidence, not papered over | n/a — binary ran | — |

## V2 — crash drills

Drill shape (all real processes, real SIGKILL, death verified by exit signal + ESRCH pid probe, not assumed). Ran 4/4 against live SurrealDB **and** 4/4 against the in-memory store. Results reported 2026-10-20 17:31 UTC.

| Drill | Assert | Measured results | Bugs caught |
|---|---|---|---|
| Base: grant legendary via `lootGrant`, kill shard, boot replacement | item exists exactly once; ledger continuous | **time-to-replacement 5.3 s** (honestly includes waiting out the dead shard's lease for the reaper — registering too early returns 409, so the lease window is a real gate); bytes recalled: not reported | — |
| Kill mid-ledger-stream with unacked batches in flight | no loss, no dupes across the stream | **time-to-replacement 5.1 s**; **exactly the 512 acked events replayed, exactly the 88 unacked lost** — loss accounted exactly as specced; bytes recalled: not reported | ✅ `e673c10` — see below |
| Kill mid-trade at the commit step | gold conservation across both characters | **gold conserved to the unit: 200 before, 200 after**; exactly one owner for all 25 items; bytes recalled: not reported | — |
| Zombie writer replaying stale-epoch writes after takeover | stale writes rejected, fencing holds | overwrite and duplicate grant both rejected; world record untouched; bytes recalled: not reported | — |

**The catch of the day** (`e673c10`, commit on the verification branch): the mid-stream drill's recall came back with **511 of 512 committed events**. Isolated to the database itself: SurrealDB 2.7.0's compound scan — `WHERE rangeKey = … AND seq > …` — *silently drops a row* once results pass ~500 (seq 501, every time; the row itself sits intact). One missing event in a long ledger stream is precisely the silent corruption this architecture exists to prevent, and no fake-store test could ever have shown it. Fix: filter the seq predicate client-side in `getLedgerEvents`; a new 600-event contract case guards it — it fails against the unfixed code on live Surreal and passes after. Caught by drill code at `0dfbec4`.

Note: the slice promised per-drill "bytes recalled" alongside time-to-replacement and events replayed; the run-back reported times and event counts but no byte counts — marked not reported rather than assumed.

Convention from the build: any real bug a drill catches gets fixed minimally with the drill as its test (the way the migration race test caught the concurrent character-lock bug in A2).

## Standing caveats

- Native addons are unbuilt in this sandbox, so drills run at the highest real level available (real processes, real HTTP, real DB) — the region's durability stack wired exactly as `server.ts` wires it. A full `server.ts` production boot stays unverified.
- The Surreal SDK's `connect()` has no timeout — it can hang forever against an unreachable server. Robustness follow-up candidate, open.
- Persistence + atomic-operations stack MERGED to main 2026-10-20 as `ef0ce1f` (fast-forward, byte-identical failure set vs pristine main). The verification branch merged origin/main in as `82b58c8`; landing the verification fixes (`185d1cd`, `e673c10`, `0dfbec4`) onto main awaits Joey's word.
- Parked item from the stack, now on main: fleet-auction economics (offline-seller buyouts fail closed; world-settled auctions pay seller FULL price, no 5% house cut — fleet vs standalone economics differ) still awaits Joey's ruling. The drills don't touch it.
