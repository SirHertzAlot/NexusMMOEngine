/**
 * Zero-Copy Hybrid Engine Data Plane Benchmark & Stress Test Suite
 * (`hybrid-data-plane-bench.ts`).
 *
 * Benchmarks:
 * 1. Lockless SPSC Ring Throughput (Single-item vs Single-Fence Batch Drain/Enqueue)
 * 2. Simulation Core Integration Kernels (JS vs C++ Strided Matrix vs C++ Fused Intents vs C++ Planar SoA Branchless SSE2 SIMD)
 *    across 1k, 10k, 50k, and 100k entities under 50% alive/dead high branch-entropy load.
 * 3. End-to-End 30Hz Frame Budget Stress Test (300 ticks @ 10,000 entities + 512 commands/tick + SurrealDB ACID persistence).
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import {
  DATA_PLANE_ENTITY_CAPACITY,
  INTENT_FLAGS,
  SOA_LAYOUT,
  attachSharedMemoryPlane,
  createSharedMemoryPlane,
  syncMatrixToPlanar,
} from "./sab-store.js";
import { AtomicSPSCQueue, packCommandToken } from "./lockless-ring.js";
import { DT, FRAME_BUDGET_MS, SimWorkerRuntime, loadNativeKernel } from "./sim-worker.js";
import { PersistenceWorkerRuntime } from "./persist-worker.js";

export interface KernelBenchRow {
  entityCount: number;
  jsMs: number;
  cppMatrixMs: number;
  cppFusedMs: number;
  cppPlanarSimdMs: number;
  speedupMatrixVsJs: number;
  speedupPlanarVsJs: number;
  speedupPlanarVsMatrix: number;
}

export interface RingBenchResult {
  totalOps: number;
  singleOpMillionPerSec: number;
  singleOpNsPerItem: number;
  batchOpMillionPerSec: number;
  batchOpNsPerItem: number;
  speedupBatchVsSingle: number;
}

export interface StressTestResult {
  ticks: number;
  entityCapacity: number;
  commandsPerTick: number;
  totalCommandsProcessed: number;
  totalPersistCommitted: number;
  frameBudgetMs: number;
  p50TickMs: number;
  p95TickMs: number;
  p99TickMs: number;
  maxTickMs: number;
  meanTickMs: number;
  budgetUtilizationPct: number;
  budgetOverruns: number;
  tickSamplesMs: number[];
}

export interface FullBenchmarkReport {
  timestamp: string;
  platform: string;
  nodeVersion: string;
  isNativeKernel: boolean;
  ring: RingBenchResult;
  kernels: KernelBenchRow[];
  stress30Hz: StressTestResult;
}

function jsReferenceMatrixStep(floatMatrixView: Float32Array, entityCount: number, dt: number): void {
  const intMatrixView = new Int32Array(
    floatMatrixView.buffer,
    floatMatrixView.byteOffset,
    floatMatrixView.length,
  );
  for (let i = 0; i < entityCount; i++) {
    const base = i * SOA_LAYOUT.STRIDE;
    if (intMatrixView[base + SOA_LAYOUT.HEALTH] <= 0) continue;
    floatMatrixView[base + SOA_LAYOUT.POSITION_X] += floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] * dt;
    floatMatrixView[base + SOA_LAYOUT.POSITION_Y] += floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] * dt;
    floatMatrixView[base + SOA_LAYOUT.POSITION_Z] += floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] * dt;
  }
}

function benchmarkRing(): RingBenchResult {
  const sab = new SharedArrayBuffer(64 * 1024);
  const q = new AtomicSPSCQueue(sab, 0, 1024);
  const totalOps = 2_000_000;
  const chunk = 512;

  // Warmup
  for (let i = 0; i < 10_000; i++) {
    q.enqueue(i);
    q.dequeue();
  }
  q.reset();

  // 1. Single enqueue/dequeue loop (with Rigtorp shadow index caching)
  const t0 = performance.now();
  let remaining = totalOps;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    for (let i = 0; i < n; i++) q.enqueue(i);
    for (let i = 0; i < n; i++) q.dequeue();
    remaining -= n;
  }
  const singleElapsedMs = performance.now() - t0;

  // 2. Single-fence batch enqueueBatch / drainTo
  q.reset();
  const inBatch = new Int32Array(chunk);
  const outBatch = new Int32Array(chunk);
  for (let i = 0; i < chunk; i++) inBatch[i] = packCommandToken(i, INTENT_FLAGS.FORWARD);

  const t1 = performance.now();
  remaining = totalOps;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    q.enqueueBatch(inBatch, n);
    q.drainTo(outBatch, n);
    remaining -= n;
  }
  const batchElapsedMs = performance.now() - t1;

  const singleOpNsPerItem = (singleElapsedMs * 1e6) / totalOps;
  const batchOpNsPerItem = (batchElapsedMs * 1e6) / totalOps;
  const singleOpMillionPerSec = totalOps / (singleElapsedMs * 1000);
  const batchOpMillionPerSec = totalOps / (batchElapsedMs * 1000);

  return {
    totalOps,
    singleOpMillionPerSec: Number(singleOpMillionPerSec.toFixed(2)),
    singleOpNsPerItem: Number(singleOpNsPerItem.toFixed(2)),
    batchOpMillionPerSec: Number(batchOpMillionPerSec.toFixed(2)),
    batchOpNsPerItem: Number(batchOpNsPerItem.toFixed(2)),
    speedupBatchVsSingle: Number((singleElapsedMs / batchElapsedMs).toFixed(2)),
  };
}

function benchmarkKernels(): KernelBenchRow[] {
  const kernel = loadNativeKernel();
  const counts = [1_000, 10_000, 50_000, 100_000];
  const iterations = 400;
  const rows: KernelBenchRow[] = [];

  for (const entityCount of counts) {
    const sab = createSharedMemoryPlane(entityCount, 8);
    const views = attachSharedMemoryPlane(sab, entityCount);
    const { floatMatrixView, intMatrixView, planar } = views;

    // Seed pseudo-random 50% alive / 50% dead entities (maximum branch-predictor entropy)
    let rng = 0x12345678;
    for (let i = 0; i < entityCount; i++) {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      const base = i * SOA_LAYOUT.STRIDE;
      floatMatrixView[base + SOA_LAYOUT.POSITION_X] = (i % 100) * 0.5;
      floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = 1.0;
      floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = (i % 100) * -0.5;
      floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] = 2.5;
      floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] = 0.25;
      floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] = -1.75;
      intMatrixView[base + SOA_LAYOUT.HEALTH] = (rng & 1) === 0 ? 100 : 0;
      intMatrixView[base + SOA_LAYOUT.INTENT_BIT] =
        (rng & 3) === 0 ? INTENT_FLAGS.FORWARD | INTENT_FLAGS.RIGHT : 0;
    }
    syncMatrixToPlanar(views, entityCount);

    // Warmup
    for (let w = 0; w < 25; w++) {
      jsReferenceMatrixStep(floatMatrixView, entityCount, DT);
      kernel.stepSimulation(floatMatrixView, entityCount, DT);
      kernel.applyIntentsAndStep(floatMatrixView, entityCount, DT, 5.0);
      kernel.stepSimulationSoA(
        planar.px,
        planar.py,
        planar.pz,
        planar.vx,
        planar.vy,
        planar.vz,
        planar.hp,
        entityCount,
        DT,
      );
    }

    const tJs0 = performance.now();
    for (let it = 0; it < iterations; it++) {
      jsReferenceMatrixStep(floatMatrixView, entityCount, DT);
    }
    const jsMs = (performance.now() - tJs0) / iterations;

    const tMat0 = performance.now();
    for (let it = 0; it < iterations; it++) {
      kernel.stepSimulation(floatMatrixView, entityCount, DT);
    }
    const cppMatrixMs = (performance.now() - tMat0) / iterations;

    const tFused0 = performance.now();
    for (let it = 0; it < iterations; it++) {
      kernel.applyIntentsAndStep(floatMatrixView, entityCount, DT, 5.0);
    }
    const cppFusedMs = (performance.now() - tFused0) / iterations;

    const tSoa0 = performance.now();
    for (let it = 0; it < iterations; it++) {
      kernel.stepSimulationSoA(
        planar.px,
        planar.py,
        planar.pz,
        planar.vx,
        planar.vy,
        planar.vz,
        planar.hp,
        entityCount,
        DT,
      );
    }
    const cppPlanarSimdMs = (performance.now() - tSoa0) / iterations;

    rows.push({
      entityCount,
      jsMs: Number(jsMs.toFixed(4)),
      cppMatrixMs: Number(cppMatrixMs.toFixed(4)),
      cppFusedMs: Number(cppFusedMs.toFixed(4)),
      cppPlanarSimdMs: Number(cppPlanarSimdMs.toFixed(4)),
      speedupMatrixVsJs: Number((jsMs / cppMatrixMs).toFixed(2)),
      speedupPlanarVsJs: Number((jsMs / cppPlanarSimdMs).toFixed(2)),
      speedupPlanarVsMatrix: Number((cppMatrixMs / cppPlanarSimdMs).toFixed(2)),
    });
  }

  return rows;
}

async function run30HzStressTest(): Promise<StressTestResult> {
  const entityCapacity = DATA_PLANE_ENTITY_CAPACITY; // 10,000 entities
  const sab = createSharedMemoryPlane(entityCapacity, 16);
  const sim = new SimWorkerRuntime({
    sharedMemory: sab,
    entityCapacity,
    inputRingCapacity: 1024,
    mode: "fused-intents",
    useBatchDrain: true,
  });
  const persist = new PersistenceWorkerRuntime({
    sharedMemory: sab,
    entityCapacity,
    dbUrl: "mem://",
  });
  await persist.init();

  // Initialize all 10,000 entities with active health and velocities
  for (let i = 0; i < entityCapacity; i++) {
    const base = i * SOA_LAYOUT.STRIDE;
    sim.views.floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] = 1.25;
    sim.views.floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] = -0.75;
    sim.views.intMatrixView[base + SOA_LAYOUT.HEALTH] = 100;
  }

  const ticks = 300; // 10 simulated seconds @ 30Hz
  const commandsPerTick = 512;
  const cmdBatch = new Int32Array(commandsPerTick);
  const tickSamplesMs: number[] = [];
  let totalCommandsProcessed = 0;
  let budgetOverruns = 0;

  try {
    for (let t = 0; t < ticks; t++) {
      for (let c = 0; c < commandsPerTick; c++) {
        const eid = (t * commandsPerTick + c) % entityCapacity;
        const checkpointFlag = c % 64 === 0 ? INTENT_FLAGS.PERSIST_CHECKPOINT : 0;
        const moveFlag = (c & 1) === 0 ? INTENT_FLAGS.FORWARD : INTENT_FLAGS.RIGHT;
        cmdBatch[c] = packCommandToken(eid, moveFlag | checkpointFlag);
      }
      sim.inputQueue.enqueueBatch(cmdBatch, commandsPerTick);

      const m = sim.tick(DT);
      tickSamplesMs.push(Number(m.elapsedMs.toFixed(4)));
      totalCommandsProcessed += m.commandsProcessed;
      if (m.budgetOverrun) budgetOverruns++;

      // Drain persistence ring periodically off-tick
      if (t % 10 === 9) {
        await persist.drainPendingTransactions(512);
      }
    }
    await persist.drainPendingTransactions(1024);

    const sorted = [...tickSamplesMs].sort((a, b) => a - b);
    const p50TickMs = sorted[Math.floor(sorted.length * 0.5)];
    const p95TickMs = sorted[Math.floor(sorted.length * 0.95)];
    const p99TickMs = sorted[Math.floor(sorted.length * 0.99)];
    const maxTickMs = sorted[sorted.length - 1];
    const meanTickMs =
      tickSamplesMs.reduce((acc, v) => acc + v, 0) / tickSamplesMs.length;

    return {
      ticks,
      entityCapacity,
      commandsPerTick,
      totalCommandsProcessed,
      totalPersistCommitted: Atomics.load(sim.views.telemetryView, 5),
      frameBudgetMs: Number(FRAME_BUDGET_MS.toFixed(2)),
      p50TickMs: Number(p50TickMs.toFixed(4)),
      p95TickMs: Number(p95TickMs.toFixed(4)),
      p99TickMs: Number(p99TickMs.toFixed(4)),
      maxTickMs: Number(maxTickMs.toFixed(4)),
      meanTickMs: Number(meanTickMs.toFixed(4)),
      budgetUtilizationPct: Number(((meanTickMs / FRAME_BUDGET_MS) * 100).toFixed(3)),
      budgetOverruns,
      tickSamplesMs,
    };
  } finally {
    await persist.stop();
  }
}

export async function runHybridDataPlaneBenchmarks(jsonOutPath?: string): Promise<FullBenchmarkReport> {
  const kernel = loadNativeKernel();
  const ring = benchmarkRing();
  const kernels = benchmarkKernels();
  const stress30Hz = await run30HzStressTest();

  const report: FullBenchmarkReport = {
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    isNativeKernel: kernel.isNative,
    ring,
    kernels,
    stress30Hz,
  };

  if (jsonOutPath) {
    fs.writeFileSync(jsonOutPath, JSON.stringify(report, null, 2), "utf8");
  }
  return report;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("hybrid-data-plane-bench.js") || process.argv[1]?.endsWith("hybrid-data-plane-bench.ts")) {
  const outArg = process.argv[2];
  void runHybridDataPlaneBenchmarks(outArg).then((report) => {
    console.log(JSON.stringify({ ...report, stress30Hz: { ...report.stress30Hz, tickSamplesMs: `[${report.stress30Hz.tickSamplesMs.length} samples]` } }, null, 2));
    process.exit(0);
  });
}
