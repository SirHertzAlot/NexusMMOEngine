# SAB Logging Layer — Phase 2 Report (Native Producers)

Implements `docs/SAB-LOGGING-LAYER-SPEC.md` §4 Phase 2: native kernels/sim worker emit
records through the generated C++ header, with a cross-language parity gate. Branch
`feat/sab-logging-phase2`.

---

## 1. What shipped

### Native producer inside the tick addon

The producer lives in the addon that already hosts the tick kernels
(`@mmo-engine/addon-integrate`, targets `integrate` + `engine_kernel`), because the
`perhaps-telemetry` emission must run *inside* the C++ step functions with no N-API
boundary crossing.

| File | Role |
| --- | --- |
| `packages/addons/integrate/src/log_producer.h` | Header-only `mmo::logging::NativeLogProducer`: once attached, emits 128-byte records into the ring SAB **directly on raw memory** — same Vyukov bounded MPSC ticket loop, same word layout, same level-mask filter and drop counting as `packages/logging/src/logging/producer.ts`. Amortized `std::chrono::steady_clock` timestamp (refreshed every 16 emits, matching the TS `emitCount` cadence). Win32 `Interlocked*` / GCC `__atomic*` CAS intrinsics. |
| `packages/addons/integrate/src/integrate.cc` | Static member definitions + N-API surface: `logAttachRing(Uint8Array, capacity)`, `logNativeTelemetryEvery(n)`, `logIsAttached()`, `logSimTickOverrunNative(tick, durationUs)`, `logSimSpiralGuardFiredNative(droppedMs)`, `logNativeEmit2(level, producerId, code, tick, entLo, entHi, tag0, val0, tag1, val1)` (fixed positional args; no object traversal — AGENTS.md §6). All three step kernels (`stepSimulation`, `stepSimulationSoA`, `applyIntentsAndStep`) call `maybeKernelTelemetry(entityCount, dt)` after their work: one branch when disabled. |
| `packages/addons/integrate/binding.gyp` | Adds `../../../packages/logging/src/logging/generated` include dir so `src/log_producer.h` consumes `log_codes.h` (generated, keep-in-sync by codegen). |
| `packages/addons/integrate/index.d.ts` | TypeScript declarations for the new surface. |

### Dictionary addition

Append-only (spec §2.3: codes are never reused):

| Code | Name | Producer | Level | Format | Notes |
| --- | --- | --- | --- | --- | --- |
| `0x0201` | `SIM_TICK_OVERRUN` | SIM | WARN | `[sim] tick {0} budget overrun: {1}us` | now also emitted natively when a ring is attached |
| `0x0202` | `SIM_SPIRAL_GUARD_FIRED` | SIM | WARN | `[sim] spiral guard fired: dropped {0}ms backlog` | **new emission site**: the runtime never logged the spiral diagnostic before Phase 2 (telemetry counter only) |
| `0x0204` | `SIM_KERNEL_TELEMETRY` | SIM | DEBUG | `[sim] kernel telemetry: entities={0} dt={1} step={2}` | new; sampled (stride-configurable, default 256 when the producer attaches) |

Regenerated outputs: `generated/log_codes.h`, `generated/log-api.ts`
(`logSimKernelTelemetry`), `generated/log-formatters.ts`. `npm run gen -w @mmo-engine/logging`
is byte-reproducible (verified: a second run produced no diff).

### Runtime wiring (`packages/engine-core/src/sim-worker.ts`)

- `SimWorkerConfig.kernelTelemetryEvery?: number` (default 256 when attached, `0` disables).
- On construction with `logRingSab`/`logRingCapacity`, once `new LogRingBuffer(...)`
  exists and `kernel.isNative && kernel.logAttachRing` is available, the runtime calls
  `logAttachRing(new Uint8Array(ring.sab), capacity)` **once** and enables the telemetry stride.
  `loadNativeKernel()` feature-detects the optional functions, so older addon binaries
  keep working (TS-producer fallback).
- `SimWorkerRuntime.tick()`: budget overrun → `kernel.logSimTickOverrunNative(tickNum, elapsedUs)`
  when natively attached, else the existing TS `logSimTickOverrun` fallback; nothing when ring-less (benches).
