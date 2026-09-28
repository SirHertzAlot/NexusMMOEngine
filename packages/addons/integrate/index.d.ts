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

export declare function worldSize(handle: WorldHandle): number;
