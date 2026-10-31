# Ragdoll cost gate: scope of work

Roadmap: section 5, "Ragdoll cost gate" (🚧) and the slice rows under it.
Measured with `npm run bench:ragdoll`; results in
[`ragdoll-cost-results.json`](ragdoll-cost-results.json). No gameplay code
in this work. The budget is 4 ms per tick, chosen on 2026-10-31.

## The question

Could the server's 30 Hz physics step carry a simulated ragdoll for every
connected player, 1,000 in the target?

## The answer

Not as one world on the engine's current tick. A crowd of 1,000 awake full
ragdolls takes 110 ms per step, more than three 33 ms ticks. At that size the
10,240-contact cap fills and Jolt skips contacts, so that figure is not valid
physics. With the cap lifted it is 142 ms. Even 512 full rigs take 64 ms, 191%
of a tick.

The budget is 4 ms per tick (12% of a tick). In one world, that holds
48 awake full rigs or 116 light ones on the bench. Through the addon, the cap admits 48 full rigs or 120 light rigs (see below). The budget does not change the answer above: 1,000 full rigs still take 110 ms.

The earlier figure of 13.8 ms for 256 awake rigs was one substep. The engine
runs two. The real figure is 25.2 ms, 76% of a tick.

## Method

- **Rig.** Jolt's own `Ragdoll`: 11 capsules joined by 10 swing-twist joints.
  `--rig light` is 5 capsules: no arms, one capsule per leg.
- **World.** A 400 m floor. Rigs drop from 1.2 to 1.8 m onto a grid, 0.9 m
  apart (crowd) or 4 m apart (apart).
- **Tick.** Stepped at 30 Hz. Only the `Update` calls are timed, not the world
  setup.
- **Engine configuration (`production`).** Two substeps, as engine-core's
  `PhysicsSystem` runs them (`subSteps = 2`); the addon's 10 MB temp allocator
  and 10,240-contact cap; the single-threaded job system the addon uses.
- **Other configurations.** Each changes one thing from `production`:
  `main` (bench defaults: one substep, 64 MB, 65,536 contacts), `substeps2`
  (two substeps, bench limits), `threads4` (a four-thread pool), `light` (the
  5-capsule rig) and `sleep0.1` (bodies sleep after 0.1 s at rest).
- **Scenarios.** `awake`: sleep off, 1 s warm-up, 3 s measured. `apart`: as
  `awake`, rigs 4 m apart. `settle`: sleep on, the first 2 s after the drop.
  `resting`: sleep on, 5 s warm-up, 2 s measured.
- **Counts and repeats.** 0, 8, 16, 32, 64, 128, 256, 512 and 1,000 rigs. Each
  count runs in its own process, and the median of 3 repeats is reported. Cost
  per rig is (step time minus the 0-rig step) divided by the rig count.
- **Build.** The bench compiles Jolt's headers with the addon's settings: C++17,
  `-O3`, `-DNDEBUG`, no `JPH_USE_*` SIMD defines, cross-platform determinism
  off. It links the addon's own Jolt objects.
- **Machine.** 4 vCPU cloud container, Intel Xeon 2.10 GHz, Node 22.22,
  g++ 13.3. Shared; see Caveats.
- **Checks.** Valgrind memcheck on the bench binary at 16 rigs, on the
  production and thread-pool paths: 0 errors, no leaks. Jolt reported no trace
  messages in any run, so the 10 MB temp allocator never ran out.
- **Time.** A full sweep of six configurations took about 20 minutes here.

## Results at the engine's tick (`production`)

Each cell gives the step time, its share of the 33.3 ms tick, and the cost per
rig.

| Rigs | Awake | Apart | Settle (first 2 s) | Resting |
|---:|:---|:---|:---|:---|
| 8 | 0.72 ms · 2% · 90 µs | 0.50 ms · 1% · 62 µs | 0.44 ms · 1% · 55 µs | 0 ms: asleep |
| 64 | 5.18 ms · 16% · 81 µs | 4.14 ms · 12% · 65 µs | 3.29 ms · 10% · 51 µs | 4.93 ms · 15% · 77 µs |
| 256 | 25.17 ms · 76% · 98 µs | 17.52 ms · 53% · 68 µs | 15.07 ms · 45% · 59 µs | 25.27 ms · 76% · 99 µs |
| 512 | 63.68 ms · 191% · 124 µs | 39.57 ms · 119% · 77 µs | 32.55 ms · 98% · 64 µs | 65.88 ms · 198% · 129 µs |
| 1,000 | 109.76 ms · 329% · 110 µs (cap hit) | 80.94 ms · 243% · 81 µs (cap hit) | 68.09 ms · 204% · 68 µs (cap hit) | 90.38 ms · 271% · 90 µs (cap hit) |

