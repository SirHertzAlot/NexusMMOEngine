# SAB Phases 2–5 — Performance Evidence

Measured 2026-10-20 on the `arlo/sab-phase5` branch (stack tip at the
time of measurement: `8a578f2`, which is current `main` @ 987530d plus
the SAB Phases 2–5 stack and two integration fixes). Companion chart:
`docs/performance-sab.png`. Raw bench output was captured during the
PR verification runs; the numbers below are quoted from those runs,
not re-derived.

## What is being measured

The stack's own benchmark gates — the benches that ship with the code:

| Bench | File | Compares |
|---|---|---|
| Fast-path codec | `packages/protocol/test/bench/fast-path.bench.mjs` | fast-path v1 vs FlatBuffers Delta (same position + linear-velocity data) |
| Sector fan-out | `packages/engine-core/test/bench/b5-pubsub.mjs` | per-topic `publish()` vs per-socket send loop, 1,000 real subscribers, 1,200-byte delta, 60 iterations |
| SoA wire encoding | `packages/engine-core/test/bench/snapshot-soa.bench.mjs` | SoA encode direct from SAB-backed stores vs collect + row-encode (same world state) |
| B3 push overhead | `packages/engine-core/test/bench/b3-push-overhead.mjs` | added latency of the push path vs its 0.5 ms mean budget |
| B4 delta bandwidth | `packages/engine-core/test/bench/b4-delta-bandwidth.mjs` | delta frame bytes + encode percentiles over 300 ticks vs an encode-p99 < 5 ms budget |

**Before/after shape:** each bench carries its own old-vs-new
comparison inside one process on identical data, so the comparison is
intrinsic. The benches (and the new-path APIs they exercise) do not
exist on pre-stack `main`, so there is no meaningful "run the same
bench on main" — the old path inside the bench *is* the pre-stack
behaviour.

## Environment and method

- Sandbox VM: AMD EPYC 9D25 (as self-reported by the B4 bench),
  7.7 GiB RAM **shared with other tenants**, Linux, node v24.20.0,
  native addons built with gcc 13.3 via the repo's node-gyp path.
- Each bench does its own warmup/iteration protocol (fast-path: 200
  iterations after 20 warmup; b5: 60 back-to-back iterations with
  drain excluded from the timed section; B4: 300 ticks).
- Single measurement session per bench. Absolute numbers are
  this-machine numbers; the **ratios** are the durable claim.
  Re-run on dedicated hardware before quoting absolutes elsewhere.
- No rendering is involved anywhere in these paths (SwiftShader/GPU
  state of the sandbox is irrelevant here).

## Results

### Fast-path v1 codec vs FlatBuffers Delta (position + velocity)

| N | FB encode (row) | FB encode (SoA) | fast-path encode | decode FB | decode fast-path | bytes FB | bytes fast-path |
|---|---|---|---|---|---|---|---|
| 1,000 | 1.130 ms | 0.805 ms | **0.050 ms (16.2× vs SoA)** | 0.570 ms | **0.063 ms (9.1×)** | 96,488 | **32,012 (3.01× smaller)** |
| 5,000 | 3.101 ms | 3.175 ms | **0.161 ms (19.8× vs SoA)** | 2.433 ms | **0.220 ms (11.1×)** | 480,488 | **160,012 (3.00× smaller)** |

(The SoA-fed fast-path encoder variant measured 0.161 ms @ N=1,000
and 0.873 ms @ N=5,000 — still faster than FlatBuffers, but the
row-fed encoder is the fast one; both are reported by the bench.)

### Sector-topic fan-out (1,000 subscribers, per tick)

| Transport | Layout | Send loop | Publish | Speedup |
|---|---|---|---|---|
| uWS (production) | 1 topic | 6.025 ms | **0.500 ms** | **12.0×** |
| uWS (production) | 8 topics | 6.315 ms | **0.471 ms** | **13.4×** |
| ws (fallback) | 1 topic | 8.674 ms | 8.863 ms | 0.98× (parity) |
| ws (fallback) | 8 topics | 8.445 ms | 8.649 ms | 0.98× (parity) |

The win lives on uWS, whose publish fans out natively; the `ws`
fallback emulates publish with a subscriber loop, so parity there is
by design, not a regression.

### SoA wire encoding from SAB views (Phase 3)

| N | Snapshot old | Snapshot new | Delta old | Delta new |
|---|---|---|---|---|
| 2,000 | 3.292 ms | **2.878 ms (−12.6%)** | 1.152 ms | **1.047 ms (−9.1%)** |
| 10,000 | 16.222 ms | **14.333 ms (−11.6%)** | 6.042 ms | **5.381 ms (−10.9%)** |

**Byte equality: PASS** at every N — the SoA path emits identical
bytes to the collect + row-encode path; this is a pure CPU win with
no wire change.

### B3 push overhead

Added mean **0.352 ms** against a < 0.5 ms mean budget — **PASS**
(920 pushes received, p99 3.61 ms, max 16.60 ms).

### B4 delta bandwidth — one honest miss

Delta encode percentiles over 300 ticks (mean frame bytes and
bandwidth at 30 Hz scale linearly with entity count):

| Entities | Mean frame | KB/s @30 Hz | Encode mean | Encode p99 | Budget p99 < 5 ms |
|---|---|---|---|---|---|
| 1,000 | 75,606 B | 2,215 | 0.285 ms | 2.084 ms | **met** |
| 5,000 | 375,123 B | 10,990 | 1.916 ms | 11.738 ms | missed |
| 10,000 | 749,526 B | 21,959 | 2.456 ms | 12.883 ms | missed |

Means stay low at every scale; the **p99 tail** blows the budget at
5k/10k entities *in this sandbox* (max spikes 32–38 ms smell like
shared-tenancy noise and GC, not encoder cost — the same workload's
mean is 2.5 ms). Stated plainly: the B4 p99 gate does **not** pass
here at high entity counts. Re-measure on dedicated hardware before
treating the tail as a property of the code.

### Phases 2 and 4 (no bench mode exists)

- **Phase 2 (physics zero-copy boundary)** ships no benchmark; its
  evidence is functional — the physics addon suite is green (11/11,
  including the determinism tests) with the SAB-view boundary in
  place.
- **Phase 4 (worker sharing)** is gated by the contention suite, not
  a bench: multi-worker atomic harvest reconciles *exactly* under
  contention, and a single-pool CAS hotspot shows retries happening
  with reconciliation still exact (`sab-contention.test.ts`, green).

## Caveats

- Shared sandbox: absolute latencies (especially p99 tails) are
  pessimistic and noisy; ratios between the old and new paths
  measured back-to-back in one process are the reliable signal.
- The fast-path codec covers position + linear velocity only; ticks
  needing other component blocks still ride FlatBuffers, and the
  codec fails closed to FlatBuffers on any layout/version anomaly
  (covered by `fast-path.test.ts`).
- Fan-out gains assume the uWS transport; deployments on the `ws`
  fallback get correctness, not speed.
