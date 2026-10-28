/**
 * Thread Coordination Loop Framework (`sim-worker.ts`)
 * (ENGINE_IMPLEMENTATION_SPEC.md §5 + DoD Planar SoA & Telemetry Extensions).
 *
 * Isolates the 30Hz (33.33ms budget) simulation loop into a dedicated worker thread.
 * Every tick:
 * 1. Drains the lockless `AtomicSPSCQueue` populated by the Master Network Gateway.
 * 2. Applies 32-bit packed `[entityIndex (16b) | actionCode (16b)]` tokens directly
 *    to `INTENT_BIT` in the `SharedArrayBuffer` matrix.
 * 3. Enqueues asynchronous persistence checkpoints onto the secondary lockless
 *    `AtomicSPSCTransactionQueue` whenever `INTENT_FLAGS.PERSIST_CHECKPOINT` is set.
 * 4. Invokes the zero-copy C++ native kernel (`engine_kernel.node` / `integrate.node`)
 *    across the shared memory views (`stepSimulation`, `applyIntentsAndStep`, or
 *    branchless SIMD `stepSimulationSoA`).
 * 5. Records lockless atomic telemetry (`TELEMETRY_SLOTS`) and monitors the 33.33ms
 *    frame budget.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_PLANE_ENTITY_CAPACITY,
  INTENT_FLAGS,
  OFFSETS,
  SOA_LAYOUT,
  TELEMETRY_SLOTS,
  attachSharedMemoryPlane,
  type SharedMemoryPlaneViews,
} from "./sab-store.js";
import {
  AtomicSPSCQueue,
  AtomicSPSCTransactionQueue,
  PERSIST_TX_KIND,
} from "./lockless-ring.js";
import {
  LogProducer,
  LogProducerClient,
  LogRingBuffer,
  logSimSpiralGuardFired,
  logSimTickOverrun,
} from "./logging/index.js";

const require = createRequire(import.meta.url);

export const TICK_RATE_HZ = 30;
export const FRAME_BUDGET_MS = 1000 / TICK_RATE_HZ; // 33.333... ms
export const DT = 1.0 / TICK_RATE_HZ;
export const DEFAULT_INPUT_RING_CAPACITY = 1024;
export const DEFAULT_PERSIST_RING_CAPACITY = 512;
export const DEFAULT_BASE_SPEED = 5.0;
export const DEFAULT_KERNEL_TELEMETRY_EVERY = 256;

export interface NativeEngineKernel {
  readonly isNative: boolean;
  stepSimulation(floatMatrixView: Float32Array, entityCount: number, dt: number): void;
  stepSimulationSoA(
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    vz: Float32Array,
    hp: Int32Array,
    entityCount: number,
    dt: number,
  ): void;
  applyIntentsAndStep(
    floatMatrixView: Float32Array,
    entityCount: number,
    dt: number,
    baseSpeed?: number,
  ): void;
  // --- SAB Logging Layer Phase 2 native producers (all optional; present only
  // on @mmo-engine/addon-integrate builds compiled after 2026-10-27) ---
  logAttachRing?(ringBytes: Uint8Array, capacity: number): boolean;
  logNativeTelemetryEvery?(n: number): void;
  logIsAttached?(): boolean;
  logSimTickOverrunNative?(tick: number, durationUs: number): boolean;
  logSimSpiralGuardFiredNative?(droppedMs: number): boolean;
}

/** Pure JS fallback matching the C++ kernel semantics bit-for-bit if native binary is unavailable. */
function createJsFallbackKernel(): NativeEngineKernel {
  return {
    isNative: false,
    stepSimulation(floatMatrixView: Float32Array, entityCount: number, dt: number): void {
      const intMatrixView = new Int32Array(
        floatMatrixView.buffer,
        floatMatrixView.byteOffset,
        floatMatrixView.length,
      );
      const dtf = Math.fround(dt);
      for (let i = 0; i < entityCount; i++) {
        const base = i * SOA_LAYOUT.STRIDE;
        if (intMatrixView[base + SOA_LAYOUT.HEALTH] <= 0) continue;
        floatMatrixView[base + SOA_LAYOUT.POSITION_X] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_X] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] * dtf),
        );
        floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_Y] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] * dtf),
        );
        floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_Z] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] * dtf),
        );
      }
    },
    stepSimulationSoA(
      px: Float32Array,
      py: Float32Array,
      pz: Float32Array,
      vx: Float32Array,
      vy: Float32Array,
      vz: Float32Array,
      hp: Int32Array,
      entityCount: number,
      dt: number,
    ): void {
      const dtf = Math.fround(dt);
      for (let i = 0; i < entityCount; i++) {
        if (hp[i] <= 0) continue;
        px[i] = Math.fround(px[i] + Math.fround(vx[i] * dtf));
        py[i] = Math.fround(py[i] + Math.fround(vy[i] * dtf));
        pz[i] = Math.fround(pz[i] + Math.fround(vz[i] * dtf));
      }
    },
    applyIntentsAndStep(
      floatMatrixView: Float32Array,
      entityCount: number,
      dt: number,
      baseSpeed: number = DEFAULT_BASE_SPEED,
    ): void {
      const intMatrixView = new Int32Array(
        floatMatrixView.buffer,
        floatMatrixView.byteOffset,
        floatMatrixView.length,
      );
      const dtf = Math.fround(dt);
      const baseSpd = Math.fround(baseSpeed);
      for (let i = 0; i < entityCount; i++) {
        const base = i * SOA_LAYOUT.STRIDE;
        if (intMatrixView[base + SOA_LAYOUT.HEALTH] <= 0) continue;
        const intent = intMatrixView[base + SOA_LAYOUT.INTENT_BIT];
        if (intent !== 0) {
          const speed = (intent & INTENT_FLAGS.SPRINT) !== 0 ? Math.fround(baseSpd * 2) : baseSpd;
          let vx = 0;
          let vy = 0;
          let vz = 0;
          if (intent & INTENT_FLAGS.RIGHT) vx += speed;
          if (intent & INTENT_FLAGS.LEFT) vx -= speed;
          if (intent & INTENT_FLAGS.UP) vy += speed;
          if (intent & INTENT_FLAGS.DOWN) vy -= speed;
          if (intent & INTENT_FLAGS.FORWARD) vz += speed;
          if (intent & INTENT_FLAGS.BACKWARD) vz -= speed;
          floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] = vx;
          floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] = vy;
          floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] = vz;
        }
        floatMatrixView[base + SOA_LAYOUT.POSITION_X] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_X] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] * dtf),
        );
        floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_Y] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] * dtf),
        );
        floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = Math.fround(
          floatMatrixView[base + SOA_LAYOUT.POSITION_Z] +
            Math.fround(floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] * dtf),
        );
      }
    },
  };
}

