/**
 * World survey — the coarse, whole-world pass of the terrain bake.
 *
 * On a coarse grid (spec.coarseCell metres, ~500 × 500 cells for 4 km) it
 * builds the world the way nature would, in order:
 *
 *  1. land: a landmass with a wandering coast, a mountain chain pushed up
 *     across the prevailing wind with spurs branching off it, and a
 *     volcano on the chain (landmass.ts);
 *  2. erosion, driven by a first look at the climate: slopes collapse to
 *     their angle of repose, glaciers grind U-shaped valleys and leave
 *     moraines (glaciers.ts), rivers fed by rain and meltwater cut
 *     valleys, and rain washes soil downhill (erosion.ts);
 *  3. water: the sea, lakes in the hollows that hold water, and rivers
 *     from the rain-weighted drainage (hydrology.ts);
 *  4. climate: sunlight on each slope over the day, with shadows, and the
 *     UV it brings (sun.ts); temperature from height, distance to the sea
 *     and the sun a slope gets; rainfall carried in off the sea by the
 *     wind, wrung out over the ranges, with rain shadows behind them
 *     (climate.ts). Glaciers melt by warmth and sunshine;
 *  5. biomes: read off all of the above by the spec's rules, smoothed into
 *     regions, each adding its surface character (biomes.ts).
 *
 * The fine heightmap (world-heights.ts) is built on top of it. Terrain is
 * baked once and stored, so this only needs to be reproducible (same spec
 * -> same bytes), not bit-identical across platforms.
 */

import { makeProcgenChunkSource } from "../procgen/chunk-source.js";
import { applySurface, biomeRegions, classifyBiomes, smoothBiomes } from "./biomes.js";
import { rainfall, temperature } from "./climate.js";
import { dropletErosion, fluvialErosion, streamPowerIncision, thermalErosion, type RockTalus } from "./erosion.js";
import { glaciate } from "./glaciers.js";
import { sunlight, uvIndex } from "./sun.js";
import { boxBlur, distanceTo, sampleBilinear, slopeDegrees } from "./grid-ops.js";
import { ridgedMultifractal } from "./relief.js";
import {
  accumulate,
  carveRivers,
  drainage,
  fillDepressions,
  findLakes,
  LAKE,
  LAND,
  SEA,
  seaMask,
} from "./hydrology.js";
import {
  baseElevation,
  landMask,
  placeRanges,
  placeVolcanoes,
  raiseVolcanoes,
  rangeUplift,
  ventDistance,
  tidyLandmass,
  type RangeAxis,
  type Volcano,
} from "./landmass.js";
import { worldBounds, type WorldSpec } from "./world-spec.js";

export { fillDepressions, flowAccumulation, LAKE, LAND, SEA } from "./hydrology.js";
export type { RangeAxis, Volcano } from "./landmass.js";

/** Coarse cell (u, v) sits at world (originX + u*cell, originZ + v*cell). */
export interface CoarseGrid {
  width: number;
  depth: number;
  cell: number;
  originX: number;
  originZ: number;
}

/** A connected patch of one biome. */
export interface BiomeRegion {
  index: number;
  /** Index into spec.biomes. */
  biome: number;
  /** Centroid, world metres. */
  x: number;
  z: number;
  /** Size in survey cells. */
  cells: number;
}

export interface Survey {
  spec: WorldSpec;
  grid: CoarseGrid;
  /** Final coarse elevation, metres (sea floor and lake beds included). */
  height: Float32Array;
  /** Fine-detail strength 0..1, blended across biome borders. */
  roughness: Float32Array;
  /** Biome (index into spec.biomes) per cell. */
  biome: Uint8Array;
  /** Biome region per cell (index into `regions`). */
  region: Uint16Array;
  /** Humidity of the wind 0..1. */
  moisture: Float32Array;
  /** Yearly precipitation (rain, or snow where it's cold), mm. */
  rain: Float32Array;
  /** Mean temperature, °C. */
  temperature: Float32Array;
  /** LAND, SEA, or LAKE per cell. */
  water: Uint8Array;
  /** Water surface height on sea and lake cells, NaN on land. */
  waterLevel: Float32Array;
  /** 1 under glacier ice or an ice cap. */
  ice: Uint8Array;
  /** Glacier meltwater released per cell, mm a year over the cell. */
  meltMm: Float32Array;
  /** Distance to the nearest volcano vent, metres (Infinity with none). */
  ventDistance: Float32Array;
  /** The day's sunlight relative to flat open ground (1); shadows included. */
  sun: Float32Array;
  /** UV index. */
  uv: Float32Array;
  /** Rain-weighted upstream area per cell, m² (at the windward coast's rainfall). */
  flow: Float32Array;
  /** 1 where a river runs. */
  river: Uint8Array;
  regions: BiomeRegion[];
  ranges: RangeAxis[];
  volcanoes: Volcano[];
  stats: {
    erodedMeanM: number;
    erodedMaxM: number;
    deepestCutM: number;
    glacierCells: number;
    glacierSnouts: number;
    deepestGlacialCutM: number;
    /** Glacier meltwater, m³ a year, over the whole world. */
    meltwaterM3: number;
    riverCells: number;
    lakeCells: number;
    /** Share of the world (inside its edges) that is land. */
    landFraction: number;
  };
}

