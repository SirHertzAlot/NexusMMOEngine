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
48 awake full rigs or 116 light ones. The budget does not change the answer above: 1,000 full rigs still take 110 ms.

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
| **F2.** Cap server-simulated rigs per world | 32 full rigs 2.7 ms (8%); 64 rigs 5.2 ms (16%); 128 rigs 11.6 ms (35%) | Other players' deaths need F5 | Cap size, set from the 4 ms budget (about 48 full or 116 light rigs per world) |
| **F3.** Keep each world under the contact cap | At 512 full rigs the cap does not fill and the cost is valid (64 ms) | Bigger crowds need F5 or F6 | Enforce in code, and say what happens at the cap |
| **F4.** Four-thread job pool | 1.9 times at 256 awake (25.2 to 13.0 ms); 2.4 times at 512 (63.7 to 26.8 ms) | Determinism: the addon's test must pass with threads | Accept threads, or keep one thread |
| **F5.** Cosmetic ragdolls on clients, for other players' deaths | Zero server cost: the server sends the death event and the client shows the body | Client cost not measured here. Not authoritative, so fine for looks only | Recommended. Measure the client budget |
| **F6.** Shard the world: several single-threaded worlds across cores | Not measured. Each world stays under the cap, and the work scales with cores | An addon change for more than one world. Must stay off the JS thread. Collisions across shards | Architecture decision |
| **F7.** Test a larger point-velocity sleep threshold | Not measured. Aimed at finding 5 | Sleeping bodies stop reacting; pile behaviour needs a look | Measure next, with a bench flag |

## Recommendation

Do not simulate every player's ragdoll on the server. At the engine's tick, no
count near 1,000 fits one world, with or without threads. The first slice
should be:

1. **Cosmetic ragdolls on clients for other players' deaths (F5).** They cost
   the server nothing. Measure the client budget separately.
2. **Server-side rigs only where gameplay needs the physics**: a corpse someone
   can hit, a body that blocks a path. Light rigs for crowds, and full rigs for a
   few dozen at most, inside the 4 ms budget (F1, F2).
3. **Keep each world under the contact cap (F3).** Decide threads (F4) after the
   determinism test, and sharding (F6) only if real play needs more rigs than one
   world holds.
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

## Open decisions

1. **Budget, set.** The person chose 4 ms per tick on 2026-10-31.
   1 ms (3%) holds 12 awake full rigs or 35 light ones. 2 ms (6%) holds 24 or
   65. 4 ms (12%) holds 48 or 116.
2. **Authoritative or cosmetic.** Server-simulated ragdolls for everyone, or
   cosmetic on clients for other players? Recommended: cosmetic for others.
3. **Rig fidelity.** The full rig, the light rig, or full up close and light far
   away?
4. **Threads, shards, or one thread.** The determinism question (F4, F6).
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
- Networking.

## Caveats

- **Run-to-run variance.** Between two sweeps of the same configuration on this
  container, times moved by up to about 35%. The same 256-rig awake case measured
  13.8 ms in the first sweep (one substep) and 16.4 ms in this sweep's one-substep run (`main`). Read ratios
  within one sweep. Treat absolute milliseconds as about ±30%.
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
