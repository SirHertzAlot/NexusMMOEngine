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

