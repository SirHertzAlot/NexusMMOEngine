# Performance and constraints

What the engine costs today, what that means for the game you would build on it, and what you give up by choosing it. Written 2026-11-11 against `main` at `f69dae9b`.

This page is for someone deciding whether, and how, to build on Nexus. It does not sell. Where a number is good it says so, and where a number is a miss it says that too. The measurement logs it draws from are linked, and the detail lives there.

## How to read the numbers

Every figure here has one of three labels:

- **Measured**: a benchmark in this repository produced it. The source and date are given. Most runs used a shared sandbox or a 4-core Xeon at 2.1 GHz, not dedicated hardware, so **trust the ratios more than the absolute milliseconds**, and re-measure on your own hardware before you plan a budget around one.
- **Derived**: worked out from a measured figure or from how the design works. It is reasoning, and it can be wrong.
- **Not measured**: the repository has no data. Say so to yourself before you rely on it.

All the time budgets below are against one tick: **33.3 ms at 30 Hz**.

## The short version

1. **A region is the unit of scale, and one region has a player ceiling that is lower than the stated 1,000-player target.** One region process held 30 Hz at 200 players in the last end-to-end run, finished 86% of its ticks on time at 500, and 43% at 1,000. The design target is 1,000 players and 50,000 entities in one region; the simulation step meets it, the end-to-end tick does not yet. Plan on adding regions, not on one big one.
2. **Adding regions works, and the world server is not what limits it.** One 4-core box ran 16 regions (500 entities and 100 players each) with a p99 tick of 7.5 ms, and every hand-off committed. At 24 regions on that box, ticks ran past a frame because the regions run out of CPU.
3. **The cost at high player counts is mostly sending, not simulating.** At 1,000 players the socket sends cost more per tick than the whole simulation step. Recent work moved fan-out to C++ and cut the 1,000-player mean tick from 157 ms to about 62 to 66 ms. That is a large gain and it is still not inside the budget.
4. **Several of the fastest paths are opt-in.** The shared-memory data plane and send batching are off by default. And **the shape matters**: the fan-out numbers on this page were measured with the core serving players directly. `npm start` runs an edge in front instead, where the per-session work moves into the edge process and runs in JavaScript. Read the next section with that in mind.
5. **It is a server-authoritative design with no client-side prediction.** That suits MMO pacing and is a poor fit for twitch games.

## Where a tick goes

**Fixed step.** The loop is a fixed-timestep accumulator at 30 Hz. A gap of more than 250 ms is clamped, and at most 5 catch-up steps run per frame. Anything beyond that is dropped and counted as a spiral event in telemetry. A region that cannot keep up therefore does not spiral; it loses time and says so. (Source: [wiki 01](wiki/01-architecture-overview.md); measured behavior in the Phase 4 report.)

**The simulation step is cheap.** On the shared-memory data plane, the 30 Hz sim worker ran **51,000 entities (1,000 players plus 50,000 NPCs) at a p99 step of 0.562 ms**, 1.7% of the budget, with no dropped steps, while 1,000 client streams were fed with injected latency and loss. Measured 2026-10-27 ([`DECISIONS.md`](DECISIONS.md), [`CPP-MAIN-TICK-PHASE4-REPORT.md`](CPP-MAIN-TICK-PHASE4-REPORT.md)). That is the simulation only: movement, intents and the native kernels. It does not include sending state to 1,000 sockets.

**The end-to-end tick is not cheap at 1,000 players.** In a sustained 60 s run with 3,000 NPCs, the per-session fan-out dominates. **These runs had the core serving players directly (no edge).** Native fan-out only runs there; behind the edge, which is what `npm start` runs, each session's envelope is assembled in the edge process and the core only encodes each sector once ([`NATIVE-FANOUT.md`](NATIVE-FANOUT.md), [`EDGE-SPLIT-RESULTS.md`](EDGE-SPLIT-RESULTS.md) B7). The repository has no 1,000-session run through the edge; the edge runs below used 50 sessions. Measured 2026-11-03 (PF2 and PF3 in the [roadmap](ROADMAP.md); the results files the roadmap cites are not in the repository):

| Players in one region | Mean tick before native fan-out | After | Ticks finished on time |
|---:|---:|---:|---|
| 200 | 30.6 ms | **16.2 ms** | within budget |
| 500 | n/a | n/a | 42% before, **86%** after |
| 1,000 | 156.7 ms | **66.4 ms** (62.5 ms in a paired run with shared assembly) | **43%** |

What is in that 1,000-player tick, after the work so far ([`NATIVE-FANOUT.md`](NATIVE-FANOUT.md)):

