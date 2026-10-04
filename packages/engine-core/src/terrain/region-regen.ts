/**
 * Regenerate part of a baked world from its world spec (OPEN-WORLD-PLAN.md
 * Phase 4, ROADMAP E9) without touching the rest: the editor's
 * "regenerate region" (terrain-tool.ts `regenerate`).
 *
 * The fresh terrain is the bake's own (survey → WorldHeights), so where
 * nothing was edited it matches the neighbours exactly. Where the
 * neighbours were sculpted, or the spec was tuned since the bake, the
 * fresh tiles would not meet them: a band along each edge that has
 * neighbours blends from the stored ground (at the edge, exactly) to the
 * fresh ground (a band's width in). Shared border samples therefore keep
 * their stored values and no seam opens.
 */

import { TILE_SAMPLES } from "@mmo-engine/protocol";
import type { WorldMap } from "../persist/terrain-tiles.js";
import type { Survey } from "./survey.js";
import { worldBounds, type WorldSpec } from "./world-spec.js";

/** Inclusive chunk rectangle [cx0, cz0, cx1, cz1]. */
export type ChunkRange = [number, number, number, number];

const CELLS = TILE_SAMPLES - 1;

/** The chunk range of region (rx, rz) of the spec's region grid. */
export function regionRange(spec: Pick<WorldSpec, "sizeChunks" | "regionsPerSide">, rx: number, rz: number): ChunkRange {
  const n = spec.regionsPerSide;
  if (!Number.isInteger(rx) || !Number.isInteger(rz) || rx < 0 || rz < 0 || rx >= n || rz >= n) {
    throw new Error(`no region ${rx},${rz} (the world has ${n} × ${n})`);
  }
  const { minChunk } = worldBounds(spec as WorldSpec);
  const per = spec.sizeChunks / n;
  return [minChunk + rx * per, minChunk + rz * per, minChunk + (rx + 1) * per - 1, minChunk + (rz + 1) * per - 1];
}

/** Every region of the spec's grid with its chunk range. */
export function worldRegions(spec: Pick<WorldSpec, "sizeChunks" | "regionsPerSide">): Array<{ rx: number; rz: number; range: ChunkRange }> {
  const out = [];
  for (let rz = 0; rz < spec.regionsPerSide; rz++) {
    for (let rx = 0; rx < spec.regionsPerSide; rx++) out.push({ rx, rz, range: regionRange(spec, rx, rz) });
  }
  return out;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Blend a fresh tile toward the stored one near the range's edges that
 * have neighbours (`world` edges have none). `band` is in metres; a
 * sample on the edge keeps `old` exactly. Writes into `fresh`; returns it.
 */
export function blendTile(
  fresh: Float32Array,
  old: Float32Array,
  cx: number,
  cz: number,
  range: ChunkRange,
  world: { minChunk: number; maxChunk: number },
  chunkWorldSize: number,
  band: number,
): Float32Array {
  if (band <= 0) return fresh;
  const spacing = chunkWorldSize / CELLS;
  // Global sample indices of the range's edges (samples are shared across chunks).
  const gx0 = range[0] * CELLS;
  const gz0 = range[1] * CELLS;
  const gx1 = (range[2] + 1) * CELLS;
  const gz1 = (range[3] + 1) * CELLS;
  const west = range[0] > world.minChunk;
  const north = range[1] > world.minChunk;
  const east = range[2] < world.maxChunk;
  const south = range[3] < world.maxChunk;
  for (let j = 0; j < TILE_SAMPLES; j++) {
    const gz = cz * CELLS + j;
    for (let i = 0; i < TILE_SAMPLES; i++) {
      const gx = cx * CELLS + i;
      let d = Infinity;
      if (west) d = Math.min(d, gx - gx0);
      if (east) d = Math.min(d, gx1 - gx);
      if (north) d = Math.min(d, gz - gz0);
      if (south) d = Math.min(d, gz1 - gz);
      const w = smoothstep((d * spacing) / band);
      if (w < 1) {
        const k = j * TILE_SAMPLES + i;
        fresh[k] = w === 0 ? old[k] : old[k] + (fresh[k] - old[k]) * w;
      }
    }
  }
  return fresh;
}

/** Survey layers the bake stores in world.db (`world_maps`), by name. */
export function surveyLayers(survey: Survey): Record<string, Float32Array | Uint8Array | Uint16Array> {
  return {
    elevation: survey.height,
    biome: survey.biome,
    region: survey.region,
    moisture: survey.moisture,
    rain: survey.rain,
    temperature: survey.temperature,
    water: survey.water,
    water_level: survey.waterLevel,
    ice: survey.ice,
    melt: survey.meltMm,
    sun: survey.sun,
    uv: survey.uv,
    flow: survey.flow,
    river: survey.river,
    roughness: survey.roughness,
  };
}

/**
 * A stored survey map with the cells inside the range (in world metres,
 * [x0, x1) × [z0, z1)) replaced from the fresh layer. Null when the grids
 * don't line up (the spec's size or cell changed: re-bake instead).
 */
export function patchMap(
  stored: WorldMap,
  fresh: Float32Array | Uint8Array | Uint16Array,
  grid: { width: number; depth: number; cell: number; originX: number; originZ: number },
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): WorldMap | null {
  if (
    stored.width !== grid.width ||
    stored.depth !== grid.depth ||
    stored.cell !== grid.cell ||
    stored.originX !== grid.originX ||
    stored.originZ !== grid.originZ ||
    stored.data.length !== fresh.length ||
    stored.data.constructor !== fresh.constructor
  ) {
    return null;
  }
  const data = stored.data.slice() as typeof stored.data;
  const u0 = Math.max(0, Math.ceil((x0 - grid.originX) / grid.cell));
  const v0 = Math.max(0, Math.ceil((z0 - grid.originZ) / grid.cell));
  const u1 = Math.min(grid.width - 1, Math.ceil((x1 - grid.originX) / grid.cell) - 1);
  const v1 = Math.min(grid.depth - 1, Math.ceil((z1 - grid.originZ) / grid.cell) - 1);
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) data[v * grid.width + u] = fresh[v * grid.width + u];
  }
  return { ...stored, data };
}
