# Next implementation roadmap — 2026-10-26

The working sequence for the two priorities Joey set (animation, IO),
plus the one designed-and-waiting piece (logging). This is the thread
roadmap; the repo's `docs/ROADMAP.md` remains the official status board.
Parked items are listed at the end so they stay visible but out of the
way. Sizes are relative (S/M/L), not calendar promises.

## Step 0 — Land what's already built (needs Joey's word)

- **Push `arlo/persist-ledger-perf`** (`95d2d3ff`): batched ledger
  appends + O(1) head reads; world-server suite 120/0. Local only until
  he says go.
- **Live SurrealDB 2.7.0 re-verification** of the ledger fix: the
  numbers so far are the embedded 3.x engine; the soak ran against a
  real 2.7.0 server. Needs the 2.7.0 binary stood up locally. (S)

## Track A — Animation (critical path for AAA demands)

From the pipeline audit (`mmo-engine-animation/ANIMATION-PIPELINE-AUDIT.md`).
The runtime half is built and merged; every step below is the supply half.

- **A0 — Pin the supply line (S/M).** Source manifest with hashes +
  expected-clip inventory; convert fails loud on a missing source
  instead of silently skipping per machine; Mesh2Motion wired as a
  proper pinnable CC0 source. Ends "works on my machine" library builds.
- **A1 — One retargeter (M).** Unify the two bone maps into the bake
  `Retargeter`; the client utility shares it or retires. The 16/66-bone
  Mesh2Motion result becomes a permanent regression test.
- **A2 — Validation gate (M).** Real `validateClip` in the convert path
  (loop continuity, foot slide, bone budgets); the Mesh2Motion grades
  become regression fixtures — 175 pass must pass, the 3 known fixes
  must flag.
- **A3 — Measure, then compress + LOD (M).** Library bytes measured;
  compression decision (acl vs gltfpack/meshopt vs accept) made on
  evidence; animator benchmarked at 100/300/1,000 characters;
  animation LOD aligned with ResidentSystem tiers.
- **A4 — See it (S, hardware-dependent).** D9 held-frame strand +
  real-GPU capture pass (same owed run as the D1 shader bench);
  creature skeletal path decided on record (bosses/mounts/dragons)
  instead of discovered mid-production.

## Track B — IO (after the ledger slice)

- **B1 — Atomic-op round trips (M).** Same measure-first treatment as
  the ledger: each op currently pays `getOpResult` + `storeOpResult`
  plus the `fn::*` invocation through core. Profile per-op latency
  against live-shaped load, then cut round trips where semantics allow.
- **B2 — Recall under realistic conditions (S).** Re-run the 54k-event
  recall now that append/head are fixed; the >900 s soak figure was
  measured against the old shapes competing under load — establish the
  new number honestly.
- **B3 — Network fan-out load test (M).** Never measured: bot clients
  against the gateway, delta fan-out at hundreds of connected clients
  in one region. This is the last big unknown in the speed/IO picture.

## Step C — Logging phase 1 (designed, awaiting Joey's word)

SAB lockless ring + dedicated log worker + structured records from
birth; no new dependency. This is the prerequisite store for the
GraphQL live-ops observability layer scoped 2026-10-14. Redis Streams
enters only at the world-tier fan-in, when multi-region is real. (M)

## Parked (visible, not in the way)

- Localized asset caching (parked 2026-10-26)
- Client cosmetic physics module — Newton evaluated, blocked for web;
  Rapier vs Jolt-WASM spike specced (parked 2026-10-26)
- PELAGIA D5/D10/D12 gate-record decision (open, unraised since 10-26)
- Character Foundation Phase 0; model-synthesis Phase 1; AI-synthesis
  forks / first slice (stimulus bus + blackboard)
- Push words owed on older local branches: dead-region lock release,
  shader library + D1, multi-settlement spawn, terrain erosion,
  contention harness, combat-module comment
- Decisions log: game name filing, auth/email vendors, bigcat,
  Sketchfab, TRELLIS.2 naming

## Sequencing note

Tracks A and B touch disjoint packages (art/client vs world-server),
so they can interleave freely; Claude's lane is untouched either way.
The single blocking decision for the critical path is the animation
start (A0+A1 together, or A0 alone first).
