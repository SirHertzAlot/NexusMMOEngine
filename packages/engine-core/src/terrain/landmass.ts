/**
 * Landmass — the first survey stage: where the land is, how it rises from
 * the sea, and where mountain ranges push it up. No biomes here; they
 * come later from what the climate does to this land.
 *
 * The coast frame: `t` runs from the land edge (0) to the sea edge (1),
 * `a` across it (-1..1). The land fills the world near t = 0 and narrows
 * into a peninsula toward t = `tip`; the sea edge and the stretches of
 * the side edges nearest it are open water (`waterEdge` of the world's
 * edge in all). Noise warps the frame so the coast wanders into bays and
 * headlands.
 */

import type { CoarseGrid } from "./survey.js";
import { distanceTo, labelComponents, smoothstep } from "./grid-ops.js";
import { windVector, worldBounds, type WorldSpec } from "./world-spec.js";

/** A mountain range's axis, world metres. */
export interface RangeAxis {
  points: Array<{ x: number; z: number }>;
}

/** Coast frame of a world point: t (land edge 0 → sea edge 1), a (across, -1..1). */
export function coastFrame(spec: WorldSpec, x: number, z: number): { t: number; a: number } {
  const b = worldBounds(spec);
  const span = b.max - b.min;
  const fx = (x - b.min) / span;
  const fz = (z - b.min) / span;
  switch (spec.land.coast.side) {
    case "south":
      return { t: fz, a: 2 * fx - 1 };
    case "north":
      return { t: 1 - fz, a: 2 * fx - 1 };
    case "east":
      return { t: fx, a: 2 * fz - 1 };
    case "west":
      return { t: 1 - fx, a: 2 * fz - 1 };
  }
}

/** Where the side edges turn from land to sea (0..1 along t). */
export function landEdgeT(spec: WorldSpec): number {
  return 1 - 2 * (spec.land.coast.waterEdge - 0.25);
}

/** Half-width of the land (in `a` units) at t: > 1 = the land reaches both side edges. */
function halfWidth(spec: WorldSpec, t: number): number {
  const { tip, taper } = spec.land.coast;
  const tEdge = landEdgeT(spec);
  if (t <= tEdge) return 1 + (tEdge - t);
  if (t >= tip) return -2 * (t - tip);
  return Math.pow((tip - t) / (tip - tEdge), taper);
}

/**
 * Land mask (1 = land) from the warped coast frame, as one landmass: sea
 * pockets enclosed by land become land (lakes come from drainage later)
 * and islands smaller than `minIslandArea` sink.
 */
export function landMask(spec: WorldSpec, grid: CoarseGrid, warpA: Float32Array, warpT: Float32Array): Uint8Array {
  const b = worldBounds(spec);
  const span = b.max - b.min;
  const W = grid.width;
  const D = grid.depth;
  const wander = spec.land.coast.wander / span;
  const mask = new Uint8Array(W * D);
  for (let v = 0; v < D; v++) {
    const z = grid.originZ + v * grid.cell;
    for (let u = 0; u < W; u++) {
      const x = grid.originX + u * grid.cell;
      const i = v * W + u;
      const f = coastFrame(spec, x, z);
      const t = f.t + wander * warpT[i];
      const a = f.a + 2 * wander * warpA[i];
      mask[i] = halfWidth(spec, t) - Math.abs(a) > 0 ? 1 : 0;
    }
  }
  return tidyLandmass(mask, W, D, grid.cell, spec.land.minIslandArea);
}

/**
 * One landmass: water not connected to the open sea (the grid border's
 * water) becomes land, and land components smaller than `minIslandArea`
 * become water. Returns a new mask.
 */
