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

export function selectSites(t: TerrainFields, rules: SettlementRules["sites"], count: number): Site[] {
  const { width, depth, cell, originX, originZ } = t.grid;
  const sea = t.seaLevel ?? 0;
  const dist = waterDistance(t);
  const fertility = (i: number): number => rules.fertilityPermille[t.biomeIds[t.biome[i]!]!] ?? 0;
  const [near, far] = rules.waterRangeM;

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
      const waterM = dist[i]! < 0 ? Infinity : dist[i]! * cell;
      const waterFactor = waterM < near ? 400 : waterM <= far ? 1000 : Math.max(0, Math.round(1000 - ((waterM - far) * 1000) / (3 * far)));
      let fert = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) fert += fertility(i + dz * width + dx);
      const pressure = Math.round((slopeFactor * waterFactor * Math.round(fert / 9)) / 1_000_000);
      if (pressure < rules.minPressurePermille) continue;
      candidates.push({ cx, cz, x: originX + cx * cell, z: originZ + cz * cell, pressurePermille: pressure, waterDistanceM: Number.isFinite(waterM) ? waterM : -1, slopePermille: slope, biome: t.biomeIds[t.biome[i]!]! });
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
