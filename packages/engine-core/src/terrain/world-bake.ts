/**
 * World terrain bake — survey the whole world, store every chunk's tile,
 * the survey maps, and the SurrealDB catalog. Run once per world (terrain
 * is data afterwards; the editor sculpts it, the server reads it).
 *
 * Memory stays bounded: the survey is a few MB, and fine tiles are
 * generated and written in batches, never held for the whole world.
 */

import * as path from "node:path";
import type { TerrainTile } from "@mmo-engine/protocol";
import { TerrainTileStore } from "../persist/terrain-tiles.js";
import { rocksdbUrl, writeWorldCatalog, type CatalogChunk } from "../persist/world-catalog.js";
import { LAND, surveyWorld, type Survey } from "./survey.js";
import { WorldHeights } from "./world-heights.js";
import { worldBounds, type WorldSpec } from "./world-spec.js";

export interface TerrainBakeReport {
  chunks: number;
  surveyMs: number;
  tilesMs: number;
  catalogMs: number | null;
  peakRssMb: number;
  heightRange: { min: number; max: number };
  /** Connected regions each biome formed. */
  biomeRegions: Record<string, number>;
  /** Share of the world each biome covers, %. */
  biomeShare: Record<string, number>;
  /** Share of the world that is land (not sea), %. */
  landPercent: number;
  riverChunks: number;
  lakeCells: number;
  mountainRanges: number;
  erosion: { meanM: number; maxM: number; deepestCutM: number };
  /** Where players spawn (world metres) and the biome it lies in. */
  spawn: { x: number; z: number; biome: string | null };
}

export interface TerrainBakeOptions {
  /** world.db to write tiles and maps into. */
  dbPath: string;
  /** SurrealDB storage directory; null skips the catalog. */
  catalogDir: string | null;
  log?: (line: string) => void;
}

const TILE_BATCH = 2500;

/** Index of the region server owning a chunk. */
export function regionOf(spec: WorldSpec, cx: number, cz: number): [number, number] {
  const { minChunk } = worldBounds(spec);
  const per = spec.sizeChunks / spec.regionsPerSide;
  return [Math.floor((cx - minChunk) / per), Math.floor((cz - minChunk) / per)];
}

/** The biome players spawn in: the spec's, else plains, else the catch-all. */
export function spawnBiome(spec: WorldSpec): string {
  return spec.spawn?.biome ?? (spec.biomes.some((b) => b.id === "plains") ? "plains" : spec.biomes[spec.biomes.length - 1].id);
}

/**
 * Where players spawn (see WorldSpec.spawn): the given point, or the
 * flattest dry spot within ~48 m of the middle of a large region of the
 * spawn biome — the one nearest the middle of the land. Falls back to the
 * world centre when that biome never formed.
 */
export function spawnPoint(spec: WorldSpec, survey: Survey): { x: number; z: number; biome: string | null } {
  if (spec.spawn?.x !== undefined && spec.spawn.z !== undefined) return { x: spec.spawn.x, z: spec.spawn.z, biome: null };
  const id = spawnBiome(spec);
  const bi = spec.biomes.findIndex((b) => b.id === id);
  const g = survey.grid;
  const W = g.width;

  let lx = 0;
  let lz = 0;
  let landCells = 0;
  for (let i = 0; i < survey.water.length; i++) {
    if (survey.water[i] !== LAND) continue;
    lx += g.originX + (i % W) * g.cell;
    lz += g.originZ + Math.floor(i / W) * g.cell;
    landCells++;
  }
  const candidates = survey.regions.filter((r) => r.biome === bi);
  if (candidates.length === 0 || landCells === 0) return { x: 0, z: 0, biome: null };
  [lx, lz] = [lx / landCells, lz / landCells];
  // Large regions only (a quarter of the biggest one), nearest the land's middle.
  const biggest = Math.max(...candidates.map((r) => r.cells));
  const region = candidates
    .filter((r) => r.cells >= biggest / 4)
    .sort((a, b) => Math.hypot(a.x - lx, a.z - lz) - Math.hypot(b.x - lx, b.z - lz) || a.index - b.index)[0];

  // The region's own cell nearest its centroid (a centroid can fall outside
  // a curved region), then the flattest dry cell of the region around it.
  const cellOf = (i: number): [number, number] => [i % W, Math.floor(i / W)];
  const cu0 = (region.x - g.originX) / g.cell;
  const cv0 = (region.z - g.originZ) / g.cell;
  let centre = -1;
  let centreD = Infinity;
  for (let i = 0; i < survey.region.length; i++) {
    if (survey.region[i] !== region.index) continue;
    const [u, v] = cellOf(i);
    const d = Math.hypot(u - cu0, v - cv0);
    if (d < centreD) [centre, centreD] = [i, d];
  }
  const [cu, cv] = cellOf(centre);
  const reach = Math.ceil(48 / g.cell);
  let best = { u: cu, v: cv, slope: Infinity, d: Infinity };
  for (let v = cv - reach; v <= cv + reach; v++) {
    for (let u = cu - reach; u <= cu + reach; u++) {
      if (u < 1 || v < 1 || u >= W - 1 || v >= g.depth - 1) continue;
      const i = v * W + u;
      if (survey.region[i] !== region.index || survey.river[i] || survey.water[i] !== LAND) continue;
      const h = survey.height[i];
      const slope = Math.max(
        Math.abs(h - survey.height[i - 1]),
        Math.abs(h - survey.height[i + 1]),
        Math.abs(h - survey.height[i - W]),
        Math.abs(h - survey.height[i + W]),
      );
      const d = Math.hypot(u - cu, v - cv);
      if (slope < best.slope - 1e-6 || (Math.abs(slope - best.slope) <= 1e-6 && d < best.d)) best = { u, v, slope, d };
    }
  }
  return { x: g.originX + best.u * g.cell, z: g.originZ + best.v * g.cell, biome: id };
}

