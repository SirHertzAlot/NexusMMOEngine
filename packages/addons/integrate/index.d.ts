/**
 * Type declarations for @mmo-engine/addon-integrate.
 *
 * The world handle is an opaque N-API External; callers must not inspect it,
 * only pass it back to stepWorld / copyPositions / worldSize.
 */
export type WorldHandle = object;

export declare function integrate(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  vz: Float32Array,
  count: number,
  dt: number,
): void;

export declare function noop(): void;

export declare function createWorld(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  vz: Float32Array,
): WorldHandle;

export declare function stepWorld(handle: WorldHandle, dt: number): void;

export declare function copyPositions(
  handle: WorldHandle,
  ox: Float32Array,
  oy: Float32Array,
  oz: Float32Array,
): void;

export declare function deleteWorld(handle: WorldHandle): void;

export declare function worldSize(handle: WorldHandle): number;

/**
 * Zero-copy C++ simulation core step over an 8-word-strided SharedArrayBuffer Float32Array
 * (ENGINE_IMPLEMENTATION_SPEC.md Section 4).
 */
export declare function stepSimulation(
  floatMatrixView: Float32Array,
  entityCount: number,
  dt: number,
): boolean;

/**
 * DoD Planar SoA branchless SIMD integration kernel.
 */
export declare function stepSimulationSoA(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  vz: Float32Array,
  hp: Int32Array,
  entityCount: number,
  dt: number,
): boolean;

/**
 * Fused DoD Intent-Decode + Integration kernel over the strided SAB matrix.
 */
export declare function applyIntentsAndStep(
  floatMatrixView: Float32Array,
  entityCount: number,
  dt: number,
  baseSpeed: number,
): boolean;

/**
 * SAB Logging Layer Phase 2: attach the process log ring's SharedArrayBuffer
 * (as a Uint8Array view) so the native kernels can emit records without
 * crossing the N-API boundary. Returns true when the ring memory validated.
 */
export declare function logAttachRing(
  ringBytes: Uint8Array,
  capacity: number,
): boolean;

/** Enable sampled in-kernel telemetry every `n` steps (0 = disabled). */
export declare function logNativeTelemetryEvery(n: number): void;

/** True when a log ring is currently attached. */
export declare function logIsAttached(): boolean;

/** Native `SIM_TICK_OVERRUN` emitter (bounded MPSC, level-mask aware). */
export declare function logSimTickOverrunNative(
  tick: number,
  durationUs: number,
): boolean;

/** Native `SIM_SPIRAL_GUARD_FIRED` emitter. */
export declare function logSimSpiralGuardFiredNative(droppedMs: number): boolean;

/** Generic native producer seam: (level, producerId, code, tick, entLo, entHi, tag0, val0, tag1, val1). */
export declare function logNativeEmit2(
  level: number,
  producerId: number,
  code: number,
  tick: number,
  entLo: number,
  entHi: number,
  tag0: number,
  val0: number | bigint,
  tag1: number,
  val1: number | bigint,
): boolean;