| Piece | Cost | Note |
|---|---|---|
| Assembling each session's delta | 10.3 ms to **0.86 ms** with shared assembly | sessions with identical bytes share one envelope |
| Choosing which names to send | 5.9 ms to **0.77 ms** per tick (PF3) | native, skips sectors a session already knows |
| Socket sends | about **22 ms** | the largest piece now; `ws.send` outside a uWS callback is one syscall each |
| Interest management | about 15% of the profile | native version is a listed follow-up |

**Reading it:** at 1,000 players the simulation is nowhere near the limit and the network fan-out is. The fan-out work still open in the roadmap (the PF2 follow-ups, such as a native `interestEntries`, about 15% of the 1,000-player profile) and the send-batching gate are aimed at exactly this. Binary mirror frames (E5a), dropping the old base64 stream (E5c) and interest management (IM) are done.

## Scaling out: regions

Each region is its own process with its own 30 Hz loop and its own state. A world server keeps the registry and leases and coordinates hand-offs between regions; it never simulates, and player traffic never passes through it.

**Measured** with `npm run stress:world` (2026-10-04, [`WORLD-STRESS-RESULTS.md`](WORLD-STRESS-RESULTS.md)). Setup: 4 cores (Xeon 2.1 GHz), Node 22, an in-memory world store, each region a real gateway at 30 Hz with 500 simulated entities and 100 players crossing region borders constantly.

| Regions on the box | Hand-off p50 / p99 | Region tick p99 | World server CPU |
|---:|---:|---:|---:|
| 1 | n/a | 2.0 ms | 0.4% of a core |
| 8 | 5.3 / 17.1 ms | 4.0 ms | 8.7% |
| **16** | **5.1 / 15.4 ms** | **7.5 ms** | **14.9%** |
| 24 | 6.4 / 26.2 ms | **40.5 ms** | 20.2% |
| 32 | 8.6 / 36.1 ms | **40.5 ms** | 20.8% |

What it says:

- **The limit on a box is region CPU.** At 24 regions, six or more 30 Hz processes share each core and ticks stretch past one frame. The rule of thumb from the run is about **4 regions per core**.
- **Every hand-off committed** at every size, and none was refused.
- **The world server has headroom** (derived: its CPU grew about 0.9% of a core per region, which puts 80% of one core past 80 regions). That was not measured. The next run worth doing puts the world server on its own box with regions spread over several.
- **Starting many regions at once** can make registration time out, because each verifies its API key with argon2. Regions retry with backoff; production regions start one at a time.

**Caution:** the 100 players per region in this run are the harness wandering, and the run does not say how much of each region's fan-out cost they carry. Do not multiply 16 regions by 100 players and treat 1,600 as a capacity number for a real game.

## Network

**Bandwidth is the first thing that grows with entity count.** Interest management is on by default. With it off (`MMO_INTEREST=0`), every client gets the whole region's delta ("global" mode); with every entity moving every tick (the worst case), the delta frame is **74 KiB at 1,000 entities, about 2.2 MB/s per client at 30 Hz**, and scales linearly. Measured 2026-10-20 ([`EDGE-SPLIT-RESULTS.md`](EDGE-SPLIT-RESULTS.md) B4), on the stream as it was then: FlatBuffers bytes inside base64. Binary frames (E5a) and dropping that stream (E5c) have landed since, so expect about a quarter fewer bytes (derived: base64 adds a third), but there is no newer global-mode run in the repository. That is why per-player interest management exists.

**Interest management cuts it hard.** Measured 2026-11-01 on a 4-core Xeon with 50 sessions over the edge channel, every entity moving ([`EDGE-SPLIT-RESULTS.md`](EDGE-SPLIT-RESULTS.md) B7):

| Entities | Layout | Per client per tick (mean / p99) | Core tick mean | Core tick p99 |
|---:|---|---|---:|---:|
| 1,000 | spread out | 1.8 / 3.4 KiB | 7.2 ms | 13 ms |
| 1,000 | clustered in towns | 6.5 / 10.6 KiB | 7.5 ms | 14 ms |
| 5,000 | spread out | 5.6 / 7.0 KiB | 21.6 ms | 33.8 ms |
| 5,000 | clustered in towns | 27.4 / 43.2 KiB | 27.8 ms | 41.9 ms |

With a burst of 100 ground items dropping at once every 30 ticks, the 5,000-entity p99 rises to 59 to 67 ms. **At 5,000 active entities in one region the tick is already near the budget, and bursts push it over.** Crowds are the expensive case: the same 5,000 entities cost five times the bandwidth when they stand in towns.