/** Survey cells overlapping a chunk: [u0, v0, u1, v1] inclusive. */
function chunkCells(survey: Survey, cx: number, cz: number): [number, number, number, number] {
  const g = survey.grid;
  const size = survey.spec.chunkWorldSize;
  const cell = (w: number, origin: number): number => Math.floor((w - origin) / g.cell);
  return [
    cell(cx * size, g.originX),
    cell(cz * size, g.originZ),
    cell((cx + 1) * size - 1e-6, g.originX),
    cell((cz + 1) * size - 1e-6, g.originZ),
  ];
}

export async function bakeWorldTerrain(spec: WorldSpec, opts: TerrainBakeOptions): Promise<TerrainBakeReport> {
  const log = opts.log ?? (() => {});
  let peakRss = process.memoryUsage().rss;
  const sampleRss = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  let t0 = performance.now();
  const survey = surveyWorld(spec);
  const surveyMs = performance.now() - t0;
  sampleRss();
  const biomeRegions: Record<string, number> = {};
  for (const r of survey.regions) {
    const id = spec.biomes[r.biome].id;
    biomeRegions[id] = (biomeRegions[id] ?? 0) + 1;
  }
  const biomeShare = biomeShares(survey);
  const landPercent = Math.round(survey.stats.landFraction * 1000) / 10;
  log(
    `[bake] survey ${survey.grid.width}x${survey.grid.depth} cells (${spec.coarseCell} m) in ${(surveyMs / 1000).toFixed(1)} s — ` +
      `land ${landPercent}%, ${survey.ranges.length} mountain range(s), ${survey.stats.lakeCells} lake cells`,
  );
  log(`[bake]   biomes (% of the world): ${Object.entries(biomeShare).map(([id, p]) => `${id} ${p}`).join(", ")}`);
  log(
    `[bake]   glaciers: ${survey.stats.glacierCells} ice cells, ${survey.stats.glacierSnouts} snouts, ` +
      `${(survey.stats.meltwaterM3 / 1e6).toFixed(2)} million m³ of meltwater a year; ` +
      `UV index ${uvRange(survey)}`,
  );

  // ---- fine tiles, in batches ------------------------------------------
  t0 = performance.now();
  const heights = new WorldHeights(survey);
  const store = new TerrainTileStore(opts.dbPath);
  const { minChunk, maxChunk } = worldBounds(spec);
  const catalogChunks: CatalogChunk[] = [];
  let batch: TerrainTile[] = [];
  let min = Infinity;
  let max = -Infinity;
  let riverChunks = 0;
  try {
    for (let cz = minChunk; cz <= maxChunk; cz++) {
      for (let cx = minChunk; cx <= maxChunk; cx++) {
        const tile = new Float32Array(heights.chunkSamples);
        heights.generateChunk(0n, cx, cz, 0, tile);
        let tmin = Infinity;
        let tmax = -Infinity;
        for (const h of tile) {
          if (h < tmin) tmin = h;
          if (h > tmax) tmax = h;
        }
        min = Math.min(min, tmin);
        max = Math.max(max, tmax);
        batch.push({ cx, cz, heights: tile });
        if (batch.length >= TILE_BATCH) {
          store.putMany(batch);
          batch = [];
          sampleRss();
        }
        const [u0, v0, u1, v1] = chunkCells(survey, cx, cz);
        let river = false;
        for (let v = v0; v <= v1 && !river; v++) {
          for (let u = u0; u <= u1; u++) if (survey.river[v * survey.grid.width + u]) river = true;
        }
        if (river) riverChunks++;
        const centre = Math.round((v0 + v1) / 2) * survey.grid.width + Math.round((u0 + u1) / 2);
        catalogChunks.push({
          cx,
          cz,
          region: regionOf(spec, cx, cz),
          biome: spec.biomes[survey.biome[centre]].id,
          minHeight: Math.round(tmin * 100) / 100,
          maxHeight: Math.round(tmax * 100) / 100,
          river,
        });
      }
      if ((cz - minChunk + 1) % 50 === 0) log(`[bake]   tiles: ${cz - minChunk + 1}/${spec.sizeChunks} rows`);
    }
    if (batch.length > 0) store.putMany(batch);

    // Survey maps: the world-scale view for the editor, scatter, and
    // settlements (biome and river placement).
    const g = survey.grid;
    const map = <T extends Float32Array | Uint8Array | Uint16Array>(data: T) => ({
      width: g.width, depth: g.depth, cell: g.cell, originX: g.originX, originZ: g.originZ, data,
    });
    store.putMap("elevation", map(survey.height));
    store.putMap("biome", map(survey.biome));
    store.putMap("region", map(survey.region));
    store.putMap("moisture", map(survey.moisture));
    store.putMap("rain", map(survey.rain));
    store.putMap("temperature", map(survey.temperature));
    store.putMap("water", map(survey.water));
    store.putMap("ice", map(survey.ice));
    store.putMap("melt", map(survey.meltMm));
    store.putMap("sun", map(survey.sun));
    store.putMap("uv", map(survey.uv));
    store.putMap("flow", map(survey.flow));
    store.putMap("river", map(survey.river));
    store.putMap("roughness", map(survey.roughness));
  } finally {
    store.close();
  }
  const tilesMs = performance.now() - t0;
  sampleRss();
  log(`[bake] ${catalogChunks.length} tiles + survey maps in ${(tilesMs / 1000).toFixed(1)} s`);

  // ---- SurrealDB catalog ---------------------------------------------------
  let catalogMs: number | null = null;
  if (opts.catalogDir !== null) {
    t0 = performance.now();
    const per = spec.sizeChunks / spec.regionsPerSide;
    const regions = [];
    for (let rz = 0; rz < spec.regionsPerSide; rz++) {
      for (let rx = 0; rx < spec.regionsPerSide; rx++) {
        regions.push({
          rx,
          rz,
          chunks: { x0: minChunk + rx * per, z0: minChunk + rz * per, x1: minChunk + (rx + 1) * per - 1, z1: minChunk + (rz + 1) * per - 1 },
        });
      }
    }
    await writeWorldCatalog(rocksdbUrl(opts.catalogDir), {
      world: {
        name: spec.name,
        seed: spec.seed,
        sizeChunks: spec.sizeChunks,
        chunkWorldSize: spec.chunkWorldSize,
        regionsPerSide: spec.regionsPerSide,
      },
      regions,
      biomeRegions: survey.regions.map((r) => ({
        index: r.index,
        biome: spec.biomes[r.biome].id,
        x: Math.round(r.x),
        z: Math.round(r.z),
      })),
      chunks: catalogChunks,
    });
    catalogMs = performance.now() - t0;
    sampleRss();
    log(`[bake] SurrealDB catalog (${path.basename(opts.catalogDir)}): ${catalogChunks.length} chunks, ${regions.length} regions in ${(catalogMs / 1000).toFixed(1)} s`);
  }

  return {
    chunks: catalogChunks.length,
    surveyMs,
    tilesMs,
    catalogMs,
    peakRssMb: Math.round(peakRss / 1e6),
    heightRange: { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 },
    biomeRegions,
    biomeShare,
    landPercent,
    riverChunks,
    lakeCells: survey.stats.lakeCells,
    mountainRanges: survey.ranges.length,
    erosion: { meanM: survey.stats.erodedMeanM, maxM: survey.stats.erodedMaxM, deepestCutM: survey.stats.deepestCutM },
    spawn: spawnPoint(spec, survey),
  };
}

