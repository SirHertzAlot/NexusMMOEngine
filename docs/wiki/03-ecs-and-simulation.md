# 03. Simulation & ECS Subsystem

[← Previous: Engine / Game Decoupling](02-engine-game-split.md) | [Back to Wiki Index](README.md) | [Next: Native C++ Addons →](04-native-addons.md)

---

## 1. Overview
The simulation subsystem in [`packages/engine-core`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core) coordinates tick timing, component storage, entity lifecycle management, and spatial queries.

---

## 2. Structure-of-Arrays (SoA) ECS (`bitECS`)

The engine uses `bitECS` to maintain high simulation density without garbage collection overhead.

### Data Layout: Array of Structures vs. Structure of Arrays
Traditional OOP representations store entities as objects containing fields (`Array of Structures`, AoS):
```
[ {x, y, z, vx, vy, vz}, {x, y, z, vx, vy, vz}, ... ]  <-- Poor cache locality
```

The Nexus MMO Engine uses **Structure of Arrays (SoA)**:
```
Position X: [ x0, x1, x2, x3, ... ]
Position Y: [ y0, y1, y2, y3, ... ]
Position Z: [ z0, z1, z2, z3, ... ]
Velocity X: [ vx0, vx1, vx2, vx3, ... ]
```
When a system updates positions:
1. It streams contiguous float arrays directly through CPU cache lines ($64\text{ bytes} = 16\text{ floats}$).
2. Hardware prefetchers load upcoming data with zero cache thrashing.
3. No temporary objects are allocated, completely eliminating V8 garbage collection on the tick.

---

## 3. High-Density Integration Kernel

The primary motion pass updates positions based on linear velocity:

$$\vec{p}_{t+1} = \vec{p}_t + \vec{v}_t \cdot \Delta t$$

In [`packages/addons/integrate`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/integrate), this is executed in native C++ using SIMD vector intrinsics:
- **Throughput**: 100,000 entities integrated in **$0.2024\text{ms}$** ($2.02\text{ns}$ per entity).
- **Headroom**: Consumes only $0.6\%$ of the $33.33\text{ms}$ budget, leaving $99.4\%$ of frame time available for gameplay logic.

---


---

## 4. Native Systems & Parity Verification

In Phase 3 of the C++ Main Tick migration (`docs/CPP-MAIN-TICK-PHASE3-REPORT.md`), heavy numerical systems were migrated behind the standardized `SimSystem` interface:

- **NativeIntegrateSystem**: Directly calls native AVX2 kernel via `addon.integrate` over bitECS SoA buffers, achieving an **18.2×** speedup (27.1µs vs 494.1µs at 50k entities) with sub-millimetre hardware precision ($\le 0.37\text{mm}$ over 50 simulation steps).
- **NativeIntentSystem**: Vectorizes wish-move velocities across locomotion states (walk, swim, fly).
- **FastSpatialGrid**: Replaces dynamic template string allocations (`"${sx},${sz}"`) with packed 32-bit integer keys:
  $$\text{key} = ((\lfloor x / 64 \rfloor \ \&\ \text{0xFFFF}) \ll 16) \mid ((\lfloor z / 64 \rfloor \ \&\ \text{0xFFFF})$$
  Delivers a **1.98×** speedup while completely eliminating **100% of heap string GC pressure**.

---

## 5. B3 Load Test at Scale (51,000 Entities @ 30Hz)

Verified in `packages/engine-core/test/bench/b3-network-injected-load.bench.mjs`:
- **Scale**: 51,000 entities (1,000 player client streams + 50,000 NPCs) in a single region.
- **Network Impairment Injection**: 45ms latency, ±15ms jitter, 2% packet loss.
- **Telemetry Results**: Mean tick = **0.238ms**, p99 tick = **0.562ms** (1.7% of 33.33ms budget), **0 dropped steps**.
- **PlayerIntent Edge-Trigger Re-Fire**: Verified sub-tick transition sequence (`PRESSED -> RELEASED -> RE-PRESSED (SPRINT)`) with zero dropped edge events.

## 4. Lockless SPSC & MPSC Ring Buffers

To prevent thread contention between the network gateway, simulation loop, and persistence workers, the engine utilizes lock-free atomic queues located in [`packages/engine-core/src/lockless-ring.ts`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core/src/lockless-ring.ts):

### `AtomicSPSCQueue` (Single-Producer Single-Consumer)
- Used for command dispatch from Edge to Sim Worker, and from Sim Worker to Persist Worker.
- Padded with 64-byte cache-line isolation (`SPSC_CACHE_LINE_BYTES = 64`) between `head` and `tail` pointers to eliminate false sharing.
- Employs Rigtorp shadow index caching (`cachedHead`, `cachedTail`) to avoid cross-core cache invalidations on every operation.

### `AtomicMPSCQueue` (Multi-Producer Single-Consumer)
- Based on Dmitry Vyukov's bounded MPSC queue design.
- Each buffer slot contains an atomic sequence number paired with power-of-2 bitmask indexing.
- Allows multiple network worker threads to push incoming player commands simultaneously without acquiring mutex locks.

---

## 5. Generational Slab Allocator

Dynamic entity recycling can introduce ABA stale-slot errors if a client holds a reference to an entity ID that has since been despawned and reassigned.

The [`GenerationalSlabAllocator`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core/src/sab-store.ts) solves this:
- **Packed 32-bit Handle**:
  ```
  [ 16-bit Generation Counter | 16-bit Slot Index ]
  ```
- When slot $i$ is freed and recycled, its generation counter increments.
- Any message or query referencing `[Gen 1 | Slot 42]` will fail validation if the slot has advanced to `[Gen 2 | Slot 42]`, preventing stale state corruption.

---

[← Previous: Engine / Game Decoupling](02-engine-game-split.md) | [Back to Wiki Index](README.md) | [Next: Native C++ Addons →](04-native-addons.md)
