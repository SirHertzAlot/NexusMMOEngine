/**
 * Site selection (spec §9 to §10): where a settlement can stand, read from the
 * world bake's coarse fields. A cell's *pressure* (0 to 1000) is how well it
 * suits a town: gentle slope, living-distance from water (not on the bank, not
 * far), fertile land around it. A site must also be walkable from the spawn: a flat
 * plateau ringed by cliffs is a stranded object, not a place to live. Sites are the best cells that keep their
 * distance from each other. The input is structural, so the world survey
 * (`surveyWorld`) passes in as it is; nothing here depends on the engine.
 */

import type { SettlementRules } from "./rules.js";

/** The fields of a survey that site selection reads. `water` is 0 land, nonzero sea or lake; heights and distances are metres. */
export interface TerrainFields {
  grid: { width: number; depth: number; cell: number; originX: number; originZ: number };
  height: Float32Array;
  water: Uint8Array;
  river: Uint8Array;
  ice?: Uint8Array;
  /** Water surface height on sea and lake cells, NaN on land (the survey's `waterLevel`); without it the sea level stands for every water cell. */
  waterLevel?: Float32Array;
  /**
   * Metres above the sea the footprint's lowest survey ground needs so the stored tiles (survey plus detail noise) still clear
   * the spawner's wet-footing margin: the caller passes STRUCTURE_MARGIN_M plus the world's detailAmplitude. Raises, never lowers, `rules.minElevationM`.
   */
  safeFloorM?: number;
  biome: Uint8Array;
  /** The biome id of each biome index. */
  biomeIds: readonly string[];
  /** Land below this is not buildable (default 0). */
  seaLevel?: number;
  /** Where players spawn, world metres: sites must be walkable from here (default: from the largest connected land). */
  spawn?: { x: number; z: number };
}

export interface Site {
  /** Cell centre, world metres. */
  x: number;
  z: number;
  pressurePermille: number;
  waterDistanceM: number;
  slopePermille: number;
  biome: string;
  /** Ground height at the centre, whole metres. */
  elevationM: number;
  /** Highest minus lowest ground across the town's footprint, whole metres. */
  reliefM: number;
  /** The nearest water's kind: the sea (water at the sea's level), a lake (water above it), a river, or none. */
  waterKind: "sea" | "lake" | "river" | "none";
  /** Water from the edge of the town's footprint, metres (the water distance less the town's half extent); -1 with no water. */
  shoreM: number;
  /** The best resource biome (rules.sites.resourcePermille) within reach of the footprint, 0 to 1000. */
  resourcePermille: number;
  /** The walk from the spawn (else the largest connected land) to the site over walkable cells, metres; -1 when not walkable. */
  walkM: number;
}

/** Highest (or lowest) height within `r` cells of each cell, a square window clipped to the grid; two separable passes. */
function windowExtreme(h: Float32Array, width: number, depth: number, r: number, pick: (a: number, b: number) => number): Float32Array {
  const rows = new Float32Array(h.length);
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      let m = h[z * width + x]!;
      for (let k = Math.max(0, x - r); k <= Math.min(width - 1, x + r); k++) m = pick(m, h[z * width + k]!);
      rows[z * width + x] = m;
    }
  }
  const out = new Float32Array(h.length);
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      let m = rows[z * width + x]!;
      for (let k = Math.max(0, z - r); k <= Math.min(depth - 1, z + r); k++) m = pick(m, rows[k * width + x]!);
      out[z * width + x] = m;
    }
  }
  return out;
}

const WATER_KINDS = ["none", "sea", "lake", "river"] as const;

/** Cells to the nearest water (river, lake or sea), 4-neighbour breadth-first, and that water's kind (1 sea, 2 lake, 3 river). */
function waterDistance(t: TerrainFields): { dist: Int32Array; kind: Uint8Array } {
  const { width, depth } = t.grid;
  const sea = t.seaLevel ?? 0;
  const dist = new Int32Array(width * depth).fill(-1);
  const kind = new Uint8Array(width * depth);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    if (!t.water[i] && !t.river[i]) continue;
    dist[i] = 0;
    kind[i] = t.river[i] ? 3 : (t.waterLevel?.[i] ?? sea) > sea + 0.5 ? 2 : 1;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % width;
    const z = (i - x) / width;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
      const j = nz * width + nx;
      if (dist[j] === -1) (dist[j] = dist[i]! + 1), (kind[j] = kind[i]!), queue.push(j);
    }
  }
  return { dist, kind };
}

/**
 * Cells walkable from the spawn (else from the largest connected land): 8-neighbour steps no steeper than
 * `slopeDeg`, over any cell that is not sea or lake. Rivers and ice are walkable. The same rule as
 * `reachableLand` in the engine's terrain code (the packages don't depend on each other).
 */
