/**
 * Type declarations for @mmo-engine/addon-terrain-kernel.
 *
 * Grid-level terrain kernel (P2-P4): the survey stays the JS orchestrator;
 * C++ owns heightfield math behind this API. All grids are row-major
 * Float32Array of width*depth, X as the inner loop: idx = v*width + u.
 * Heights are metres; flow is rain-weighted upstream area in m^2.
 */

/** Bake parameters for {@link bakeHeightfield}. */
export interface BakeParams {
  /** u64 world seed. */
  seed: bigint;
  /** Grid width in cells, integer in [1, 4096]. */
  width: number;
  /** Grid depth in cells, integer in [1, 4096]. */
  depth: number;
  /** Cell size in metres, > 0. */
  cell: number;
  /** Sea level in metres. */
  seaLevel: number;
  /** Stages to run in order (see {@link BakeStage}). */
  stages: BakeStage[];
  /** Rainfall share per cell, 0..1+. Required by fluvial/droplet stages. */
  rainShare?: Float32Array;
  /** u64 droplet seed; defaults to `seed`. */
  dropletSeed?: bigint;
}

/** One stage of a {@link bakeHeightfield} run. */
export type BakeStage =
  | { op: "identity" }
  | { op: "thermal"; talusDeg: number; passes: number }
  | { op: "fluvial"; passes: number; strength: number }
  | { op: "droplet"; droplets: number; strength: number };

/**
 * Run the grid-level bake: applies `params.stages` to `height` in place,
 * then writes rain-weighted upstream area into `flow` via the kernel's
 * own depression filling + drainage.
 */
export declare function bakeHeightfield(
  params: BakeParams,
  height: Float32Array,
  flow: Float32Array,
): void;

/** Parameters for {@link computeTectonics}. */
export interface TectonicParams {
  /** u64 seed for the plate mosaic. */
  seed: bigint;
  width: number;
  depth: number;
  /** Cell size in metres, > 0. */
  cell: number;
  /** Plate count, default 12. */
  plateCount?: number;
  /** Uplift at a fully convergent boundary, metres. Default 600. */
  maxUpliftM?: number;
  /** Subsidence at a fully divergent boundary, metres. Default 250. */
  riftDepthM?: number;
  /** Half-width of the boundary influence zone, metres. Default 120000. */
  boundaryWidthM?: number;
}

/**
 * Voronoi plate tectonics: writes the uplift field (metres, + ridge /
 * - rift) and the strain field (0..1) for the grid. Bit-identical for a
 * given seed on every platform (no transcendentals in the field math).
 */
export declare function computeTectonics(
  params: TectonicParams,
  uplift: Float32Array,
  strain: Float32Array,
): void;

/** Collapse slopes steeper than `talusDeg`, `passes` times. In place. */
export declare function thermalErode(
  height: Float32Array,
  width: number,
  depth: number,
  cell: number,
  talusDeg: number,
  passes: number,
): void;

/**
 * Stream-power incision. In place. Returns the deepest cut in metres.
 */
export declare function fluvialErode(
  height: Float32Array,
  width: number,
  depth: number,
  cell: number,
  seaLevel: number,
  rainShare: Float32Array,
  passes: number,
  strength: number,
): number;

/** Beyer droplet weathering. In place. Returns mean/max change, metres. */
export declare function dropletErode(
  height: Float32Array,
  width: number,
  depth: number,
  cell: number,
  seaLevel: number,
  rainShare: Float32Array,
  droplets: number,
  strength: number,
  seed: bigint,
): { meanM: number; maxM: number };

/**
 * Rain-weighted upstream area (m^2) into `flow`, via the kernel's own
 * depression filling + drainage. `weight` may be null for uniform weight.
 */
export declare function computeFlow(
  height: Float32Array,
  width: number,
  depth: number,
  cell: number,
  weight: Float32Array | null,
  flow: Float32Array,
): void;

/** Provenance string for the kernel. */
export declare function libraryInfo(): string;
