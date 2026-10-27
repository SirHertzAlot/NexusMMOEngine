/**
 * SAB Logging Layer — Phase 2 tests (docs/SAB-LOGGING-LAYER-SPEC.md §4 Phase 2)
 *
 * Covers: native C++ producers riding the integrate addon's kernels —
 * cross-language record parity (same code+args from TS and C++ decode and
 * format identically), sampled in-kernel telemetry emission with zero N-API
 * crossings, and the runtime's overrun/spiral diagnostics routing through the
 * native emitters when a log ring is attached (data-plane topology).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LogLevel,
  LogProducer,
  LogRingBuffer,
  LogProducerClient,
  LogWorkerCore,
  decodeLogRecord,
  logSimTickOverrun,
  logSimSpiralGuardFired,
} from "../src/logging/index.js";
import { SimWorkerRuntime, loadNativeKernel } from "../src/sim-worker.js";
import { createSharedMemoryPlane } from "../src/sab-store.js";

const kernel = loadNativeKernel();
const hasNativeLogProducer =
  kernel.isNative && typeof kernel.logAttachRing === "function";

interface StrippedRecord {
  level: number;
  producer: number;
  code: number;
  tick: number;
  entityRef: bigint;
  args: Array<number | bigint | string | boolean>;
}

/** A LogRecordView with the wall-clock timestamp removed (TS and C++ clocks legitimately differ). */
function stripTick(r: ReturnType<typeof decodeLogRecord>): StrippedRecord {
  return {
    level: r.level,
    producer: r.producer,
    code: r.code,
    tick: r.tick,
    entityRef: r.entityRef,
    args: r.args,
  };
}

function formattedLines(ring: LogRingBuffer): string[] {
  const lines: string[] = [];
  const core = new LogWorkerCore({ ring, flushMs: 0, onBatch: (t) => lines.push(...t.split("\n")) });
  core.pump();
  core.stop();
  return lines.map((l) => l.replace(/^\S+\s/, "")); // drop the wall-clock token
}

