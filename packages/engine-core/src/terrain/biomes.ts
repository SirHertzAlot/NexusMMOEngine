/**
 * Biomes — read off the finished land and climate, not placed.
 *
 * Every cell is classified by the spec's biome rules (first match wins),
 * then land biomes are smoothed into coherent regions: a majority filter
 * removes speckle, and patches smaller than `minBiomeArea` join the biome
 * around them. Water cells keep whatever the rules made of them. Finally
 * each biome adds its surface character (dunes, flats, hills), blended
 * across borders so no biome stands on a step.
 */

import type { BiomeRegion, CoarseGrid } from "./survey.js";
import { boxBlur } from "./grid-ops.js";
import { LAKE, LAND, SEA } from "./hydrology.js";
import { windVector, type BiomeCondition, type Bound, type WorldSpec } from "./world-spec.js";

/** What the rules can see of each cell. */
export interface BiomeInputs {
  water: Uint8Array;
  tempC: Float32Array;
  rainMm: Float32Array;
  /** Height above sea level, metres. */
  height: Float32Array;
  slopeDeg: Float32Array;
  coastDistance: Float32Array;
  waterDistance: Float32Array;
  freshwaterDistance: Float32Array;
  seaExposure: Float32Array;
  ice: Uint8Array;
  volcanoDistance: Float32Array;
}

const within = (b: Bound | undefined, x: number): boolean =>
  b === undefined || ((b.min === undefined || x >= b.min) && (b.max === undefined || x <= b.max));

function matches(c: BiomeCondition, f: BiomeInputs, i: number): boolean {
  if (c.water !== undefined) {
    const kind = f.water[i] === SEA ? "sea" : f.water[i] === LAKE ? "lake" : "land";
    if (kind !== c.water) return false;
  }
  return (
    within(c.tempC, f.tempC[i]) &&
    within(c.rainMm, f.rainMm[i]) &&
    within(c.height, f.height[i]) &&
    within(c.slopeDeg, f.slopeDeg[i]) &&
    within(c.coastDistance, f.coastDistance[i]) &&
    within(c.waterDistance, f.waterDistance[i]) &&
    within(c.freshwaterDistance, f.freshwaterDistance[i]) &&
    within(c.seaExposure, f.seaExposure[i]) &&
    within(c.ice, f.ice[i]) &&
    within(c.volcanoDistance, f.volcanoDistance[i])
  );
}

/** Biome index per cell: the first rule whose condition (or any alternative) holds. */
export function classifyBiomes(spec: WorldSpec, f: BiomeInputs): Uint8Array {
  const rules = spec.biomes.map((b) => (b.when === undefined ? null : Array.isArray(b.when) ? b.when : [b.when]));
  const out = new Uint8Array(f.water.length);
  for (let i = 0; i < out.length; i++) {
    let k = 0;
    while (k < rules.length - 1) {
      const alts = rules[k];
      if (alts === null || alts.some((c) => matches(c, f, i))) break;
      k++;
    }
    out[i] = k;
  }
  return out;
}

/**
 * Smooth land biomes into regions (in place): `passes` of a 3×3 majority
 * filter over land cells, then patches under `minCells` join the biome
 * they share the most border with. Water cells never change and never
 * spread onto land.
 */