function walkable(t: TerrainFields, slopeDeg: number): { walk: Uint8Array; walkM: Float32Array } {
  const { width, depth, cell, originX, originZ } = t.grid;
  const tan = Math.tan((slopeDeg * Math.PI) / 180);
  const label = new Int32Array(width * depth);
  const queue = new Int32Array(width * depth);
  const sizes: number[] = [];
  for (let s = 0; s < label.length; s++) {
    if (label[s] || t.water[s]) continue;
    const id = sizes.length + 1;
    let head = 0;
    let tail = 0;
    label[s] = id;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      const z = (i - x) / width;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if ((dx === 0 && dz === 0) || nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
          const j = nz * width + nx;
          if (label[j] || t.water[j]) continue;
          if (Math.abs(t.height[j]! - t.height[i]!) > tan * cell * (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1)) continue;
          label[j] = id;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(tail);
  }
  let keep = sizes.indexOf(Math.max(0, ...sizes)) + 1;
  let start = -1;
  if (t.spawn) {
    const sx = Math.round((t.spawn.x - originX) / cell);
    const sz = Math.round((t.spawn.z - originZ) / cell);
    if (sx >= 0 && sz >= 0 && sx < width && sz < depth && label[sz * width + sx]) (keep = label[sz * width + sx]!), (start = sz * width + sx);
  }
  const out = new Uint8Array(width * depth);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === keep ? 1 : 0;
  // Without a spawn, the walk is measured from the kept land's middle cell (in index order).
  if (start < 0) {
    const cells = out.reduce<number[]>((a, v, i) => (v ? (a.push(i), a) : a), []);
    start = cells[Math.floor(cells.length / 2)] ?? 0;
  }
  return { walk: out, walkM: walkDistance(t, out, tan, start) };
}

/**
 * Metres walked from `start` to each walkable cell (8-neighbour steps, diagonals sqrt 2 cells, the same slope
 * limit): a bucketed Dijkstra over half-cell units. Unwalkable cells are -1.
 */
function walkDistance(t: TerrainFields, walk: Uint8Array, tan: number, start: number): Float32Array {
  const { width, depth, cell } = t.grid;
  const units = new Int32Array(width * depth).fill(-1);
  const buckets: number[][] = [];
  const push = (i: number, d: number): void => {
    (buckets[d] ??= []).push(i);
  };
  if (walk[start]) units[start] = 0, push(start, 0);
  for (let d = 0; d < buckets.length; d++) {
    for (const i of buckets[d] ?? []) {
      if (units[i] !== d) continue;
      const x = i % width;
      const z = (i - x) / width;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if ((dx === 0 && dz === 0) || nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
          const j = nz * width + nx;
          if (!walk[j]) continue;
          const diag = dx !== 0 && dz !== 0;
          if (Math.abs(t.height[j]! - t.height[i]!) > tan * cell * (diag ? Math.SQRT2 : 1)) continue;
          const nd = d + (diag ? 3 : 2);
          if (units[j] === -1 || nd < units[j]!) (units[j] = nd), push(j, nd);
        }
      }
    }
  }
  const out = new Float32Array(width * depth);
  for (let i = 0; i < out.length; i++) out[i] = units[i]! < 0 ? -1 : (units[i]! * cell) / 2;
  return out;
}

/**
 * The best `count` sites. `extentM` is half the town's footprint (`townHalfExtentM`): a site's
 * elevation and relief are read from the height field over that whole reach, so a gentle slope
 * that climbs far, or a ridge a coarse cell's slope hides, still rules the place out.
 */
