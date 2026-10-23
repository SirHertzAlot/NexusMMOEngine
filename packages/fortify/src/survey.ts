/**
 * Survey adapter: the seam between the real world bake and the fortify
 * sim. The world bake's survey (engine-core `Survey`) is consumed
 * through this narrow structural interface — fortify never imports
 * engine-core, so the seam stays swappable.
 *
 * What the adapter derives, per survey cell:
 *  - terrain kind: water (sea/lake/river cells), marsh (wet lowland),
 *    land.
 *  - diggable: soil a sap can be dug in — land or marsh without high
 *    roughness (rocky ground refuses tunnels).
 *  - waterDepth: metres to the water table. If the survey ever grows a
 *    real water-table map, pass it as `waterTable` and it wins. Until
 *    then (derivation v1): wet climates sit on shallow tables —
 *    `9 × (1 − moisture)` — and ground within two cells of open water
 *    is shallower still (≤ 1.2 m). This is the number the mining probe
 *    and the well gate read, so "will a sap flood here?" is answered by
 *    the survey, not by a fixture.
 */

import { idx, type Grid, type Settlement, type Tile } from "./model.js";
import { layoutOnGrid } from "./generate.js";

/** The slice of the world survey the fortify sim needs. */
export interface SurveyLike {
  grid: { width: number; depth: number; cell: number; originX: number; originZ: number };
  /** Elevation, metres. */
  height: Float32Array;
  /** Water kind per cell; `landCode` marks dry land. */
  water: Uint8Array;
  /** Humidity 0..1. */
  moisture: Float32Array;
  /** Fine-detail / rockiness 0..1. */
  roughness: Float32Array;
  /** 1 where a river runs. */
  river: Uint8Array;
  /** The `water` value meaning land (engine-core: LAND = 0). */
  landCode: number;
  /** Optional real water-table map (metres); overrides the derivation. */
  waterTable?: Float32Array;
}

export interface Site {
  /** Survey cell of the window's top-left (north-west) corner. */
  u0: number;
  v0: number;
  /** Window size in survey cells (square). */
  size: number;
  /** Siting score components, for reports. */
  score: { landFraction: number; waterAdjacent: number; flatness: number };
}

/** World-space transform for a site: tile (x, y) → [worldX, worldZ] metres. */
export interface SiteTransform {
  cell: number;
  originX: number;
  originZ: number;
  u0: number;
  v0: number;
}

export function makeTransform(survey: SurveyLike, site: Site): SiteTransform {
  return { cell: survey.grid.cell, originX: survey.grid.originX, originZ: survey.grid.originZ, u0: site.u0, v0: site.v0 };
}

/** Centre of tile (x, y) in world metres. */
export function tileToWorld(t: SiteTransform, x: number, y: number): [number, number] {
  return [t.originX + (t.u0 + x + 0.5) * t.cell, t.originZ + (t.v0 + y + 0.5) * t.cell];
}

const isWater = (s: SurveyLike, i: number): boolean => s.water[i] !== s.landCode || s.river[i] === 1;

/**
 * Find a settlement site: a mostly-land window, as flat as available,
 * preferring water at its edge (the pond-village situation: water does
 * half the defending before a single wall is placed). Windows already
 * claimed (earlier sites) are skipped. Returns null when no window is
 * at least 45% land.
 */
export function findSite(survey: SurveyLike, size: number, claimed: Site[] = []): Site | null {
  const { width, depth } = survey.grid;
  let best: Site | null = null;
  let bestScore = -Infinity;
  const step = Math.max(1, Math.floor(size / 2));
  for (let v0 = 0; v0 + size <= depth; v0 += step) {
    for (let u0 = 0; u0 + size <= width; u0 += step) {
      if (claimed.some((c) => Math.abs(c.u0 - u0) < size && Math.abs(c.v0 - v0) < size)) continue;
      let land = 0;
      let total = 0;
      let hMin = Infinity;
      let hMax = -Infinity;
      let waterNear = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (v0 + y) * width + (u0 + x);
          total++;
          if (!isWater(survey, i)) {
            land++;
            hMin = Math.min(hMin, survey.height[i]);
            hMax = Math.max(hMax, survey.height[i]);
          }
        }
      }
      // Water just outside the window counts double: a moat that digs itself.
      for (let y = -2; y < size + 2; y++) {
        for (let x = -2; x < size + 2; x++) {
          if (x >= 0 && y >= 0 && x < size && y < size) continue;
          const u = u0 + x;
          const v = v0 + y;
          if (u < 0 || v < 0 || u >= width || v >= depth) continue;
          if (isWater(survey, v * width + u)) waterNear++;
        }
      }
      const landFraction = land / total;
      if (landFraction < 0.45) continue;
      const relief = hMax - hMin;
      const flatness = 1 / (1 + relief / survey.grid.cell);
      const score = landFraction * 2 + Math.min(1, waterNear / 12) * 1.5 + flatness;
      if (score > bestScore) {
        bestScore = score;
        best = { u0, v0, size, score: { landFraction, waterAdjacent: waterNear, flatness } };
      }
    }
  }
  return best;
}

/** Convert one survey window into the fortify tile grid. */
export function tilesFromSurvey(survey: SurveyLike, site: Site): Grid {
  const { width } = survey.grid;
  const size = site.size;
  const tiles: Tile[] = new Array(size * size);
  const at = (x: number, y: number): number => (site.v0 + y) * width + (site.u0 + x);
  const waterWithin2 = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = site.u0 + x + dx;
        const ny = site.v0 + y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= survey.grid.depth) continue;
        if (isWater(survey, ny * width + nx)) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = at(x, y);
      const moisture = survey.moisture[i];
      let depth = survey.waterTable ? survey.waterTable[i] : 9 * (1 - moisture);
      let t: Tile;
      if (isWater(survey, i)) {
        t = { terrain: "water", diggable: false, waterDepth: 0 };
      } else {
        const wet = moisture >= 0.72 || waterWithin2(x, y);
        // The proximity shallowing is part of the derivation — a real
        // water-table map overrides it too, untouched.
        if (wet && !survey.waterTable) depth = Math.min(depth, 1.2);
        t = {
          terrain: wet && moisture >= 0.6 ? "marsh" : "land",
          diggable: survey.roughness[i] < 0.7,
          waterDepth: Math.max(0.2, depth),
        };
      }
      tiles[y * size + x] = t;
    }
  }
  return { w: size, h: size, tiles };
}

/** Adapter end to end: survey window → laid-out (unfortified) settlement. */
export function settlementFromSurvey(survey: SurveyLike, site: Site, name: string): Settlement {
  return layoutOnGrid(tilesFromSurvey(survey, site), name);
}

/** Tile index helper re-exported for emit. */
export { idx };