/**
 * Load the compiled C++ N-API simulation kernel (`engine_kernel.node` or `@mmo-engine/addon-integrate`),
 * falling back to the bit-compatible JS implementation only if no native binary exists.
 */
export function loadNativeKernel(): NativeEngineKernel {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../addons/integrate/build/Release/engine_kernel.node"),
    path.resolve(here, "../../../addons/integrate/build/Release/engine_kernel.node"),
    path.resolve(here, "../../../../packages/addons/integrate/build/Release/engine_kernel.node"),
    "@mmo-engine/addon-integrate",
    path.resolve(here, "../../addons/integrate/build/Release/integrate.node"),
    path.resolve(here, "../../../addons/integrate/build/Release/integrate.node"),
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate) as Partial<NativeEngineKernel>;
      if (typeof mod.stepSimulation === "function") {
        const fallback = createJsFallbackKernel();
        return {
          isNative: true,
          stepSimulation: mod.stepSimulation.bind(mod),
          stepSimulationSoA:
            typeof mod.stepSimulationSoA === "function"
              ? mod.stepSimulationSoA.bind(mod)
              : fallback.stepSimulationSoA,
          applyIntentsAndStep:
            typeof mod.applyIntentsAndStep === "function"
              ? mod.applyIntentsAndStep.bind(mod)
              : fallback.applyIntentsAndStep,
          logAttachRing:
            typeof mod.logAttachRing === "function" ? mod.logAttachRing.bind(mod) : undefined,
          logNativeTelemetryEvery:
            typeof mod.logNativeTelemetryEvery === "function"
              ? mod.logNativeTelemetryEvery.bind(mod)
              : undefined,
          logIsAttached:
            typeof mod.logIsAttached === "function" ? mod.logIsAttached.bind(mod) : undefined,
          logSimTickOverrunNative:
            typeof mod.logSimTickOverrunNative === "function"
              ? mod.logSimTickOverrunNative.bind(mod)
              : undefined,
          logSimSpiralGuardFiredNative:
            typeof mod.logSimSpiralGuardFiredNative === "function"
              ? mod.logSimSpiralGuardFiredNative.bind(mod)
              : undefined,
        };
      }
    } catch {
      // Try next candidate path
    }
  }
  return createJsFallbackKernel();
}

