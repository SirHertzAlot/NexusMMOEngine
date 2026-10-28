# Edge / core split: measured results (E5)

Numbers for [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) slice E5. Each
benchmark appends a dated section; run them all with `npm run bench:e5`.
Budgets: B1 p99 < 1 ms added by the hop; B3 pushes add < 0.5 ms mean per
tick; B4 encode p99 < 5 ms. B2 is flagged if p99 > 10 ms at 100 clients.
B5 records timings without pass/fail; B6 asserts stability.

## B1: Extra-hop latency (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

10000 `player.intent` packets, one at a time, to a core process with 1000 moving entities ticking at 30 Hz. Edge ingress to egress, ms:

| Path | p50 | p95 | p99 | max |
|---|---|---|---|---|
| core-bound (`player.intent`, through the channel) | 0.08 | 0.4509 | 1.0997 | 45.0621 |
| local (`ping`, no hop) | 0.005 | 0.0141 | 0.03 | 1.571 |

10000 of 10000 intents accepted by the core. The whole core-bound time is counted against the budget (the hop plus the core's handling), so the budget is met if that p99 is under 1 ms: **BREACH** (p99 1.0997 ms).

## B2: Channel throughput (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

Concurrent channel clients, each with one `player.intent` in flight, for 30 s against a core process that answers at once. Latency is request to answer, ms.

| Clients | req/s | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 10 | 62686 | 0.1204 | 0.344 | 0.7183 | 26.452 |
| 50 | 61356 | 0.6506 | 1.6877 | 2.8097 | 56.046 |
| 100 | 64212 | 1.3184 | 3.1218 | 4.3821 | 35.599 |

p99 stays under 10 ms at 100 clients. Baseline only; no budget.

## B3: Tick overhead of pushes (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

1000 moving entities, 1000 measured ticks after 100 warm-up, same seed, ticks driven back to back. Tick time, ms:

| Pushes | mean | p50 | p99 | max |
|---|---|---|---|---|
| disabled | 0.5857 | 0.5291 | 1.439 | 4.5675 |
| enabled (1 edge connected) | 1.1045 | 0.9625 | 2.7753 | 6.2839 |

Added mean per tick: **0.5188 ms** (budget < 0.5 ms): **BREACH**. The edge received 1100 `tick.delta` pushes.

## B4: Delta bandwidth at scale (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

Every entity moves every tick, so every delta carries all of them (the worst case). 300 ticks per row. Encode = FlatBuffers bytes to base64, JSON, and the length-prefixed frame.

| Entities | delta frame (mean) | at 30 Hz | encode p50 ms | encode p99 ms | snapshot frame | snapshot encode ms |
|---|---|---|---|---|---|---|
| 1000 | 73.8 KiB | 2213.7 KiB/s | 0.313 | 1.3717 | 125.7 KiB | 2.2382 |
| 5000 | 366.3 KiB | 10988.8 KiB/s | 2.1865 | 3.1942 | 625.7 KiB | 10.0026 |
| 10000 | 731.9 KiB | 21957.5 KiB/s | 4.0736 | 5.8525 | 1250.7 KiB | 14.2628 |

Encode p99 budget < 5 ms: **BREACH** (worst 5.8525 ms).

## B5: Failure drill timings (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

A core process with 1000 entities, the edge at default heartbeat (5000 ms × 3), one player sending `player.intent` every 50 ms throughout.

| Drill | Detect (core marked down) | First `core.unavailable` | Back to up (resync complete) |
|---|---|---|---|
| `kill -9` the core | 0.01 s | 11.9 ms after down | 0.988 s after restart (process boot + first reconnect step) |
| hung core (`SIGSTOP`) | 18.888 s (heartbeat) | 5.047 s after the stop (request timeout) | 1 s after `SIGCONT` |

Blackout: 495 core-bound packets sent, 495 answered (453 with `core.unavailable`), **0 silent hangs**. PASS.

A killed core closes its socket, so the edge knows at once. A hung core is only caught by the heartbeat; until then core-bound packets wait out the 5 s request timeout before answering `core.unavailable`. Whether 15 s detection is acceptable is Joey's call (a config change: `heartbeatMs`, `maxMissed`).

## B6: Soak (2026-10-03)

Machine: Intel(R) Xeon(R) Processor @ 2.10GHz x4, 15.7 GiB, Linux 6.18.44-fc-v64, Node v22.22.0. Commit `fa88b81`.

600 s, 20 players in the world each sending `player.intent` at 5 Hz through the edge, a core process with 1000 moving entities.

| Check | Result |
|---|---|
| Unhandled rejections (edge + core) | 0 |
| `tick.delta` pushes received / gaps in tick numbers | 17975 / 0 |
| Intents sent / accepted / refused / other answers | 59828 / 59828 / 0 / 0 |
| RSS growth, edge | 43.9 MiB (66.8 → 110.7) |
| RSS growth, core | -10.2 MiB (124.8 → 114.6) |

**PASS** (no unhandled rejections, no dropped deltas, RSS growth < 100 MB each).

## Reading the first run, and follow-ups (2026-10-03)

Three budgets were breached, all narrowly, and all by the same cost: the
mirror stream is sent as JSON with the FlatBuffers bytes inside as base64.

- **B4 (encode p99 5.85 ms at 10k entities, budget 5 ms).** Base64 adds a
  third to every delta and `JSON.stringify` then copies the whole string.
  At 5k entities it is inside budget (3.2 ms).
- **B3 (pushes add 0.52 ms a tick at 1k entities, budget 0.5 ms).** The
  same encode on the tick thread, once per tick.
- **B1 (core-bound p99 1.10 ms, budget 1 ms).** The median is 0.08 ms; the
  tail is requests that land while the core is busy ticking and encoding
  pushes on the same event loop (max 45 ms). A trial run of the same bench
  earlier the same day measured p99 0.70 ms, so this one sits on the line.

B6's edge RSS rose in the first three and a half minutes (67 → 110 MB)
and then held flat at 110 MB for the remaining six and a half: warm-up,
not a leak. The core's RSS ended lower than it started.

Proposed follow-up slices (not done in E5, which only measures):

- **E5a. Binary mirror frames.** Give the channel a binary frame kind
  (a type byte after the length) and send `tick.delta` and `snapshot` as
  raw FlatBuffers bytes with the tick in a fixed header: no base64, no
  JSON. Expected to clear B4 and B3, and to shorten B1's tail. Re-run
  B1, B3 and B4 after.
- **E5b. Encode off the tick.** If B3 is still over after E5a, move the
  push encode and write to a microtask after the tick's broadcast so it
  does not count against the tick (it still shares the thread).
- **Heartbeat (B5, no change made):** a hung core is caught in about 19 s
  at the defaults (5 s × 3, plus the partial first interval). Tightening
  is a config change, `heartbeatMs` and `maxMissed`, for Joey to decide.

## B3: Tick overhead of pushes (2026-10-20)

Machine: AMD EPYC 9D25 126-Core Processor x2, 7.7 GiB, Linux 7.0.0-39-generic, Node v24.20.0. Commit `8a578f2`.

1000 moving entities, 1000 measured ticks after 100 warm-up, same seed, ticks driven back to back. Tick time, ms:

| Pushes | mean | p50 | p99 | max |
|---|---|---|---|---|
| disabled | 0.632 | 0.5471 | 1.1088 | 17.3995 |
| enabled (1 edge connected) | 0.9842 | 0.7473 | 3.6071 | 16.5956 |

Added mean per tick: **0.3522 ms** (budget < 0.5 ms): **PASS**. The edge received 920 `tick.delta` pushes.

## B4: Delta bandwidth at scale (2026-10-20)

Machine: AMD EPYC 9D25 126-Core Processor x2, 7.7 GiB, Linux 7.0.0-39-generic, Node v24.20.0. Commit `8a578f2`.

Every entity moves every tick, so every delta carries all of them (the worst case). 300 ticks per row. Encode = FlatBuffers bytes to base64, JSON, and the length-prefixed frame.

| Entities | delta frame (mean) | at 30 Hz | encode p50 ms | encode p99 ms | snapshot frame | snapshot encode ms |
|---|---|---|---|---|---|---|
| 1000 | 73.8 KiB | 2215 KiB/s | 0.1554 | 2.0839 | 125.7 KiB | 2.4978 |
| 5000 | 366.3 KiB | 10989.9 KiB/s | 0.9321 | 11.738 | 625.7 KiB | 6.679 |
| 10000 | 732.0 KiB | 21958.8 KiB/s | 1.7661 | 12.8834 | 1250.7 KiB | 16.1394 |

Encode p99 budget < 5 ms: **BREACH** (worst 12.8834 ms).

## B7: Interest bandwidth (2026-10-23)

Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz x12, 15.7 GiB, Windows_NT 10.0.26200, Node v25.9.0. Commit `3922c955`.

50 sessions over the edge channel, placed like the entities; every entity moves every tick. 300 ticks after 30 warm-up (includes the periodic snapshot tick). Mode `global` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 |
|---|---|---|---|---|---|---|---|---|
| global | spread | 1000 | 55.3 KiB | 55.2 KiB | 9.84 | 19.23 | 3547.0 KiB | 3534.5 KiB |
| global | spread | 5000 | 274.6 KiB | 273.9 KiB | 64.06 | 91.5 | 17583.7 KiB | 17534.5 KiB |
| global | towns | 1000 | 55.3 KiB | 55.2 KiB | 7.86 | 22.14 | 2739.7 KiB | 2724.5 KiB |
| global | towns | 5000 | 274.6 KiB | 273.9 KiB | 47.81 | 73.27 | 13578.8 KiB | 13516.2 KiB |

## B7: Interest bandwidth (2026-10-23)

Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz x12, 15.7 GiB, Windows_NT 10.0.26200, Node v25.9.0. Commit `76046301`.

50 sessions over the edge channel, placed like the entities; every entity moves every tick. 300 ticks after 30 warm-up (includes the periodic snapshot tick). Mode `global` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 |
|---|---|---|---|---|---|---|---|---|
| global | spread | 1000 | 55.3 KiB | 55.2 KiB | 2 | 4.36 | 97.7 KiB | 73.6 KiB |
| global | spread | 5000 | 274.6 KiB | 273.9 KiB | 8.21 | 22.86 | 471.7 KiB | 365.3 KiB |
| global | towns | 1000 | 55.3 KiB | 55.2 KiB | 2.61 | 8.02 | 97.7 KiB | 73.6 KiB |
| global | towns | 5000 | 274.6 KiB | 273.9 KiB | 8.94 | 24.23 | 471.7 KiB | 365.3 KiB |

## B7: Interest bandwidth (2026-10-24)

Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz x12, 15.7 GiB, Windows_NT 10.0.26200, Node v25.9.0. Commit `52f604f4`.

50 sessions over the edge channel, placed like the entities; every entity moves every tick. 300 ticks after 30 warm-up (includes the periodic snapshot tick). Mode `global` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 |
|---|---|---|---|---|---|---|---|---|
| global | spread | 1000 | 55.4 KiB | 55.2 KiB | 1.18 | 3.1 | 97.7 KiB | 73.7 KiB |
| global | spread | 5000 | 274.6 KiB | 273.9 KiB | 5.3 | 16.11 | 471.8 KiB | 365.3 KiB |
| global | towns | 1000 | 55.4 KiB | 55.2 KiB | 1.23 | 3.5 | 97.7 KiB | 73.7 KiB |
| global | towns | 5000 | 274.6 KiB | 273.9 KiB | 5.55 | 22.09 | 471.8 KiB | 365.3 KiB |
| interest | spread | 1000 | 4.9 KiB | 8.2 KiB | 6.21 | 10.41 | 332.7 KiB | 335.5 KiB |
| interest | spread | 5000 | 10.5 KiB | 12.2 KiB | 13 | 21.26 | 706.4 KiB | 707.6 KiB |
| interest | towns | 1000 | 9.8 KiB | 15.5 KiB | 5.78 | 10.29 | 657.9 KiB | 663.6 KiB |
| interest | towns | 5000 | 32.0 KiB | 48.1 KiB | 16.2 | 37.77 | 2134.2 KiB | 2137.3 KiB |

## B7: Interest bandwidth (2026-10-24)

Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz x12, 15.7 GiB, Windows_NT 10.0.26200, Node v25.9.0. Commit `658dc349`.

50 sessions over the edge channel, placed like the entities; every entity moves every tick. 300 ticks after 30 warm-up (includes the periodic snapshot tick). Mode `global` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 | edge assembly ms mean |
|---|---|---|---|---|---|---|---|---|---|
| global | spread | 1000 | 55.4 KiB | 55.2 KiB | 1.73 | 5.43 | 97.7 KiB | 73.7 KiB | 0 |
| global | spread | 5000 | 274.6 KiB | 273.9 KiB | 5.66 | 18.81 | 471.8 KiB | 365.3 KiB | 0 |
| global | towns | 1000 | 55.4 KiB | 55.2 KiB | 1.58 | 4.23 | 97.7 KiB | 73.7 KiB | 0 |
| global | towns | 5000 | 274.6 KiB | 273.9 KiB | 6.41 | 23.12 | 471.8 KiB | 365.3 KiB | 0 |
| interest | spread | 1000 | 4.9 KiB | 8.2 KiB | 9.42 | 22.77 | 228.2 KiB | 230.3 KiB | 1.22 |
| interest | spread | 5000 | 10.5 KiB | 12.2 KiB | 14.46 | 22.77 | 495.6 KiB | 496.4 KiB | 1.335 |
| interest | towns | 1000 | 9.8 KiB | 15.5 KiB | 5.42 | 10.75 | 149.9 KiB | 152.5 KiB | 0.742 |
| interest | towns | 5000 | 32.0 KiB | 48.1 KiB | 17.45 | 63.63 | 450.8 KiB | 454.8 KiB | 1.597 |

## B7: Interest bandwidth (2026-10-24)

Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz x12, 15.7 GiB, Windows_NT 10.0.26200, Node v25.9.0. Commit `0b2614ad`.

50 sessions over the edge channel, placed like the entities; every entity moves every tick. 300 ticks after 30 warm-up (includes the periodic snapshot tick). Mode `global` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 | edge assembly ms mean |
|---|---|---|---|---|---|---|---|---|---|
| global | spread | 1000 | 55.4 KiB | 55.2 KiB | 1.18 | 2.8 | 97.7 KiB | 73.7 KiB | 0 |
| global | spread | 5000 | 274.6 KiB | 273.9 KiB | 4.3 | 14.1 | 471.8 KiB | 365.3 KiB | 0 |
| global | towns | 1000 | 55.4 KiB | 55.2 KiB | 1.08 | 3.13 | 97.7 KiB | 73.7 KiB | 0 |
| global | towns | 5000 | 274.6 KiB | 273.9 KiB | 4.35 | 16.93 | 471.8 KiB | 365.3 KiB | 0 |
