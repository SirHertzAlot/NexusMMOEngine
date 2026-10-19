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

import { mulberry32, type CoarseGrid } from "./survey.js";
import { distanceTo, labelComponents, sampleBilinear, smoothstep } from "./grid-ops.js";
import { crestProfile } from "./relief.js";
import { windVector, worldBounds, type WorldSpec } from "./world-spec.js";

/** A mountain range's axis (world metres) and its size. */
export interface RangeAxis {
  points: Array<{ x: number; z: number }>;
  height: number;
  width: number;
  /** A spur grows out of another range at its first point: no taper there. */
  spur: boolean;
}

/** A volcano's vent, world metres. */
export interface Volcano {
  x: number;
  z: number;
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
  if (spec.land.coast.shape !== "peninsula") {
    islandMask(spec, grid, warpA, warpT, mask);
    return tidyLandmass(mask, W, D, grid.cell, spec.land.minIslandArea);
  }
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

/** A round landmass seed in half-span units: centre and radius. */
interface Blob { x: number; z: number; r: number; p: number }

/** Distance from a blob's centre in its own norm: p = 2 is round, higher is squarer (fills a world cell better). */
const reach = (o: Blob, x: number, z: number): number => Math.pow(Math.pow(Math.abs(x - o.x), o.p) + Math.pow(Math.abs(z - o.z), o.p), 1 / o.p);

/**
 * Where the main landmasses sit. "island": one at the world's centre.
 * "continents": `continents` landmasses spread apart, their sizes grown
 * together until the land covers `continentCover` of the world, or until
 * neighbours are `continentGap` apart (a negative gap lets them overlap,
 * which joins them with land bridges; satellites and wandering coasts add
 * a little).
 */
function mainBlobs(spec: WorldSpec, rng: () => number, share: (blobs: Blob[]) => number): Blob[] {
  const c = spec.land.coast;
  if (c.shape === "island") return [{ x: 0, z: 0, r: c.islandRadius, p: 2 }];
  if (c.shape === "pangaea") {
    // One supercontinent: a large centre and four lobes that overlap it, so the coast is ragged and inland seas and gulfs appear, grown to the cover.
    const lobes: Blob[] = [{ x: 0, z: 0, r: 1, p: 2.3 }];
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      lobes.push({ x: sx * (0.4 + 0.1 * rng()), z: sz * (0.4 + 0.1 * rng()), r: 0.6 + 0.2 * rng(), p: 2.3 });
    }
    let lo = 0.05;
    let hi = 1.6;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (share(lobes.map((b) => ({ ...b, r: b.r * mid }))) < c.continentCover) lo = mid;
      else hi = mid;
    }
    return lobes.map((b) => ({ ...b, r: b.r * ((lo + hi) / 2) }));
  }
  const n = c.continents;
  // Centres on a jittered grid (the best way to pack big round landmasses
  // with room between them); cells beyond `n` stay empty, chosen at random.
  const cols = Math.ceil(Math.sqrt(n));
  const cells: Blob[] = [];
  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const x = ((col + 0.5) / cols) * 2 - 1 + (rng() - 0.5) * 0.12;
      const z = ((row + 0.5) / cols) * 2 - 1 + (rng() - 0.5) * 0.12;
      cells.push({ x, z, r: 0.92 + 0.16 * rng(), p: 2.6 });
    }
  }
  while (cells.length > n) cells.splice(Math.floor(rng() * cells.length), 1);
  const seeds = cells;
  const grown = (k: number): Blob[] => seeds.map((b) => ({ ...b, r: b.r * k }));
  // How far they may grow: a sea channel of `continentGap` between neighbours,
  // or, when it is negative, that much overlap, which makes land bridges.
  const CHANNEL = c.continentGap;
  let hi = 2.5;
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const d = Math.hypot(seeds[i].x - seeds[j].x, seeds[i].z - seeds[j].z) - CHANNEL;
      hi = Math.min(hi, d / (seeds[i].r + seeds[j].r));
    }
  }
  let lo = 0.05;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (share(grown(mid)) < c.continentCover) lo = mid;
    else hi = mid;
  }
  return grown((lo + hi) / 2);
}

/**
 * Island and continent shapes: the main landmass(es) in open sea, plus
 * `satellites` smaller islands scattered in the sea between and around
 * them. The same noise that bends the peninsula's coast wobbles each shore.
 */
