# @mmo-engine/addon-physics

Jolt Physics native addon for the MMO engine: authoritative rigid-body
simulation behind a bulk, structure-of-arrays N-API boundary (Phase 2).

## What lives where

| Side | Owns |
|---|---|
| JS (engine-core) | `Transform`, `Velocity`, `BodyConfig` components — the authoritative config |
| Native (`native/physics_world.cpp`) | Jolt `PhysicsSystem`, temp allocator, job system, layer setup, the entity→`BodyID` map, shape cache |

The native entity→`BodyID` map **never crosses to JS**. Identity on
the wire and in the addon API is always the engine's u64 wire id
(`generation << 32 | slot`); `BodyID`s are purely native.

Per tick, exactly three bulk calls move all bodies — no per-entity
N-API on the hot path:

```
syncBodies(count, …) → step(dt, subSteps) → copyResults(count, …)
```

All native-world operations run on the JS thread, never concurrently.

## Build

Vendored Jolt builds offline from a clean clone — no network access
needed (`third_party/JoltPhysics`, pinned commit, see `VENDORING.md`).

**Requirements: cmake ≥ 3.20** (Jolt's minimum — stricter than the
3.10 the procgen addon documents), a C++17 compiler, `make`/`ninja`,
and `node-gyp`. A plain `npm install` builds everything:

1. The `jolt_bundle` gyp action runs `scripts/build-jolt.sh`, which
   drives CMake over the vendored Jolt tree plus
   `native/physics_world.cpp` into two static archives
   (`build/jolt/lib/libJolt.a`, `libphysics_native.a`).
2. node-gyp compiles **only** `src/physics.cc` (the N-API shim) and
   links the archives into `build/Release/physics.node`.

### Why the two-stage build

The shim includes only `native/physics_c_api.h` (a pure-C ABI) —
**never Jolt headers**. Jolt's compile definitions
(`JPH_OBJECT_LAYER_BITS=16`, …), SIMD architecture flags (AVX2/SSE)
and LTO settings are set by Jolt's own CMake and propagate to the
wrapper translation unit by linking against the `Jolt` target. The
shim therefore cannot introduce an ABI mismatch no matter what the
host compiler defaults to.

Production build requirements (from the Phase 2 evaluation):

