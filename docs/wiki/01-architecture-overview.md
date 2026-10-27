# 01. Architectural Blueprint

[← Back to Wiki Index](README.md) | [Next: Engine / Game Decoupling →](02-engine-game-split.md)

---

## 1. Overview
The Nexus MMO Engine is an authoritative, data-oriented spatial simulation engine engineered for large-scale persistent virtual worlds. 

The architecture physically isolates:
1. **Network Ingress & Session Handling** ([`apps/edge`](file:///c:/Users/user/Downloads/mmo-engine-full/apps/edge))
2. **Authoritative Simulation** ([`packages/engine-core`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core))
3. **World Coordination & Persistence** ([`packages/world-server`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/world-server))
4. **Client Visualization** ([`apps/client`](file:///c:/Users/user/Downloads/mmo-engine-full/apps/client))

---

## 2. The 3-Tier Execution Topology

```mermaid
flowchart LR
    Client["Browser Mirror Client<br/>(React 19 + Three.js)"]
    Edge["Edge Gateway Node<br/>(uWebSockets.js)"]
    Core["Authoritative Sim Core<br/>(30 Hz fixed loop + bitECS)"]
    World["World Server<br/>(SurrealDB registry)"]

    Client <-->|"Binary WS (FlatBuffers)"| Edge
    Edge <-->|"Zero-Copy SAB Ring"| Core
    Core <-->|"Async Transaction Ring"| World
```

### Tier 1: Client Mirror
- The browser client runs **no authoritative game logic**.
- The client receives binary snapshots and deltas, interpolates transforms, predicts local camera movement, and sends user intents back to the server.

### Tier 2: Edge Ingress Layer
- Runs `uWebSockets.js` directly over native C++ socket polling.
- Authenticates users, rate-limits requests, validates packets against strict schemas, and routes intents to the simulation core.
- Computes sector-based Area of Interest (AoI) and serializes binary delta frames per connection.

### Tier 3: Authoritative Simulation Core
- Fixed 30 Hz simulation loop ($dt = 1/30\text{s} = 33.33\text{ms}$).
- Owns all canonical entity state, spatial indexing, physics step integration, and module updates.
- Steps native C++ kernels directly in-process via N-API with zero per-entity serialization overhead.

---

## 3. The Hybrid Data Plane

Communication across threads uses lock-free queues over a single page-aligned `SharedArrayBuffer`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   SHAREDARRAYBUFFER MEMORY ARENA                       │
├────────────────────┬────────────────────┬──────────────────────────────┤
│ 1. Planar SoA      │ 2. Lockless Rings  │ 3. Telemetry Counters        │
│ Contiguous columns │ AtomicSPSCQueue    │ Atomic tick metrics,         │
│ (px, py, pz, ...)  │ AtomicMPSCQueue    │ packet counts, drop counters │
└────────────────────┴────────────────────┴──────────────────────────────┘
```

1. **Planar SoA Component Storage**: Contiguous 64-byte aligned columns of floats/integers, enabling direct SIMD vector processing.
2. **Lockless Command Rings**: Single-producer and multi-producer queues operating via atomic CAS (Compare-And-Swap) operations without mutex locks.
3. **Atomic Telemetry**: Thread-safe atomic counters tracking tick duration, frame drops, and queue depths.

---

## 4. The 30 Hz Fixed Timestep Loop

The loop in [`packages/engine-core/src/tick-loop.ts`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core/src/tick-loop.ts) decouples simulation time from wall-clock variance:

- **Accumulator**: Wall time is accumulated; when accumulated time exceeds $33.33\text{ms}$, a tick executes.
- **Spiral Guard**: If frame time exceeds $166.6\text{ms}$ (5 catch-up ticks), excess backlog is dropped and counted as a `spiralEvent`. This prevents catastrophic frame death cascades.

---

[← Back to Wiki Index](README.md) | [Next: Engine / Game Decoupling →](02-engine-game-split.md)