- `SimWorkerRuntime.frame()`: spiral guard → `kernel.logSimSpiralGuardFiredNative(droppedMs)`
  (native) / `logSimSpiralGuardFired` (TS fallback) / silent (no ring).

### Decode fix (`packages/logging/src/logging/log-record.ts`)

`ARG_TAGS.F32` records now decode as floats: C++ writes IEEE-754 bits into the low
word; decode re-interprets them through a `Uint32Array`/`Float32Array` scratch pair.
TS producers never set `F32`, so existing records are unaffected.

---

## 2. Gate evidence

| Gate (spec §4 Phase 2) | Evidence |
| --- | --- |
| Cross-language parity green | `logging-phase2-native.test.ts`: same code+args emitted TS-side (`LogProducerClient`) and C++-side decode to **deep-equal** records (all fields except the legitimately-differing wall-clock timestamp), and format **identically** through the real `LogWorkerCore` (`WARN sim [sim] tick 7 budget overrun: 48000us`, `WARN sim [sim] spiral guard fired: dropped 83ms backlog`). Native emitters stamp tick-metadata `0` to match the TS producer's default (metadata tick is not part of the code+args contract). |
| Native records flowing end-to-end in the data-plane topology | A real `SimWorkerRuntime` over a production `createSharedMemoryPlane()` with the ring attached: in-kernel telemetry records (`0x0204`, producer SIM, DEBUG, `args=[10000, fround(1/30), step]`) appear after each kernel step with **zero per-record N-API calls** (emission happens inside `maybeKernelTelemetry`); the spiral guard emits `0x0202` WARN with `args=[83]` after a clamped 10 s frame spike; stride `0` = no records; ring-less runtime stays inert. |
| Suite green | Logging: 27/27 (`logging-phase0`, `logging-phase1`, `logging-phase2-native`). Adjacent sim/data-plane: 18/18 (`sim-worker-crash-drill`, `hybrid-data-plane`, `data-plane-production-boot`, `determinism-and-fp-audit`; run with `--test-force-exit`, the suite's standard flag — without it known worker-thread teardown hangs appear on Windows, same class as the documented `net/transport` note). Addon regression: `packages/addons/integrate` 10/10. Perf budget: `persist` store p95 1.67 ms (limit 5 ms) — saveSnapshot path unaffected. `npm run lint`: OK. |

---

## 3. Design notes / constraints honored (AGENTS.md §6)

- **Zero per-record N-API crossings.** `logAttachRing` acquires the ring base pointer
  once; every hot emission is raw C++ memory + CAS on the SAB. `maybeKernelTelemetry`
  is one predictable branch when disabled (`telemetryEvery_ == 0`) or detached.
- **Fixed positional arguments only.** The generic seam `logNativeEmit2` takes
  scalars (`level, producerId, code, tick, entLo, entHi, tag0, val0, tag1, val1`);
  no arrays, closures, or rest parameters exist on the native path.
- **No `performance.now()` traps.** One `std::chrono::steady_clock` call per 16 records,
  identical amortization to the TS producer.
- **No checksum drift.** Layout constants (`MPSC_HEADER_BYTES=192`, 32-word records,
  ctrl-word indices `0/16/32/36..43`) are compiled into `log_producer.h` and asserted in
  the parity test; both implementations write `[level u8 | producer u8 | code u16]`,
  `flags=0 | version=1`, and zeroed inline-string bytes for numeric-only records.
- **Ring sizing discipline.** The producer validates power-of-two capacity and the exact
  byte length (`192 + cap*4 + cap*128`) and refuses attach otherwise — mirroring
  `LogRingBuffer`/`AtomicMPSCQueue` construction. Runtime attach is skipped when an
  explicit `kernel` was injected for benches.

## 4. Follow-ups carried to Phase 3

- Gateway `logs` topic + worker→gateway batch handoff (spec §4 Phase 3) — unchanged.
- Optional extension: dictionary-aware inline-string emission from native producers
  (`logNativeEmit2` supports numeric tags only; `STRING_INTERNED` tables would ride the
  same seam later).
- Environmental carry-over from Phase 1 §7: Windows/Node 25.9.0 `--test-force-exit`
  libuv teardown artifact (`net/transport`) and the intermittent RocksDB `EPERM` cleanup
  in `persistence-core` remain process-level, not producer-related.