**Encoding.** The B3 and B4 figures in the edge results log (2026-10-03 and 2026-10-20) measured a mirror stream of FlatBuffers bytes wrapped in base64 inside JSON. Its delta-encode p99 missed the 5 ms budget at 5,000 entities (11.7 ms) and at 10,000 (12.9 ms), on a shared sandbox where some of the tail was noise. **That stream no longer exists**: E5a moved the channel to binary frames, and E5c stopped the core pushing it (the B3 push overhead fell from 0.69 to 0.23 ms per tick at 1,000 entities, median of 7). What costs encode time today is the per-sector delta encoding of interest management, which is inside the "core tick" column of the B7 table above (7 to 28 ms at 1,000 to 5,000 entities, with 50 sessions). A separate "fast-path" codec for position and velocity is **16 to 20 times faster to encode and 3 times smaller** than FlatBuffers in its benchmark, but only covers position and linear velocity; any other change in a tick falls back to the full encoder ([`PERFORMANCE-SAB.md`](PERFORMANCE-SAB.md), 2026-10-20).

**Transport.** uWebSockets.js is the production transport and `ws` is a pure-JavaScript fallback. In the transport benchmark both kept up at 1,000 clients, and at 2,000 clients uWS delivered about 1.8 times the messages `ws` did ([`transport-bench-results.json`](transport-bench-results.json), 2026-10-27). uWS fans out one published message natively: for 1,000 subscribers a `publish` took 0.5 ms against 6.0 ms for a send loop, 12 times faster, and `ws` shows no gain ([`PERFORMANCE-SAB.md`](PERFORMANCE-SAB.md)). **If uWS has no prebuilt binary for your Node and OS you silently get the slower path** (`ws`, with JavaScript fan-out). Check the server's `listening` line and `gateway.fanoutStatus`; [`NATIVE-FANOUT.md`](NATIVE-FANOUT.md) lists which condition gives which path.

**Send batching (opt-in).** `MMO_UWS_CORK=1` batches each session's several messages per tick into one write. In a single run on a shared sandbox with 1,000 clients and three messages per socket per tick, broadcast p50 fell from 37.4 to 15.6 ms, p99 from 150 to 42.6 ms, CPU from 79% to 63%, and delivered messages rose from 57k to 85k a second. Measured 2026-11-10 with `npm run bench:transport -- 1000 --multi` with and without `--cork`, one run each on a shared Codespace, uWS transport (the `ws` control did not change). The feature and its gate are described in [`SEND-PATH-BATCHING-REPORT.md`](SEND-PATH-BATCHING-REPORT.md), which records no performance numbers of its own. It is **off by default**: the gate to turn it on (the whole gateway at 1,000 and 10,000 entities with no ordering failures) has not been run.

## Physics and collision

Physics is Jolt in C++, in-process. The default is one thread.

**Ragdolls are the expensive item.** The question was whether the 30 Hz step could carry a ragdoll for every one of 1,000 players. The answer is no, in one world. Measured ([`RAGDOLL-COST-GATE.md`](RAGDOLL-COST-GATE.md), 2026-11-01), awake full rigs at the engine's tick:

| Rigs | Step time | Share of a tick |
|---:|---:|---:|
| 64 | 5.2 ms | 16% |
| 256 | 25.2 ms | 76% |
| 512 | 63.7 ms | 191% |
| 1,000 | 110 ms (contact cap hit, so not valid physics) | 329% |

The engine's policy is a **4 ms budget per tick** for ragdolls, which admits **48 full rigs or 120 light rigs**. A four-thread pool cut 256 rigs from 25.6 to 13.2 ms (1.9 times), but made 16-rig worlds slower (0.44 to 0.85 times), so threads are opt-in per world and default to one.

**Prop collision** (walkers blocked by trees and rocks) costs about **5.9 M instructions per tick** for 500 props and 100 walkers, and 8.8 M for 5,000 props on a 200 m square. It was 55.9 M before a grid fix on 2026-11-11 ([roadmap PF4](ROADMAP.md)).

## Per-system cost

Instruction counts under Valgrind's callgrind, which are repeatable run to run and independent of the machine's speed. Measured 2026-11-11 on Node 24.21. A count is not a time: use it to compare a system with itself over time and to see relative weight.

| Workload | Instructions |
|---|---:|
| Sim tick, 1,000 entities | 14.0 M per tick |
| Physics step, 200 bodies | 2.4 M per step |
| Crowd tick, 100 agents | 4.4 M per tick |
| Prop collision, 500 props | 5.9 M per tick |
| Prop collision, 5,000 props | 8.8 M per tick |
| Prop bridge (character controllers) | 3.0 M per tick |
| Residents | 3.7 M per second |
| Path batch of 100 | 6.1 M per batch |
| One world chunk (procedural) | 68 k per chunk |
| One dungeon shell | 586 M per shell |
| Channel push | 7.0 M per push |