export type SimExecutionMode = "matrix" | "fused-intents" | "planar-soa";

export interface SimWorkerConfig {
  sharedMemory: SharedArrayBuffer;
  entityCapacity?: number;
  inputRingCapacity?: number;
  persistRingCapacity?: number;
  mode?: SimExecutionMode;
  decodeMovementIntents?: boolean;
  baseSpeed?: number;
  useBatchDrain?: boolean;
  kernel?: NativeEngineKernel;
  /** SAB of the process's log ring. Absent (CLI benches) = no ring emission. */
  logRingSab?: SharedArrayBuffer;
  /** Exact record capacity the log ring was created with (must match its creator). */
  logRingCapacity?: number;
  /**
   * Sampled in-kernel telemetry stride (records per kernel steps). Default 256
   * when the native producer attaches; 0 disables. Ignored without a ring.
   */
  kernelTelemetryEvery?: number;
}

export interface SimTickMetrics {
  tick: number;
  commandsProcessed: number;
  persistEnqueued: number;
  elapsedMs: number;
  elapsedUs: number;
  budgetOverrun: boolean;
}

/**
 * Deterministic, zero-allocation 30Hz Simulation Worker Runtime.
 * Can be driven inside a `worker_threads` background loop or stepped directly in tests/benchmarks.
 */
export class SimWorkerRuntime {
  public readonly views: SharedMemoryPlaneViews;
  public readonly inputQueue: AtomicSPSCQueue;
  public readonly persistQueue: AtomicSPSCTransactionQueue;
  public readonly kernel: NativeEngineKernel;
  public readonly entityCapacity: number;
  public readonly mode: SimExecutionMode;
  public readonly decodeMovementIntents: boolean;
  public readonly baseSpeed: number;
  public readonly useBatchDrain: boolean;

  private readonly drainScratch: Int32Array;
  private readonly logRing?: LogRingBuffer;
  private readonly logClient?: LogProducerClient;
  private nativeLogAttached: boolean = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  public readonly stepMs: number = 1000 / TICK_RATE_HZ;
  public readonly maxStepsPerFrame: number = 5;
  public readonly maxFrameDeltaMs: number = 250;
  private accMs: number = 0;
  private lastFrameMs: number | null = null;
  private spirals: number = 0;
  private droppedAccumulatedMs: number = 0;