function islandMask(spec: WorldSpec, grid: CoarseGrid, warpA: Float32Array, warpT: Float32Array, mask: Uint8Array): void {
  const b = worldBounds(spec);
  const half = (b.max - b.min) / 2;
  const cx = (b.max + b.min) / 2;
  const wander = spec.land.coast.wander / half;
  const rng = mulberry32(spec.seed ^ 0x151a4d);
  const nxAt = (i: number, u: number): number => (grid.originX + u * grid.cell - cx) / half + wander * warpA[i];
  const nzAt = (i: number, v: number): number => (grid.originZ + v * grid.cell - cx) / half + wander * warpT[i];
  // Share of the world the blobs cover, sampled on every 4th cell.
  const share = (bs: Blob[]): number => {
    let land = 0;
    let all = 0;
    for (let v = 0; v < grid.depth; v += 4) {
      for (let u = 0; u < grid.width; u += 4) {
        const i = v * grid.width + u;
        const x = nxAt(i, u);
        const z = nzAt(i, v);
        all++;
        if (bs.some((o) => reach(o, x, z) < o.r)) land++;
      }
    }
    return land / all;
  };
  const blobs = mainBlobs(spec, rng, share);
  for (let k = 0; k < spec.land.coast.satellites; k++) {
    const r = 0.04 + 0.06 * rng();
    for (let tries = 0; tries < 60; tries++) {
      const reach = 1 - r - 0.04;
      const x = (rng() * 2 - 1) * reach;
      const z = (rng() * 2 - 1) * reach;
      if (blobs.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 0.05)) {
        blobs.push({ x, z, r, p: 2 });
        break;
      }
    }
  }
  const W = grid.width;
  for (let v = 0; v < grid.depth; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const nx = nxAt(i, u);
      const nz = nzAt(i, v);
      let land = false;
      for (let s = 0; s < blobs.length && !land; s++) land = reach(blobs[s], nx, nz) < blobs[s].r;
      mask[i] = land ? 1 : 0;
    }
  }
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
 * Lay out the mountain ranges as one connected system per main chain: a
 * long chain roughly across the prevailing wind (it catches the rain and
 * casts a shadow behind it), clear of the coast, and spurs that branch
 * off it at varied angles on alternating sides and merge into it where
 * they join — ranges connect instead of standing in parallel rows. A
 * chain or spur that can't fit is shortened, and dropped if even a short
 * one can't.
 */
export function placeRanges(spec: WorldSpec, grid: CoarseGrid, land: Uint8Array, rng: () => number): RangeAxis[] {
  const R = spec.ranges;
  const W = grid.width;
  const D = grid.depth;
  const toSea = distanceTo(W, D, grid.cell, (i) => land[i] === 0);
  // Beyond the grid, read the nearest edge cell: a chain may run on past
  // the world's land edge (the land continues), never out over the sea.
  const coastAt = (x: number, z: number): number => {
    const u = Math.min(W - 1, Math.max(0, Math.round((x - grid.originX) / grid.cell)));
    const v = Math.min(D - 1, Math.max(0, Math.round((z - grid.originZ) / grid.cell)));
    return toSea[v * W + u];
  };
  const wind = windVector(spec.climate.wind);
  const across = Math.atan2(wind.x, -wind.z); // perpendicular to the wind
  const segments = 16;

  /** A curving polyline of `length` from (x, z) along `heading`. */
  const walk = (x: number, z: number, heading: number, length: number, bend: number): Array<{ x: number; z: number }> => {
    const pts = [{ x, z }];
    const step = length / segments;
    let a = heading;
    for (let s = 0; s < segments; s++) {
      a += (rng() - 0.5) * bend;
      x += Math.cos(a) * step;
      z += Math.sin(a) * step;
      pts.push({ x, z });
    }
    return pts;
  };
  const onLand = (pts: Array<{ x: number; z: number }>, clearance: number): boolean =>
    pts.every((p) => coastAt(p.x, p.z) >= clearance);

  const ranges: RangeAxis[] = [];
  const eligible: number[] = [];
  for (let i = 0; i < W * D; i++) if (land[i] && toSea[i] >= R.coastClearance) eligible.push(i);

  // Main chains: centred on land (the first where the spec says, if it
  // does), grown both ways across the wind.
  for (let k = 0; k < R.count && eligible.length > 0; k++) {
    let placed: RangeAxis | null = null;
    const pinned = k === 0 ? R.center : undefined;
    for (let length = R.length; !placed && length >= R.length * 0.3; length *= 0.85) {
      for (let attempt = 0; attempt < 80 && !placed; attempt++) {
        const c = eligible[Math.floor(rng() * eligible.length)];
        const cx = pinned ? pinned.x : grid.originX + (c % W) * grid.cell;
        const cz = pinned ? pinned.z : grid.originZ + Math.floor(c / W) * grid.cell;
        const heading = across + (rng() - 0.5) * 0.7;
        const back = walk(cx, cz, heading + Math.PI, length / 2, 0.25).slice(1).reverse();
        const points = [...back, ...walk(cx, cz, heading, length / 2, 0.25)];
        const apart = ranges.every((r) =>
          r.points.every((q) => points.every((p) => Math.hypot(p.x - q.x, p.z - q.z) >= R.width)),
        );
        if (onLand(points, R.coastClearance * 0.6) && apart) placed = { points, height: R.height, width: R.width, spur: false };
      }
    }
    if (placed) ranges.push(placed);
  }

  // Spurs: branch off an existing range, alternating sides, 35–80° out.
  const chains = ranges.length;
  for (let k = 0; k < R.spurs && chains > 0; k++) {
    const side = k % 2 === 0 ? 1 : -1;
    let placed: RangeAxis | null = null;
    for (let length = R.spurLength; !placed && length >= R.spurLength * 0.3; length *= 0.85) {
      for (let attempt = 0; attempt < 60 && !placed; attempt++) {
        const parent = ranges[Math.floor(rng() * ranges.length)];
        const p = parent.points;
        const s = Math.max(1, Math.min(p.length - 2, Math.round((0.15 + 0.7 * rng()) * (p.length - 1))));
        const along = Math.atan2(p[s + 1].z - p[s - 1].z, p[s + 1].x - p[s - 1].x);
        const heading = along + side * ((35 + 45 * rng()) * Math.PI) / 180;
        const points = walk(p[s].x, p[s].z, heading, length, 0.35);
        // Clear of the other spurs (the parent it grows from is fine).
        const apart = ranges.every(
          (r) => r === parent || r.points.every((q) => points.slice(4).every((pt) => Math.hypot(pt.x - q.x, pt.z - q.z) >= parent.width * R.spurScale)),
        );
        if (onLand(points.slice(2), R.coastClearance * 0.5) && apart) {
          placed = { points, height: parent.height * R.spurScale, width: parent.width * R.spurScale, spur: true };
        }
      }
    }
    if (placed) ranges.push(placed);
  }
  return ranges;
}

