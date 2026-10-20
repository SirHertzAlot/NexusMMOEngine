/**
 * Erosion — the forms that shape the landform after uplift:
 *
 *  - thermal: ground steeper than its angle of repose collapses downhill
 *    into scree, so uplifted ranges get walkable feet instead of walls;
 *  - fluvial: rivers cut their beds in proportion to how much water they
 *    carry and how steep they run (stream power), carving the branching
 *    valleys that make a range read as a range;
 *  - hydraulic: rain droplets, spawned where it actually rains, wash
 *    soil downhill and drop it where they slow — gullies on wet slopes,
 *    deltas where they reach the sea, little change in the dry lands.
 *
 * All work in place on the coarse height grid (metres).
 */

import type { CoarseGrid } from "./survey.js";
import { accumulate, drainage, fillDepressions } from "./hydrology.js";

/** Bare rock holds a steeper angle: from `fromM` it rises to `deg` over `spanM`. */
export interface RockTalus {
  deg: number;
  fromM: number;
  spanM: number;
}

/**
 * Collapse slopes steeper than `talusDeg`, `passes` times. With `rock`, the
 * angle a cell holds rises with its height, so crests and cliffs of bare
 * rock stay sharp while scree below them settles at `talusDeg`.
 */
export function thermalErosion(h: Float32Array, grid: CoarseGrid, talusDeg: number, passes: number, rock?: RockTalus): void {
  const W = grid.width;
  const D = grid.depth;
  const tan = Math.tan((talusDeg * Math.PI) / 180);
  const limit = [tan * grid.cell, tan * grid.cell * Math.SQRT2];
  const delta = new Float32Array(h.length);
  const excess = new Float32Array(8);
  const nbr = new Int32Array(8);
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    for (let v = 1; v < D - 1; v++) {
      for (let u = 1; u < W - 1; u++) {
        const i = v * W + u;
        let lim0 = limit[0];
        let lim1 = limit[1];
        if (rock && h[i] > rock.fromM) {
          const x = Math.min(1, (h[i] - rock.fromM) / rock.spanM);
          const t = Math.tan(((talusDeg + (rock.deg - talusDeg) * x * x * (3 - 2 * x)) * Math.PI) / 180) * grid.cell;
          lim0 = t;
          lim1 = t * Math.SQRT2;
        }
        let n = 0;
        let sum = 0;
        let max = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const j = i + dz * W + dx;
            const e = h[i] - h[j] - (dx !== 0 && dz !== 0 ? lim1 : lim0);
            if (e > 0) {
              excess[n] = e;
              nbr[n++] = j;
              sum += e;
              if (e > max) max = e;
            }
          }
        }
        if (n === 0) continue;
        // Move half the largest excess, shared by how far each neighbour is
        // over the limit: stable, and never overshoots the lowest one.
        const moved = 0.5 * max;
        delta[i] -= moved;
        for (let k = 0; k < n; k++) delta[nbr[k]] += (moved * excess[k]) / sum;
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
  }
}

/**
 * Stream-power incision: each land cell above sea level is lowered by
 * strength · √(upstream rain-weighted area) · slope per pass, never below
 * the cell it drains into. Returns the deepest cut, metres.
 */
export function fluvialErosion(
  h: Float32Array,
  grid: CoarseGrid,
  seaLevel: number,
  rainShare: Float32Array,
  passes: number,
  strength: number,
): number {
  const MAX_CUT_PER_PASS = 2;
  const before = Float32Array.from(h);
  for (let p = 0; p < passes; p++) {
    const flow = drainage(fillDepressions(h, grid), grid);
    const acc = accumulate(flow, grid, (i) => rainShare[i]);
    for (const i of flow.order) {
      const r = flow.receiver[i];
      if (r < 0 || h[i] <= seaLevel) continue;
      const slope = Math.max(0, h[i] - h[r]) / flow.distance[i];
      const cut = Math.min(MAX_CUT_PER_PASS, strength * Math.sqrt(acc[i]) * slope, Math.max(0, h[i] - h[r] - 0.01));
      h[i] -= cut;
    }
  }
  let deepest = 0;
  for (let i = 0; i < h.length; i++) deepest = Math.max(deepest, before[i] - h[i]);
  return deepest;
}

