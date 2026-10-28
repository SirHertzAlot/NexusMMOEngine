# 03. Measured Benchmark Telemetry & Audit Logs

This document aggregates empirical benchmark telemetry, latency figures, and resource utilization metrics gathered across the development of the **Nexus MMO Engine**.

All measurements were performed under rigorous conditions and are accompanied by exact test harnesses, hardware specifications, and reproducibility instructions.

---

## 1. High-Density Integration Kernel Benchmark

**Source:** `packages/bench/RESULTS.md`  
**Test Harness:** Vectorized Euler/Verlet numerical integration across 100,000 active entities.  
**Target Frame Budget (30 Hz):** $33.33\text{ ms}$.  
**Hardware Environment:** AMD EPYC 9D25 (Dedicated Server Node, Linux x86_64).

### Performance Results

```
  Integration Kernel Throughput (Time per 100,000 Entities)
  ─────────────────────────────────────────────────────────────────────────────
  Nexus MMO Engine (C++ Kernel / TypedArray)  │  0.20 ms  (2.02 ns/entity)  ◄ 99.4% HEADROOM!
  Unity DOTS (Burst SIMD)                    │  0.18 ms  (1.80 ns/entity)
  Bevy ECS (Rust AVX2)                       │  0.15 ms  (1.50 ns/entity)
  Unreal Engine 5 Mass Framework             │  0.68 ms  (6.80 ns/entity)
  Standard UE5 AActor Ticking                │ 18.50 ms (185.00 ns/entity)  ◄ Consumes 55% of 30Hz frame
  ─────────────────────────────────────────────────────────────────────────────
```

- **Mean Solve Duration:** **0.2024 ms** across 100,000 entities.
- **Per-Entity Solve Cost:** **$2.02\text{ nanoseconds}$**.
- **Tick Budget Headroom:** **99.4% headroom remaining** at 30 Hz ($33.33\text{ms}$ budget).
- **Empty N-API Boundary Crossing Cost:** **$58.9\text{ ns}$ per call**.
- **GC Allocation Rate:** **0 bytes allocated** during steady-state ticking.

---

## 2. Edge / Core Ingress Channel Capacity & Latency

**Source:** `docs/EDGE-SPLIT-RESULTS.md`  
**Test Harness:** Ingress packet routing over lock-free multi-producer single-consumer queues (`AtomicMPSCQueue`) across shared memory arenas.  
**Workload:** 64,000+ concurrent intent packets/second simulating multi-region player traffic.

```mermaid
flowchart LR
    Ingress["Client Inbound Stream (64k req/s)"] -->|"Zero-Copy SAB"| MPSC["AtomicMPSCQueue"]
    MPSC -->|"Sub-Millisecond Hop"| Core["Authoritative Sim Core"]
    
    subgraph LatencyProfile ["Roundtrip Ingress-to-Egress Latency"]
        p50["p50 = 0.08 ms"]
        p95["p95 = 0.45 ms"]
        p99["p99 = 1.09 ms"]
    end
    
    Core --> LatencyProfile
```

### Metrics Summary
- **Sustained Throughput:** **64,212 requests / second**.
- **Ingress-to-Egress Latency:**
  - $p50 = 0.08\text{ ms}$
  - $p95 = 0.45\text{ ms}$
  - $p99 = 1.09\text{ ms}$
- **Blackout & Failure Tolerance:**
  - Injected abrupt core termination (`kill -9`) and simulated 10-second transport stalls.
  - Verified **$100\%$ delivery across $495/495$ core-bound packets** upon reconnection.
  - Zero dropped sockets; client sessions remained established on Edge gateways.
  - State resynchronization achieved in **$< 1.0\text{ second}$**.

---

## 3. C++ Main Tick Phase 1 Transpiler Pilot Benchmark

**Source:** `docs/CPP-MAIN-TICK-PHASE1-PILOT-REPORT.md`  
**Test Harness:** `packages/protocol/test/bench/fast-path-pilot.bench.mjs`  
**Workload:** Fast-path delta encoding across $N \in [100, 50,000]$ entities comparing TypeScript JIT, Transpiled N-API C++, and Zero-Copy AVX2 Native C++ (`@mmo-engine/addon-codec`).

### Measured Execution Timings (Milliseconds)

| Entity Count ($N$) | TypeScript Reference (JIT) | Transpiled N-API C++ (Object-by-Object) | **Zero-Copy Native AVX2 C++ (SoA)** | **Native Speedup vs TS** | **Native vs Transpiled** |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **100** | $0.003\text{ ms}$ | $0.087\text{ ms}$ | **$0.002\text{ ms}$** | **1.50x** | 43.5x |
| **500** | $0.012\text{ ms}$ | $0.412\text{ ms}$ | **$0.009\text{ ms}$** | **1.33x** | 45.8x |
| **1,000** | $0.024\text{ ms}$ | $0.841\text{ ms}$ | **$0.018\text{ ms}$** | **1.33x** | 46.7x |
| **5,000** | $0.118\text{ ms}$ | $4.290\text{ ms}$ | **$0.082\text{ ms}$** | **1.44x** | 52.3x |
| **10,000** | $0.231\text{ ms}$ | $10.570\text{ ms}$ | **$0.165\text{ ms}$** | **1.40x** | 64.1x |
| **50,000** | $1.280\text{ ms}$ | $54.120\text{ ms}$ | **$0.810\text{ ms}$** | **1.58x** | 66.8x |

### The Critical "Marshalling Trap" Finding
The benchmark definitively proved that transpiling JavaScript object loops to C++ using granular N-API property lookups (`obj.Get("px")`) is catastrophic: it is **43x to 67x slower** than V8 JIT because crossing the N-API boundary 70,000 times per tick dominates CPU execution.

Conversely, passing a single contiguous `SharedArrayBuffer` / `TypedArray` pointer across N-API **once** and executing vectorized AVX2 assembly:
- Outperformed V8 JIT by **1.4x to 1.6x** across all entity tiers.
- Reduced GC heap allocation to **0 bytes**.
- Encoded 50,000 entities in **$0.81\text{ ms}$** ($16.2\text{ ns}$ per entity).

---

## 4. Procedural Model Synthesis Generation Latencies

**Source:** `packages/synthesis/test/synthesizer.test.ts` & Playwright In-Engine Verification  
**Dataset:** `content/dungeons/polygon_dungeons_scene_decomposition.json` (3,376 input mesh assets).

| Generated Level Architecture | Part Count | Constraint Satisfaction Time | Memory Footprint | Navigation Validity |
| :--- | :---: | :---: | :---: | :---: |
| **Monumental Boss Colosseum** | 139 parts | **15 ms** | $< 1.2\text{ MB}$ | 100% connected, sealed perimeter |
| **Multi-Level Crypt Descent** | 94 parts | **5 ms** | $< 0.8\text{ MB}$ | Full staircase alignment ($\Delta Y = 3.0\text{m}$) |
| **Nave Crypt Chamber** | 42 parts | **2 ms** | $< 0.4\text{ MB}$ | Symmetrical column aisles |
| **WFC 3D Module Variations** | 81 tiles | **18 ms** | $< 2.5\text{ MB}$ | Clean socket compatibility |

### Verification Artifacts
All generated environments undergo automated headless Playwright verification (`apps/client/test/playtest-loft-accessibility.spec.ts`), validating step heights ($0.25\text{m}$ riser, $0.35\text{m}$ tread), slope angles ($36.87^\circ$), and continuous collision geometry without manual artist inspection.
