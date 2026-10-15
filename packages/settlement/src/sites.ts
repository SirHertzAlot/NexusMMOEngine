/**
 * Site selection (spec §9 to §10): where a settlement can stand, read from the
 * world bake's coarse fields. A cell's *pressure* (0 to 1000) is how well it
 * suits a town: gentle slope, living-distance from water (not on the bank, not
 * far), fertile land around it. Sites are the best cells that keep their
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
  biome: Uint8Array;
  /** The biome id of each biome index. */
  biomeIds: readonly string[];
  /** Land below this is not buildable (default 0). */
  seaLevel?: number;
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

/** Cells to the nearest water (river, lake or sea), 4-neighbour breadth-first. */
function waterDistance(t: TerrainFields): Int32Array {
  const { width, depth } = t.grid;
  const dist = new Int32Array(width * depth).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++) if (t.water[i] || t.river[i]) (dist[i] = 0), queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % width;
    const z = (i - x) / width;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
      const j = nz * width + nx;
      if (dist[j] === -1) (dist[j] = dist[i]! + 1), queue.push(j);
    }
  }
  return dist;
}

/**
 * The best `count` sites. `extentM` is half the town's footprint (`townHalfExtentM`): a site's
 * elevation and relief are read from the height field over that whole reach, so a gentle slope
 * that climbs far, or a ridge a coarse cell's slope hides, still rules the place out.
 */
export function selectSites(t: TerrainFields, rules: SettlementRules["sites"], count: number, extentM = 0): Site[] {
  const { width, depth, cell, originX, originZ } = t.grid;
  const sea = t.seaLevel ?? 0;
  const dist = waterDistance(t);
  const fertility = (i: number): number => rules.fertilityPermille[t.biomeIds[t.biome[i]!]!] ?? 0;
  const [near, far] = rules.waterRangeM;
  const reach = Math.ceil(extentM / cell);
  const hi = windowExtreme(t.height, width, depth, reach, Math.max);
  const lo = windowExtreme(t.height, width, depth, reach, Math.min);
  // The whole footprint must be dry land: water or ice anywhere within the town's reach rules the cell out.
  const wet = new Float32Array(width * depth);
  for (let i = 0; i < wet.length; i++) wet[i] = t.water[i] || t.river[i] || t.ice?.[i] ? 1 : 0;
  const wetNear = windowExtreme(wet, width, depth, reach, Math.max);
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
      if (t.water[i] || t.river[i] || t.ice?.[i] || t.height[i]! <= sea) continue;
      // Slope: the steepest rise over a cell to a neighbour, permille.
      let rise = 0;
      for (const j of [i - 1, i + 1, i - width, i + width]) rise = Math.max(rise, Math.abs(t.height[j]! - t.height[i]!));
      const slope = Math.round((rise * 1000) / cell);
      if (slope > rules.maxSlopePermille) continue;
      const slopeFactor = 1000 - Math.round((slope * 1000) / rules.maxSlopePermille);
      // Elevation and relief over the whole footprint; a mountain anywhere near rules the cell out.
      const relief = hi[i]! - lo[i]!;
      if (wetNear[i]! > 0 || hi[i]! - sea > ceilingM || relief > rules.maxReliefM || peaks[i]! > rules.ridgeHeightM) continue;
      const elevFactor = 1000 - Math.round(((hi[i]! - sea) * 500) / ceilingM);
      const reliefFactor = 1000 - Math.round((relief * 500) / rules.maxReliefM);
      const waterM = dist[i]! < 0 ? Infinity : dist[i]! * cell;
      const waterFactor = waterM < near ? 400 : waterM <= far ? 1000 : Math.max(0, Math.round(1000 - ((waterM - far) * 1000) / (3 * far)));
      let fert = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) fert += fertility(i + dz * width + dx);
      const pressure = Math.round((slopeFactor * waterFactor * Math.round(fert / 9) * elevFactor * reliefFactor) / 1e12);
      if (pressure < rules.minPressurePermille) continue;
      candidates.push({ cx, cz, x: originX + cx * cell, z: originZ + cz * cell, pressurePermille: pressure, waterDistanceM: Number.isFinite(waterM) ? waterM : -1, slopePermille: slope, elevationM: Math.round(t.height[i]!), reliefM: Math.round(relief), biome: t.biomeIds[t.biome[i]!]! });
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
