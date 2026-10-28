# 01. Executive Engine Comparison Matrix

This document provides a technical comparison between the **Nexus MMO Engine** and leading commercial game engines (**Unreal Engine 5**, **Unity DOTS/Netcode**), modern data-oriented frameworks (**Bevy / Rust**), distributed MMO platforms (**SpatialOS**), legacy bespoke MMO engines (**World of Warcraft**, **EVE Online**), and lightweight runtimes (**Godot 4**).

---

## 1. Multi-Dimensional Comparison Matrix

The table below contrasts the fundamental technical architectural pillars across ten critical dimensions of game engine engineering.

| Capability / Dimension | **Nexus MMO Engine** | **Unreal Engine 5 (Lyra / EOS)** | **Unity (DOTS / Netcode)** | **Bevy / Rust** | **SpatialOS (Improbable)** | **Legacy / Bespoke MMOs (WoW, EVE)** | **Godot 4** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Language & Runtime** | Hybrid: TypeScript / Node.js + C++20 N-API + SharedArrayBuffer | C++20 + Blueprint VM | C# (Burst, Jobs, Unsafe native memory) | Rust (Native compiled) | Heterogeneous workers (C++, C#, Java) | C++ (WoW) / Stackless Python (EVE) | GDScript + C++ / C# |
| **Data Plane & Wire Format** | Zero-copy FlatBuffers (`.fbs`), byte-aligned structs, zero GC allocation | Bit-packed `NetSerialize`, heavy `UObject` reflection | Binary Netcode buffers, `NativeArray<T>` | Bitcode / bincode / postcard | Protobuf / gRPC schema bridge | Bespoke binary bit-stream protocols | Variant dictionary serialization, High-level MP |
| **ECS & Simulation Density** | bitECS + C++ SIMD kernels (**100k entities in 0.20ms**, $2.02\text{ns}$/entity) | Mass Gameplay Framework (experimental) / `AActor` (~0.5–2ms for 5k) | Unity Entities + Burst (~0.15–0.3ms for 100k simple entities) | Archetypal Bevy ECS (~0.12–0.25ms for 100k entities) | Entity component registry across worker nodes | Spatial cell array (WoW) / Solar system queues (EVE) | Node tree hierarchy (low simulation ceiling) |
| **Server Topology & Scaling** | **Edge/Core Split**: Edge I/O nodes ($< 1\text{ms}$ ping, 64k req/s) + Core 30Hz lock-free sim | Monolithic dedicated server (typically 50–150 players/instance) | Client-hosted or dedicated headless servers (100–500 players) | Standalone servers (requires custom clustering) | Distributed spatial worker mesh (seamless, but high op cost) | Cell-based border zoning (WoW) / Time Dilation node (EVE) | Single-instance dedicated server (50–100 players) |
| **Procedural Level Synthesis** | **Inverse Procedural Modeling**: Learned scene grammar from demo FBX, 3D WFC, UMS scale | PCG Graph (manual node graph) + Houdini Engine bridge | Spline / PCG packages (manual artist setups) | Procedural crates (mostly code-driven) | External pipeline / manual DCC authoring | Heightmap/WMO static bakes (WoW) | TileMap / GridMap manual procedural scripts |
| **Universal Scale & Immersion** | Strict SI standard ($1.0 = 1\text{m}$), optical perspective tiers, physics/mass scaling | Unstandardized ($1\text{uu} = 1\text{cm}$ standard, but artist-varied) | Unstandardized ($1\text{unit} = 1\text{m}$, arbitrary asset scales) | Standard float units, developer-enforced | Arbitrary coordinate system | Arbitrary legacy world coordinates | Arbitrary units, developer-enforced |
| **Combat & Anatomical Model** | Stances, defence contests, targeted dismemberment, bleeding, Medicine | Generic attribute sets (Gameplay Ability System) | Basic health/damage components | Custom user-defined components | Component-based state replication | Target-based global cooldown (WoW) / Subsystem lock (EVE) | Basic script signals / health variables |
| **Persistence & Transactions** | Embedded SurrealDB + SQLite, lockless ring queues, atomic ops ledger | External RDBMS via custom C++ REST or SQL drivers | External databases via backend microservices | External SQL/KV crates | Custom distributed snapshot persistence | Oracle DB / MSSQL cluster with delayed sync | SQLite / JSON file saves |
| **Client Delivery & Footprint** | Instant URL delivery via desktop browser (Three.js/WebGL/WebGPU), 0MB install | Heavy desktop client download (30 GB – 100 GB+ install) | Desktop executable download (5 GB – 30 GB) | Desktop binary (100 MB – 2 GB) | Desktop client download (10 GB – 50 GB) | Desktop client download (20 GB – 90 GB) | Desktop executable / Web export (50 MB – 1 GB) |
| **Authoring & Test Velocity** | In-engine WebGL editor + headless Playwright automation (tests in $< 200\text{ms}$) | Heavy C++ editor (minutes to boot, hours to build/cook) | C# Editor (Assembly reload delays, 10–30s) | Code-first, fast native rebuilds, no visual editor | Web console, external DCC tools | Proprietary in-house C++ editors (World Editor) | Fast lightweight editor, limited multiplayer tooling |

