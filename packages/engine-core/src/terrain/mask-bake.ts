/**
 * The world's terrain material masks, baked from the survey the terrain bake
 * already computes: height (slope is its gradient), moisture, flow, biome.
 * Road data is not in the survey: roads are routed by the settlement stage.
 * The path channel is baked by a second, path-only pass (`bakeWorldPathMask`)
 * once the settlements have routed their roads (docs/internals/TERRAIN-MASK.md).
 *
 * The bake works on plain arrays (`MaskSource`) so it can run in worker
 * threads. Rows of chunks are split across workers; each worker returns its
 * slab of channel bytes, and the slabs are stitched in order.
 *
 * Sample (x, z) of chunk (cx, cz) sits at world (cx*size + (x+0.5)*size/res,
 * cz*size + ...), so chunks line up and neighbours agree on their edge.
 */
import { type TerrainMaskSpec, TERRAIN_MASK_CHANNELS, type TerrainMaskChannel } from "@mmo-engine/art/browser";
import { Worker } from "node:worker_threads";
import type { Survey } from "./survey.js";
import { bakeTerrainMask, blur, maskHash, type TerrainMaskInputs } from "./terrain-mask.js";
import { detAtan, detLog1p } from "@mmo-engine/placement";

/** The survey's fields the mask needs, as plain arrays (structured-clone safe). */
export interface MaskSource {
  grid: { width: number; depth: number; cell: number; originX: number; originZ: number };
  chunkWorldSize: number;
  /** Slope in degrees per survey cell. */
  slope: Float32Array;
  /** Humidity 0..1 per survey cell. */
  moisture: Float32Array;
  /** Log-normalised flow 0..1 per survey cell. */
  flow: Float32Array;
  /** Biome index normalised 0..1 per survey cell (index / (count − 1)). */
  biome: Float32Array;
  /** 1 on a road cell (empty when the bake has no road data). */
  road?: Uint8Array;
}

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

const slopeOf = (survey: Survey): Float32Array => {
  const { width: w, depth: d, cell } = survey.grid;
  const h = survey.height;
  const out = new Float32Array(w * d);
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const zl = Math.max(0, z - 1), zr = Math.min(d - 1, z + 1);
      const dhdx = (h[z * w + xr] - h[z * w + xl]) / ((xr - xl) * cell || 1);
      const dhdz = (h[zr * w + x] - h[zl * w + x]) / ((zr - zl) * cell || 1);
      out[z * w + x] = (detAtan(Math.hypot(dhdx, dhdz)) * 180) / Math.PI;
    }
  }
  return out;
};

/** Build the mask's inputs from a survey (the terrain bake's own data). */
export function maskSourceOf(survey: Survey, road?: Uint8Array): MaskSource {
  const g = survey.grid;
  let maxFlow = 0;
  for (const f of survey.flow) if (f > maxFlow) maxFlow = f;
  const logMax = detLog1p(maxFlow) || 1;
  const flow = new Float32Array(survey.flow.length);
  for (let i = 0; i < flow.length; i++) flow[i] = detLog1p(survey.flow[i]) / logMax;
  const biomeMax = Math.max(1, survey.spec.biomes.length - 1);
  const biome = new Float32Array(survey.biome.length);
  for (let i = 0; i < biome.length; i++) biome[i] = survey.biome[i] / biomeMax;
  return {
    grid: { width: g.width, depth: g.depth, cell: g.cell, originX: g.originX, originZ: g.originZ },
    chunkWorldSize: survey.spec.chunkWorldSize,
    slope: slopeOf(survey),
    moisture: survey.moisture,
    flow,
    biome,
    road,
  };
}

