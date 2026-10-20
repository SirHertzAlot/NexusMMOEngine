/**
 * World terrain bake — survey the whole world, store every chunk's tile,
 * the survey maps, and the SurrealDB catalog. Run once per world (terrain
 * is data afterwards; the editor sculpts it, the server reads it).
 *
 * Memory stays bounded: the survey is a few MB, and fine tiles are
 * generated and written in batches, never held for the whole world.
 *
 * Incremental (roadmap WX2):
 *   - The survey is content-addressed (surveyHash = sha256 of the canonical
 *     spec JSON). On re-bake, an unchanged spec skips the survey entirely.
 *   - Tiles are content-addressed via TerrainCache: a tile whose
 *     (seed, surveyHash, terrainVersion) key matches the stored one is
 *     skipped, so a re-bake after an unrelated change rewrites nothing.
 *   - `--region rx,rz` re-bakes only one region's tiles.
 *   - `--survey-only` re-runs the survey and invalidates the tile cache.
 *   - The tile loop runs across worker threads for CPU parallelism.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { TerrainTile } from "@mmo-engine/protocol";
import { TerrainCache } from "../persist/terrain-cache.js";
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
  /** sha256 of the canonical spec JSON — stored in meta as survey_hash. */
  surveyHash: string;
  /** True when the survey was skipped (spec unchanged from the stored hash). */
  surveySkipped: boolean;
  /** Number of tiles skipped because they were already current. */
  tilesSkipped: number;
  /** Number of tiles regenerated. */
  tilesGenerated: number;
}

export interface TerrainBakeOptions {
  /** world.db to write tiles and maps into. */
  dbPath: string;
  /** SurrealDB storage directory; null skips the catalog. */
  catalogDir: string | null;
  log?: (line: string) => void;
  /** Terrain pass version; bumping it invalidates every cached tile. */
  terrainVersion?: number;
  /** Re-bake only this region's tiles (rx, rz). */
  region?: [number, number];
  /** Re-run the survey and invalidate the tile cache, without regenerating tiles. */
  surveyOnly?: boolean;
  /** Skip tiles whose cache key matches (default true). */
  skipUnchanged?: boolean;
  /** The survey hash stored in meta from a previous bake; skips the survey when equal. */
  existingSurveyHash?: string | null;
  /** Number of worker threads for tile generation (default: CPU count). */
  workers?: number;
}

const TILE_BATCH = 2500;

/** Index of the region server owning a chunk. */
export function regionOf(spec: WorldSpec, cx: number, cz: number): [number, number] {
  const { minChunk } = worldBounds(spec);
  const per = spec.sizeChunks / spec.regionsPerSide;
  return [Math.floor((cx - minChunk) / per), Math.floor((cz - minChunk) / per)];
}

/**
 * The chunk range [minCx, maxCx] × [minCz, maxCz] that a region covers.
 * Used by --region to re-bake only one region's tiles.
 */
export function regionChunks(spec: WorldSpec, rx: number, rz: number): { minCx: number; maxCx: number; minCz: number; maxCz: number } {
  const { minChunk } = worldBounds(spec);
  const per = spec.sizeChunks / spec.regionsPerSide;
  return {
    minCx: minChunk + rx * per,
    maxCx: minChunk + (rx + 1) * per - 1,
    minCz: minChunk + rz * per,
    maxCz: minChunk + (rz + 1) * per - 1,
  };
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

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: sorted keys, no whitespace. Two specs that differ only in
 * key order produce the same string; any semantic change produces a
 * different one.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Content-address the survey: sha256 of the canonical spec JSON. Stored in
 * meta as `survey_hash`. On re-bake, an equal hash means the survey (maps
 * + catalog) is already in the db and can be skipped.
 */
export function surveyHash(spec: WorldSpec): string {
  return crypto.createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

// ---------------------------------------------------------------------------
// Parallel tile generation
// ---------------------------------------------------------------------------

interface TileWorkerData {
  height: Float32Array;
  roughness: Float32Array;
  gridWidth: number;
  gridDepth: number;
  gridCell: number;
  originX: number;
  originZ: number;
  chunkWorldSize: number;
  detailAmplitude: number;
  detailScale: number;
  specSeed: number;
  chunks: Array<[number, number]>;
}

interface TileWorkerResult {
  tiles: Array<{ cx: number; cz: number; heights: Float32Array }>;
}

/**
 * Generate tiles for a batch of chunks in a worker thread. The survey's
 * height and roughness arrays are sent via structured clone (read-only in
 * the worker).
 */
function runTileWorker(data: TileWorkerData): Promise<TileWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tile-worker.js", import.meta.url), {
      workerData: data,
    });
    worker.on("message", (result: TileWorkerResult) => {
      worker.terminate().catch(() => {});
      resolve(result);
    });
    worker.on("error", (err) => {
      worker.terminate().catch(() => {});
      reject(err);
    });
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`tile worker exited with code ${code}`));
    });
  });
}