/** Share of the world (inside its edges) each biome covers, %, largest first. */
export function biomeShares(survey: Survey): Record<string, number> {
  const g = survey.grid;
  const b = worldBounds(survey.spec);
  const counts = new Array<number>(survey.spec.biomes.length).fill(0);
  let total = 0;
  for (let v = 0; v < g.depth; v++) {
    const z = g.originZ + v * g.cell;
    for (let u = 0; u < g.width; u++) {
      const x = g.originX + u * g.cell;
      if (x < b.min || z < b.min || x >= b.max || z >= b.max) continue;
      counts[survey.biome[v * g.width + u]]++;
      total++;
    }
  }
  return Object.fromEntries(
    counts
      .map((n, i) => [survey.spec.biomes[i].id, Math.round((1000 * n) / total) / 10] as const)
      .filter(([, p]) => p > 0)
      .sort((a, b) => b[1] - a[1]),
  );
}

/** UV index range over land, "min–max (median)". */
function uvRange(survey: Survey): string {
  const land = survey.uv.filter((_, i) => survey.water[i] === LAND).sort();
  if (land.length === 0) return "n/a";
  const at = (p: number): string => land[Math.min(land.length - 1, Math.floor(p * land.length))].toFixed(1);
  return `${at(0)}–${at(1)} (median ${at(0.5)})`;
}
