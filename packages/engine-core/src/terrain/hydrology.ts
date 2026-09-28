/**
 * Hydrology — where the water is once the land has its final shape:
 *
 *  - sea: every cell below sea level connected to the open water at the
 *    world's edge (inlets and lagoons included);
 *  - lakes: hollows the land can't drain, deep, large and wet enough to
 *    hold water (dry hollows stay dry — salt flats in the desert);
 *  - rivers: where the rain-weighted upstream area gets large, from the
 *    hills down to the sea or a lake.
 */

import type { CoarseGrid } from "./survey.js";
import { labelComponents } from "./grid-ops.js";

/** Water kinds in the survey's `water` map. */
export const LAND = 0;
export const SEA = 1;
export const LAKE = 2;

/**
 * Priority-flood depression filling (Barnes, Lehman & Mulla 2014): raise
 * every enclosed hollow to its spill level (+ a tiny gradient so flats
 * drain), giving a surface on which all water reaches the world's edge.
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

/**
 * Steepest-descent receivers and a high-to-low processing order over a
 * depression-filled surface (every land cell drains to the edge).
 */
export function drainage(surface: Float32Array, grid: CoarseGrid): { receiver: Int32Array; distance: Float32Array; order: Uint32Array } {
  const W = grid.width;
  const D = grid.depth;
  const receiver = new Int32Array(surface.length).fill(-1);
  const distance = new Float32Array(surface.length);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      let best = -1;
      let bestDrop = 0;
      let bestDist = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dz === 0) || u + dx < 0 || v + dz < 0 || u + dx >= W || v + dz >= D) continue;
          const j = (v + dz) * W + (u + dx);
          const dist = dx !== 0 && dz !== 0 ? Math.SQRT2 * grid.cell : grid.cell;
          const drop = (surface[i] - surface[j]) / dist;
          if (drop > bestDrop) [best, bestDrop, bestDist] = [j, drop, dist];
        }
      }
      receiver[i] = best;
      distance[i] = bestDist;
    }
  }
  const order = Uint32Array.from({ length: surface.length }, (_, i) => i).sort((a, b) => surface[b] - surface[a] || a - b);
  return { receiver, distance, order };
}

/** Upstream area (m²) per cell, each cell weighted (e.g. by its rainfall share). */
export function accumulate(
  { receiver, order }: { receiver: Int32Array; order: Uint32Array },
  grid: CoarseGrid,
  weight: (i: number) => number,
): Float32Array {
  const area = grid.cell * grid.cell;
  const acc = new Float32Array(receiver.length);
  for (let i = 0; i < acc.length; i++) acc[i] = area * weight(i);
  for (const i of order) if (receiver[i] >= 0) acc[receiver[i]] += acc[i];
  return acc;
}

/** D8 flow accumulation (upstream area, m²): every cell drains to its steepest-descent neighbour. */
export function flowAccumulation(h: Float32Array, grid: CoarseGrid, weight: (i: number) => number = () => 1): Float32Array {
  return accumulate(drainage(h, grid), grid, weight);
}

/**
 * Sea: cells below sea level connected (4-way) to below-sea cells on the
 * world's edge. Returns 1 for sea.
 */
export function seaMask(h: Float32Array, grid: CoarseGrid, seaLevel: number): Uint8Array {
  const W = grid.width;
  const D = grid.depth;
  const below = labelComponents(W, D, (i) => h[i] < seaLevel);
  const open = new Set<number>();
  for (let u = 0; u < W; u++) {
    for (const v of [0, D - 1]) if (below.label[v * W + u] >= 0) open.add(below.label[v * W + u]);
  }
  for (let v = 0; v < D; v++) {
    for (const u of [0, W - 1]) if (below.label[v * W + u] >= 0) open.add(below.label[v * W + u]);
  }
  const sea = new Uint8Array(W * D);
  for (let i = 0; i < W * D; i++) if (below.label[i] >= 0 && open.has(below.label[i])) sea[i] = 1;
  return sea;
}

/**
 * Lakes in the hollows of the land: connected cells the filled surface
 * stands above, kept where the hollow is at least `minDepth` deep, covers
 * `minArea` m², and gets `minRainMm` on average. Returns the lake mask and
 * each lake cell's water level (NaN elsewhere).
 */
export function findLakes(
  h: Float32Array,
  filled: Float32Array,
  grid: CoarseGrid,
  sea: Uint8Array,
  rainMm: Float32Array,
  opts: { minDepth: number; minArea: number; minRainMm: number },
): { lake: Uint8Array; level: Float32Array } {
  const W = grid.width;
  const D = grid.depth;
  const hollow = labelComponents(W, D, (i) => !sea[i] && filled[i] - h[i] > 0.05);
  const n = hollow.sizes.length;
  const deepest = new Float32Array(n);
  const rainSum = new Float64Array(n);
  for (let i = 0; i < W * D; i++) {
    const k = hollow.label[i];
    if (k < 0) continue;
    deepest[k] = Math.max(deepest[k], filled[i] - h[i]);
    rainSum[k] += rainMm[i];
  }
  const minCells = opts.minArea / (grid.cell * grid.cell);
  const lake = new Uint8Array(W * D);
  const level = new Float32Array(W * D).fill(Number.NaN);
  for (let i = 0; i < W * D; i++) {
    const k = hollow.label[i];
    if (k < 0) continue;
    if (deepest[k] >= opts.minDepth && hollow.sizes[k] >= minCells && rainSum[k] / hollow.sizes[k] >= opts.minRainMm) {
      lake[i] = 1;
      level[i] = filled[i];
    }
  }
  return { lake, level };
}

/**
 * Carve river beds: deeper where more water flows, with soft banks so they
 * read as valleys, not slots. Only land is carved.
 */
export function carveRivers(
  h: Float32Array,
  grid: CoarseGrid,
  river: Uint8Array,
  discharge: Float32Array,
  water: Uint8Array,
  minCatchment: number,
  maxDepth: number,
): void {
  const W = grid.width;
  const D = grid.depth;
  const carve = new Float32Array(W * D);
  for (let v = 1; v < D - 1; v++) {
    for (let u = 1; u < W - 1; u++) {
      const i = v * W + u;
      if (!river[i]) continue;
      const depth = maxDepth * Math.min(1, 0.25 + Math.log(discharge[i] / minCatchment) / Math.log(64));
      carve[i] = Math.max(carve[i], depth);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = (v + dz) * W + (u + dx);
          carve[n] = Math.max(carve[n], depth * 0.4);
        }
      }
    }
  }
  for (let i = 0; i < W * D; i++) if (water[i] === LAND) h[i] -= carve[i];
}