The contact cap is hit at 1,000 full rigs, so those points are not valid
physics. Some bodies reached 20 m/s or more (21.7 m/s awake, 46 m/s resting).

Same counts, awake scenario, one change at a time:

| Configuration | Change from `production` | 256 rigs | 512 rigs | 1,000 rigs |
|:---|:---|:---|:---|:---|
| `production` | none | 25.17 ms (76%) | 63.68 ms (191%) | 109.76 ms (329%), cap hit |
| `main` | one substep, bench limits | 16.40 ms (49%) | 40.09 ms (120%) | 89.96 ms (270%), valid |
| `substeps2` | bench limits | 26.71 ms (80%) | 64.82 ms (194%) | 142.08 ms (426%), valid |
| `threads4` | four-thread pool | 12.97 ms (39%) | 26.84 ms (81%) | 43.43 ms (130%), cap hit |
| `light` | five-capsule rig | 8.60 ms (26%) | 18.38 ms (55%) | 37.31 ms (112%), valid |
| `sleep0.1` | sleep after 0.1 s | 26.34 ms (79%) | 62.43 ms (187%) | 107.16 ms (321%), cap hit |

What fits one 30 Hz world, awake scenario, `production` unless marked. Budget
figures are the step alone, not the rest of the game's tick:

| Budget per tick | Full rigs | Light rigs | Full rigs, resting | Full rigs, `threads4` |
|:---|---:|---:|---:|---:|
| 1 ms (3%) | 12 | 35 | 17 | 14 |
| 2 ms (6%) | 24 | 65 | 30 | 33 |
| 4 ms (12%), chosen | 48 | 116 | 53 | 76 |

Whole-tick fill (no budget left for anything else): full awake rigs reach
33.3 ms at about 310 rigs; light rigs at about 900.

## Through the addon: F1 and F2

The tables above call Jolt directly. This is the path the engine runs: the addon's rig API with the budget in place. `npm run bench:ragdoll:addon` builds a resting world (sleep on, two substeps, the addon's limits) for each configuration at each count, in its own process, and reports the median of 3 step times.

| Requested | Full, no cap (before) | Full, capped (F2) | Light, no cap (F1) | Light, capped (F1 + F2) |
|---:|---:|---:|---:|---:|
| 16 | 0.96 ms | 0.94 ms | 0.35 ms | 0.34 ms |
| 64 | 4.51 ms | 4.99 ms | 1.73 ms | 1.70 ms |
| 128 | 10.45 ms | 3.61 ms | 3.78 ms | 3.37 ms |
| 256 | 25.17 ms | 3.65 ms | 8.18 ms | 3.45 ms |

- **Accepted.** The cap admits 48 full rigs (240 units at 5 each) or 120 light
  rigs (240 units at 2 each). A batch past the cap is refused, and the spawner
  adds only what fits.
- **Budget reconciled.** The bench's awake column gave 48 full and 116 light
  rigs at 4 ms. The cap's 120 light rigs is the unit model's answer, about 3%
  above that estimate. Through the addon, 120 light rigs take about 3.4 ms, under
  the 4 ms budget.
- **Light rigs.** Below the cap, capped and uncapped light rigs run the same
  scene, so their lines coincide. Uncapped at 256 requested they take 8.2 ms,
  about a third of the full rigs' 25.2 ms.
- **The 64-rig point.** The capped full case at 64 and at 128 requested is the
  same 48 rigs. Its runs split between about 3.6 and 5.0 ms, and the cause is not
  known. The 128 and 256 medians agree at about 3.6 ms; read those.
- **Not measured through the addon: sleep off.** The addon keeps sleep on, so
  the awake figures above still come from the bench. A fully awake world at the
  cap is the case the 48-rig budget assumes.

## Through the addon: F7 (sleep threshold)