- `CMAKE_POSITION_INDEPENDENT_CODE=ON` — the archives link into
  `physics.node`, a shared object (Jolt's default CMake is not PIC).
- The wrapper target keeps Jolt's `INTERPROCEDURAL_OPTIMIZATION=ON`
  (Release default), so the final node-gyp link passes `-flto=auto`
  (slim-LTO objects — without it the link fails).

## API (`index.js`)

```js
const { createWorld, ShapeKind, MotionType, SyncFlags } = require('@mmo-engine/addon-physics');
const world = createWorld();

world.addBodies({ count, entityIds, shapeKind, halfExtents, radius, mass,
  friction, restitution, motionType, layer, pos, quat, linVel, angVel });
world.removeBodies(entityIds);            // BigUint64Array; idempotent
world.syncBodies(count, entityIds, pos, quat, linVel, angVel, flags, dt);
world.step(dt, subSteps);                 // dt > 0, subSteps >= 1
world.copyResults(count, entityIds, pos, quat, linVel, angVel);
world.bodyCount();                        // diagnostics
world.destroy();                          // explicit; idempotent
```

- `shapeKind`: `ShapeKind.Box` (0, uses `halfExtents`),
  `ShapeKind.Sphere` (1, uses `radius`) or `ShapeKind.Capsule` (2, uses
  `radius` and `halfExtents.y`, half the straight section; upright, its
  base at the body's position: a character's feet). `motionType`:
  `MotionType.Static` (0) / `Kinematic` (1) / `Dynamic` (2).
  `layer`: 0 → NON_MOVING (static geometry), anything else → MOVING.
- `addBodies` is **order-sensitive**: pass entities in ascending
  wire-id order (the engine-core `PhysicsSystem` does this) so native
  insertion order is deterministic across processes.
- `syncBodies`: kinematic bodies follow the given transform every
  tick (Jolt derives their velocity from the frame delta); dynamic
  bodies ignore it unless `SyncFlags.Teleport` is set (respawns,
  restores); static bodies are skipped. `linVel`/`angVel` are reserved.
- `step(dt, subSteps)`: `dt` seconds total, internally substepped
  (`dt/subSteps` per Jolt `Update` with one collision step each — the
  fixed-timestep pattern Jolt's docs recommend). The engine runs
  30 Hz ticks with 2 substeps.
- Invalid input throws a JS `TypeError`/`RangeError`; a C++ exception
  never crosses the boundary (`NAPI_DISABLE_CPP_EXCEPTIONS`).
- `destroy()` is explicit and idempotent; the C++ finalizer tears the
  world down as a backstop if the caller forgets.

### Server ragdolls

`addRagdolls(ids, rigKind, pos)` adds Jolt `Ragdoll`s (capsule parts joined by
swing-twist joints) to the same physics system as the bodies. `RagdollRig.Full`
is 11 bodies; `RagdollRig.Light` is 5 (no arms, one capsule per leg). `pos`
holds 3 floats per id: the root where each rig is dropped.

- **Budget.** Each world has a budget in units. A full rig costs 5 and a light
  rig 2. The default budget of 240 holds 48 full rigs or 120 light ones, which
  is the cost gate's 4 ms per tick (see the bench below). A batch that would
  exceed the budget throws a `RangeError` and changes nothing. So does a
  repeated or already present id, and an unknown rig kind.
- `removeRagdolls(ids)` is idempotent. `copyRagdollRoots(ids, pos)` writes each
  rig's root position (NaN for an unknown id). `ragdollCount()`,
  `ragdollUnits()`, `ragdollBudget()` and `setRagdollBudget(units)` report and
  set the budget; a lower budget refuses new rigs and keeps the ones present.
- Rigs step with the bodies and sleep as Jolt decides: the production
  configuration (sleep on, the addon's defaults).
- `sleepThreshold()` and `setSleepThreshold(metresPerSecond)` set Jolt's point-velocity sleep threshold for the whole world (default 0.03 m/s; a larger value lets resting bodies sleep sooner). `ragdollActiveBodies()` counts the ragdoll bodies still simulating. Measured in the sleep bench below.
- **Not yet covered:** the determinism fingerprint does not include rigs, and
  the thread pool stays off. Both are the next slices.

## Determinism

Jolt is deterministic given **the same binary and the same
mutating-API call order** (Jolt `Docs/Architecture.md`,
"Deterministic Simulation"). What we guarantee and what we don't:

- **Guaranteed:** the same scene stepped on the same build produces
  bit-identical results across processes and runs. Pinned by
  `test/determinism.test.js` (three fresh processes, exact f32-bit
  fingerprint over a scene with stacked spheres, a kinematic platform
  and mixed shapes/masses).
- **Deliberately avoided:** broadphase/narrowphase query result
  ordering, contact-listener callbacks and `GetActiveBodies()` —
  Jolt documents these as nondeterministic (multithreaded). If a
  future feature needs them, collect-and-sort before the results feed
  game logic.
- **Single-threaded job system** (`JobSystemSingleThreaded`): maximum
  determinism, no per-world thread-pool overhead. A thread pool is a
  future tuning knob if physics ever shows up in tick profiles.

### `CROSS_PLATFORM_DETERMINISTIC` — open decision

Left **OFF** (upstream default). Turning it ON buys determinism across
different compilers/OSs at roughly 8% simulation cost. Revisit when
the deploy target needs heterogeneous dedicated servers; the
determinism test will catch any behavioral change from flipping it.

## Engine integration

engine-core's `PhysicsSystem` (`packages/engine-core/src/systems.ts`)
implements the narrow `SimSystem` interface over an injected
`PhysicsBackend`. Production wires `createJoltBackend()` (this
addon); tests inject a mock. Entities carrying `BodyConfig` are
simulated by `PhysicsSystem`; `IntegrateSystem` excludes them
(`Not(BodyConfig)`) so motion is never double-applied. `BodyConfig`
is ComponentId 5 and round-trips through the Snapshot/Delta codec and
persistence restore.

## Shape-settings footgun (documented, fixed)

Jolt: a stack-allocated `ShapeSettings` passed into
`BodyCreationSettings` must call `SetEmbedded()`, or teardown can
bad-free (caught via ASan in the Phase 2 spike). This addon
heap-allocates every settings object (`JPH::Ref<ShapeSettings>`) —
the footgun cannot recur here.

## Ragdoll cost bench

`npm run bench:ragdoll` (repo root) measures what simulated ragdolls add to a
physics step. `bench/ragdoll-cost.cpp` links against this package's compiled
Jolt objects, so build the addon first (`npx node-gyp rebuild` here). It runs
Jolt's own `Ragdoll` (11 bodies, 10 swing-twist joints; `--rig light` is 5
bodies) from 0 to 1,000 rigs, in four scenarios (`settle`, `awake`, `apart`,
`resting`), under six configurations: the bench defaults (`main`), two substeps
with the bench's limits (`substeps2`), the engine's tick (`production`: two
substeps and the addon's temp allocator and contact cap), and the engine's tick
with a thread pool (`threads4`), a lighter rig (`light`) or a shorter sleep
time (`sleep0.1`). It writes `docs/ragdoll-cost-results.json`. `-- --quick`
runs three counts once and writes no file. Needs a C++17 compiler (`$CXX`, or
`c++`); Linux and macOS. A full run takes a while, so start it in the
background.

The addon path, the one the engine runs, has its own bench: `npm run bench:ragdoll:addon` (repo root) builds a resting world through this addon's rig API, with the budget on and off, and writes `docs/addon-ragdoll-results.json`. The sweep and what it shows are in [the scope doc](../../../docs/RAGDOLL-COST-GATE.md#through-the-addon-f1-and-f2).

The sleep threshold has its own sweep: `npm run bench:sleep:addon` (repo root) settles a resting crowd for 20 s at each threshold, times 2 s, and checks that a sphere wakes a sleeping rig. It writes `docs/addon-sleep-threshold-results.json`.

## License

Jolt Physics: MIT, © 2021 Jorrit Rouwe (see `third_party/JoltPhysics/LICENSE`).
Addon glue (native wrapper, shim, JS boundary): same license as the engine.