export function tidyLandmass(land: Uint8Array, W: number, D: number, cell: number, minIslandArea: number): Uint8Array {
  const out = Uint8Array.from(land);
  const water = labelComponents(W, D, (i) => out[i] === 0);
  const open = new Set<number>();
  for (let u = 0; u < W; u++) {
    for (const v of [0, D - 1]) if (water.label[v * W + u] >= 0) open.add(water.label[v * W + u]);
  }
  for (let v = 0; v < D; v++) {
    for (const u of [0, W - 1]) if (water.label[v * W + u] >= 0) open.add(water.label[v * W + u]);
  }
  for (let i = 0; i < W * D; i++) if (out[i] === 0 && !open.has(water.label[i])) out[i] = 1;

  const islands = labelComponents(W, D, (i) => out[i] === 1);
  let largest = -1;
  for (let k = 0; k < islands.sizes.length; k++) if (largest < 0 || islands.sizes[k] > islands.sizes[largest]) largest = k;
  const minCells = minIslandArea / (cell * cell);
  for (let i = 0; i < W * D; i++) {
    const k = islands.label[i];
    if (k >= 0 && k !== largest && islands.sizes[k] < minCells) out[i] = 0;
  }
  return out;
}

/**
 * Base elevation before ranges: the land climbs from just above the sea at
 * the coast toward `rise` inland, with broad swells; the sea floor falls
 * away to `shelfDepth` offshore.
 */
export function baseElevation(spec: WorldSpec, grid: CoarseGrid, land: Uint8Array, swell: Float32Array): Float32Array {
  const W = grid.width;
  const D = grid.depth;
  const L = spec.land;
  const toSea = distanceTo(W, D, grid.cell, (i) => land[i] === 0);
  const toLand = distanceTo(W, D, grid.cell, (i) => land[i] === 1);
  const h = new Float32Array(W * D);
  for (let i = 0; i < W * D; i++) {
    if (land[i]) {
      const d = toSea[i];
      // Swells fade in over the first 150 m so the shore stays low; where
      // one dips below the sea it floods into an inlet.
      h[i] = L.seaLevel + 0.6 + L.rise * (1 - Math.exp(-d / L.riseDistance)) + L.relief * swell[i] * Math.min(1, d / 150);
    } else {
      const d = toLand[i];
      h[i] = L.seaLevel - 0.6 - L.shelfDepth * (1 - Math.exp(-d / L.shelfWidth)) + 2 * swell[i];
    }
  }
  return h;
}

/**
 * Lay out mountain range axes on the land, roughly across the prevailing
 * wind (so they catch its rain and cast a shadow behind them), clear of
 * the coast and of each other. A range that can't fit is shortened, and
 * dropped if even a short one can't.
 */
export function placeRanges(spec: WorldSpec, grid: CoarseGrid, land: Uint8Array, rng: () => number): RangeAxis[] {
  const R = spec.ranges;
  const W = grid.width;
  const D = grid.depth;
  const toSea = distanceTo(W, D, grid.cell, (i) => land[i] === 0);
  const at = (x: number, z: number): number => {
    const u = Math.round((x - grid.originX) / grid.cell);
    const v = Math.round((z - grid.originZ) / grid.cell);
    if (u < 0 || v < 0 || u >= W || v >= D) return -1;
    return toSea[v * W + u];
  };
  const wind = windVector(spec.climate.wind);
  const across = Math.atan2(wind.x, -wind.z); // perpendicular to the wind
  const eligible: number[] = [];
  for (let i = 0; i < W * D; i++) if (land[i] && toSea[i] >= R.coastClearance) eligible.push(i);

  const ranges: RangeAxis[] = [];
  const segments = 16;
  for (let k = 0; k < R.count && eligible.length > 0; k++) {
    let placed: RangeAxis | null = null;
    for (let length = R.length; !placed && length >= R.length * 0.3; length *= 0.8) {
      for (let attempt = 0; attempt < 60 && !placed; attempt++) {
        const c = eligible[Math.floor(rng() * eligible.length)];
        const cx = grid.originX + (c % W) * grid.cell;
        const cz = grid.originZ + Math.floor(c / W) * grid.cell;
        const heading = across + (rng() - 0.5) * 0.7;
        const step = length / segments;
        const half = (dir: number): Array<{ x: number; z: number }> => {
          const pts: Array<{ x: number; z: number }> = [];
          let x = cx;
          let z = cz;
          let a = heading;
          for (let s = 0; s < segments / 2; s++) {
            a += (rng() - 0.5) * 0.25;
            x += dir * Math.cos(a) * step;
            z += dir * Math.sin(a) * step;
            pts.push({ x, z });
          }
          return pts;
        };
        const points = [...half(-1).reverse(), { x: cx, z: cz }, ...half(1)];
        const clear = points.every((p) => at(p.x, p.z) >= R.coastClearance * 0.6);
        const apart = ranges.every((r) =>
          r.points.every((q) => points.every((p) => Math.hypot(p.x - q.x, p.z - q.z) >= R.width * 0.9)),
        );
        if (clear && apart) placed = { points };
      }
    }
    if (placed) ranges.push(placed);
  }
  return ranges;
}