The addon takes a sleep threshold (`setSleepThreshold`, in m/s; Jolt's default is 0.03) and counts the ragdoll bodies still awake (`ragdollActiveBodies`). `npm run bench:sleep:addon` settles a resting crowd on the 0.9 m grid for 20 s at each threshold, records when it is all asleep, then times 2 s. Crowds at the cap:

| Threshold | 48 full rigs | 120 light rigs | Step once settled |
|:---|:---|:---|:---|
| 0.03 (default) | never; 528 of 528 awake at 20 s | never; 550 of 600 awake | 3.58 ms and 3.33 ms, awake |
| 0.1 m/s | asleep at 16 s | asleep at 10 s | under 0.01 ms |
| 0.3 m/s | asleep at 1 s | asleep at 1 s | under 0.01 ms |
| 1.0 m/s | asleep at 8 s | asleep at 1 s | under 0.01 ms |

Smaller crowds fall asleep sooner: 16 full rigs at 15 s and 16 light rigs at 13 s at the default, and at 6 to 7 s at 0.1 m/s. Sleep times and awake counts come from the first of three runs; step times are medians of three.

Wake check: 16 light rigs settled for 20 s, then a 5 kg sphere dropped 2 m onto the middle rig.

- At every threshold tested, the rig woke when the sphere landed.
- At 0.3 m/s at most 5 bodies woke at once (one rig's worth), and the rig moved 28.5 cm. At 0.03 m/s, where the rigs were asleep, it woke 70 of 80 bodies and the rig moved 7 mm. These are one sample each: the test establishes that the rig wakes, not how far it moves.

What it means:

- The 4 ms budget is an awake budget. A settled crowd costs under 0.01 ms; a default crowd does not fall asleep within 20 s, so at the cap it costs about 3.5 ms a tick.
- A larger threshold trades fidelity for that cost. A body slower than the threshold for 0.5 s is put to sleep, so slow motion can freeze. And in this scene, at 0.3 m/s no more than one rig woke, but at the default 70 of 80 bodies did. Both need a look in the client before a default changes.
- Recommendation: keep 0.03 as the default for now. The person picks the value after a client look. 0.3 m/s is the one that puts a capped crowd to sleep within a second.

## Through the addon: F4 (threads and determinism)

`createWorld({ threads })` runs the world on a Jolt thread pool of that size. The default, 0, keeps one thread. `npm run bench:threads:addon` runs the resting sweep on 0 and 4 threads, median of 3. Results: [`addon-ragdoll-threads-results.json`](addon-ragdoll-threads-results.json).

Each cell is step time on one thread, then on four, with the speed-up in brackets:

| Rigs requested | Full, no cap | Full, capped | Light, capped |
|---:|:---|:---|:---|
| 16 | 0.93 / 1.22 ms (0.77×) | 0.96 / 1.13 ms (0.85×) | 0.35 / 0.80 ms (0.44×) |
| 64 | 4.56 / 3.36 ms (1.36×) | 3.72 / 2.74 ms (1.36×) | 1.68 / 1.66 ms (1.02×) |
| 128 | 10.50 / 6.96 ms (1.51×) | 3.62 / 3.04 ms (1.19×) | 3.52 / 2.73 ms (1.29×) |
| 256 | 25.61 / 13.20 ms (1.94×) | 3.64 / 3.30 ms (1.10×) | 3.43 / 2.93 ms (1.17×) |

The capped columns admit 48 full or 120 light rigs, so every row above those counts is the same world. On four threads the same 48 rigs measured 2.7 to 3.3 ms across rows, which is the spread this container gives.

- **The pool pays off in big worlds.** From 64 full rigs, and from 120 light rigs, four threads are faster. Uncapped, 256 full rigs take 13.2 ms against 25.6 ms.
- **At the cap the gain is small, and not needed.** 48 full rigs take 3.6 to 3.7 ms on one thread and 2.7 to 3.3 ms on four. Both fit the 4 ms budget, so the cap does not need threads.
- **Small worlds get slower.** At 16 rigs the pool adds 0.2 to 0.3 ms a step for full rigs and about 0.45 ms for light ones: the cost of waking and joining the workers each step. A pool has to be chosen per world, by size.
- **The result did not change with the thread count, on this scene.** Fresh processes at 0 threads and at 4 threads each give the same bits, and the two thread counts give the same bits as each other. The scene has six dynamic bodies, 32 rig bodies and 240 steps (`test/determinism.test.js`). Jolt's architecture notes promise determinism for the same call order and binary, not for every thread count, so this holds for the scene the test runs and no wider.
- **Caveats.** The container has 4 vCPUs, shared, so the pool competes with the JS thread. On server hardware with more cores the gain could be larger, and with fewer it is worse. Each world owns its pool, so one world means four native threads. A pool shared across worlds is not built.

**Decision (recommended).** Threads stay opt-in per world, and the default stays one thread. The engine can use a pool for worlds of 64 full rigs or more, or 120 light rigs. The 4 ms cap does not need one. Whether the engine uses threads at all is the person's call.

## Findings

1. **Most of the cost is per rig.** Rigs 4 m apart, with no contact between
   them, cost 70% to 82% of the crowd at 64 to 256 rigs (17.5 ms against
   25.2 ms at 256). A budget is mostly a per-rig budget.
2. **The engine's tick costs about 1.6 times the earlier numbers.** Two
   substeps cost 1.5 to 1.7 times one substep at the same count (`substeps2`
   against `main`).
3. **The contact cap is the first hard limit.** The 10,240-contact cap fills
   between 512 and 1,000 full rigs. Past it Jolt skips contacts, and bodies fly
   (21.7 m/s at 1,000 awake rigs). The cap protects correctness, not cost:
   lifting it costs 142 ms at 1,000 awake rigs.
4. **The temp allocator is not the limit.** The 10 MB temp allocator never ran
   out up to 1,000 rigs, and Jolt reported no traces.
5. **Crowds do not sleep.** Eight resting rigs all fall asleep (0 of 88 bodies
   awake). From 16 rigs up, most of the pile stays awake: 154 of 176 bodies at
   16 rigs, 1,386 of 1,408 at 128. In the resting runs, for 16 to 512 rigs, the fastest body at the end
   of each run moved at 0.04 to 0.28 m/s. Jolt's default point-velocity sleep threshold is
   0.03 m/s (`PhysicsSettings::mPointVelocitySleepThreshold`). The likely cause:
   the pile is one contact island, and one body above the threshold keeps the
   whole island awake. That is an inference from these numbers. It is not tested
   yet (F7).
6. **A shorter sleep time does nothing in a crowd.** With a 0.1 s sleep time,
   production costs at 256 rigs match the default within 5% (resting 25.5 ms
   against 25.3 ms; awake 26.3 ms against 25.2 ms). `sleep0.1` is not a fix.
7. **Threads help, well short of 4 times.** Four threads cut the awake cost
   1.9 times at 256 rigs and 2.4 times at 512; apart at 512 the cut is 2.7 times.
   The addon's README records that multithreaded Jolt does not guarantee query
   ordering, so threading needs the addon's determinism test run again before it
   is used.
8. **The light rig is the largest measured saving.** It is about 3 times cheaper
   at 256 to 1,000 rigs: 34 to 37 µs a rig, against 98 to 124 µs for the full
   rig. A thousand light rigs stay under the cap, but still take 37 ms, more than
   one tick.
9. **Cost per rig grows with the count, even apart.** 62 µs at 8 rigs and 81 µs
   at 1,000. The broadphase grows with the number of bodies.

## Recommended fixes, with measured effect

| Fix | Measured effect | Cost or risk | Decision |
|:---|:---|:---|:---|
| **F1.** Light rig for crowds | About 3 times cheaper per rig at 256 to 1,000 rigs (34 to 37 µs against 98 to 124 µs) | No arms. Art and gameplay must accept it | Which rig, for which rigs |
| **F2.** Cap server-simulated rigs per world | 32 full rigs 2.7 ms (8%); 64 rigs 5.2 ms (16%); 128 rigs 11.6 ms (35%). Through the addon, capped: 3.6 ms at 128 and 256 full rigs | Other players' deaths need F5 | Cap size, set from the 4 ms budget: 48 full or 120 light rigs per world |
| **F3.** Keep each world under the contact cap | At 512 full rigs the cap does not fill and the cost is valid (64 ms) | Bigger crowds need F5 or F6 | Enforce in code, and say what happens at the cap |
| **F4.** Four-thread job pool | Through the addon: 1.9 times at 256 uncapped full rigs (25.6 to 13.2 ms); 1.1 to 1.4 times at the cap; 16-rig worlds slower (0.44 to 0.85 times) | Determinism: the same bits at 0 and 4 threads on the test scene. Each world owns its pool | Opt-in per world, default one thread. A pool from about 64 full or 120 light rigs |
| **F5.** Cosmetic ragdolls on clients, for other players' deaths | Zero server cost: the server sends the death event and the client shows the body | Client cost not measured here. Not authoritative, so fine for looks only | Recommended. Measure the client budget |
| **F6.** Shard the world: several single-threaded worlds across cores | Not measured. Each world stays under the cap, and the work scales with cores | An addon change for more than one world. Must stay off the JS thread. Collisions across shards | Architecture decision |
| **F7.** Larger point-velocity sleep threshold | At 0.3 m/s a capped crowd sleeps within a second and costs under 0.01 ms once settled. At the default it does not sleep within 20 s and costs 3.3 to 3.6 ms a tick. Through the addon, above | A body slower than the threshold for 0.5 s freezes. A hit reached only its own rig at 0.3 m/s in one test. Needs a client look | Default unchanged. The person picks the value |

## Recommendation

Do not simulate every player's ragdoll on the server. At the engine's tick, no
count near 1,000 fits one world, with or without threads. The first slice
should be:

1. **Cosmetic ragdolls on clients for other players' deaths (F5).** They cost
   the server nothing. Measure the client budget separately.
2. **Server-side rigs only where gameplay needs the physics**: a corpse someone
   can hit, a body that blocks a path. Light rigs for crowds, and full rigs for a
   few dozen at most, inside the 4 ms budget (F1, F2).
3. **Keep each world under the contact cap (F3).** Threads (F4) are opt-in per world, for large worlds only, and sharding (F6) only if real play needs more rigs than one world holds.
4. **Measure the sleep threshold (F7)** before deciding whether resting piles are
   a problem.

## Phases

- **Phase 0, this PR.** The bench, the sweep, this scope, and the roadmap rows.
  No gameplay.
- **Phase 1, decisions and two measurements.** The rig fidelity, and
  cosmetic or authoritative. Then F7 (a bench flag for the sleep threshold) and
  the addon's determinism test with a thread pool.
- **Phase 2, first slice.** Light rigs for crowds, a cap per world, and cosmetic
  client deaths. Benchmark the slice in the real world, through the addon, with
  the same sweep.
- **Phase 3, only if needed.** Sharding (F6).
- **Phase 4, CharacterVirtual.** Its own cost gate, using the same method, before
  any gameplay code (roadmap row C).

Status: F1 and F2 are in PR #489, ready for review, stacked on #488 (slice 2, measured through the addon above). F7 is in PR #490, ready for review, stacked on #489 (below). F4 is measured through the addon (below), in its own PR stacked on #490. F3 is not measured yet. F5 is still scope only.

## Open decisions

1. **Budget, set.** The person chose 4 ms per tick on 2026-10-31.
   1 ms (3%) holds 12 awake full rigs or 35 light ones. 2 ms (6%) holds 24 or
   65. 4 ms (12%) holds 48 full rigs or 120 light ones through the cap (the bench estimated 116).
2. **Authoritative or cosmetic.** Server-simulated ragdolls for everyone, or
   cosmetic on clients for other players? Recommended: cosmetic for others.
3. **Rig fidelity.** The full rig, the light rig, or full up close and light far
   away?
4. **Threads, shards, or one thread.** Recommended: threads opt-in per world (F4), default one thread. Shards (F6) are not started.
5. **The contact cap.** Keep 10,240 and limit crowds, or raise it at a cost
   (142 ms at 1,000 awake rigs)?

## Not measured

- Client cost, rendering, and any gameplay: no damage, animation blending, or
  kinematic driving.
- CharacterVirtual.
- Contacts per rig. The cap shows only as a flag.
- Server hardware. This container is 4 vCPU at 2.1 GHz and shared.
- The engine's real world. The bench floor is one box, with no terrain, no static
  colliders and no other bodies.
- Awake crowds through the addon. The addon keeps sleep on, so the awake figures come from the bench.
- Networking.

## Caveats

- **Run-to-run variance.** Between two sweeps of the same configuration on this
  container, times moved by up to about 35%. The same 256-rig awake case measured
  13.8 ms in the first sweep (one substep) and 16.4 ms in this sweep's one-substep run (`main`). Read ratios
  within one sweep. Treat absolute milliseconds as about ±30%.
- **Addon sweep spread.** Single runs in the addon sweep sat up to about 40% above their median. The 64-rig point in the addon table is the clearest case.
- **The floor.** The first sweep used a floor with a 50 m half-width, and this one uses a 200 m half-width (400 m across) so
  the 1,000-rig apart case fits. The counts measured in the first sweep did not
  reach the edge, so they are unaffected.
- **Hardware.** Run `npm run bench:ragdoll` on the target server hardware before
  the first slice ships.

## Reproduce

```
npm run bench:ragdoll              # full sweep, about 20 minutes here; writes the results file
npm run bench:ragdoll -- --quick   # three counts, one repeat; no file
```

Build the addon first (`npx node-gyp rebuild` in `packages/addons/physics`). The
bench is `packages/addons/physics/bench/ragdoll-cost.cpp`, and its runner is
`packages/addons/physics/bench/run-ragdoll-cost.mjs`.

Through the addon, the path the engine runs (after the addon builds):

```
npm run bench:ragdoll:addon              # full sweep, 3 repeats; writes docs/addon-ragdoll-results.json
npm run bench:ragdoll:addon -- --quick   # one repeat; no file
```
