/**
 * World survey — the coarse, whole-world pass of the terrain bake.
 *
 * On a coarse grid (spec.coarseCell metres, ~500 × 500 cells for 4 km) it
 * lays out the world's large-scale shape: continental elevation and
 * moisture, a FINITE set of biome regions chosen by that survey (mountains
 * take the highest ground, swamps the low wet ground, …), blended biome
 * landforms, droplet erosion, and rivers from flow accumulation. The fine
 * heightmap (world-heights.ts) is built on top of it.
 *
 * Terrain is baked once and stored, so this only needs to be reproducible
 * (same spec -> same bytes), not bit-identical across platforms.
 */

import { makeProcgenChunkSource } from "../procgen/chunk-source.js";
import { worldBounds, type BiomeSpec, type WorldSpec } from "./world-spec.js";

/** Coarse cell (u, v) sits at world (originX + u*cell, originZ + v*cell). */
export interface CoarseGrid {
  width: number;
  depth: number;
  cell: number;
  originX: number;
  originZ: number;
}

export interface BiomeRegion {
  index: number;
  /** Index into spec.biomes. */
  biome: number;
  x: number;
  z: number;
}

export interface Survey {
  spec: WorldSpec;
  grid: CoarseGrid;
  /** Final coarse elevation, metres (after erosion and rivers). */
  height: Float32Array;
  /** Fine-detail strength 0..1, blended across biome borders. */
  roughness: Float32Array;
  /** Dominant biome (index into spec.biomes) per cell. */
  biome: Uint8Array;
  /** Nearest biome region per cell. */
  region: Uint16Array;
  /** Moisture -1..1. */
  moisture: Float32Array;
  /** Upstream catchment area per cell, m². */
  flow: Float32Array;
  /** 1 where a river runs. */
  river: Uint8Array;
  regions: BiomeRegion[];
  stats: { erodedMeanM: number; erodedMaxM: number; riverCells: number };
}

/** Cells beyond the world edge so bicubic sampling never runs off the grid. */
const MARGIN = 3;

export function coarseGrid(spec: WorldSpec): CoarseGrid {
  const b = worldBounds(spec);
  const cells = Math.ceil((b.max - b.min) / spec.coarseCell) + 1 + 2 * MARGIN;
  return {
    width: cells,
    depth: cells,
    cell: spec.coarseCell,
    originX: b.min - MARGIN * spec.coarseCell,
    originZ: b.min - MARGIN * spec.coarseCell,
  };
}

