/**
 * Type declarations for @mmo-engine/addon-procgen.
 *
 * Pure-function boundary: generateChunk writes 16x16 height samples into
 * the caller-provided Float32Array (zero-copy). Same (seed, cx, cz, lod,
 * frequency) always yields bit-identical output.
 */

/** Samples per chunk side (16). */
export declare const CHUNK_SIZE: 16;
/** Total height samples per chunk (256). */
export declare const CHUNK_SAMPLES: 256;
/** Maximum accepted lod (8). */
export declare const MAX_LOD: 8;
/** Noise frequency used when generateChunk's `frequency` is omitted. */
export declare const DEFAULT_FREQUENCY: number;

/**
 * Generate a chunk heightmap, normalized to [-1, 1] (scale to world units
 * in the caller).
 *
 * Adjacent chunks share their border samples exactly: row/column 15 of
 * chunk (cx, cz) is bit-identical to row/column 0 of the next chunk, so
 * consumers place sample i at local position i * 16/15 and tiles meet
 * with no seams.
 *
 * @param seed u64 seed; the low 32 bits are used (FastNoise2 seeds are int32).
 * @param cx chunk X coordinate (int32).
 * @param cz chunk Z coordinate (int32).
 * @param lod level of detail, integer in [0, 8]. Each LOD doubles the
 *   chunk's footprint at the same sample count.
 * @param out caller-provided Float32Array with room for >= 256 floats.
 *   Receives row-major heights, X as the inner loop: out[j*16 + i].
 * @param frequency noise frequency in (0, 1]; defaults to
 *   DEFAULT_FREQUENCY. Lower = broader hills.
 */
export declare function generateChunk(
  seed: bigint,
  cx: number,
  cz: number,
  lod: number,
  out: Float32Array,
  frequency?: number,
): void;

/** Provenance string for the vendored noise library. */
export declare function libraryInfo(): string;
