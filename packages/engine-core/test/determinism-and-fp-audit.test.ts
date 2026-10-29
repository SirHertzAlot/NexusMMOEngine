/**
 * Phase 4 Determinism, FP Model Audit & Fixed-Step Accumulator Suite
 * (docs/CPP-MAIN-TICK-SPEC.md §5 Phase 4)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSharedMemoryPlane,
  attachSharedMemoryPlane,
  TELEMETRY_SLOTS,
  INTENT_FLAGS,
  SOA_LAYOUT,
} from "../src/sab-store.js";
import {
  SimWorkerRuntime,
  DT,
  TICK_RATE_HZ,
  FRAME_BUDGET_MS,
} from "../src/sim-worker.js";
import { packCommandToken } from "../src/lockless-ring.js";

/** 64-bit FNV-1a hash over float array bytes to verify bit-level determinism */
function computePlaneChecksum(floatView: Float32Array, entityCount: number): bigint {
  const bytes = new Uint8Array(floatView.buffer, floatView.byteOffset, entityCount * SOA_LAYOUT.STRIDE * 4);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

describe("Phase 4: Determinism Audit & Fixed-Step Accumulator Loop", () => {
  it("maintains bit-for-bit replay determinism across 500 ticks under complex inputs", () => {
    const ENTITY_COUNT = 100;
    const TICKS = 500;

    // Generate pseudo-random deterministic input sequence
    const inputScript: Array<{ tick: number; entity: number; token: number }> = [];
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let t = 0; t < TICKS; t++) {
      for (let e = 0; e < 10; e++) {
        const entityIdx = Math.floor(rnd() * ENTITY_COUNT);
        let flags = 0;
        if (rnd() > 0.5) flags |= INTENT_FLAGS.FORWARD;
        if (rnd() > 0.7) flags |= INTENT_FLAGS.RIGHT;
        if (rnd() > 0.8) flags |= INTENT_FLAGS.SPRINT;
        if (rnd() > 0.9) flags |= INTENT_FLAGS.UP;
        inputScript.push({ tick: t, entity: entityIdx, token: packCommandToken(entityIdx, flags) });
      }
    }

    // Run 1: First simulation pass
    const sab1 = createSharedMemoryPlane(ENTITY_COUNT);
    const runtime1 = new SimWorkerRuntime({
      sharedMemory: sab1,
      entityCapacity: ENTITY_COUNT,
      mode: "matrix",
      decodeMovementIntents: true,
    });
    for (let e = 0; e < ENTITY_COUNT; e++) {
      runtime1.views.intMatrixView[e * SOA_LAYOUT.STRIDE + SOA_LAYOUT.HEALTH] = 100;
    }

    let scriptIdx1 = 0;
    for (let t = 0; t < TICKS; t++) {
      while (scriptIdx1 < inputScript.length && inputScript[scriptIdx1].tick === t) {
        runtime1.inputQueue.enqueue(inputScript[scriptIdx1].token);
        scriptIdx1++;
      }
      runtime1.tick(DT);
    }
    const checksum1 = computePlaneChecksum(runtime1.views.floatMatrixView, ENTITY_COUNT);

    // Run 2: Second independent simulation pass on fresh memory
    const sab2 = createSharedMemoryPlane(ENTITY_COUNT);
    const runtime2 = new SimWorkerRuntime({
      sharedMemory: sab2,
      entityCapacity: ENTITY_COUNT,
      mode: "matrix",
      decodeMovementIntents: true,
    });
    for (let e = 0; e < ENTITY_COUNT; e++) {
      runtime2.views.intMatrixView[e * SOA_LAYOUT.STRIDE + SOA_LAYOUT.HEALTH] = 100;
    }

    let scriptIdx2 = 0;
    for (let t = 0; t < TICKS; t++) {
      while (scriptIdx2 < inputScript.length && inputScript[scriptIdx2].tick === t) {
        runtime2.inputQueue.enqueue(inputScript[scriptIdx2].token);
        scriptIdx2++;
      }
      runtime2.tick(DT);
    }
    const checksum2 = computePlaneChecksum(runtime2.views.floatMatrixView, ENTITY_COUNT);

    assert.equal(checksum1, checksum2, "Replay checksums must be bit-for-bit identical across independent runs");
    assert.equal(runtime1.stats().ticks, TICKS);
    assert.equal(runtime2.stats().ticks, TICKS);
  });

  it("handles fixed-timestep accumulator, absorbs clock jitter, and respects spiral guard", () => {
    const ENTITY_COUNT = 50;
    const sab = createSharedMemoryPlane(ENTITY_COUNT);
    const runtime = new SimWorkerRuntime({
      sharedMemory: sab,
      entityCapacity: ENTITY_COUNT,
    });

    // 1. First frame arms the clock (0 steps)
    let t = 1000.0;
    let steps = runtime.frame(t);
    assert.equal(steps, 0, "Initial frame arms the clock");

    // 2. Advance by exactly 1 tick duration (33.33ms) -> 1 step
    t += FRAME_BUDGET_MS;
    steps = runtime.frame(t);
    assert.equal(steps, 1, "33.33ms delta executes exactly 1 tick");

    // 3. Small jitter delta (10ms) -> 0 steps (accumulated in backlog)
    t += 10.0;
    steps = runtime.frame(t);
    assert.equal(steps, 0, "Sub-step delta accumulates without stepping");

    // 4. Follow-up delta (25ms, total accumulated = 35ms) -> 1 step
    t += 25.0;
    steps = runtime.frame(t);
    assert.equal(steps, 1, "Backlog over step threshold executes step");

    // 5. Large delta triggering multiple catch-up steps (e.g. 70ms = 2 steps)
    t += 70.0;
    steps = runtime.frame(t);
    assert.equal(steps, 2, "Multi-step delta catches up properly");

    // 6. Pathological delta (> 250ms maxFrameDelta clamped, exceeding 5 steps max)
    // Simulates a 1-second tab switch or debugger pause
    t += 1000.0;
    steps = runtime.frame(t);
    assert.equal(steps, runtime.maxStepsPerFrame, "Catch-up is capped at maxStepsPerFrame (5)");
    
    const stats = runtime.stats();
    assert.equal(stats.spiralEvents, 1, "Spiral guard must record 1 spiral event");
    assert.ok(stats.droppedMs > 0, "Dropped backlog ms must be greater than 0");
  });

  it("inventories Math.* single-precision floating-point equivalents for native C++ parity", () => {
    const testValues = [0.0, 0.12345, -0.707106, 1.0, 3.1415926, 42.5];
    for (const v of testValues) {
      const f32 = Math.fround(v);
      // Math.fround truncates to IEEE-754 32-bit single precision
      const buf = new Float32Array(1);
      buf[0] = v;
      assert.equal(buf[0], f32, `Float32Array[0] must match Math.fround for value ${v}`);
    }

    // Verify 2D vector normalization behavior
    const mx = 0.707106;
    const mz = 0.707106;
    const len = Math.hypot(mx, mz);
    const inv = len > 1e-5 ? 1.0 / len : 0.0;
    const nx = Math.fround(mx * inv);
    const nz = Math.fround(mz * inv);
    assert.ok(Math.abs(Math.hypot(nx, nz) - 1.0) < 1e-6, "Normalized vector length must be ~1.0");
  });
});