/** Per-field seed derived from the world seed (procgen uses the low 32 bits). */
export function fieldSeed(worldSeed: number, salt: number): bigint {
  return (BigInt(worldSeed) * 0x9e3779b1n + BigInt(salt)) & 0xffffffffn;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Normalised FBm noise (-1..1) at every coarse cell, feature size `scale`
 * metres. Uses the native procgen addon one 16×16 block at a time: cell
 * (u, v) is noise coordinate (u, v), so blocks tile exactly.
 */
export function noiseField(grid: CoarseGrid, seed: bigint, scale: number): Float32Array {
  const frequency = Math.min(1, grid.cell / scale);
  const source = makeProcgenChunkSource({ amplitude: 1, frequency });
  const out = new Float32Array(grid.width * grid.depth);
  const block = new Float32Array(source.chunkSamples);
  for (let bz = 0; bz * 15 < grid.depth; bz++) {
    for (let bx = 0; bx * 15 < grid.width; bx++) {
      source.generateChunk(seed, bx, bz, 0, block);
      for (let j = 0; j < 16; j++) {
        const v = bz * 15 + j;
        if (v >= grid.depth) break;
        for (let i = 0; i < 16; i++) {
          const u = bx * 15 + i;
          if (u < grid.width) out[v * grid.width + u] = block[j * 16 + i];
        }
      }
    }
  }
  return out;
}

function sampleNearest(field: Float32Array, grid: CoarseGrid, x: number, z: number): number {
  const u = Math.min(grid.width - 1, Math.max(0, Math.round((x - grid.originX) / grid.cell)));
  const v = Math.min(grid.depth - 1, Math.max(0, Math.round((z - grid.originZ) / grid.cell)));
  return field[v * grid.width + u];
}

/**
 * Spread `n` region centres over the world (best-candidate sampling: each
 * new centre is the candidate farthest from the existing ones).
 */
function placeRegionCentres(spec: WorldSpec, n: number, rng: () => number): Array<{ x: number; z: number }> {
  const b = worldBounds(spec);
  const inset = (b.max - b.min) * 0.08;
  const lo = b.min + inset;
  const span = b.max - b.min - 2 * inset;
  const points: Array<{ x: number; z: number }> = [];
  for (let k = 0; k < n; k++) {
    let best = { x: 0, z: 0 };
    let bestD = -1;
    for (let c = 0; c < 32; c++) {
      const p = { x: lo + rng() * span, z: lo + rng() * span };
      let d = Infinity;
      for (const q of points) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
      if (d > bestD) [best, bestD] = [p, d];
    }
    points.push(best);
  }
  return points;
}

/** Order in which picks claim regions; "rest" takes what is left. */
const PICK_ORDER = ["highest", "lowest-wet", "driest", "wettest", "rest"] as const;

/**
 * Give every region centre a biome, honouring each biome's finite count and
 * its pick rule against the survey (continental elevation, moisture).
 */
export function assignBiomes(
  spec: WorldSpec,
  centres: Array<{ x: number; z: number }>,
  elevationAt: (x: number, z: number) => number,
  moistureAt: (x: number, z: number) => number,
): BiomeRegion[] {
  const pool = centres.map((c, index) => ({ ...c, index, e: elevationAt(c.x, c.z), m: moistureAt(c.x, c.z) }));
  const regions: BiomeRegion[] = [];
  const score: Record<(typeof PICK_ORDER)[number], (p: (typeof pool)[number]) => number> = {
    highest: (p) => p.e,
    "lowest-wet": (p) => p.m - p.e,
    driest: (p) => -p.m,
    wettest: (p) => p.m,
    rest: () => 0,
  };
  for (const pick of PICK_ORDER) {
    spec.biomes.forEach((biome, bi) => {
      if (biome.pick !== pick) return;
      pool.sort((a, b) => score[pick](b) - score[pick](a) || a.index - b.index);
      for (const p of pool.splice(0, biome.count)) regions.push({ index: p.index, biome: bi, x: p.x, z: p.z });
    });
  }
  return regions.sort((a, b) => a.index - b.index);
}

/** 0..1 landform shape of a biome at a point, from its own noise field value n (-1..1). */
function shape(biome: BiomeSpec, n: number, x: number, z: number): number {
  switch (biome.shape) {
    case "rolling":
      return 0.5 * (n + 1);
    case "ridged": {
      const r = 1 - Math.abs(n);
      return r * r;
    }
    case "dunes":
      return 0.5 + 0.5 * Math.sin((2 * Math.PI * (x * 0.8 + z * 0.6)) / biome.scale + 2.5 * n);
    case "flat":
      return 0.15 * (n + 1);
  }
}

function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Droplet hydraulic erosion (after Hans Theobald Beyer's method). Heights
 * are handled in units of one cell width so gradients are true slopes.
 */
function erode(
  h: Float32Array,
  grid: CoarseGrid,
  droplets: number,
  strength: number,
  rng: () => number,
): { meanM: number; maxM: number } {
  const W = grid.width;
  const D = grid.depth;
  const toUnits = 1 / grid.cell;
  for (let i = 0; i < h.length; i++) h[i] *= toUnits;
  const before = Float32Array.from(h);
  const inertia = 0.05;
  const capacityFactor = 4;
  const minCapacity = 0.01;
  const erodeSpeed = 0.3 * strength;
  const depositSpeed = 0.3;
  const evaporate = 0.02;
  const gravity = 4;
  const maxLife = 40;
  const radius = 2;
  // Cap what one droplet step may move (units = cell widths). Without it,
  // a step on 250 m mountains can remove a whole slope's drop at once and
  // 150k droplets carve 100 m canyons instead of weathering the relief.
  const maxStep = 0.04;

  const heightGrad = (x: number, z: number): [number, number, number] => {
    const u = Math.floor(x);
    const v = Math.floor(z);
    const fx = x - u;
    const fz = z - v;
    const i = v * W + u;
    const nw = h[i], ne = h[i + 1], sw = h[i + W], se = h[i + W + 1];
    return [
      nw * (1 - fx) * (1 - fz) + ne * fx * (1 - fz) + sw * (1 - fx) * fz + se * fx * fz,
      (ne - nw) * (1 - fz) + (se - sw) * fz,
      (sw - nw) * (1 - fx) + (se - ne) * fx,
    ];
  };

  for (let d = 0; d < droplets; d++) {
    let x = 1 + rng() * (W - 3);
    let z = 1 + rng() * (D - 3);
    let dx = 0;
    let dz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let life = 0; life < maxLife; life++) {
      const u = Math.floor(x);
      const v = Math.floor(z);
      const fx = x - u;
      const fz = z - v;
      const [height, gx, gz] = heightGrad(x, z);
      dx = dx * inertia - gx * (1 - inertia);
      dz = dz * inertia - gz * (1 - inertia);
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) break;
      dx /= len;
      dz /= len;
      x += dx;
      z += dz;
      if (x < 1 || z < 1 || x >= W - 2 || z >= D - 2) break;
      const deltaH = heightGrad(x, z)[0] - height;
      const capacity = Math.max(-deltaH * speed * water * capacityFactor, minCapacity);
      const i = v * W + u;
      if (sediment > capacity || deltaH > 0) {
        const amount = Math.min(maxStep, deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - capacity) * depositSpeed);
        sediment -= amount;
        h[i] += amount * (1 - fx) * (1 - fz);
        h[i + 1] += amount * fx * (1 - fz);
        h[i + W] += amount * (1 - fx) * fz;
        h[i + W + 1] += amount * fx * fz;
      } else {
        const amount = Math.min(maxStep, (capacity - sediment) * erodeSpeed, -deltaH);
        // Spread the removal over a small brush so channels stay smooth.
        let wsum = 0;
        for (let bz = -radius; bz <= radius; bz++) {
          for (let bx = -radius; bx <= radius; bx++) {
            const w = Math.max(0, radius - Math.hypot(bx, bz));
            if (w > 0 && u + bx > 0 && v + bz > 0 && u + bx < W - 1 && v + bz < D - 1) wsum += w;
          }
        }
        if (wsum > 0) {
          for (let bz = -radius; bz <= radius; bz++) {
            for (let bx = -radius; bx <= radius; bx++) {
              const w = Math.max(0, radius - Math.hypot(bx, bz));
              if (w <= 0 || u + bx <= 0 || v + bz <= 0 || u + bx >= W - 1 || v + bz >= D - 1) continue;
              // Heights are signed metres (swamps sit below 0), so no
              // clamp at zero: each brush cell gives up its share.
              const take = (amount * w) / wsum;
              h[(v + bz) * W + (u + bx)] -= take;
              sediment += take;
            }
          }
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + -deltaH * gravity));
      water *= 1 - evaporate;
    }
  }
  let sum = 0;
  let max = 0;
  for (let i = 0; i < h.length; i++) {
    const change = Math.abs(h[i] - before[i]) * grid.cell;
    sum += change;
    if (change > max) max = change;
    h[i] *= grid.cell;
  }
  return { meanM: sum / h.length, maxM: max };
}