  constructor(config: SimWorkerConfig) {
    this.entityCapacity = config.entityCapacity ?? DATA_PLANE_ENTITY_CAPACITY;
    this.views = attachSharedMemoryPlane(config.sharedMemory, this.entityCapacity);
    const inputCap = config.inputRingCapacity ?? DEFAULT_INPUT_RING_CAPACITY;
    const persistCap = config.persistRingCapacity ?? DEFAULT_PERSIST_RING_CAPACITY;

    // When using the default 10,000 entity capacity, OFFSETS.RINGS === this.views.offsets.RINGS
    const ringOffset =
      this.entityCapacity === DATA_PLANE_ENTITY_CAPACITY
        ? OFFSETS.RINGS
        : this.views.offsets.RINGS;
    this.inputQueue = new AtomicSPSCQueue(config.sharedMemory, ringOffset, inputCap);
    this.persistQueue = new AtomicSPSCTransactionQueue(
      config.sharedMemory,
      this.views.offsets.PERSIST_RING,
      persistCap,
    );
    this.kernel = config.kernel ?? loadNativeKernel();
    this.mode = config.mode ?? "matrix";
    this.decodeMovementIntents = config.decodeMovementIntents ?? false;
    this.baseSpeed = config.baseSpeed ?? DEFAULT_BASE_SPEED;
    this.useBatchDrain = config.useBatchDrain ?? false;
    this.drainScratch = new Int32Array(inputCap);
    if (config.logRingSab && config.logRingCapacity) {
      this.logRing = new LogRingBuffer(config.logRingCapacity, config.logRingSab);
      this.logClient = new LogProducerClient(LogProducer.SIM, this.logRing);
      // Phase 2: hand the same ring memory to the C++ side once. From here on
      // the native kernels emit records without crossing the N-API boundary
      // (kernel telemetry), and the runtime's own rare events (budget overrun,
      // spiral guard) route through the native emitters too.
      const nativeAttach =
        this.logClient !== undefined &&
        this.kernel.isNative &&
        typeof this.kernel.logAttachRing === "function";
      if (nativeAttach) {
        this.nativeLogAttached = this.kernel.logAttachRing!(new Uint8Array(config.logRingSab), config.logRingCapacity);
        if (this.nativeLogAttached) {
          const every = config.kernelTelemetryEvery ?? DEFAULT_KERNEL_TELEMETRY_EVERY;
          this.kernel.logNativeTelemetryEvery?.(every);
        }
      }
    }
  }