export function smoothBiomes(biome: Uint8Array, water: Uint8Array, W: number, D: number, minCells: number, passes = 2): void {
  const counts = new Uint16Array(256);
  for (let p = 0; p < passes; p++) {
    const next = Uint8Array.from(biome);
    for (let v = 1; v < D - 1; v++) {
      for (let u = 1; u < W - 1; u++) {
        const i = v * W + u;
        if (water[i] !== LAND) continue;
        let best = biome[i];
        const seen: number[] = [];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = i + dz * W + dx;
            if (water[j] !== LAND) continue;
            if (counts[biome[j]]++ === 0) seen.push(biome[j]);
          }
        }
        for (const b of seen) if (counts[b] > counts[best]) best = b;
        for (const b of seen) counts[b] = 0;
        next[i] = best;
      }
    }
    biome.set(next);
  }

  for (let round = 0; round < 4; round++) {
    const comp = labelByBiome(biome, water, W, D);
    let changed = false;
    const border = new Map<number, Map<number, number>>();
    for (let i = 0; i < W * D; i++) {
      const k = comp.label[i];
      if (k < 0 || comp.sizes[k] >= minCells) continue;
      const u = i % W;
      const v = (i - u) / W;
      for (const j of [u > 0 ? i - 1 : -1, u < W - 1 ? i + 1 : -1, v > 0 ? i - W : -1, v < D - 1 ? i + W : -1]) {
        if (j < 0 || water[j] !== LAND || comp.label[j] === k) continue;
        let m = border.get(k);
        if (!m) border.set(k, (m = new Map()));
        m.set(biome[j], (m.get(biome[j]) ?? 0) + 1);
      }
    }
    for (let i = 0; i < W * D; i++) {
      const m = border.get(comp.label[i]);
      if (!m) continue;
      let best = -1;
      let most = 0;
      for (const [b, n] of m) if (n > most || (n === most && b < best)) [best, most] = [b, n];
      if (best >= 0 && biome[i] !== best) {
        biome[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** 4-connected components of equal biome over land cells. */
function labelByBiome(biome: Uint8Array, water: Uint8Array, W: number, D: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(W * D).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(W * D);
  for (let s = 0; s < W * D; s++) {
    if (label[s] !== -1 || water[s] !== LAND) continue;
    const id = sizes.length;
    const b = biome[s];
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const u = i % W;
      const v = (i - u) / W;
      for (const j of [u > 0 ? i - 1 : -1, u < W - 1 ? i + 1 : -1, v > 0 ? i - W : -1, v < D - 1 ? i + W : -1]) {
        if (j >= 0 && label[j] === -1 && water[j] === LAND && biome[j] === b) {
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/**
 * Biome regions: every connected patch of one biome (water included),
 * with its size and centroid. Returns the per-cell region index too.
 */
export function biomeRegions(biome: Uint8Array, grid: CoarseGrid): { regions: BiomeRegion[]; region: Uint16Array } {
  const W = grid.width;
  const D = grid.depth;
  const label = new Int32Array(W * D).fill(-1);
  const regions: BiomeRegion[] = [];
  const stack = new Int32Array(W * D);
  for (let s = 0; s < W * D; s++) {
    if (label[s] !== -1) continue;
    const id = regions.length;
    const b = biome[s];
    let top = 0;
    let n = 0;
    let sx = 0;
    let sz = 0;
    stack[top++] = s;
    label[s] = id;
    while (top > 0) {
      const i = stack[--top];
      const u = i % W;
      const v = (i - u) / W;
      n++;
      sx += u;
      sz += v;
      for (const j of [u > 0 ? i - 1 : -1, u < W - 1 ? i + 1 : -1, v > 0 ? i - W : -1, v < D - 1 ? i + W : -1]) {
        if (j >= 0 && label[j] === -1 && biome[j] === b) {
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    regions.push({
      index: id,
      biome: b,
      x: grid.originX + (sx / n) * grid.cell,
      z: grid.originZ + (sz / n) * grid.cell,
      cells: n,
    });
  }
  const region = new Uint16Array(W * D);
  for (let i = 0; i < W * D; i++) region[i] = Math.min(0xffff, label[i]);
  return { regions, region };
}

/**
 * Each biome's surface character, blended across its borders over
 * `blendWidth`, added to the land (in place); returns the blended fine
 * detail roughness per cell. `noise(b)` gives biome b's own noise field.
 */
export function applySurface(
  spec: WorldSpec,
  grid: CoarseGrid,
  h: Float32Array,
  biome: Uint8Array,
  water: Uint8Array,
  noise: (b: number) => Float32Array,
): Float32Array {
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const radius = spec.blendWidth / grid.cell / 3;
  const sea = spec.land.seaLevel;
  const wind = windVector(spec.climate.wind);

  const rough = new Float32Array(N);
  for (let i = 0; i < N; i++) rough[i] = spec.biomes[biome[i]].roughness;
  const roughness = boxBlur(rough, W, D, radius);

  const delta = new Float32Array(N);
  spec.biomes.forEach((b, bi) => {
    const s = b.surface;
    if (!s || (s.relief === 0 && s.shape !== "flat")) return;
    const one = new Float32Array(N);
    let any = false;
    for (let i = 0; i < N; i++) {
      if (biome[i] === bi) {
        one[i] = 1;
        any = true;
      }
    }
    if (!any) return;
    const w = boxBlur(one, W, D, radius);
    const n = s.shape === "flat" ? null : noise(bi);
    for (let v = 0; v < D; v++) {
      const z = grid.originZ + v * grid.cell;
      for (let u = 0; u < W; u++) {
        const i = v * W + u;
        if (water[i] !== LAND || w[i] < 1e-3) continue;
        const x = grid.originX + u * grid.cell;
        switch (s.shape) {
          case "rolling":
            delta[i] += w[i] * s.relief * 0.5 * n![i];
            break;
          case "ridged":
            delta[i] += w[i] * s.relief * ((1 - Math.abs(n![i])) ** 2 - 0.45);
            break;
          case "dunes":
            // Crests run across the wind.
            delta[i] += w[i] * s.relief * 0.5 * Math.sin((2 * Math.PI * (x * wind.x + z * wind.z)) / s.scale + 2.5 * n![i]);
            break;
          case "flat":
            // Settle toward `relief` metres above the sea.
            delta[i] += w[i] * 0.85 * (sea + s.relief - h[i]);
            break;
        }
      }
    }
  });
  for (let i = 0; i < N; i++) h[i] += delta[i];
  return roughness;
}