/**
 * Priority-flood depression filling (Barnes, Lehman & Mulla 2014): raise
 * every enclosed hollow to its spill level (+ a tiny gradient so flats
 * drain), giving a surface on which all water reaches the world's edge.
 * Used only to ROUTE flow — the terrain itself keeps its hollows.
 */
export function fillDepressions(h: Float32Array, grid: CoarseGrid): Float32Array {
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const filled = Float32Array.from(h);
  const closed = new Uint8Array(N);
  // Binary min-heap of cell indices keyed by filled height.
  const heap = new Int32Array(N);
  let size = 0;
  const less = (a: number, b: number): boolean =>
    filled[heap[a]] < filled[heap[b]] || (filled[heap[a]] === filled[heap[b]] && heap[a] < heap[b]);
  const push = (i: number): void => {
    let k = size++;
    heap[k] = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(k, p)) break;
      [heap[k], heap[p]] = [heap[p], heap[k]];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    heap[0] = heap[--size];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < size && less(l, m)) m = l;
      if (r < size && less(r, m)) m = r;
      if (m === k) break;
      [heap[k], heap[m]] = [heap[m], heap[k]];
      k = m;
    }
    return top;
  };
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      if (u === 0 || v === 0 || u === W - 1 || v === D - 1) {
        closed[v * W + u] = 1;
        push(v * W + u);
      }
    }
  }
  const epsilon = 1e-3;
  while (size > 0) {
    const c = pop();
    const u = c % W;
    const v = (c - u) / W;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nu = u + dx;
        const nv = v + dz;
        if ((dx === 0 && dz === 0) || nu < 0 || nv < 0 || nu >= W || nv >= D) continue;
        const n = nv * W + nu;
        if (closed[n]) continue;
        closed[n] = 1;
        filled[n] = Math.max(filled[n], filled[c] + epsilon);
        push(n);
      }
    }
  }
  return filled;
}