The stored baseline is from Node 22, so `npm run valgrind:perf` reports its comparison as "not comparable" on Node 24. A re-baseline on one Node version is owed.

## Persistence

- **Region state** lives in an embedded SQLite file (`region.db`) in the region process as a hot cache, with the world server as the source of truth when it is configured. A full snapshot is taken every 300 ticks (10 seconds).
- **The data-plane ledger** (only when `MMO_DATA_PLANE=1`) writes through a separate persistence worker to a durable SurrealMX server (started with `npm run db -w @mmo-engine/world-server`, which needs the `surreal` binary on your path). A benchmark put the tick's p99 under 0.5 ms against the 33.3 ms budget, because the sim only enqueues. **Boot refuses to start if that server is unreachable.**
- **Derived:** between snapshots, state that does not go through the ledger can be lost on a crash, up to about 10 seconds of it. Check which of your state is ledgered before relying on it.
- Batched character writes are about 5.5 times the old path at 500 records (measured in a sandbox, PL6).

## The client

Instanced props draw one call per model, and a model with level-of-detail meshes draws one call per level in use; the client has a quality governor that lowers resolution when frames drop and raises it again. **The repository has no frames-per-second measurements for the player client.** A figure often quoted for WebGL 2 draw-call limits (a few thousand per frame) appears in older docs; it is not measured here.

## Choices and what they cost

| Choice | What you get | What you give up |
|---|---|---|
| Server-authoritative, mirror clients, **no client prediction** | No client cheating surface for game logic; simple, consistent state | Input feels at least a round trip plus one interpolation tick (about 33 ms) late. A poor fit for twitch games. (Derived) |
| World in typed arrays (bitECS) with native C++ for physics, navigation and noise | Cheap simulation steps; game logic in TypeScript | Game logic runs on one main thread per region. Garbage collection is a real risk: one leak caused 200 to 400 ms tick stalls (fixed, PF1) |
| 30 Hz fixed tick | A predictable budget, replayable determinism (verified bit-for-bit over 500 ticks on 100 entities) | 33 ms between world updates; heavy systems must be spread over ticks |
| Scale by adding regions | Near-linear scale in processes, cheap hand-offs (p50 about 5 ms) | Cross-region state is eventually consistent: friends and presence sync about every 30 s, so a region boundary is a consistency boundary |
| One process per region, about 4 per core | Failures stay local | You run and monitor many processes, and each carries its own memory |
| Opt-in fast paths (data plane, send batching) | Safe defaults, easy rollback | You get the speed only if you turn it on, and each has its own failure modes. The edge is not opt-in: `npm start` runs it, and the native fan-out path does not run behind it |
| Native C++ addons | Speed where it counts | A C++17 toolchain on every developer machine, native builds in CI, and memory-safety checks (Valgrind runs on Linux only) |

## What it means if you are choosing

**It fits if:**
- you want a persistent, server-authoritative world with MMO pacing (movement at walking and running speeds, not twitch aiming);
- you can shard geographically, so players spread across regions;
- your team is comfortable with TypeScript on Node, and with C++ when you extend native parts;
- you want content (rules, creatures, loot, dungeons) as data your designers can edit and version in Git.

**Think hard if:**
- you need one seamless space with **1,000 players in a crowd** (a city, a siege). The simulation can carry it; the end-to-end tick does not yet. This is the main open performance item.
- you need competitive, low-latency combat.
- you cannot run Linux servers with several cores each, or you develop on Windows with a Node version that has no uWS binary (you will run the slower transport locally).
- you need a measured, independently verified capacity number today. These are repository benchmarks on shared hardware.

## What is not measured

- Any run on dedicated hardware. Every absolute figure above should be re-measured.
- Multi-hour soak tests. The edge soak ran 10 minutes (2026-10-03).
- The world server on its own box with regions spread across hosts.
- Player-client frame rates on real GPUs.
- Cloud cost per player. This repository holds no measurement of it, so this page does not estimate one.
- Comparisons with other engines. This page is about Nexus only; nothing here was benchmarked against another engine.

## Reproduce it

| To measure | Run |
|---|---|
| Per-system instruction cost | `npm run valgrind:perf` (Linux, needs Valgrind) |
| Transport and send-path cost | `npm run bench:transport` (add `-- --multi --cork` to compare batching) |
| The edge/core split | `npm run bench:e5` |
| Regions per box | `npm run stress:world` |
| Ragdoll cost | `npm run bench:ragdoll` and `npm run bench:ragdoll:addon` |
| Persistence | `npm run bench:persist` |
| Everything in the tick budget harness | `npm run bench` |

Run these on the machine you plan to deploy on. Quote ratios, not absolutes.