  private applyCommandToken(commandToken: number): boolean {
    const { intMatrixView, planar } = this.views;
    // Unpack bits: [EntityIndex (16-bit) | ActionCode (16-bit)]
    const entityIndex = (commandToken >>> 16) & 0xffff;
    const actionCode = commandToken & 0xffff;

    if (entityIndex < this.entityCapacity) {
      const baseOffset = entityIndex * SOA_LAYOUT.STRIDE;
      intMatrixView[baseOffset + SOA_LAYOUT.INTENT_BIT] = actionCode;
      if (this.mode === "planar-soa") {
        planar.intent[entityIndex] = actionCode;
      }

      // Optional velocity translation on the matrix before stepSimulation when requested
      if (this.decodeMovementIntents && this.mode === "matrix") {
        const moveMask =
          INTENT_FLAGS.FORWARD |
          INTENT_FLAGS.BACKWARD |
          INTENT_FLAGS.LEFT |
          INTENT_FLAGS.RIGHT |
          INTENT_FLAGS.UP |
          INTENT_FLAGS.DOWN;
        if ((actionCode & moveMask) !== 0) {
          const speed =
            (actionCode & INTENT_FLAGS.SPRINT) !== 0 ? this.baseSpeed * 2.0 : this.baseSpeed;
          let vx = 0;
          let vy = 0;
          let vz = 0;
          if (actionCode & INTENT_FLAGS.RIGHT) vx += speed;
          if (actionCode & INTENT_FLAGS.LEFT) vx -= speed;
          if (actionCode & INTENT_FLAGS.UP) vy += speed;
          if (actionCode & INTENT_FLAGS.DOWN) vy -= speed;
          if (actionCode & INTENT_FLAGS.FORWARD) vz += speed;
          if (actionCode & INTENT_FLAGS.BACKWARD) vz -= speed;
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_X] = vx;
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_Y] = vy;
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_Z] = vz;
        } else {
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_X] = 0;
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_Y] = 0;
          this.views.floatMatrixView[baseOffset + SOA_LAYOUT.VELOCITY_Z] = 0;
        }
      }

      // Enqueue lockless persistence checkpoint if PERSIST_CHECKPOINT flag is set
      if ((actionCode & INTENT_FLAGS.PERSIST_CHECKPOINT) !== 0) {
        const hp = intMatrixView[baseOffset + SOA_LAYOUT.HEALTH];
        return this.persistQueue.enqueue({
          kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT,
          sabIndex: entityIndex,
          paramA: hp,
          paramB: actionCode,
        });
      }
    }
    return false;
  }

  /** Execute one fixed simulation tick (`dt = DT` by default). */
  public tick(dt: number = DT): SimTickMetrics {
    const startTime = performance.now();
    let commandsProcessed = 0;
    let persistEnqueued = 0;

    // 1. Drain Lockless Ring Queue & Mutate Shared Memory Intents
    if (this.useBatchDrain) {
      const count = this.inputQueue.drainTo(this.drainScratch);
      for (let i = 0; i < count; i++) {
        commandsProcessed++;
        if (this.applyCommandToken(this.drainScratch[i])) {
          persistEnqueued++;
        }
      }
    } else {
      let commandToken: number | null;
      while ((commandToken = this.inputQueue.dequeue()) !== null) {
        commandsProcessed++;
        if (this.applyCommandToken(commandToken)) {
          persistEnqueued++;
        }
      }
    }

    // 2. Call Native C++ Simulation Step directly on SharedArrayBuffer views
    if (this.mode === "planar-soa") {
      const p = this.views.planar;
      this.kernel.stepSimulationSoA(
        p.px,
        p.py,
        p.pz,
        p.vx,
        p.vy,
        p.vz,
        p.hp,
        this.entityCapacity,
        dt,
      );
    } else if (this.mode === "fused-intents") {
      this.kernel.applyIntentsAndStep(
        this.views.floatMatrixView,
        this.entityCapacity,
        dt,
        this.baseSpeed,
      );
    } else {
      this.kernel.stepSimulation(this.views.floatMatrixView, this.entityCapacity, dt);
    }

    // 3. Enforce Frame Budget & Update Lockless Telemetry
    const elapsedMs = performance.now() - startTime;
    const elapsedUs = Math.max(1, Math.round(elapsedMs * 1000));
    const budgetOverrun = elapsedMs > FRAME_BUDGET_MS;

    const tel = this.views.telemetryView;
    const tickNum = Atomics.add(tel, TELEMETRY_SLOTS.TICK_COUNT, 1) + 1;
    Atomics.store(tel, TELEMETRY_SLOTS.LAST_TICK_US, elapsedUs);

    // Lockless CAS loop to update high-water max tick duration
    let prevMax = Atomics.load(tel, TELEMETRY_SLOTS.MAX_TICK_US);
    while (elapsedUs > prevMax) {
      const exchanged = Atomics.compareExchange(
        tel,
        TELEMETRY_SLOTS.MAX_TICK_US,
        prevMax,
        elapsedUs,
      );
      if (exchanged === prevMax) break;
      prevMax = exchanged;
    }

    if (commandsProcessed > 0) {
      Atomics.add(tel, TELEMETRY_SLOTS.COMMANDS_PROCESSED, commandsProcessed);
    }
    if (persistEnqueued > 0) {
      Atomics.add(tel, TELEMETRY_SLOTS.PERSIST_ENQUEUED, persistEnqueued);
    }
    if (budgetOverrun) {
      Atomics.add(tel, TELEMETRY_SLOTS.BUDGET_OVERRUNS, 1);
      // The locked counter above is the metric; this is the diagnostic. The
      // native emitter runs the whole MPSC enqueue inside C++ (Phase 2);
      // without native attachment the TS producer is the fallback. Without a
      // ring (benches): nothing.
      if (this.logClient === undefined) {
        // no ring — benches only, nothing to do
      } else if (this.nativeLogAttached && this.kernel.logSimTickOverrunNative) {
        this.kernel.logSimTickOverrunNative(tickNum, elapsedUs);
      } else {
        logSimTickOverrun(this.logClient, tickNum, elapsedUs);
      }
    }

    return {
      tick: tickNum,
      commandsProcessed,
      persistEnqueued,
      elapsedMs,
      elapsedUs,
      budgetOverrun,
    };
  }

  /**
   * Advance the simulation by wall-clock time nowMs using the fixed-timestep accumulator
   * and spiral-of-death guard (matching tick-loop.ts semantics).
   * Returns the count of fixed steps executed.
   */
  public frame(nowMs: number): number {
    if (this.lastFrameMs === null) {
      this.lastFrameMs = nowMs;
      return 0;
    }
    let delta = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    if (delta < 0) delta = 0;
    if (delta > this.maxFrameDeltaMs) delta = this.maxFrameDeltaMs;

    this.accMs += delta;
    let steps = 0;
    while (this.accMs + 1e-6 >= this.stepMs && steps < this.maxStepsPerFrame) {
      this.tick(DT);
      this.accMs -= this.stepMs;
      steps += 1;
    }
    if (this.accMs + 1e-6 >= this.stepMs) {
      this.spirals += 1;
      const dropped = Math.round(this.accMs);
      this.droppedAccumulatedMs += dropped;
      this.accMs = 0;
      Atomics.add(this.views.telemetryView, TELEMETRY_SLOTS.SPIRAL_EVENTS, 1);
      Atomics.add(this.views.telemetryView, TELEMETRY_SLOTS.DROPPED_MS, dropped);
      // Phase 2: the spiral diagnostic is now an actual log record (WARN,
      // SIM_SPIRAL_GUARD_FIRED) — native first, TS producer fallback, and
      // nothing at all in ring-less bench configurations.
      if (this.logClient !== undefined && dropped > 0) {
        if (this.nativeLogAttached && this.kernel.logSimSpiralGuardFiredNative) {
          this.kernel.logSimSpiralGuardFiredNative(dropped);
        } else {
          logSimSpiralGuardFired(this.logClient, dropped);
        }
      }
    }
    return steps;
  }

  /** Get live atomic telemetry and drop statistics. */
  public stats() {
    const tel = this.views.telemetryView;
    return {
      ticks: Atomics.load(tel, TELEMETRY_SLOTS.TICK_COUNT),
      spiralEvents: Atomics.load(tel, TELEMETRY_SLOTS.SPIRAL_EVENTS),
      droppedMs: Atomics.load(tel, TELEMETRY_SLOTS.DROPPED_MS),
      lastTickUs: Atomics.load(tel, TELEMETRY_SLOTS.LAST_TICK_US),
      maxTickUs: Atomics.load(tel, TELEMETRY_SLOTS.MAX_TICK_US),
      commandsProcessed: Atomics.load(tel, TELEMETRY_SLOTS.COMMANDS_PROCESSED),
      persistEnqueued: Atomics.load(tel, TELEMETRY_SLOTS.PERSIST_ENQUEUED),
      budgetOverruns: Atomics.load(tel, TELEMETRY_SLOTS.BUDGET_OVERRUNS),
    };
  }

  /** Start the 30Hz simulation loop driven by fixed-timestep accumulator. */
  public start(): void {
    if (this.timer !== null) return;
    this.lastFrameMs = performance.now();
    this.timer = setInterval(() => {
      if (Atomics.load(this.views.telemetryView, TELEMETRY_SLOTS.SHUTDOWN_SIGNAL) !== 0) {
        this.stop();
        return;
      }
      this.frame(performance.now());
    }, 16);
  }

  /** Stop the 30Hz simulation interval loop. */
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// Worker thread auto-bootstrap when spawned directly as sim-worker
const isSimWorkerEntrypoint =
  !isMainThread &&
  workerData &&
  workerData.sharedMemory instanceof SharedArrayBuffer &&
  (workerData.workerRole === "sim" ||
    (typeof process.argv[1] === "string" &&
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))));