/**
 * Uplift from the ranges: a smooth ridge profile across each axis, tapered
 * at its ends (a spur not where it joins its parent) and varied along it,
 * broken into ridges and valleys by ridged noise. Where ranges meet the
 * higher uplift wins, so they merge into one massif.
 */
export function rangeUplift(
  spec: WorldSpec,
  grid: CoarseGrid,
  ranges: RangeAxis[],
  ridgeNoise: Float32Array,
  alongNoise: Float32Array,
  crossNoise: Float32Array,
  warpU: Float32Array,
  warpV: Float32Array,
  /** Ridged multifractal 0..1 (relief.ts); applied when spec.ranges.crest.detailOctaves > 0. */
  detail?: Float32Array,
): Float32Array {
  const R = spec.ranges;
  const W = grid.width;
  const D = grid.depth;
  const up = new Float32Array(W * D);
  for (const range of ranges) {
    const p = range.points;
    const halfW = range.width / 2;
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
        const profile = crestProfile(r, R.crest.sharpness);
        const ends = (range.spur ? 1 : smoothstep(0, 0.2, along)) * smoothstep(0, 0.2, 1 - along);
        const lift = range.height * profile * ends * (0.75 + 0.25 * alongNoise[i]);
        if (lift > up[i]) up[i] = lift;
      }
    }
  }
  // Ridges: crests where the noise crosses 0. One field alone lines its
  // crests up in parallel bands, so it is warped (crests meander) and a
  // smaller field crossing it adds side ridges: a ridge network.
  const warp = (4 * R.ridgeScale) / 25 / grid.cell;
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      if (up[i] === 0) continue;
      const main = (1 - Math.abs(sampleBilinear(ridgeNoise, W, D, u + warp * warpU[i], v + warp * warpV[i]))) ** 2;
      const side = (1 - Math.abs(crossNoise[i])) ** 2;
      const ridge = Math.max(main, 0.8 * side);
      up[i] *= 1 - R.ridges + 2 * R.ridges * ridge;
      // Ridged multifractal crests: detail gathers on the high ground.
      if (detail) up[i] *= 1 - R.crest.detailStrength + 2 * R.crest.detailStrength * detail[i];
    }
  }
  return up;
}

/**
 * Volcanoes sit on the main chain (the first range), spread along its
 * middle stretch, always inside the world (a chain may run on past the
 * land edge; its volcanoes don't).
 */
