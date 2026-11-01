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

The addon takes a sleep threshold (`setSleepThreshold`, in m/s) and counts the ragdoll bodies still awake (`ragdollActiveBodies`). A new world starts at 0.05 m/s, chosen in the decision below; Jolt's own default is 0.03. `npm run bench:sleep:addon` settles a resting crowd on the 0.9 m grid for 20 s at each threshold, records when it is all asleep, then times 2 s. This first sweep ran at 0.03 and predates the decision. Crowds at the cap:

| Threshold | 48 full rigs | 120 light rigs | Step once settled |
|:---|:---|:---|:---|
| 0.03 (Jolt's default, then) | never; 528 of 528 awake at 20 s | never; 550 of 600 awake | 3.58 ms and 3.33 ms, awake |
| 0.1 m/s | asleep at 16 s | asleep at 10 s | under 0.01 ms |
| 0.3 m/s | asleep at 1 s | asleep at 1 s | under 0.01 ms |
| 1.0 m/s | asleep at 8 s | asleep at 1 s | under 0.01 ms |

Smaller crowds fall asleep sooner: 16 full rigs at 15 s and 16 light rigs at 13 s at the default, and at 6 to 7 s at 0.1 m/s. Sleep times and awake counts come from the first of three runs; step times are medians of three.

Wake check: 16 light rigs settled for 20 s, then a 5 kg sphere dropped 2 m onto the middle rig.

- At every threshold tested, the rig woke when the sphere landed.
- At 0.3 m/s at most 5 bodies woke at once (one rig's worth), and the rig moved 28.5 cm. At 0.03 m/s, where the rigs were asleep, it woke 70 of 80 bodies and the rig moved 7 mm. These are one sample each: the test establishes that the rig wakes, not how far it moves.

What it means:

- The 4 ms budget is an awake budget. A settled crowd costs under 0.01 ms; a crowd at Jolt's 0.03 m/s does not fall asleep within 20 s, so at the cap it costs about 3.5 ms a tick.
- A larger threshold trades fidelity for that cost. A body slower than the threshold for 0.5 s is put to sleep, so slow motion can freeze. And in this scene, at 0.3 m/s no more than one rig woke, but at 0.03 m/s 70 of 80 bodies did. Both need a look in the client, which is still open.
- Decision (2026-11-01): the default is now 0.05 m/s, chosen by the ensemble bench below. 0.3 m/s puts a capped crowd to sleep within a second, but it was not in the ensemble, and 0.15 and 0.20 m/s fail the bar.

### Decision (2026-11-01): the default is 0.05 m/s

A new world starts at 0.05 m/s. `bench/addon-sleep-ensemble.mjs` chose it. Each crowd (48 full or 120 light rigs, the cap) runs from five start grids (1 mm random offsets, seeds 1 to 5) for 60 s at each of 0.03, 0.05, 0.10, 0.15 and 0.20 m/s. The bar was fixed before the first run. Against the 0.03 runs, a threshold passes when the settled height and footprint of each crowd are within |z| ≤ 3 (Welch, five runs each), a 5 kg sphere dropped 2 m onto the middle light rig wakes it on every seed, and its mean move differs from the 0.03 mean by less than 20 mm. The cheapest passing threshold is chosen. Data: [`addon-sleep-threshold-ensemble-results.json`](addon-sleep-threshold-ensemble-results.json).

| Threshold | Physics time over 60 s, both crowds | Height z, full / light | Footprint z, full / light | Wake, mean move | Result |
|:---|:---|:---|:---|:---|:---|
| 0.03 (Jolt's default, reference) | 8,531 ms | 0 / 0 | 0 / 0 | 4.9 mm | reference |
| **0.05 (chosen)** | **6,030 ms** | 1.15 / 0.19 | −0.03 / 0 | 4.9 mm | passes |
| 0.10 | 1,555 ms | 1.96 / **4.36** | −0.07 / 0.81 | 5.7 mm | light height over the bar |
| 0.15 | 1,174 ms | 2.18 / **10.1** | −0.08 / 1.72 | 5.7 mm | light height over the bar |
| 0.20 | 1,093 ms | 2.55 / **7.91** | 0.04 / 2.11 | **143 mm** | light height and the wake bar |

0.05 is the cheapest threshold that passes. It costs 29% less physics time than 0.03 across both crowds (6.0 s against 8.5 s). Its settled crowds sit 1.1 mm higher (full) and 0.2 mm higher (light) than the default's. 0.10 fails on light-rig height: its rigs sit about 17 mm higher, z 4.36 against a bar of 3. A bar of 4.36 or wider would pass 0.10 instead.

Caveats:

- The 60 s reference is not settled. At 0.03, 2 of 5 full crowds and all 5 light crowds were still awake at 60 s. At 0.05, no full crowd and 3 of 5 light crowds were. The height and footprint are taken over the final 2 s of each run.
- The bench does not test slow motion. A body slower than the threshold for 0.5 s is put to sleep, so at 0.05 m/s a slow-moving body can freeze. The client look is still open.
- The |z| ≤ 3 bar was fixed before the run. It is the only reason 0.10 fails.
- Round 1 (`bench/addon-sleep-threshold.mjs`) is superseded. Its pose check was invalid: a 1 mm change in the start grid moves the default's own settled pose by 263 mm RMS (48 full) and 609 mm (120 light). Its settle-cost and wake numbers stand.

## Through the addon: F4 (threads and determinism)

`createWorld({ threads })` runs the world on a Jolt thread pool of that size. The default, 0, keeps one thread. `npm run bench:threads:addon` sweeps 0, 1, 2 and 4 threads at the chosen sleep threshold of 0.05 m/s, median of 3 runs per cell. Each row records how many ragdoll bodies are still awake at the end of its 7 s window (`activeBodies`). Results: [`addon-ragdoll-threads-results.json`](addon-ragdoll-threads-results.json). This sweep replaces the earlier 0-and-4 sweep, which ran at Jolt's 0.03 m/s.

Step time per cell is the median of three runs, in ms. The last column is four threads against none. The middle column is the requested rig count and, in brackets, the count the budget accepted.

| Config | Requested (accepted) | 0 threads | 1 | 2 | 4 | 4 vs 0 |
|:---|:---|---:|---:|---:|---:|---:|
| Full, no cap | 16 (16) | 1.26 | 1.16 | 1.09 | 1.23 | 1.02× |
| | 64 (64) | 3.81 | 3.82 | 3.90 | 3.18 | 1.20× |
| | 128 (128) | 9.42 | 10.04 | 8.10 | 6.86 | 1.37× |
| | 256 (256) | 27.23 | 20.86 | 15.81 | 13.15 | 2.07× |
| Full, capped | 16 (16) | 0.76 | 0.99 | 1.18 | 0.98 | 0.78× |
| | 64 (48) | 2.88 | 3.00 | 3.46 | 2.46 | 1.17× |
| | 128 (48) | 2.88 | 3.25 | 2.78 | 2.80 | 1.03× |
| | 256 (48) | 3.65 | 3.59 | 2.72 | 2.87 | 1.27× |
| Light, capped | 16 (16) | 0.34 | 0.75 | 0.79 | 0.79 | 0.43× |
| | 64 (64) | 1.34 | 1.77 | 1.74 | 1.70 | 0.79× |
| | 128 (120) | 3.34 | 4.22 | 3.45 | 3.18 | 1.05× |
| | 256 (120) | 4.02 | 3.72 | 3.72 | 3.22 | 1.25× |

The capped configs admit 48 full or 120 light rigs, so their 128 and 256 rows are the same world. The 16-rig worlds fall asleep within the window: none of their 176 full bodies or 80 light bodies is awake at the end. From 64 rigs up most bodies are still awake at 7 s; for example 484 of the 528 bodies of the 48 capped full rigs.

- **Four threads pay off only well past the cap.** Uncapped, 256 full rigs take 13.2 ms on four threads against 27.2 ms on one (2.1×), and 128 rigs take 6.9 ms against 9.4 ms. At 64 full rigs the gain is 1.2×, and at 16 it is within noise.
- **At the cap the gain is 1.0 to 1.3×, and not needed.** 48 full rigs take 2.9 to 3.7 ms on one thread and 2.5 to 2.9 ms on four. 120 light rigs take 3.3 to 4.0 ms on one thread and 3.2 ms on four. The cap already fits the 4 ms budget on one thread.
- **Small worlds get slower.** At 16 light rigs four threads cost 0.79 ms against 0.34 ms, and at 64 light rigs 1.70 ms against 1.34 ms: the cost of waking and joining the workers each step. A pool has to be chosen per world, by size.
- **One and two threads sit between.** At 256 uncapped full rigs one thread gives 1.3× and two give 1.7×. At the small sizes they cost as much as four, so neither changes the default.
- **The result did not change with the thread count, on this scene.** The addon's determinism tests pass on this branch: fresh processes at 0 threads each give the same bits, fresh processes at 4 threads each give the same bits, and 0 and 4 threads give the same bits as each other. The scene has six dynamic bodies, 32 rig bodies and 240 steps (`test/determinism.test.js`). Threads 1 and 2 are measured for cost only, and a 256-rig scene with a pool is not checked for bits. Jolt's architecture notes promise determinism for the same call order and binary, not for every thread count, so this holds for the scene the test runs and no wider.
- **Caveats.** The container has 4 vCPUs, shared with the JS thread, so four workers oversubscribe the cores. On server hardware with more cores the gain could be larger, and with fewer it is worse. Each world owns its pool, so one world means four native threads. A pool shared across worlds is not built. Cells near 1× are noise.
- **The result did not change with the thread count, on this scene.** Fresh processes at 0 threads and at 4 threads each give the same bits, and the two thread counts give the same bits as each other. The scene has six dynamic bodies, 32 rig bodies and 240 steps (`test/determinism.test.js`). Jolt's architecture notes promise determinism for the same call order and binary, not for every thread count, so this holds for the scene the test runs and no wider.
- **Caveats.** The container has 4 vCPUs, shared, so the pool competes with the JS thread. On server hardware with more cores the gain could be larger, and with fewer it is worse. Each world owns its pool, so one world means four native threads. A pool shared across worlds is not built.

**Decision (2026-11-01): the default stays one thread.** Threads stay opt-in per world. A pool pays off only past the cap (from about 128 full rigs uncapped), and costs time in smaller worlds, so it would be chosen per world by size. The 4 ms cap does not need one, and the cap keeps each world at a size where a pool gains little (1.0 to 1.3×), so the engine needs no pool yet.

## Through the addon: F3 (contact cap)

Jolt keeps 10,240 contact constraints per world. When they are full, Jolt drops the contacts that did not fit for that step, and its update returns error bits to say so. The addon ignored those bits, so a full cap was silent. `lastStepErrors()` now reports them for each step, and `UpdateError.ContactConstraintsFull` is the cap. Tests: `test/contact-cap.test.js`. An awake crowd at the budget stays clear for 150 steps, and a sheet of 6,400 touching spheres fills the cap and is reported on every step.

`npm run bench:contact-cap:addon` runs settle, awake and apart for full and light rigs with the budget lifted. Each run records the step time, the cap bit, the fastest body and the bodies below the floor at the end. For each rig kind and scenario it then bisects for the first count that sets the bit, to within 4 rigs. Results: [`addon-contact-cap-results.json`](addon-contact-cap-results.json).

| Scenario | Full rigs: first count that fills the cap | Light rigs: first count that fills the cap |
|:---|:---|:---|
| Awake crowd: 0.9 m apart, sleep off | 636 (clear at 632) | 1,458 (clear at 1,455) |
| Apart: 4 m apart, sleep off, no rig touches | 920 (clear at 916) | 1,882 (clear at 1,878) |
| Settle: 0.9 m apart, sleep on, the first 2 s | 1,084 (clear at 1,080) | not reached by 3,200 |

The budget (48 full or 120 light rigs) sits 12 to 19 times below these counts. Per rig, the cap is about 16 constraints for an awake full rig and about 7 for an awake light one. That is the cap divided by the fill point, not a count. An apart rig gives 11 full and 5 light, one for each body on the floor, which checks the arithmetic. At the budget an awake crowd uses about 8% of the cap.

Past the cap, with an awake crowd, bodies fly and fall through the floor:

| Full rigs | Fastest body | Bodies below the floor |
|---:|:---|:---|
| 512 (clear) | 1.4 m/s | 0% |
| 768 | 15 m/s | 16% |
| 1,024 | 19 m/s | 46% |
| 2,048 | 23 m/s | 81% |

Light rigs: 1,440 is clear at 1.5 m/s. At 1,920 the fastest body is 14 m/s with 28% below the floor, and at 3,200 it is 16 m/s with 63%. Apart full rigs at 1,024, past their cap, are at 17 m/s with 11% below the floor. Settle's fastest body reads the same at every count, about 5 m/s for full rigs and 1.6 m/s for light ones, so the signal there is the count below the floor: 2% at 2,048 full rigs.

**The budget holds only for a crowd that sleeps.** With sleep off, the budget's rigs cost more than 4 ms: 5.4 ms for 48 full rigs and 7.1 ms for 120 light rigs in the sweep. A quiet re-measure gave 4.2 and 4.0 ms, so timings on this shared container vary by up to about 30% between sessions. Resting, the same counts cost 3.4 to 3.7 ms (F2). A crowd that sleeps stays inside the budget, and one that stays awake sits at or just above 4 ms. That is why the sleep threshold (F7) matters.

Caveats:

- The fill points are for rigs on one floor. Other bodies in the same world share the cap, and each one reduces the room past the budget.
- The constraints per rig are inferred from the fill points, not counted.
- A fill point is the first count that set the bit in the run, warm-up included. The bisection is to 4 rigs.
- The engine does not read `lastStepErrors()` yet, so a full cap is silent in the game until it does.

Reproduce: `npm run bench:contact-cap:addon` runs the full sweep and fill search, about 20 minutes on this container. `-- --quick` runs three counts. Tests: `node --test packages/addons/physics/test/contact-cap.test.js`.

## F5: cosmetic deaths on the client (scope only)

Roadmap "Ragdoll slice 1". Not measured, and not built. The server cost is zero: the server already sends the life message on a death. The client cost is unknown, because no client package depends on a physics library.

- **What exists.** `LifeMessage` (`packages/protocol/src/items.ts`) carries the target, its state, the killer, the cause and the body part. The client handles it in `apps/client/src/render/combat-feedback.ts`. The protocol also defines a death-fall clip (`ClipId.DeathFall`, `packages/protocol/src/animation.ts`), which nothing in `apps/client` references yet.
- **What is missing.** A client physics option, and a direction for the fall. The life message has no direction, so a ragdoll would start from the death pose with no push. The hit message (0x16) may carry where a blow came from; that is not checked here. Otherwise a field costs a few bytes per death.

Options, for decision 6:

- **A. A JavaScript physics library in `apps/client`**, for example cannon-es or Rapier's JavaScript build. Quickest to measure. The client's rig may differ from the server's, which is fine for looks. Adds a second engine and its bundle size.
- **B. Jolt compiled to WebAssembly**, from the vendored `third_party/JoltPhysics` (MIT). The same engine and rig layout as the server's addon. More work: a new build target, and the size of the WebAssembly.
- **C. No ragdoll.** Keep the deaths as they are. Zero cost, and no physical fall.

Recommended: A for the first measurement, since it gives the client number soonest. B only if the look needs the server's exact rigs.

Measurement plan, once an option is chosen:

- Headless Chromium through Playwright, as in the client captures, with N cosmetic ragdolls in view at once: 1, 10, 50 and 100.
- Frame time with and without the ragdolls (median over 5 s), and the bundle size added, gzipped.
- A chart and a GIF of a crowd of falls. The GIF shows motion, so it goes with the media outside the repo, in `/mnt/project-files/marketing/physics/`.

Proposed client budget, not decided: 12% of the frame, the same share as the server budget. At 60 fps that is about 2 ms.

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
   whole island awake. That is an inference from these numbers. F7 tests it
   below.
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
| **F3.** Keep each world under the contact cap | Measured through the addon: the budget sits 12 to 19 times below the cap. Past it, bodies fall through the floor (16% at 768 awake full rigs, 46% at 1,024) | Bigger crowds need F5 or F6 | Keep 10,240 (decision 5). The addon reports a full cap each step (`lastStepErrors()`) |
| **F4.** Four-thread job pool | At 0.05 m/s, through the addon: 2.1 times at 256 uncapped full rigs (27.2 to 13.2 ms); 1.0 to 1.3 times at the cap; small light worlds slower (0.43 times at 16 rigs, 0.79 at 64) | Determinism: the same bits at 0 and 4 threads on the test scene. Each world owns its pool | Opt-in per world, default one thread (decided 2026-11-01). A pool pays off past the cap, from about 128 full rigs uncapped |
| **F5.** Cosmetic ragdolls on clients, for other players' deaths | Zero server cost: the server sends the death event and the client shows the body | Client cost not measured here. Not authoritative, so fine for looks only | Recommended. Measure the client budget |
| **F6.** Shard the world: several single-threaded worlds across cores | Not measured. Each world stays under the cap, and the work scales with cores | An addon change for more than one world. Must stay off the JS thread. Collisions across shards | Architecture decision |
| **F7.** Larger point-velocity sleep threshold | At 0.3 m/s a capped crowd sleeps within a second and costs under 0.01 ms once settled. At the default it does not sleep within 20 s and costs 3.3 to 3.6 ms a tick. Through the addon, above | A body slower than the threshold for 0.5 s freezes. A hit reached only its own rig at 0.3 m/s in one test. Needs a client look | Default 0.05 m/s, chosen by the ensemble bench (below). Client look still open |

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

Status: F1 and F2 are in PR #489, ready for review, stacked on #488 (slice 2, measured through the addon above). F7 is in PR #490, ready for review, stacked on #489 (below). F4 is measured through the addon (below), in its own PR stacked on #490. F3 is measured through the addon (below), in its own PR stacked on #492. F5 has a scope section below and no measurement: the client needs a physics option first.

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
   (142 ms at 1,000 awake rigs)? Recommended: keep it. The budget sits 12 to 19
   times below the cap (F3).
6. **Client physics for cosmetic deaths.** A JavaScript library (A), Jolt as WebAssembly (B), or no ragdoll (C)? Recommended: A, measured first. The fall's direction is a separate question (see F5).

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