describe("SAB Logging Phase 2: native producers", () => {
  it("the loaded kernel exposes the Phase 2 producer surface", {
    skip: !hasNativeLogProducer && "requires a freshly built @mmo-engine/addon-integrate",
  }, () => {
    assert.equal(kernel.isNative, true);
    assert.equal(typeof kernel.logNativeTelemetryEvery, "function");
    assert.equal(typeof kernel.logSimTickOverrunNative, "function");
    assert.equal(typeof kernel.logSimSpiralGuardFiredNative, "function");
  });

  it("TS and C++ emitters produce byte-identical decodable records (same code+args)", {
    skip: !hasNativeLogProducer && "requires native addon",
  }, () => {
    const tsRing = new LogRingBuffer(64);
    const nativeRing = new LogRingBuffer(64);
    assert.ok(kernel.logAttachRing!(new Uint8Array(nativeRing.sab), 64));

    const client = new LogProducerClient(LogProducer.SIM, tsRing);
    logSimTickOverrun(client, 42, 9000);
    assert.equal(kernel.logSimTickOverrunNative!(42, 9000), true);

    const fromTs: StrippedRecord[] = [];
    tsRing.drain((r) => fromTs.push(stripTick(r)));
    const fromCpp: StrippedRecord[] = [];
    nativeRing.drain((r) => fromCpp.push(stripTick(r)));

    assert.equal(fromTs.length, 1);
    assert.equal(fromCpp.length, 1);
    assert.deepEqual(fromCpp[0], fromTs[0]);
    assert.equal(fromTs[0].level, LogLevel.WARN);
    assert.equal(fromTs[0].producer, LogProducer.SIM);
    assert.equal(fromTs[0].code, 0x0201);
    assert.deepEqual(fromTs[0].args, [42, 9000]);
  });

  it("TS and C++ records format identically through the shared worker", {
    skip: !hasNativeLogProducer && "requires native addon",
  }, () => {
    const tsRing = new LogRingBuffer(64);
    const nativeRing = new LogRingBuffer(64);
    kernel.logAttachRing!(new Uint8Array(nativeRing.sab), 64);

    const client = new LogProducerClient(LogProducer.SIM, tsRing);
    logSimTickOverrun(client, 7, 48000);
    kernel.logSimTickOverrunNative!(7, 48000);
    logSimSpiralGuardFired(client, 83);
    kernel.logSimSpiralGuardFiredNative!(83);

    const tsLines = formattedLines(tsRing);
    const cppLines = formattedLines(nativeRing);
    assert.deepEqual(cppLines, tsLines);
    assert.match(tsLines[0], /WARN\s+sim .*tick 7 budget overrun: 48000us/);
    assert.match(tsLines[1], /WARN\s+sim .*spiral guard fired: dropped 83ms backlog/);
  });

  it("sampled in-kernel telemetry flows into the ring with no per-record N-API call", {
    skip: !hasNativeLogProducer && "requires native addon",
  }, () => {
    const ring = new LogRingBuffer(256);
    const sharedMemory = createSharedMemoryPlane();
    const runtime = new SimWorkerRuntime({
      sharedMemory,
      logRingSab: ring.sab,
      logRingCapacity: 256,
      kernelTelemetryEvery: 1,
    });
    assert.equal(kernel.logIsAttached!(), true, "the runtime attached the ring natively");

    runtime.tick();
    runtime.tick();

    let telemetry = 0;
    let overrun = 0;
    ring.drain((r) => {
      if (r.code === 0x0204) {
        telemetry++;
        assert.equal(r.producer, LogProducer.SIM);
        assert.equal(r.level, LogLevel.DEBUG);
        assert.deepEqual(r.args, [10000, Math.fround(1 / 30), telemetry]);
      }
      if (r.code === 0x0201) overrun++;
    });
    assert.equal(telemetry, 2, "one telemetry record per kernel step at stride 1");
    assert.equal(overrun, 0, "values that fit the budget produce no overrun records");

    kernel.logNativeTelemetryEvery?.(0);
    runtime.stop();
  });

  it("the spiral guard diagnostic becomes a native WARN record in the data-plane runtime", {
    skip: !hasNativeLogProducer && "requires native addon",
  }, () => {
    const ring = new LogRingBuffer(256);
    const sharedMemory = createSharedMemoryPlane();
    const runtime = new SimWorkerRuntime({
      sharedMemory,
      logRingSab: ring.sab,
      logRingCapacity: 256,
      kernelTelemetryEvery: 0,
    });

    const start = 1_000;
    runtime.frame(start); // primes lastFrameMs
    // delta clamps to maxFrameDeltaMs (250ms) => 5 steps execute, ~83ms backlog dropped.
    const steps = runtime.frame(start + 10_000);
    assert.equal(steps, 5);
    const stats = runtime.stats();
    assert.equal(stats.spiralEvents, 1);

    let spiralRecord: StrippedRecord | null = null;
    let telemetryUninvited = false;
    ring.drain((r) => {
      if (r.code === 0x0202) spiralRecord = stripTick(r);
      if (r.code === 0x0204) telemetryUninvited = true;
    });
    assert.equal(telemetryUninvited, false, "telemetry stride 0 emits nothing");
    assert.ok(spiralRecord);
    assert.equal((spiralRecord as StrippedRecord).code, 0x0202);
    assert.equal((spiralRecord as StrippedRecord).producer, LogProducer.SIM);
    assert.equal((spiralRecord as StrippedRecord).level, LogLevel.WARN);
    assert.deepEqual((spiralRecord as StrippedRecord).args, [83]);
    runtime.stop();
    kernel.logNativeTelemetryEvery?.(0);
  });

  it("without a log ring the runtime stays inert (bench path unchanged)", () => {
    const sharedMemory = createSharedMemoryPlane();
    const runtime = new SimWorkerRuntime({ sharedMemory });
    runtime.tick();
    assert.equal(runtime.stats().ticks, 1);
  });
});
