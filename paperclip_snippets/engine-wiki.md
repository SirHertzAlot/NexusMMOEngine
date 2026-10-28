# Nexus MMO Engine — Hierarchical Documentation Wiki

## Summary
Commissioned by Joey 2026-10-27. Comprehensive, hierarchical technical wiki documenting the entire engine architecture, design philosophy, subsystems, and developer workflows. Built purely with Markdown (`.md`), strictly focused on our engine without external comparisons or disparaging competition, and linked directly from the root `README.md` and `docs/README.md`.

## Structure & Deliverables
- **Master Technical Specification**: `docs/WIKI.md`
- **Hierarchical Chapter Hub**: `docs/wiki/README.md`
  - `01-architecture-overview.md`: 3-Tier execution topology (Edge, Core, Client), fixed 30 Hz tick loop, spiral-of-death guard, and `SharedArrayBuffer` memory plane.
  - `02-engine-game-split.md`: Blank substrate boot, modular system architecture (`modules/` via `content/modules.json`), and data-driven rule contracts (`packages/rules`).
  - `03-ecs-and-simulation.md`: `bitECS` Structure-of-Arrays (SoA) layout, SIMD vectorization, lock-free SPSC/MPSC queues, and generational slab allocation.
  - `04-native-addons.md`: In-process C++20 N-API modules (Jolt Physics, Recast/Detour, FastNoise2/FastSIMD, Manifold 3D CSG, and SIMD Poisson scatter) with bulk zero-copy memory boundaries.
  - `05-networking-and-edge.md`: `uWebSockets.js` transport, Edge/Core split, 64m sector interest management, and binary fast-path delta serialization.
  - `06-multi-region-world.md`: World server coordination, chunk registry, cross-region migration handoffs, and persistence.
  - `07-procedural-generation.md`: Continuous model synthesis, learned scene grammars, Universal Measurement System (UMS), load-bearing structural invariants, and 3D Wave Function Collapse.
  - `08-client-and-rendering.md`: Zero-logic thin client model, Three.js / React Three Fiber rendering, snapshot/delta interpolation, biomechanical first-person rig, and WebGPU modernization roadmap.
  - `09-developer-guide.md`: Environment setup (Node 22 LTS, C++ toolchain), authoring custom gameplay modules, writing native C++ addons, and running automated Playwright playtests.
- **Root Entry Point**: `README.md` updated with prominent Engine Wiki links.