export function selectSites(t: TerrainFields, rules: SettlementRules["sites"], count: number, extentM = 0): Site[] {
  const { width, depth, cell, originX, originZ } = t.grid;
  const sea = t.seaLevel ?? 0;
  const { dist, kind: waterKindOf } = waterDistance(t);
  const walked = walkable(t, rules.walkSlopeDeg);
  const walk = rules.requireReachable ? walked.walk : undefined;
  const fertility = (i: number): number => rules.fertilityPermille[t.biomeIds[t.biome[i]!]!] ?? 0;
  const far = rules.waterRangeM[1];
  // Resources near the footprint: the best resource biome within its reach plus resourceRangeM.
  const resource = new Float32Array(width * depth);
  for (let i = 0; i < resource.length; i++) resource[i] = (rules.resourcePermille ?? {})[t.biomeIds[t.biome[i]!]!] ?? 0;
  const reach = Math.ceil(extentM / cell);
  const hi = windowExtreme(t.height, width, depth, reach, Math.max);
  const lo = windowExtreme(t.height, width, depth, reach, Math.min);
  // The whole footprint must be dry land: water or ice anywhere within the town's reach rules the cell out.
  const wet = new Float32Array(width * depth);
  for (let i = 0; i < wet.length; i++) wet[i] = t.water[i] || t.river[i] || t.ice?.[i] ? 1 : 0;
  const wetNear = windowExtreme(wet, width, depth, reach, Math.max);
  // Dry feet: the footprint's lowest ground stands this far above the sea and above any water surface near it (the lakes, and
  // the rivers' beds, one cell past the reach: the spawner's sample at the footprint's edge sees the surface of the cells around it).
  // Never less than `safeFloorM`: the survey is coarse, the stored tiles add detail noise, and the spawner wants its margin under the whole footprint.
  const floorM = Math.max(rules.minElevationM, t.safeFloorM ?? 0);
  const surface = new Float32Array(width * depth).fill(sea);
  for (let i = 0; i < surface.length; i++) {
    if (t.water[i]) surface[i] = Math.max(sea, t.waterLevel?.[i] ?? sea);
    else if (t.river[i]) surface[i] = Math.max(sea, t.height[i]!);
  }
  const nearSurface = windowExtreme(surface, width, depth, reach + 1, Math.max);
  const resourceNear = windowExtreme(resource, width, depth, Math.ceil((extentM + (rules.resourceRangeM ?? 600)) / cell), Math.max);
  const peaks = windowExtreme(t.height, width, depth, Math.ceil(rules.mountainClearanceM / cell), Math.max);
  // The footprint may rise this far above the sea: the stricter of the lowland band and the absolute cap.
  const ceilingM = Math.min(rules.lowlandBandM, rules.maxElevationM - sea);

  interface Candidate extends Site {
    cx: number;
    cz: number;
  }
  const candidates: Candidate[] = [];
  for (let cz = 1; cz < depth - 1; cz++) {
    for (let cx = 1; cx < width - 1; cx++) {
      const i = cz * width + cx;
      if (t.water[i] || t.river[i] || t.ice?.[i] || t.height[i]! <= sea || (walk && !walk[i])) continue;
      // Slope: the steepest rise over a cell to a neighbour, permille.
      let rise = 0;
      for (const j of [i - 1, i + 1, i - width, i + width]) rise = Math.max(rise, Math.abs(t.height[j]! - t.height[i]!));
      const slope = Math.round((rise * 1000) / cell);
      if (slope > rules.maxSlopePermille) continue;
      const slopeFactor = 1000 - Math.round((slope * 1000) / rules.maxSlopePermille);
      // Elevation and relief over the whole footprint; a mountain anywhere near rules the cell out.
      const relief = hi[i]! - lo[i]!;
      if (lo[i]! - nearSurface[i]! < floorM) continue;
      if (wetNear[i]! > 0 || hi[i]! - sea > ceilingM || relief > rules.maxReliefM || peaks[i]! > rules.ridgeHeightM) continue;
      const elevFactor = 1000 - Math.round(((hi[i]! - sea) * 500) / ceilingM);
      const reliefFactor = 1000 - Math.round((relief * 500) / rules.maxReliefM);
      // Water is measured from the footprint's edge: against it or in easy reach is best, a long walk worth less.
      const waterM = dist[i]! < 0 ? Infinity : dist[i]! * cell;
      const shoreM = Math.max(0, waterM - extentM);
      const waterFactor = shoreM <= far ? 1000 : Math.max(0, Math.round(1000 - ((shoreM - far) * 1000) / (3 * far)));
      const resourceFactor = 700 + Math.round((resourceNear[i]! * 300) / 1000);
      let fert = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) fert += fertility(i + dz * width + dx);
      const pressure = Math.round((((slopeFactor * waterFactor * Math.round(fert / 9) * elevFactor) / 1e9) * reliefFactor * resourceFactor) / 1e6);
      if (pressure < rules.minPressurePermille) continue;
      candidates.push({ cx, cz, x: originX + cx * cell, z: originZ + cz * cell, pressurePermille: pressure, waterDistanceM: Number.isFinite(waterM) ? waterM : -1, shoreM: Number.isFinite(waterM) ? Math.round(shoreM) : -1, resourcePermille: resourceNear[i]!, slopePermille: slope, elevationM: Math.round(t.height[i]!), reliefM: Math.round(relief), biome: t.biomeIds[t.biome[i]!]!, waterKind: dist[i]! < 0 ? "none" : WATER_KINDS[waterKindOf[i]!]!, walkM: Math.round(walked.walkM[i]!) });
    }
  }
  candidates.sort((a, b) => b.pressurePermille - a.pressurePermille || a.cz - b.cz || a.cx - b.cx);
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= rules.minSpacingM)) chosen.push(c);
  }
  return chosen.map(({ cx: _cx, cz: _cz, ...site }) => site);
}