/**
 * Generate tiles for all chunks in parallel across worker threads. Falls
 * back to sequential generation when workers are unavailable or the chunk
 * count is small.
 */
async function generateTilesParallel(
  survey: Survey,
  chunks: Array<[number, number]>,
  workers: number,
): Promise<Array<{ cx: number; cz: number; heights: Float32Array }>> {
  if (chunks.length === 0) return [];
  if (workers <= 1 || chunks.length < 4) {
    // Sequential fallback for small batches or single-threaded mode.
    const heights = new WorldHeights(survey);
    const out: Array<{ cx: number; cz: number; heights: Float32Array }> = [];
    for (const [cx, cz] of chunks) {
      const tile = new Float32Array(heights.chunkSamples);
      heights.generateChunk(0n, cx, cz, 0, tile);
      out.push({ cx, cz, heights: tile });
    }
    return out;
  }

  const spec = survey.spec;
  const g = survey.grid;

  // Split chunks into `workers` batches.
  const perWorker = Math.ceil(chunks.length / workers);
  const batches: Array<Array<[number, number]>> = [];
  for (let i = 0; i < chunks.length; i += perWorker) {
    batches.push(chunks.slice(i, i + perWorker));
  }

  const results = await Promise.all(
    batches.map((batch) =>
      runTileWorker({
        height: survey.height,
        roughness: survey.roughness,
        gridWidth: g.width,
        gridDepth: g.depth,
        gridCell: g.cell,
        originX: g.originX,
        originZ: g.originZ,
        chunkWorldSize: spec.chunkWorldSize,
        detailAmplitude: spec.detailAmplitude,
        detailScale: spec.detailScale,
        specSeed: spec.seed,
        chunks: batch,
      }),
    ),
  );

  const out: Array<{ cx: number; cz: number; heights: Float32Array }> = [];
  for (const r of results) {
    for (const t of r.tiles) {
      out.push({ cx: t.cx, cz: t.cz, heights: t.heights });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main bake
// ---------------------------------------------------------------------------

export async function bakeWorldTerrain(spec: WorldSpec, opts: TerrainBakeOptions): Promise<TerrainBakeReport> {
  const log = opts.log ?? (() => {});
  let peakRss = process.memoryUsage().rss;
  const sampleRss = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  const hash = surveyHash(spec);
  const skipUnchanged = opts.skipUnchanged ?? true;
  const workers = opts.workers ?? Math.max(1, (await import("node:os")).cpus().length - 1);

  // ---- survey (skippable) -------------------------------------------------
  let survey: Survey | null = null;
  let surveySkipped = false;
  let surveyMs = 0;

  const needSurvey =
    opts.surveyOnly === true ||
    opts.region !== undefined ||
    opts.existingSurveyHash == null ||
    opts.existingSurveyHash !== hash;

  if (needSurvey) {
    const t0 = performance.now();
    survey = surveyWorld(spec);
    surveyMs = performance.now() - t0;
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
  } else {
    surveySkipped = true;
    log(`[bake] survey skipped (spec unchanged, survey_hash ${hash.slice(0, 12)}…)`);
  }

  // ---- fine tiles, in batches ------------------------------------------
  const t0 = performance.now();
  const store = new TerrainTileStore(opts.dbPath);
  const terrainVersion = opts.terrainVersion ?? 1;
  const { minChunk, maxChunk } = worldBounds(spec);
  const cache = new TerrainCache({ dbPath: opts.dbPath, terrainVersion, minChunk, sizeChunks: spec.sizeChunks });

  // Determine the chunk range to bake.
  let bakeMinCx = minChunk;
  let bakeMaxCx = maxChunk;
  let bakeMinCz = minChunk;
  let bakeMaxCz = maxChunk;
  if (opts.region) {
    const rc = regionChunks(spec, opts.region[0], opts.region[1]);
    bakeMinCx = rc.minCx;
    bakeMaxCx = rc.maxCx;
    bakeMinCz = rc.minCz;
    bakeMaxCz = rc.maxCz;
    log(`[bake] region ${opts.region[0]},${opts.region[1]}: chunks ${bakeMinCx}..${bakeMaxCx} × ${bakeMinCz}..${bakeMaxCz}`);
  }

  // Build the chunk list.
  const chunks: Array<[number, number]> = [];
  for (let cz = bakeMinCz; cz <= bakeMaxCz; cz++) {
    for (let cx = bakeMinCx; cx <= bakeMaxCx; cx++) {
      chunks.push([cx, cz]);
    }
  }

  // For a regional re-bake, invalidate the region's cache first so its
  // tiles are regenerated even if they were already cached.
  if (opts.region && skipUnchanged) {
    const invalidated = cache.invalidateRegion(opts.region[0], opts.region[1], spec.regionsPerSide);
    log(`[bake] region ${opts.region[0]},${opts.region[1]}: invalidated ${invalidated} cached tiles`);
  }

  // Filter out unchanged tiles.
  let tilesSkipped = 0;
  let tilesGenerated = 0;
  const toGenerate: Array<[number, number]> = [];
  if (skipUnchanged && !opts.surveyOnly) {
    for (const [cx, cz] of chunks) {
      if (cache.has(cx, cz, 0, BigInt(spec.seed), hash)) {
        tilesSkipped++;
      } else {
        toGenerate.push([cx, cz]);
      }
    }
    log(`[bake] tiles: ${toGenerate.length} to generate, ${tilesSkipped} unchanged (skipped)`);
  } else if (opts.surveyOnly) {
    log(`[bake] survey-only: skipping tile generation`);
  } else {
    for (const c of chunks) toGenerate.push(c);
  }

  // Generate tiles (parallel or sequential).
  const catalogChunks: CatalogChunk[] = [];
  let batch: TerrainTile[] = [];
  let min = Infinity;
  let max = -Infinity;
  let riverChunks = 0;

  if (!opts.surveyOnly && toGenerate.length > 0) {
    // We need the survey for tile generation. If it was skipped, we must
    // still have it from a previous bake — but we can't regenerate tiles
    // without it. This shouldn't happen in practice: if the survey was
    // skipped, all tiles should be cached. But if some tiles are missing
    // (e.g. a partial previous bake), we need the survey.
    if (!survey) {
      log(`[bake] ${toGenerate.length} tiles missing from cache — re-running survey to generate them`);
      survey = surveyWorld(spec);
      surveyMs = performance.now() - t0;
    }

    const generated = await generateTilesParallel(survey, toGenerate, workers);
    tilesGenerated = generated.length;

    for (const { cx, cz, heights: tile } of generated) {
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
        // Also update the cache.
        for (const t of batch) {
          cache.put(t.cx, t.cz, 0, BigInt(spec.seed), hash, t.heights);
        }
        batch = [];
        sampleRss();
      }
      // Catalog entry.
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
    if (batch.length > 0) {
      store.putMany(batch);
      for (const t of batch) {
        cache.put(t.cx, t.cz, 0, BigInt(spec.seed), hash, t.heights);
      }
    }
  }

  // Write survey maps (only when the survey ran).
  if (survey && (!surveySkipped || opts.surveyOnly || opts.region !== undefined)) {
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
    store.putMap("water_level", map(survey.waterLevel));
    store.putMap("ice", map(survey.ice));
    store.putMap("melt", map(survey.meltMm));
    store.putMap("sun", map(survey.sun));
    store.putMap("uv", map(survey.uv));
    store.putMap("flow", map(survey.flow));
    store.putMap("river", map(survey.river));
    store.putMap("roughness", map(survey.roughness));
  }

  // Invalidate the tile cache for a new survey hash (survey-only mode).
  if (opts.surveyOnly) {
    const invalidated = cache.invalidateSurvey(hash);
    log(`[bake] survey-only: invalidated ${invalidated} cached tiles for survey ${hash.slice(0, 12)}…`);
  }

  cache.close();
  store.close();
  const tilesMs = performance.now() - t0;
  sampleRss();
  log(`[bake] ${catalogChunks.length} tiles + survey maps in ${(tilesMs / 1000).toFixed(1)} s`);

  // ---- SurrealDB catalog ---------------------------------------------------
  let catalogMs: number | null = null;
  if (opts.catalogDir !== null && survey && (!surveySkipped || opts.surveyOnly || opts.region !== undefined)) {
    const t1 = performance.now();
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
    catalogMs = performance.now() - t1;
    sampleRss();
    log(`[bake] SurrealDB catalog (${path.basename(opts.catalogDir)}): ${catalogChunks.length} chunks, ${regions.length} regions in ${(catalogMs / 1000).toFixed(1)} s`);
  }

  // If the survey was skipped, we need to reconstruct the report from the
  // stored data. Read the maps back from the store.
  let biomeRegions: Record<string, number> = {};
  let biomeShare: Record<string, number> = {};
  let landPercent = 0;
  let lakeCells = 0;
  let mountainRanges = 0;
  let erosion = { meanM: 0, maxM: 0, deepestCutM: 0 };
  let spawn = { x: 0, z: 0, biome: null as string | null };

  if (survey) {
    for (const r of survey.regions) {
      const id = spec.biomes[r.biome].id;
      biomeRegions[id] = (biomeRegions[id] ?? 0) + 1;
    }
    biomeShare = biomeShares(survey);
    landPercent = Math.round(survey.stats.landFraction * 1000) / 10;
    lakeCells = survey.stats.lakeCells;
    mountainRanges = survey.ranges.length;
    erosion = { meanM: survey.stats.erodedMeanM, maxM: survey.stats.erodedMaxM, deepestCutM: survey.stats.deepestCutM };
    spawn = spawnPoint(spec, survey);
  } else {
    // Survey was skipped: read maps from the store for the report.
    const tileStore = new TerrainTileStore(opts.dbPath);
    const biomeMap = tileStore.getMap("biome");
    const regionMap = tileStore.getMap("region");
    const waterMap = tileStore.getMap("water");
    if (biomeMap && regionMap && waterMap) {
      // Reconstruct biome regions from the region map.
      const regionBiomes = new Map<number, number>();
      for (let i = 0; i < regionMap.data.length; i++) {
        const r = (regionMap.data as Uint16Array)[i];
        regionBiomes.set(r, (regionBiomes.get(r) ?? 0) + 1);
      }
      // We don't have the biome index per region from the map alone;
      // use the biome map to infer it.
      const regionBiomeIdx = new Map<number, number>();
      for (let i = 0; i < regionMap.data.length; i++) {
        const r = (regionMap.data as Uint16Array)[i];
        if (!regionBiomeIdx.has(r)) {
          regionBiomeIdx.set(r, (biomeMap.data as Uint8Array)[i]);
        }
      }
      for (const [r, cells] of regionBiomes) {
        const bi = regionBiomeIdx.get(r) ?? 0;
        const id = spec.biomes[bi].id;
        biomeRegions[id] = (biomeRegions[id] ?? 0) + 1;
      }
      // Biome share.
      const counts = new Array<number>(spec.biomes.length).fill(0);
      let total = 0;
      for (let i = 0; i < biomeMap.data.length; i++) {
        if ((waterMap.data as Uint8Array)[i] === LAND) {
          counts[(biomeMap.data as Uint8Array)[i]]++;
          total++;
        }
      }
      biomeShare = Object.fromEntries(
        counts
          .map((n, i) => [spec.biomes[i].id, Math.round((1000 * n) / total) / 10] as const)
          .filter(([, p]) => p > 0)
          .sort((a, b) => b[1] - a[1]),
      );
      landPercent = Math.round((total / biomeMap.data.length) * 1000) / 10;
    }
    tileStore.close();
    // Spawn point: read from meta or default to 0,0.
    spawn = { x: 0, z: 0, biome: null };
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
    lakeCells,
    mountainRanges,
    erosion,
    spawn,
    surveyHash: hash,
    surveySkipped,
    tilesSkipped,
    tilesGenerated,
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
