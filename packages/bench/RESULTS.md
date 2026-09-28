# Slice 1.5 — Validation Benchmark Results

World-location decision under test: **JS world (bitECS) with C++ addons**
vs a pure C++ world, measured on the integration workload
(`position += velocity * dt`, f32 SoA).

- Date: 2026-09-27T07:36:11.159Z
- Machine: linux/x64, AMD EPYC 9D25 126-Core Processor, 7.7 GiB RAM
- Node: v24.20.0, compiler: g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0 (-O3), N-API (node-addon-api 8.x)
- bitECS 0.3.40, dt=1/30 s, 200 warmup + 1000 measured ticks per case
- Initial data: deterministic (mulberry32 seed 1337), positions in [-500, 500], velocities in [-20, 20]

## Method

- **Harness A** (the chosen shape): bitECS world sized N; per tick ONE N-API
  call `integrate(px,py,pz,vx,vy,vz,count,dt)` operating directly on the
  JS-owned Float32Array component stores. N-API TypedArray access is
  zero-copy (raw pointer into the JS heap); the only marshalling cost is
  argument validation + the call itself.
- **Harness B** (the alternative): pure C++ world (`World{n, 6x vector<float>}`);
  per tick ONE N-API call `stepWorld(handle, dt)` with no data movement.
- Both harnesses execute the **same** `integrate_kernel`; a 60-tick
  correctness check per size asserts **bit-exact** A/B position equality.
- Empty N-API call overhead measured separately (100k `noop()` calls).

## Results

| entities | harness | mean (ms) | p95 (ms) | max (ms) | ns/entity | p95 headroom vs 33.33 ms |
|----------|---------|-----------|----------|----------|-----------|--------------------------|
| 1,000 | B | 0.0033 | 0.0024 | 0.3110 | 3.25 | 100.0% |
| 1,000 | A | 0.0033 | 0.0033 | 0.0255 | 3.27 | 100.0% |
| 10,000 | B | 0.0190 | 0.0195 | 0.0817 | 1.90 | 99.9% |
| 10,000 | A | 0.0217 | 0.0206 | 1.0373 | 2.17 | 99.9% |
| 100,000 | B | 0.2581 | 0.2769 | 4.2456 | 2.58 | 99.2% |
| 100,000 | A | 0.2024 | 0.2121 | 0.5149 | 2.02 | 99.4% |

Empty N-API call overhead: **58.9 ns/call**.

## Verdict

**HOLD — harness A p95 (0.021 ms) is 0.1% of the 33.33 ms budget at 10k entities, under the 50% reopen line. JS-world decision stands.**

## Caveats

- Harness A measures the steady-state bulk-call shape from the plan: one
  N-API call per tick over shared buffers. JS-side per-entity iteration
  (queries, archetype walks) is not part of this workload; the slice-1.2
  sim (1k entities, full tick incl. FlatBuffers encode) measured p95
  ~11–17 ms, which bounds the real-world orchestration cost.
- Single-threaded; one run per config (run-to-run variance is GC noise —
  max column shows the spike tail).
- Benchmark order per size was B then A with fresh state each; a GC was
  requested between phases when --expose-gc is present.