export function placeVolcanoes(spec: WorldSpec, ranges: RangeAxis[], rng: () => number): Volcano[] {
  const main = ranges.find((r) => !r.spur);
  if (!main || spec.volcano.count === 0) return [];
  const b = worldBounds(spec);
  const margin = spec.volcano.radius / 2;
  const inside = (p: { x: number; z: number }): boolean =>
    p.x >= b.min + margin && p.x <= b.max - margin && p.z >= b.min + margin && p.z <= b.max - margin;
  const p = main.points;
  const middle = (p.length - 1) / 2;
  // Points inside the world, nearest the chain's middle first.
  const usable = p
    .map((pt, s) => ({ pt, s }))
    .filter(({ pt }) => inside(pt))
    .sort((a, c) => Math.abs(a.s - middle) - Math.abs(c.s - middle));
  if (usable.length === 0) return [];
  const span = Math.max(1, Math.round(usable.length * 0.6)); // the middle stretch of what's inside
  const out: Volcano[] = [];
  for (let k = 0; k < spec.volcano.count; k++) {
    const pick = usable[Math.floor(rng() * span)].pt;
    out.push({ x: pick.x, z: pick.z });
  }
  return out;
}

/** How far a lobed cone reaches in the direction of a cell: 1 ± 35%. */
const lobeAt = (lobes: Float32Array, i: number): number => 1 + 0.35 * lobes[i];

/**
 * Each cell's distance to the nearest vent (Infinity without volcanoes),
 * measured through the cones' lobes (lava ran further on some sides), so
 * vent heat and volcanic ground follow a cone's outline.
 */
export function ventDistance(spec: WorldSpec, grid: CoarseGrid, volcanoes: Volcano[], lobes: Float32Array): Float32Array {
  const W = grid.width;
  const D = grid.depth;
  const dist = new Float32Array(W * D).fill(Infinity);
  for (const vent of volcanoes) {
    const cu = (vent.x - grid.originX) / grid.cell;
    const cv = (vent.z - grid.originZ) / grid.cell;
    const reach = Math.ceil((spec.volcano.radius * 2) / grid.cell);
    for (let v = Math.max(0, Math.floor(cv - reach)); v <= Math.min(D - 1, Math.ceil(cv + reach)); v++) {
      for (let u = Math.max(0, Math.floor(cu - reach)); u <= Math.min(W - 1, Math.ceil(cu + reach)); u++) {
        const i = v * W + u;
        dist[i] = Math.min(dist[i], (Math.hypot(u - cu, v - cv) * grid.cell) / lobeAt(lobes, i));
      }
    }
  }
  return dist;
}

/**
 * Raise each volcano's cone over whatever stands there: concave flanks
 * from its lobed foot up to a crater rim `height` above the land's base
 * level, and a bowl-shaped crater `craterDepth` below the rim. Volcanoes
 * are young: this runs after erosion, so the cone and crater stand sharp.
 */
export function raiseVolcanoes(
  spec: WorldSpec,
  grid: CoarseGrid,
  h: Float32Array,
  baseLevel: Float32Array,
  volcanoes: Volcano[],
  lobes: Float32Array,
  /**
   * Noise (-1..1) read in polar coordinates (angle across, radius slowly
   * down) so ridged crests run down the cone: with `volcano.gullies` > 0 the
   * flank is cut by radial gullies between spur ridges, from below the rim.
   */
  gullyNoise?: Float32Array,
): void {
  const V = spec.volcano;
  const W = grid.width;
  const D = grid.depth;
  for (const vent of volcanoes) {
    const cu = (vent.x - grid.originX) / grid.cell;
    const cv = (vent.z - grid.originZ) / grid.cell;
    const base = baseLevel[Math.round(cv) * W + Math.round(cu)];
    const reach = Math.ceil((V.radius * 1.35) / grid.cell);
    for (let v = Math.max(0, Math.floor(cv - reach)); v <= Math.min(D - 1, Math.ceil(cv + reach)); v++) {
      for (let u = Math.max(0, Math.floor(cu - reach)); u <= Math.min(W - 1, Math.ceil(cu + reach)); u++) {
        const i = v * W + u;
        const r = Math.hypot(u - cu, v - cv) * grid.cell;
        const reachHere = V.radius * lobeAt(lobes, i);
        if (r >= reachHere) continue;
        if (r < V.craterRadius) {
          h[i] = base + V.height - V.craterDepth * (1 - (r / V.craterRadius) ** 2);
          continue;
        }
        const flank = (reachHere - r) / (reachHere - V.craterRadius);
        let rise = V.height * Math.pow(flank, 1.6);
        if (gullyNoise && V.gullies > 0) {
          // Polar noise coordinates: ~50 cells of noise per radian, radius stretched ~3x.
          const theta = Math.atan2(v - cv, u - cu);
          const n = sampleBilinear(gullyNoise, W, D, W / 2 + theta * 50, D / 2 + (r / grid.cell) * 0.3);
          const spur = (1 - Math.abs(n)) ** 2;
          rise *= 1 - V.gullies * (1 - spur) * smoothstep(0.08, 0.45, 1 - flank) * Math.min(1, flank * 4);
        }
        h[i] = Math.max(h[i], base + rise);
      }
    }
  }
}
