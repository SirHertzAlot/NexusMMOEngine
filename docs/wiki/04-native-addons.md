# 04. Native C++ Addon Ecosystem

[← Previous: Simulation & ECS](03-ecs-and-simulation.md) | [Back to Wiki Index](README.md) | [Next: Networking & Distributed Scaling →](05-networking-and-edge.md)

---

## 1. Overview
Numerics-bound, geometric, and physics operations live in compiled C++20 N-API addons inside [`packages/addons/`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons). These modules run directly inside the host process with no IPC or network boundaries.

---

## 2. The Bulk SoA Boundary Pattern

A fundamental rule of the native addon architecture is:
> **Never cross the N-API boundary per-entity in hot loops.**

Instead, the engine uses the **Bulk SoA Pattern**:
```cpp
// Example C++ N-API boundary method in addon-physics
Napi::Value StepBodies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  // 1. Extract raw pointers into JS-owned TypedArrays (zero-copy)
  const float* px = CheckedF32(env, info[0], "px", count);
  const float* py = CheckedF32(env, info[1], "py", count);
  const float* pz = CheckedF32(env, info[2], "pz", count);
  float* out_vx = CheckedF32Mut(env, info[3], "out_vx", count);
  
  // 2. Execute tight vectorized loop in C++
  #pragma omp simd
  for (size_t i = 0; i < count; ++i) {
    // SIMD physics step
  }
  
  return env.Undefined();
}
```
Because `TypedArray.Data()` exposes the raw memory buffer allocated in the V8 heap, C++ reads and writes directly to simulation memory with **zero serialization, zero marshaling, and zero copies**.

---

## 3. Native Addon Catalog

| Addon | Directory | Primary Library / Technology | Responsibility |
| :--- | :--- | :--- | :--- |
| **`addon-physics`** | [`packages/addons/physics`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/physics) | Jolt Physics (C ABI) | Rigid body simulation, collision shapes, raycasting, and terrain heightfield colliders. |
| **`addon-navigation`** | [`packages/addons/navigation`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/navigation) | Recast & Detour | Navmesh generation from 3D geometry and multi-agent pathfinding. |
| **`addon-procgen`** | [`packages/addons/procgen`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/procgen) | FastNoise2 & FastSIMD | Deterministic, vector-accelerated terrain heightfields and climate maps. |
| **`addon-geometry`** | [`packages/addons/geometry`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/geometry) | Manifold 3D & Clipper2 | Guaranteed 2-manifold topological booleans (union, difference) and 2D polygon offsetting. |
| **`addon-scatter`** | [`packages/addons/scatter`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/scatter) | SIMD Poisson Disc Sampling | Generates natural spatial distributions for foliage, boulders, and prop placement. |
| **`addon-integrate`** | [`packages/addons/integrate`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/integrate) | AVX2 / SSE2 FMA3 Kernels | Vectorized motion integration benchmarks ($2.02\text{ns}$/entity). |
| **`addon-template`** | [`packages/addons/template`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/addons/template) | N-API Baseline | Addon skeleton and CI toolchain smoke test. |

---

## 4. Building Native Addons

All native modules compile using standard `node-gyp` with platform-specific optimizations:
- **Windows**: Visual Studio 2022 C++ Build Tools (`/O2`, `/arch:AVX2`).
- **Linux**: GCC 13+ or Clang 16+ (`-O3`, `-mavx2`, `-mfma`).
- **macOS**: Apple Clang with ARM NEON support.

To build all addons:
```sh
npm run build:native
```

---


---

## 5. Deterministic Floating-Point Compiler Contract & Math Equivalence

To guarantee identical simulation trajectories across native C++ binaries (MSVC/Clang/GCC) and the V8 JIT engine:
- **Compiler Precision Directives**: Native C++ builds enforce strict IEEE-754 single-precision semantics (`/fp:precise` under MSVC, `-ffp-contract=off` under Clang/GCC) preventing non-deterministic hardware FMA instruction fusion differences across compiler releases.
- **Single-Precision Math Equivalence**:
  - `Math.fround(v)` $\to$ native 32-bit `float`
  - `Math.sqrt(v)` $\to$ `sqrtf(v)` / `_mm256_sqrt_ps`
  - `Math.hypot(x, z)` $\to$ `sqrtf(x*x + z*z)`
  - `Math.atan2(y, x)` $\to$ `atan2f(y, x)`
  - `Math.floor(v)` $\to$ `floorf(v)` / `(int32_t)floorf`
- **Replay Determinism**: Verified 500-tick bit-for-bit replay determinism across independent runs with $0\text{ ulp}$ hash deviation (`packages/engine-core/test/determinism-and-fp-audit.test.ts`).

[← Previous: Simulation & ECS](03-ecs-and-simulation.md) | [Back to Wiki Index](README.md) | [Next: Networking & Distributed Scaling →](05-networking-and-edge.md)