/**
 * Uplift from the ranges: a smooth ridge profile across each axis, tapered
 * at its ends and varied along it, broken into ridges and valleys by
 * ridged noise. Overlapping ranges take the higher uplift.
 */
export function rangeUplift(
  spec: WorldSpec,
  grid: CoarseGrid,
  ranges: RangeAxis[],
  ridgeNoise: Float32Array,
  alongNoise: Float32Array,
): Float32Array {
  const R = spec.ranges;
  const W = grid.width;
  const D = grid.depth;
  const up = new Float32Array(W * D);
  const halfW = R.width / 2;
  for (const range of ranges) {
    const p = range.points;
    const cum = [0];
    for (let s = 1; s < p.length; s++) cum.push(cum[s - 1] + Math.hypot(p[s].x - p[s - 1].x, p[s].z - p[s - 1].z));
    const total = cum[cum.length - 1];
    const xs = p.map((q) => q.x);
    const zs = p.map((q) => q.z);
    const u0 = Math.max(0, Math.floor((Math.min(...xs) - halfW - grid.originX) / grid.cell));
    const u1 = Math.min(W - 1, Math.ceil((Math.max(...xs) + halfW - grid.originX) / grid.cell));
    const v0 = Math.max(0, Math.floor((Math.min(...zs) - halfW - grid.originZ) / grid.cell));
    const v1 = Math.min(D - 1, Math.ceil((Math.max(...zs) + halfW - grid.originZ) / grid.cell));
    for (let v = v0; v <= v1; v++) {
      const z = grid.originZ + v * grid.cell;
      for (let u = u0; u <= u1; u++) {
        const x = grid.originX + u * grid.cell;
        let best = Infinity;
        let along = 0;
        for (let s = 1; s < p.length; s++) {
          const ax = p[s - 1].x;
          const az = p[s - 1].z;
          const dx = p[s].x - ax;
          const dz = p[s].z - az;
          const len2 = dx * dx + dz * dz;
          const k = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
          const d = Math.hypot(x - (ax + k * dx), z - (az + k * dz));
          if (d < best) {
            best = d;
            along = (cum[s - 1] + k * (cum[s] - cum[s - 1])) / total;
          }
        }
        const r = best / halfW;
        if (r >= 1) continue;
        const i = v * W + u;
        const profile = (1 - r * r) * (1 - r * r);
        const ends = smoothstep(0, 0.2, along) * smoothstep(0, 0.2, 1 - along);
        const lift = R.height * profile * ends * (0.75 + 0.25 * alongNoise[i]);
        if (lift > up[i]) up[i] = lift;
      }
    }
  }
  for (let i = 0; i < W * D; i++) {
    if (up[i] === 0) continue;
    const ridge = (1 - Math.abs(ridgeNoise[i])) ** 2; // 0..1, crests where the noise crosses 0
    up[i] *= 1 - R.ridges + 2 * R.ridges * ridge;
  }
  return up;
}
