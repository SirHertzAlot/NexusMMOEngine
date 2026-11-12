/**
 * Terrain material masks, baked per chunk (see packages/art terrain-mask.ts
 * for the schema and channel meanings).
 *
 * Pure and seeded: the same spec, chunk origin and inputs give the same
 * bytes. Noise is sampled at world coordinates, so neighbouring chunks
 * agree on their shared edge. Each channel reads only its own parameters
 * (plus the shared seed and noise scale), so changing one channel changes
 * only that channel's bytes.
 */
import { type TerrainMaskSpec, parseTerrainMaskSpec } from "@mmo-engine/art/browser";

export interface TerrainMaskInputs {
  /** Slope in degrees per mask sample (resolution² values). */
  slope: Float32Array;
  /** Moisture 0..1 per sample. */
  moisture: Float32Array;
  /** Normalised flow accumulation 0..1 per sample. */
  flow: Float32Array;
  /** 1 on a road sample, 0 elsewhere. */
  road: Uint8Array;
}

export interface TerrainMaskChunk {
  /** World metres of the chunk's minimum corner. */
  originX: number;
  originZ: number;
  /** Metres between mask samples. */
  cellMetres: number;
}

/** Integer hash to [0, 1). */
function hash01(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) at a world position, feature size `scale` metres. */
export function valueNoise(seed: number, x: number, z: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** smoothstep between two edges, clamped to 0..1. */
function ramp(v: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Per-channel noise salt, so each channel draws its own noise from the one seed. */
const SALT = { base: 0x1111, rock: 0x2222, wet: 0x3333 } as const;

/** One 3×3 box-blur pass over a 0..1 field (edges clamp). */
function blur(field: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(field.length);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
          sum += field[zz * n + xx];
          count++;
        }
      }
      out[z * n + x] = sum / count;
    }
  }
  return out;
}

/**
 * Bake one chunk's mask: resolution² samples of RGBA bytes (R base, G rock,
 * B wet, A path). Throws with the field path if the spec is invalid.
 */
export function bakeTerrainMask(specValue: TerrainMaskSpec, chunk: TerrainMaskChunk, inputs: TerrainMaskInputs): Uint8Array {
  const spec = parseTerrainMaskSpec(specValue);
  const n = spec.resolution;
  const count = n * n;
  for (const [name, arr] of Object.entries({ slope: inputs.slope, moisture: inputs.moisture, flow: inputs.flow, road: inputs.road })) {
    if (arr.length !== count) throw new Error(`terrain mask: input ${name} has ${arr.length} samples, expected ${count}`);
  }
  const out = new Uint8Array(count * 4);

  // Path: road samples, widened by a few box-blur passes (the feather).
  let path: Float32Array<ArrayBuffer> = new Float32Array(count);
  for (let i = 0; i < count; i++) path[i] = inputs.road[i] ? 1 : 0;
  for (let p = 0; p < spec.path.featherCells; p++) path = blur(path, n);

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const wx = chunk.originX + (x + 0.5) * chunk.cellMetres;
      const wz = chunk.originZ + (z + 0.5) * chunk.cellMetres;
      const o = i * 4;

      // R base: ground variation, independent of every threshold.
      const base = valueNoise(spec.seed ^ SALT.base, wx, wz, spec.noiseScaleMetres);
      out[o] = Math.round(base * 255);

      // G rock: steep slopes, thinned where the ground is wet.
      const rockNoise = (valueNoise(spec.seed ^ SALT.rock, wx, wz, spec.noiseScaleMetres) - 0.5) * 2;
      const slope = inputs.slope[i] + rockNoise * spec.rock.slope.noiseAmplitude;
      const rockRaw = ramp(slope, spec.rock.slope.from, spec.rock.slope.to);
      const rock = rockRaw * (1 - spec.rock.moistureDamping * inputs.moisture[i]);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, rock)) * 255);

      // B wet: high moisture, boosted by flow.
      const wetNoise = (valueNoise(spec.seed ^ SALT.wet, wx, wz, spec.noiseScaleMetres) - 0.5) * 2;
      const moisture = inputs.moisture[i] + wetNoise * spec.wet.moisture.noiseAmplitude + spec.wet.flowBoost * inputs.flow[i];
      out[o + 2] = Math.round(ramp(moisture, spec.wet.moisture.from, spec.wet.moisture.to) * 255);

      // A path: the feathered road field.
      out[o + 3] = Math.round(Math.min(1, Math.max(0, path[i])) * 255);
    }
  }
  return out;
}

/** FNV-1a 32-bit over the bytes, as 8 hex digits (for golden-hash tests). */
export function maskHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