/** Cells beyond the world edge so bicubic sampling never runs off the grid. */
const MARGIN = 3;

export function coarseGrid(spec: WorldSpec): CoarseGrid {
  const b = worldBounds(spec);
  const cells = Math.ceil((b.max - b.min) / spec.coarseCell) + 1 + 2 * MARGIN;
  return {
    width: cells,
    depth: cells,
    cell: spec.coarseCell,
    originX: b.min - MARGIN * spec.coarseCell,
    originZ: b.min - MARGIN * spec.coarseCell,
  };
}

/** Per-field seed derived from the world seed (procgen uses the low 32 bits). */
export function fieldSeed(worldSeed: number, salt: number): bigint {
  return (BigInt(worldSeed) * 0x9e3779b1n + BigInt(salt)) & 0xffffffffn;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Normalised FBm noise (-1..1) at every coarse cell, feature size `scale`
 * metres. Uses the native procgen addon one 16×16 block at a time: cell
 * (u, v) is noise coordinate (u, v), so blocks tile exactly.
 */
export function noiseField(grid: CoarseGrid, seed: bigint, scale: number): Float32Array {
  const frequency = Math.min(1, grid.cell / scale);
  const source = makeProcgenChunkSource({ amplitude: 1, frequency });
  const out = new Float32Array(grid.width * grid.depth);
  const block = new Float32Array(source.chunkSamples);
  for (let bz = 0; bz * 15 < grid.depth; bz++) {
    for (let bx = 0; bx * 15 < grid.width; bx++) {
      source.generateChunk(seed, bx, bz, 0, block);
      for (let j = 0; j < 16; j++) {
        const v = bz * 15 + j;
        if (v >= grid.depth) break;
        for (let i = 0; i < 16; i++) {
          const u = bx * 15 + i;
          if (u < grid.width) out[v * grid.width + u] = block[j * 16 + i];
        }
      }
    }
  }
  return out;
}

/**
 * Ridged multifractal detail over the ranges (undefined when the spec asks
 * for none): octaves of ridged noise at half the ridge scale and finer,
 * each domain-warped by the range's warp fields.
 */
function crestDetail(spec: WorldSpec, grid: CoarseGrid, warpU: Float32Array, warpV: Float32Array): Float32Array | undefined {
  const octaves = spec.ranges.crest.detailOctaves;
  if (octaves === 0) return undefined;
  const warp = (2 * spec.ranges.ridgeScale) / 25 / grid.cell;
  const fields: Float32Array[] = [];
  for (let k = 0; k < octaves; k++) {
    const noise = noiseField(grid, fieldSeed(spec.seed, 20 + k), spec.ranges.ridgeScale / 2 ** (k + 1));
    const warped = new Float32Array(noise.length);
    for (let v = 0; v < grid.depth; v++) {
      for (let u = 0; u < grid.width; u++) {
        const i = v * grid.width + u;
        warped[i] = sampleBilinear(noise, grid.width, grid.depth, u + warp * warpU[i], v + warp * warpV[i]);
      }
    }
    fields.push(warped);
  }
  return ridgedMultifractal(fields, 0.5);
}

/** Neighbourhood for sea exposure: ~400 m across. */
const SEA_EXPOSURE_RADIUS_M = 400;

/** Keep land at least this far above the sea (off the rivers) after the surface pass. */
const SHORE_MARGIN_M = 0.3;

export function surveyWorld(spec: WorldSpec): Survey {
  const grid = coarseGrid(spec);
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const sea = spec.land.seaLevel;
  const E = spec.erosion;

  // ---- 1. land and uplift ---------------------------------------------------
  const swell = noiseField(grid, fieldSeed(spec.seed, 1), spec.land.reliefScale);
  const warpA = noiseField(grid, fieldSeed(spec.seed, 3), spec.land.coast.wanderScale);
  const warpT = noiseField(grid, fieldSeed(spec.seed, 4), spec.land.coast.wanderScale);
  const land = landMask(spec, grid, warpA, warpT);
  const height = baseElevation(spec, grid, land, swell);
  const baseLevel = Float32Array.from(height);
  const layout = mulberry32(spec.seed ^ 0x5eed);
  const ranges = placeRanges(spec, grid, land, layout);
  const warpU = noiseField(grid, fieldSeed(spec.seed, 10), spec.ranges.ridgeScale * 2);
  const warpV = noiseField(grid, fieldSeed(spec.seed, 11), spec.ranges.ridgeScale * 2);
  const uplift = rangeUplift(
    spec,
    grid,
    ranges,
    noiseField(grid, fieldSeed(spec.seed, 5), spec.ranges.ridgeScale),
    noiseField(grid, fieldSeed(spec.seed, 6), spec.ranges.length / 3),
    noiseField(grid, fieldSeed(spec.seed, 9), spec.ranges.ridgeScale * 0.6),
    warpU,
    warpV,
    crestDetail(spec, grid, warpU, warpV),
  );
  for (let i = 0; i < N; i++) if (land[i]) height[i] += uplift[i];
  // Volcanoes: placed now (their heat shapes the climate the erosion
  // sees), raised after erosion (they are young).
  const volcanoes = placeVolcanoes(spec, ranges, layout);
  const lobes = noiseField(grid, fieldSeed(spec.seed, 8), spec.volcano.radius / 3);
  const vents = ventDistance(spec, grid, volcanoes, lobes);

  // ---- 2. erosion, driven by a first look at the rain ------------------------
  const rock: RockTalus | undefined =
    E.rockTalusDeg === undefined ? undefined : { deg: E.rockTalusDeg, fromM: sea + E.rockFromM, spanM: E.rockSpanM };
  thermalErosion(height, grid, E.talusDeg, Math.ceil(E.thermalPasses / 2), rock);
  const shaped = Float32Array.from(height);
  const firstSea = seaMask(height, grid, sea);
  const firstRain = rainfall(spec, grid, height, (i) => firstSea[i] === 1).rainMm;
  const youngSun = sunlight(spec, grid, height).sun;
  const glaciers = glaciate(
    spec,
    grid,
    height,
    temperature(spec, grid, height, vents, youngSun),
    firstRain,
    (i) => firstSea[i] === 1,
    youngSun,
  );
  const meltMm = glaciers.melt.map((m) => (m / (grid.cell * grid.cell)) * 1000);
  const share = firstRain.map((r) => r / spec.climate.rainMm);
  const runoff = firstRain.map((r, i) => (r + meltMm[i]) / spec.climate.rainMm);
  const deepestCutM = fluvialErosion(height, grid, sea, runoff, E.fluvialPasses, E.fluvialStrength);
  streamPowerIncision(height, grid, sea, runoff, E.incision.passes, E.incision.k, E.incision.areaExponent, E.incision.maxCutM);
  dropletErosion(height, grid, sea, share, E.droplets, E.strength, mulberry32(spec.seed ^ 0xe20d));
  thermalErosion(height, grid, E.talusDeg, Math.floor(E.thermalPasses / 2), rock);
  let erodedSum = 0;
  let erodedMaxM = 0;
  for (let i = 0; i < N; i++) {
    const change = Math.abs(height[i] - shaped[i]);
    erodedSum += change;
    erodedMaxM = Math.max(erodedMaxM, change);
  }
  const gullyNoise = spec.volcano.gullies > 0 ? noiseField(grid, fieldSeed(spec.seed, 30), 22 * grid.cell) : undefined;
  raiseVolcanoes(spec, grid, height, baseLevel, volcanoes, lobes, gullyNoise);

  // ---- 3. water ---------------------------------------------------------------
  // One landmass: islands the erosion cut off, if too small, go under.
  let seaCells = seaMask(height, grid, sea);
  const kept = tidyLandmass(seaCells.map((s) => (s ? 0 : 1)), W, D, grid.cell, spec.land.minIslandArea);
  for (let i = 0; i < N; i++) if (!kept[i] && !seaCells[i]) height[i] = Math.min(height[i], sea - 0.5);
  seaCells = seaMask(height, grid, sea);
  const filled = fillDepressions(height, grid);
  // Meltwater fills lakes too (glacial lakes behind moraines).
  const lakes = findLakes(height, filled, grid, seaCells, firstRain.map((r, i) => r + meltMm[i]), spec.lakes);
  const water = new Uint8Array(N);
  const waterLevel = new Float32Array(N).fill(Number.NaN);
  for (let i = 0; i < N; i++) {
    if (seaCells[i]) [water[i], waterLevel[i]] = [SEA, sea];
    else if (lakes.lake[i]) [water[i], waterLevel[i]] = [LAKE, lakes.level[i]];
  }

  // ---- 4. climate --------------------------------------------------------------
  const { rainMm, humidity } = rainfall(spec, grid, height, (i) => water[i] !== LAND);
  const light = sunlight(spec, grid, height);
  const tempC = temperature(spec, grid, height, vents, light.sun);
  const uv = uvIndex(spec, grid, height, light, rainMm, (i) => glaciers.ice[i] === 1 || tempC[i] <= spec.glaciers.formBelowC);

  // ---- rivers: rain-weighted drainage over the filled surface -----------------
  const flow = accumulate(drainage(filled, grid), grid, (i) => (rainMm[i] + meltMm[i]) / spec.climate.rainMm);
  const river = new Uint8Array(N);
  let riverCells = 0;
  for (let i = 0; i < N; i++) {
    if (water[i] === LAND && flow[i] >= spec.rivers.minCatchment) {
      river[i] = 1;
      riverCells++;
    }
  }

  // ---- 5. biomes ---------------------------------------------------------------
  const above = height.map((h) => h - sea);
  const seaShare = new Float32Array(N);
  for (let i = 0; i < N; i++) seaShare[i] = water[i] === SEA ? 1 : 0;
  const biome = classifyBiomes(spec, {
    water,
    tempC,
    rainMm,
    height: above,
    slopeDeg: slopeDegrees(height, W, D, grid.cell),
    coastDistance: distanceTo(W, D, grid.cell, (i) => water[i] === SEA),
    waterDistance: distanceTo(W, D, grid.cell, (i) => water[i] !== LAND || river[i] === 1),
    freshwaterDistance: distanceTo(W, D, grid.cell, (i) => water[i] === LAKE || river[i] === 1),
    seaExposure: boxBlur(seaShare, W, D, SEA_EXPOSURE_RADIUS_M / grid.cell / 2),
    ice: glaciers.ice,
    volcanoDistance: vents,
    uvIndex: uv,
  });
  smoothBiomes(biome, water, W, D, spec.minBiomeArea / (grid.cell * grid.cell));
  const { regions, region } = biomeRegions(biome, grid);

  // ---- surface character, then river beds -------------------------------------
  const roughness = applySurface(spec, grid, height, biome, water, (b) =>
    noiseField(grid, fieldSeed(spec.seed, 100 + b), spec.biomes[b].surface!.scale),
  );
  carveRivers(height, grid, river, flow, water, spec.rivers.minCatchment, spec.rivers.maxDepth);
  // Land stays above the sea off the rivers: the water map is final, and
  // surface noise must not open flooded pits it doesn't know about.
  for (let i = 0; i < N; i++) {
    if (water[i] === LAND && !river[i] && height[i] < sea + SHORE_MARGIN_M) height[i] = sea + SHORE_MARGIN_M;
  }

  let landCells = 0;
  let worldCells = 0;
  let lakeCells = 0;
  const b = worldBounds(spec);
  for (let v = 0; v < D; v++) {
    const z = grid.originZ + v * grid.cell;
    for (let u = 0; u < W; u++) {
      const x = grid.originX + u * grid.cell;
      const i = v * W + u;
      if (water[i] === LAKE) lakeCells++;
      if (x < b.min || z < b.min || x >= b.max || z >= b.max) continue;
      worldCells++;
      if (water[i] !== SEA) landCells++;
    }
  }

  return {
    spec,
    grid,
    height,
    roughness,
    biome,
    region,
    moisture: humidity,
    rain: rainMm,
    temperature: tempC,
    water,
    waterLevel,
    ice: glaciers.ice,
    meltMm,
    ventDistance: vents,
    sun: light.sun,
    uv,
    flow,
    river,
    regions,
    ranges,
    volcanoes,
    stats: {
      erodedMeanM: erodedSum / N,
      erodedMaxM,
      deepestCutM,
      glacierCells: glaciers.ice.reduce((a, b) => a + b, 0),
      glacierSnouts: glaciers.snouts,
      deepestGlacialCutM: glaciers.deepestCutM,
      meltwaterM3: glaciers.melt.reduce((a, m) => a + m, 0),
      riverCells,
      lakeCells,
      landFraction: landCells / worldCells,
    },
  };
}