/** D8 flow accumulation: every cell drains to its steepest-descent neighbour. */
export function flowAccumulation(h: Float32Array, grid: CoarseGrid): Float32Array {
  const W = grid.width;
  const D = grid.depth;
  const area = grid.cell * grid.cell;
  const flow = new Float32Array(h.length).fill(area);
  const order = Uint32Array.from({ length: h.length }, (_, i) => i).sort((a, b) => h[b] - h[a] || a - b);
  for (const i of order) {
    const u = i % W;
    const v = (i - u) / W;
    let best = -1;
    let bestDrop = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dz === 0) || u + dx < 0 || v + dz < 0 || u + dx >= W || v + dz >= D) continue;
        const n = (v + dz) * W + (u + dx);
        const drop = (h[i] - h[n]) / (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1);
        if (drop > bestDrop) [best, bestDrop] = [n, drop];
      }
    }
    if (best >= 0) flow[best] += flow[i];
  }
  return flow;
}

export function surveyWorld(spec: WorldSpec): Survey {
  const grid = coarseGrid(spec);
  const W = grid.width;
  const N = W * grid.depth;
  const continental = noiseField(grid, fieldSeed(spec.seed, 1), spec.continentalScale);
  const moisture = noiseField(grid, fieldSeed(spec.seed, 2), spec.continentalScale * 0.8);
  const biomeNoise = spec.biomes.map((b, i) => noiseField(grid, fieldSeed(spec.seed, 100 + i), b.scale));

  const total = spec.biomes.reduce((n, b) => n + b.count, 0);
  const rng = mulberry32(spec.seed ^ 0x5eed);
  const regions = assignBiomes(
    spec,
    placeRegionCentres(spec, total, rng),
    (x, z) => sampleNearest(continental, grid, x, z),
    (x, z) => sampleNearest(moisture, grid, x, z),
  );

  // Blend biome landforms: softmax over distance to region centres, so
  // borders are smooth over ~blendWidth metres.
  const height = new Float32Array(N);
  const roughness = new Float32Array(N);
  const biome = new Uint8Array(N);
  const region = new Uint16Array(N);
  const tau = spec.blendWidth / 3;
  const dist = new Float64Array(regions.length);
  const biomeWeight = new Float64Array(spec.biomes.length);
  for (let v = 0; v < grid.depth; v++) {
    const z = grid.originZ + v * grid.cell;
    for (let u = 0; u < W; u++) {
      const x = grid.originX + u * grid.cell;
      const i = v * W + u;
      let dmin = Infinity;
      let nearest = 0;
      for (let r = 0; r < regions.length; r++) {
        dist[r] = Math.hypot(x - regions[r].x, z - regions[r].z);
        if (dist[r] < dmin) [dmin, nearest] = [dist[r], r];
      }
      // Depth inside the nearest biome's territory: half the extra distance
      // to the nearest region of another biome (0 on the border). Touching
      // regions of one biome are one territory, so they form one massif.
      const nearBiome = regions[nearest].biome;
      let dOther = Infinity;
      for (let r = 0; r < regions.length; r++) {
        if (regions[r].biome !== nearBiome && dist[r] < dOther) dOther = dist[r];
      }
      const depth = (dOther - dmin) / 2;
      biomeWeight.fill(0);
      let wsum = 0;
      for (let r = 0; r < regions.length; r++) {
        const w = Math.exp(-(dist[r] - dmin) / tau);
        biomeWeight[regions[r].biome] += w;
        wsum += w;
      }
      let h = continental[i] * spec.continentalRelief;
      let rough = 0;
      let dominant = 0;
      for (let b = 0; b < spec.biomes.length; b++) {
        const w = biomeWeight[b] / wsum;
        if (w === 0) continue;
        const bs = spec.biomes[b];
        // A ramped biome's relief grows from nothing at its border to full
        // height `ramp` metres in (it has none outside its territory).
        const rise = bs.ramp > 0 ? (b === nearBiome ? smoothstep(depth / bs.ramp) : 0) : 1;
        h += w * (bs.base + bs.relief * rise * shape(bs, biomeNoise[b][i], x, z));
        rough += w * bs.roughness;
        if (biomeWeight[b] > biomeWeight[dominant]) dominant = b;
      }
      height[i] = h;
      roughness[i] = rough;
      biome[i] = dominant;
      region[i] = regions[nearest].index;
    }
  }

  const erosion = erode(height, grid, spec.erosion.droplets, spec.erosion.strength, mulberry32(spec.seed ^ 0xe20d));

  // Rivers: route water over the depression-filled surface (so hollows
  // don't swallow it), then carve beds into the real terrain wherever the
  // upstream catchment is large enough.
  const flow = flowAccumulation(fillDepressions(height, grid), grid);
  const river = new Uint8Array(N);
  let riverCells = 0;
  const { minCatchment, maxDepth } = spec.rivers;
  const carve = new Float32Array(N);
  for (let v = MARGIN; v < grid.depth - MARGIN; v++) {
    for (let u = MARGIN; u < W - MARGIN; u++) {
      const i = v * W + u;
      if (flow[i] < minCatchment) continue;
      river[i] = 1;
      riverCells++;
      const depth = maxDepth * Math.min(1, 0.25 + Math.log(flow[i] / minCatchment) / Math.log(64));
      carve[i] = Math.max(carve[i], depth);
      // Soften the banks so beds are valleys, not slots.
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = (v + dz) * W + (u + dx);
          carve[n] = Math.max(carve[n], depth * 0.4);
        }
      }
    }
  }
  for (let i = 0; i < N; i++) height[i] -= carve[i];

  return {
    spec,
    grid,
    height,
    roughness,
    biome,
    region,
    moisture,
    flow,
    river,
    regions,
    stats: { erodedMeanM: erosion.meanM, erodedMaxM: erosion.maxM, riverCells },
  };
}