/** Bilinear sample of a survey-grid field at a world position (clamped). */
function sample(field: ArrayLike<number>, grid: MaskSource["grid"], wx: number, wz: number): number {
  const u = Math.min(grid.width - 1, Math.max(0, (wx - grid.originX) / grid.cell - 0.5));
  const v = Math.min(grid.depth - 1, Math.max(0, (wz - grid.originZ) / grid.cell - 0.5));
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const x1 = Math.min(grid.width - 1, x0 + 1), z1 = Math.min(grid.depth - 1, z0 + 1);
  const tx = u - x0, tz = v - z0;
  const a = field[z0 * grid.width + x0], b = field[z0 * grid.width + x1];
  const c = field[z1 * grid.width + x0], d = field[z1 * grid.width + x1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** The channel bytes for chunk rows [czFrom, czTo) across [minChunk, maxChunk]. */
export interface MaskSlab {
  czFrom: number;
  czTo: number;
  /** Samples across the whole world (same for every slab). */
  width: number;
  /** channel name → bytes for this slab's rows (width × rows). */
  channels: Record<TerrainMaskChannel, Uint8Array>;
}

/** Bake the rows [czFrom, czTo) of chunks, across the chunk columns [minChunk, maxChunk]. */
export function bakeMaskSlab(
  src: MaskSource,
  maskSpec: TerrainMaskSpec,
  bounds: { minChunk: number; maxChunk: number },
  czFrom: number,
  czTo: number,
): MaskSlab {
  const size = src.chunkWorldSize;
  const res = maskSpec.resolution;
  const chunks = bounds.maxChunk - bounds.minChunk + 1;
  const width = chunks * res;
  const rows = (czTo - czFrom) * res;
  const cell = size / res;
  const channels = Object.fromEntries(TERRAIN_MASK_CHANNELS.map((c) => [c, new Uint8Array(width * rows)])) as Record<TerrainMaskChannel, Uint8Array>;

  const count = res * res;
  const inputs: TerrainMaskInputs = {
    slope: new Float32Array(count),
    moisture: new Float32Array(count),
    flow: new Float32Array(count),
    road: new Uint8Array(count),
    biome: new Float32Array(count),
  };
  for (let cz = czFrom; cz < czTo; cz++) {
    for (let cx = bounds.minChunk; cx <= bounds.maxChunk; cx++) {
      for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
          const wx = cx * size + (x + 0.5) * cell;
          const wz = cz * size + (z + 0.5) * cell;
          const i = z * res + x;
          inputs.slope[i] = sample(src.slope, src.grid, wx, wz);
          inputs.moisture[i] = sample(src.moisture, src.grid, wx, wz);
          inputs.flow[i] = sample(src.flow, src.grid, wx, wz);
          inputs.biome![i] = sample(src.biome, src.grid, wx, wz);
          inputs.road[i] = src.road ? (sample(src.road, src.grid, wx, wz) >= 0.5 ? 1 : 0) : 0;
        }
      }
      const bytes = bakeTerrainMask(maskSpec, { originX: cx * size, originZ: cz * size, cellMetres: cell }, inputs);
      const ox = (cx - bounds.minChunk) * res;
      const oz = (cz - czFrom) * res;
      for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
          const o = (z * res + x) * 4;
          const w = (oz + z) * width + ox + x;
          channels.base[w] = bytes[o];
          channels.rock[w] = bytes[o + 1];
          channels.wet[w] = bytes[o + 2];
          channels.path[w] = bytes[o + 3];
        }
      }
    }
  }
  return { czFrom, czTo, width, channels };
}

/** Stitch slabs (any order) into the whole world's masks. */
export function assembleMasks(src: MaskSource, maskSpec: TerrainMaskSpec, bounds: { minChunk: number; maxChunk: number }, slabs: MaskSlab[]): WorldMasks {
  const res = maskSpec.resolution;
  const n = (bounds.maxChunk - bounds.minChunk + 1) * res;
  const channels = Object.fromEntries(TERRAIN_MASK_CHANNELS.map((c) => [c, new Uint8Array(n * n)])) as Record<TerrainMaskChannel, Uint8Array>;
  for (const slab of [...slabs].sort((a, b) => a.czFrom - b.czFrom)) {
    const offset = (slab.czFrom - bounds.minChunk) * res * n;
    for (const c of TERRAIN_MASK_CHANNELS) channels[c].set(slab.channels[c], offset);
  }
  return { width: n, depth: n, cell: src.chunkWorldSize / res, originX: bounds.minChunk * src.chunkWorldSize, originZ: bounds.minChunk * src.chunkWorldSize, channels };
}

/** Bake every chunk's mask in one thread. */
export function bakeWorldMasks(src: MaskSource, maskSpec: TerrainMaskSpec, bounds: { minChunk: number; maxChunk: number }): WorldMasks {
  const slab = bakeMaskSlab(src, maskSpec, bounds, bounds.minChunk, bounds.maxChunk + 1);
  return assembleMasks(src, maskSpec, bounds, [slab]);
}