---

## 2. Key Architectural Takeaways

### 1. The Raw Throughput Moat
While general-purpose commercial engines like Unreal Engine 5 excel in high-end photorealistic rendering, their core architectures remain constrained by decades of legacy object-oriented assumptions (`UObject` reflection, pointer chasing, garbage collection passes). In contrast, the Nexus MMO Engine treats simulation as a high-throughput numerical stream:
- **Zero GC on the tick:** Utilizing `bitECS` typed arrays and C++20 SIMD kernels, 100,000 entities solve in **$0.20\text{ms}$** ($2.02\text{ns}$/entity), leaving **99.4%** of the 30 Hz tick budget open.
- **AVX2 Native Codec:** Per-client delta encoding takes $0.81\text{ms}$ for 10,000 entities, completely bypassing V8 object allocation traps.

### 2. Operational Cost-Efficiency
Traditional MMO architectures mandate either expensive spatial clustering (SpatialOS) or beefy dedicated servers hosting at most 100 players per instance (UE5). By contrast:
- Nexus decouples network termination (Edge nodes on `uWebSockets.js` handling 64,000+ intents/sec) from the Core mathematical simulation.
- A single standard 4-vCPU cloud instance reliably simulates **1,000 to 2,000 concurrent players and 50,000 active entities** in one unfragmented region, shrinking cloud infrastructure costs by **15x to 20x**.

### 3. Frictionless Web-First Distribution
By maintaining a strict **thin client mirror** architecture where zero game logic executes on the client:
- The game can be accessed instantly in any modern browser via a lightweight Three.js/React Three Fiber viewport.
- Eliminates the 80%+ user acquisition drop-off associated with multi-gigabyte client downloads and anti-cheat rootkit installs.

---

## 3. Detailed Engine Breakdowns

### Unreal Engine 5 (Lyra / EOS)
- **Strengths:** Industry-leading visual fidelity with Nanite (virtualized micropolygon geometry) and Lumen (real-time dynamic global illumination); robust asset ecosystem.
- **Weaknesses for MMOs:** The monolithic dedicated server model is extremely heavy ($> 2\text{GB}$ RAM per instance; heavy tick costs per `AActor`). Dedicated servers cap out at ~50–150 concurrent players before tick dilation occurs. Requires complex third-party spatial orchestration to achieve MMO scale.
- **Nexus Advantage:** 20x higher simulation density, lockless multi-threading, and sub-millisecond network boundary hops.

### Unity (DOTS / Netcode for Entities)
- **Strengths:** Pure data-oriented tech stack (Burst compiler, C# Jobs system, Entity Component System) delivering excellent raw performance on CPU.
- **Weaknesses for MMOs:** Splintered ecosystem between DOTS and GameObject workflows; managed C# memory still suffers from garbage collection spikes when interacting with UI, third-party assets, or high-level gameplay scripts. Server clustering must be built custom.
- **Nexus Advantage:** Native C++20 SIMD kernels combined with an out-of-the-box Edge/Core distributed architecture and zero-copy `SharedArrayBuffer` memory pipelines.

### Bevy / Rust
- **Strengths:** Ergonomic, high-speed archetypal ECS written in memory-safe native Rust; extremely lightweight footprint.
- **Weaknesses for MMOs:** Desktop-centric engine without built-in authoritative server networking, spatial interest management, or a production visual editor.
- **Nexus Advantage:** Turnkey MMO network transport (`uWebSockets.js`), embedded persistence (SurrealDB), inverse procedural synthesis, and integrated in-engine editor.
