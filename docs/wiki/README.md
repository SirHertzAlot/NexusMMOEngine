# Nexus MMO Engine Documentation Wiki

Welcome to the hierarchical documentation wiki for the **Nexus MMO Engine**. This knowledge base guides developers, systems architects, and technical designers through the design, implementation, and extension of the engine.

---

## 📖 Wiki Navigation

The wiki is organized into focused, hierarchical chapters:

### 🏛️ Fundamentals & Architecture
* **[Master Wiki Specification](../WIKI.md)**: The unified, complete single-page technical manual.
* **[01. Architectural Blueprint](01-architecture-overview.md)**: The 3-tier execution model (Edge, Core, Client), fixed 30 Hz tick loop, and zero-copy memory plane.
* **[02. Engine / Game Decoupling](02-engine-game-split.md)**: The unconstrained engine substrate, zero-content boot, modular gameplay system architecture (`modules/`), and data-driven rule contracts.

### ⚡ Simulation & Native Systems
* **[03. Simulation & ECS Subsystem](03-ecs-and-simulation.md)**: `bitECS` Structure-of-Arrays (SoA) layout, SIMD vectorization, lock-free SPSC/MPSC queues, and generational slab allocation.
* **[04. Native C++ Addon Ecosystem](04-native-addons.md)**: In-process C++20 N-API modules: Jolt Physics, Recast/Detour Navigation, FastNoise2/FastSIMD, Manifold 3D CSG, and SIMD Poisson scatter.

### 🌐 Networking & Scale
* **[05. Networking & Distributed Scaling](05-networking-and-edge.md)**: `uWebSockets.js` native transport, Edge/Core split, 64m sector interest management, and binary fast-path delta serialization.
* **[06. Multi-Region World Coordination](06-multi-region-world.md)**: World server coordination, chunk registry, cross-region migration handoffs, and persistence.

### 🎨 Worlds, Assets & Viewport
* **[07. Procedural Generation & Spatial Synthesis](07-procedural-generation.md)**: Continuous model synthesis, learned scene grammars, Universal Measurement System (UMS), load-bearing structural invariants, and 3D Wave Function Collapse.
* **[08. Client & Viewport Mirror](08-client-and-rendering.md)**: Zero-logic thin client model, Three.js / React Three Fiber rendering, snapshot/delta interpolation, biomechanical first-person rig, and WebGPU modernization.

### 🛠️ Developer Operations & Guides
* **[09. Developer Guide & Module Authoring](09-developer-guide.md)**: Environment setup (Node 22 LTS, C++ toolchain), authoring custom gameplay modules, writing native C++ addons, and running automated Playwright playtests.
* **[10. Architectural Decision Log](../DECISIONS.md)**: Chronological record of locked architectural decisions.
* **[11. Engine Roadmap](../ROADMAP.md)**: Active milestones, deliverables, and development schedule.

---

## 🎯 Quick Reference Links
- Master Wiki: [`docs/WIKI.md`](file:///c:/Users/user/Downloads/mmo-engine-full/docs/WIKI.md)
- Getting Started Guide: [`docs/GETTING-STARTED.md`](file:///c:/Users/user/Downloads/mmo-engine-full/docs/GETTING-STARTED.md)
- Wire Schema (`mmo_engine.fbs`): [`packages/schema/mmo_engine.fbs`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/schema/mmo_engine.fbs)
- Engine Core: [`packages/engine-core`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core)
- Native Addons: [`packages/addons`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons)
