# Zero-Copy Hybrid Engine Data Plane (`HYBRID-DATA-PLANE.md`)

Authoritative specification and benchmark record for the **Zero-Copy Hybrid Engine Data Plane** (`packages/engine-core/src/{sab-store,lockless-ring,sim-worker,persist-worker,data-plane-server}.ts`, `packages/addons/integrate/src/integrate.cc`, and `packages/engine-core/src/persist/schema.surrealql`).

---

## 1. System Topology

The Hybrid Data Plane isolates high-frequency network ingestion, deterministic 30Hz physics/movement integration, and ACID persistence into three dedicated execution contexts communicating exclusively over page-aligned `SharedArrayBuffer` regions and 64-byte cache-line-padded lockless SPSC rings:

1. **Master Thread (`data-plane-server.ts`)**:
   - Runs `uWebSockets.js` (`ws` fallback) on `/ws/sim` (`compression: DISABLED`, `maxPayloadLength: 64`).
   - Parses raw 4-byte binary frames (`[Uint16 entityIndex (LE), Uint16 actionCode (LE)]`) via `DataView` with zero JSON parsing or V8 heap allocation churn.
   - Packs `(entityIndex << 16) | (actionCode & 0xFFFF)` into a single 32-bit command token and enqueues it into `AtomicSPSCQueue` at `OFFSETS.RINGS`.

2. **Simulation Worker Thread (`sim-worker.ts` + `engine_kernel.node`)**:
   - Executes at a strict 30Hz tick cadence (`FRAME_BUDGET_MS = 33.33 ms`, `DT = 1 / 30`).
   - Drains the lockless `AtomicSPSCQueue` (via single-item `dequeue()` or single-fence `drainTo()`), mutates `INTENT_BIT` directly in the shared matrix, and dispatches `ENTITY_CHECKPOINT` transactions onto the secondary `AtomicSPSCTransactionQueue` whenever `INTENT_FLAGS.PERSIST_CHECKPOINT` is set.
   - Calls the zero-copy C++ N-API simulation kernel (`stepSimulation`, `applyIntentsAndStep`, or 4-wide SSE2 branchless `stepSimulationSoA`).
   - Updates lockless atomic telemetry counters at `OFFSETS.TELEMETRY` (`TELEMETRY_SLOTS`).

3. **Persistence Worker Thread (`persist-worker.ts` + `persist/schema.surrealql`)**:
   - Runs an embedded SurrealDB engine (`@surrealdb/node`, supporting `mem://` and `rocksdb://`).
   - Applies `schema.surrealql` (`SCHEMAFULL` `entity` with unique `sab_index >= 0`, `inventory_slot` with `capacity > 0`, and `owns` graph relation `IN entity OUT inventory_slot` with unique `structural_ownership` index).
   - Asynchronously drains `AtomicSPSCTransactionQueue` at `OFFSETS.PERSIST_RING` to commit ACID checkpoints and inventory transfers off the simulation thread.

---

## 2. Shared Memory Arena Layout (`sab-store.ts`)

| Constant / Offset | Value | Description |
| :--- | :--- | :--- |
| `DATA_PLANE_ENTITY_CAPACITY` | `10,000` | Default entity slot count for the hybrid matrix plane |
| `SOA_LAYOUT.STRIDE` | `8` (`32 bytes`) | `[POSITION_X, POSITION_Y, POSITION_Z, VELOCITY_X, VELOCITY_Y, VELOCITY_Z, HEALTH, INTENT_BIT]` |
| `OFFSETS.MATRIX` | `0` | Start of the 32-byte-strided entity matrix (`Float32Array` & `Int32Array` aliased views) |
| `OFFSETS.RINGS` | `320,000` | Primary lockless `AtomicSPSCQueue` (Master Gateway $\rightarrow$ Simulation Worker) |
| `OFFSETS.PERSIST_RING` | `336,384` | Secondary lockless `AtomicSPSCTransactionQueue` (Simulation Worker $\rightarrow$ Persistence Worker) |
| `OFFSETS.TELEMETRY` | `369,152` | Lockless `Int32Array` telemetry slots (`TICK_COUNT`, `LAST_TICK_US`, `MAX_TICK_US`, etc.) |
| `OFFSETS.BAKE` | `385,536` | Start of the 32MB heap region for chunks, navmesh bakes, and 64-byte-aligned Planar SoA columns |

---

## 3. Lockless Synchronization & DoD Enhancements (`lockless-ring.ts`)

- **64-Byte Cache-Line Padding (`SPSC_CACHE_LINE_BYTES = 64`)**: `head` (`offset + 0`), `tail` (`offset + 64`), and `buffer` (`offset + 128`) reside on separate CPU cache lines to prevent false-sharing invalidations between producer and consumer cores.
- **Rigtorp Shadow Index Caching**: Producer caches `cachedTail` and only issues `Atomics.load(this.tail, 0)` when the ring appears full; consumer caches `cachedHead` and only issues `Atomics.load(this.head, 0)` when the ring appears empty.
- **Single-Fence Batching (`enqueueBatch`, `drainTo`)**: Drains an entire frame's worth of commands with a single acquire load on `head` and a single release store on `tail`, achieving **103.43 Million ops/sec** (`9.67 ns/op`).

---

## 4. Empirical Benchmarks (`hybrid-data-plane-bench.ts`)

| Entity Count | JS Reference (`ms`) | C++ Strided `stepSimulation` (`ms`) | C++ Fused `applyIntentsAndStep` (`ms`) | C++ Planar SoA SSE2 `stepSimulationSoA` (`ms`) | Planar SIMD Speedup vs JS |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1,000** | `0.0078 ms` | `0.0013 ms` | `0.0020 ms` | `0.0020 ms` | **3.96x** |
| **10,000** | `0.0833 ms` | `0.0378 ms` | `0.0656 ms` | **`0.0070 ms`** | **11.95x** |
| **50,000** | `0.5029 ms` | `0.2127 ms` | `0.3735 ms` | **`0.0369 ms`** | **13.63x** |
| **100,000** | `0.9873 ms` | `0.4814 ms` | `0.7890 ms` | **`0.0805 ms`** | **12.27x** |

- **30Hz Stress Test (300 Ticks @ 10,000 Entities + 512 Binary Commands/Tick):**
  - `p50 = 0.0499 ms`, `p95 = 0.0896 ms`, `p99 = 0.1422 ms`, `mean = 0.0576 ms` (**`0.173%`** of the `33.33 ms` frame budget, **0 overruns**).