/**
 * Stream-power incision, implicit and detachment-limited (Braun & Willgoose;
 * as in Cordonnier et al. 2016): each pass relaxes every land cell toward the
 * cell it drains into, h = (h + F * h_receiver) / (1 + F) with
 * F = k * area^m / distance, taken from the outlet upstream so it is stable
 * for any k. Summits (no upstream area) barely move; trunk valleys deepen.
 * No cell is cut more than `maxCutM` in total or below the shore. Flow is
 * re-routed every few passes. `areaWeight` weights each cell's area (rain
 * share). Returns the deepest cut, metres.
 */
export function streamPowerIncision(
  h: Float32Array,
  grid: CoarseGrid,
  seaLevel: number,
  areaWeight: Float32Array,
  passes: number,
  k: number,
  m: number,
  maxCutM: number,
): number {
  if (passes <= 0 || k <= 0) return 0;
  const before = Float32Array.from(h);
  const floor = seaLevel + 0.3;
  let flow = drainage(fillDepressions(h, grid), grid);
  let acc = accumulate(flow, grid, (i) => areaWeight[i]);
  for (let p = 0; p < passes; p++) {
    if (p > 0 && p % 3 === 0) {
      flow = drainage(fillDepressions(h, grid), grid);
      acc = accumulate(flow, grid, (i) => areaWeight[i]);
    }
    const { receiver, distance, order } = flow;
    // order runs high to low: walk it backwards so receivers update first.
    for (let n = order.length - 1; n >= 0; n--) {
      const i = order[n];
      const r = receiver[i];
      if (r < 0 || h[i] <= floor || h[i] <= h[r]) continue;
      const f = (k * (m === 0.5 ? Math.sqrt(acc[i]) : Math.pow(acc[i], m))) / distance[i];
      let next = (h[i] + f * h[r]) / (1 + f);
      next = Math.max(next, before[i] - maxCutM, Math.min(h[i], floor));
      if (next < h[i]) h[i] = next;
    }
  }
  let deepest = 0;
  for (let i = 0; i < h.length; i++) deepest = Math.max(deepest, before[i] - h[i]);
  return deepest;
}

/**
 * Droplet hydraulic erosion (after Hans Theobald Beyer's method). Droplets
 * start where it rains (`rainShare`, 0..1+) on land, and stop — dropping
 * what they carry — when they reach the sea. Heights are handled in units
 * of one cell width so gradients are true slopes. Returns the mean and
 * largest change, metres.
 */
export function dropletErosion(
  h: Float32Array,
  grid: CoarseGrid,
  seaLevel: number,
  rainShare: Float32Array,
  droplets: number,
  strength: number,
  rng: () => number,
): { meanM: number; maxM: number } {
  const W = grid.width;
  const D = grid.depth;
  const toUnits = 1 / grid.cell;
  const sea = seaLevel * toUnits;
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
  // a step on steep mountains can remove a whole slope's drop at once and
  // the droplets carve canyons instead of weathering the relief.
  const maxStep = 0.04;
  let maxShare = 0;
  for (let i = 0; i < rainShare.length; i++) maxShare = Math.max(maxShare, rainShare[i]);

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
  const deposit = (x: number, z: number, amount: number): void => {
    const u = Math.floor(x);
    const v = Math.floor(z);
    const fx = x - u;
    const fz = z - v;
    const i = v * W + u;
    h[i] += amount * (1 - fx) * (1 - fz);
    h[i + 1] += amount * fx * (1 - fz);
    h[i + W] += amount * (1 - fx) * fz;
    h[i + W + 1] += amount * fx * fz;
  };

  let spawned = 0;
  // Rejection sampling by rainfall; bounded so a dry world can't spin.
  for (let tries = 0; spawned < droplets && tries < droplets * 20 && maxShare > 0; tries++) {
    let x = 1 + rng() * (W - 3);
    let z = 1 + rng() * (D - 3);
    const start = Math.floor(z) * W + Math.floor(x);
    if (h[start] <= sea || rng() * maxShare > rainShare[start]) continue;
    spawned++;
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
      const next = heightGrad(x, z)[0];
      if (next <= sea) {
        // Reached the sea: what it carries settles at the mouth (deltas).
        deposit(x, z, Math.min(sediment, maxStep * 4));
        break;
      }
      const deltaH = next - height;
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
