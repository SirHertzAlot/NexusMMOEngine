/**
 * The world's terrain material masks, baked from the survey the terrain bake
 * already computes (height, moisture, flow, water). Slope is the gradient of
 * the survey's height. Road/path data is not in the survey yet, so the path
 * channel is empty until a road field is passed in (see docs/TERRAIN-MASK.md).
 *
 * One mask per chunk at `resolution` samples a side, world-aligned: sample
 * (x, z) of chunk (cx, cz) sits at world position (cx*size + (x+0.5)*size/res).
 */
import { type TerrainMaskSpec, TERRAIN_MASK_CHANNELS, type TerrainMaskChannel } from "@mmo-engine/art/browser";
import type { Survey } from "./survey.js";
import { bakeTerrainMask, maskHash, type TerrainMaskInputs } from "./terrain-mask.js";

export interface WorldMasks {
  /** Samples across and down the whole world. */
  width: number;
  depth: number;
  /** Metres between samples. */
  cell: number;
  originX: number;
  originZ: number;
  /** One byte per sample, per channel (width × depth). */
  channels: Record<TerrainMaskChannel, Uint8Array>;
}

/** Slope (degrees) per survey cell, computed once per survey. */
const slopeCache = new WeakMap<Survey, Float32Array>();

function slopeGrid(survey: Survey): Float32Array {
  const cached = slopeCache.get(survey);
  if (cached) return cached;
  const { width: w, depth: d, cell } = survey.grid;
  const h = survey.height;
  const out = new Float32Array(w * d);
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const zl = Math.max(0, z - 1), zr = Math.min(d - 1, z + 1);
      const dhdx = (h[z * w + xr] - h[z * w + xl]) / ((xr - xl) * cell || 1);
      const dhdz = (h[zr * w + x] - h[zl * w + x]) / ((zr - zl) * cell || 1);
      out[z * w + x] = (Math.atan(Math.hypot(dhdx, dhdz)) * 180) / Math.PI;
    }
  }
  slopeCache.set(survey, out);
  return out;
}

/** Bilinear sample of a survey field at a world position (clamped to the grid). */
function sample(field: Float32Array | Uint8Array, survey: Survey, wx: number, wz: number): number {
  const g = survey.grid;
  const u = Math.min(g.width - 1, Math.max(0, (wx - g.originX) / g.cell - 0.5));
  const v = Math.min(g.depth - 1, Math.max(0, (wz - g.originZ) / g.cell - 0.5));
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const x1 = Math.min(g.width - 1, x0 + 1), z1 = Math.min(g.depth - 1, z0 + 1);
  const tx = u - x0, tz = v - z0;
  const a = field[z0 * g.width + x0], b = field[z0 * g.width + x1];
  const c = field[z1 * g.width + x0], d = field[z1 * g.width + x1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/**
 * Bake the masks for every chunk in [minChunk, maxChunk] on both axes.
 * Pure and seeded: the same survey and spec give the same bytes.
 */
export function bakeWorldMasks(
  survey: Survey,
  maskSpec: TerrainMaskSpec,
  bounds: { minChunk: number; maxChunk: number },
  road?: Uint8Array,
): WorldMasks {
  const size = survey.spec.chunkWorldSize;
  const res = maskSpec.resolution;
  const chunks = bounds.maxChunk - bounds.minChunk + 1;
  const n = chunks * res;
  const cell = size / res;
  const originX = bounds.minChunk * size;
  const originZ = bounds.minChunk * size;
  const channels = Object.fromEntries(TERRAIN_MASK_CHANNELS.map((c) => [c, new Uint8Array(n * n)])) as Record<TerrainMaskChannel, Uint8Array>;

  const slope = slopeGrid(survey);
  let maxFlow = 0;
  for (const f of survey.flow) if (f > maxFlow) maxFlow = f;
  const flowNorm = new Float32Array(survey.flow.length);
  const logMax = Math.log1p(maxFlow) || 1;
  for (let i = 0; i < flowNorm.length; i++) flowNorm[i] = Math.log1p(survey.flow[i]) / logMax;

  const count = res * res;
  const inputs: TerrainMaskInputs = {
    slope: new Float32Array(count),
    moisture: new Float32Array(count),
    flow: new Float32Array(count),
    road: new Uint8Array(count),
  };
  for (let cz = bounds.minChunk; cz <= bounds.maxChunk; cz++) {
    for (let cx = bounds.minChunk; cx <= bounds.maxChunk; cx++) {
      for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
          const wx = cx * size + (x + 0.5) * cell;
          const wz = cz * size + (z + 0.5) * cell;
          const i = z * res + x;
          inputs.slope[i] = sample(slope, survey, wx, wz);
          inputs.moisture[i] = sample(survey.moisture, survey, wx, wz);
          inputs.flow[i] = sample(flowNorm, survey, wx, wz);
          inputs.road[i] = road ? (sample(road, survey, wx, wz) >= 0.5 ? 1 : 0) : 0;
        }
      }
      const bytes = bakeTerrainMask(maskSpec, { originX: cx * size, originZ: cz * size, cellMetres: cell }, inputs);
      const ox = (cx - bounds.minChunk) * res;
      const oz = (cz - bounds.minChunk) * res;
      for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
          const o = (z * res + x) * 4;
          const w = (oz + z) * n + ox + x;
          channels.base[w] = bytes[o];
          channels.rock[w] = bytes[o + 1];
          channels.wet[w] = bytes[o + 2];
          channels.path[w] = bytes[o + 3];
        }
      }
    }
  }
  return { width: n, depth: n, cell, originX, originZ, channels };
}

/** Hash of every channel, in channel order (for golden tests). */
export function worldMasksHash(masks: WorldMasks): string {
  return TERRAIN_MASK_CHANNELS.map((c) => `${c}:${maskHash(masks.channels[c])}`).join(" ");
}