/** Bake the masks across `workers` threads, one slab of chunk rows each. */
export async function bakeWorldMasksParallel(
  src: MaskSource,
  maskSpec: TerrainMaskSpec,
  bounds: { minChunk: number; maxChunk: number },
  workers: number,
): Promise<WorldMasks> {
  const rows = bounds.maxChunk - bounds.minChunk + 1;
  const n = Math.max(1, Math.min(workers, rows));
  if (n === 1) return bakeWorldMasks(src, maskSpec, bounds);
  const per = Math.ceil(rows / n);
  const ranges: Array<[number, number]> = [];
  for (let from = bounds.minChunk; from <= bounds.maxChunk; from += per) ranges.push([from, Math.min(bounds.maxChunk + 1, from + per)]);
  const slabs = await Promise.all(
    ranges.map(
      ([czFrom, czTo]) =>
        new Promise<MaskSlab>((resolve, reject) => {
          const w = new Worker(new URL("./mask-worker.js", import.meta.url), {
            workerData: { src, maskSpec, bounds, czFrom, czTo },
          });
          w.once("message", (slab: MaskSlab) => {
            w.terminate().catch(() => {});
            resolve(slab);
          });
          w.once("error", (err) => {
            w.terminate().catch(() => {});
            reject(err);
          });
        }),
    ),
  );
  return assembleMasks(src, maskSpec, bounds, slabs);
}

/** A road as a world-space polyline, [x, z] metres. */
export type RoadPolyline = ReadonlyArray<readonly [number, number]>;

/** Distance from (px, pz) to the segment a-b. */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * The path channel alone, from road polylines in world metres: a second pass
 * that runs after the settlements have routed their roads. Each chunk
 * rasterises the roads within half a width of its samples, then applies the
 * spec's feather (the same box blur the full bake uses). The chunk is padded
 * by the feather so the blur sees the neighbours' roads and chunk seams
 * match. Chunks no road reaches stay zero. Returns width × width bytes laid
 * out like `WorldMasks.channels.path`.
 */
export function bakeWorldPathMask(
  chunkWorldSize: number,
  maskSpec: TerrainMaskSpec,
  bounds: { minChunk: number; maxChunk: number },
  roads: ReadonlyArray<RoadPolyline>,
  widthMetres: number,
): Uint8Array {
  const res = maskSpec.resolution;
  const feather = maskSpec.path.featherCells;
  const chunks = bounds.maxChunk - bounds.minChunk + 1;
  const width = chunks * res;
  const out = new Uint8Array(width * width);
  const cell = chunkWorldSize / res;
  const half = widthMetres / 2;
  const segs: number[][] = [];
  for (const line of roads) {
    for (let i = 0; i + 1 < line.length; i++) segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  }
  if (segs.length === 0) return out;

  const pad = feather;
  const n = res + 2 * pad;
  const reach = half + (feather + 1) * cell;
  for (let cz = bounds.minChunk; cz <= bounds.maxChunk; cz++) {
    for (let cx = bounds.minChunk; cx <= bounds.maxChunk; cx++) {
      const x0 = cx * chunkWorldSize, z0 = cz * chunkWorldSize;
      const near = segs.filter(
        (s) =>
          Math.max(s[0], s[2]) >= x0 - reach && Math.min(s[0], s[2]) <= x0 + chunkWorldSize + reach &&
          Math.max(s[1], s[3]) >= z0 - reach && Math.min(s[1], s[3]) <= z0 + chunkWorldSize + reach,
      );
      if (near.length === 0) continue;
      let field: Float32Array<ArrayBuffer> = new Float32Array(n * n);
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
          const wx = x0 + (x - pad + 0.5) * cell;
          const wz = z0 + (z - pad + 0.5) * cell;
          for (const s of near) {
            if (segmentDistance(wx, wz, s[0], s[1], s[2], s[3]) <= half) {
              field[z * n + x] = 1;
              break;
            }
          }
        }
      }
      for (let p = 0; p < feather; p++) field = blur(field, n);
      const ox = (cx - bounds.minChunk) * res;
      const oz = (cz - bounds.minChunk) * res;
      for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
          out[(oz + z) * width + ox + x] = Math.round(Math.min(1, Math.max(0, field[(z + pad) * n + x + pad])) * 255);
        }
      }
    }
  }
  return out;
}

/** Hash of every channel, in channel order (for golden tests). */
export function worldMasksHash(masks: WorldMasks): string {
  return TERRAIN_MASK_CHANNELS.map((c) => `${c}:${maskHash(masks.channels[c])}`).join(" ");
}
