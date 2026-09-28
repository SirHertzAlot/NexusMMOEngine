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

- `shapeKind`: `ShapeKind.Box` (0, uses `halfExtents`) or
  `ShapeKind.Sphere` (1, uses `radius`). `motionType`:
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

## License

Jolt Physics: MIT, © 2021 Jorrit Rouwe (see `third_party/JoltPhysics/LICENSE`).
Addon glue (native wrapper, shim, JS boundary): same license as the engine.