if (isSimWorkerEntrypoint) {
  const runtime = new SimWorkerRuntime({
    sharedMemory: workerData.sharedMemory,
    entityCapacity: workerData.entityCapacity,
    inputRingCapacity: workerData.inputRingCapacity,
    persistRingCapacity: workerData.persistRingCapacity,
    mode: workerData.mode,
    decodeMovementIntents: workerData.decodeMovementIntents,
    baseSpeed: workerData.baseSpeed,
    useBatchDrain: workerData.useBatchDrain,
    logRingSab: workerData.logRingSab instanceof SharedArrayBuffer ? workerData.logRingSab : undefined,
    logRingCapacity: typeof workerData.logRingCapacity === "number" ? workerData.logRingCapacity : undefined,
  });

  if (workerData.autoStart !== false) {
    runtime.start();
  }

  parentPort?.on("message", (msg: { type?: string; dt?: number }) => {
    if (msg?.type === "step") {
      const metrics = runtime.tick(msg.dt ?? DT);
      parentPort?.postMessage({ type: "stepped", metrics });
    } else if (msg?.type === "stop") {
      runtime.stop();
      parentPort?.postMessage({ type: "stopped" });
      process.exit(0);
    }
  });

  parentPort?.postMessage({
    type: "ready",
    isNative: runtime.kernel.isNative,
    entityCapacity: runtime.entityCapacity,
  });
}
