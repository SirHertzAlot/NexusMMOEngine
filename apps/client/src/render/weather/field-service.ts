/**
 * FieldService — the main-thread weather service.
 *
 * Owns a WeatherField instance, builds the static climatology from the
 * world map, advances the field via the worker (with inline fallback),
 * and exposes sample() plus the raw field for rendering.
 *
 * The climatology is derived from the coarse world map: temperature from
 * height via a lapse rate plus a biome offset, moisture from water
 * proximity plus a biome offset. Dynamic params (wind, dryDistance,
 * orographic, recycling) come from a ClimateParams object sourced from the
 * world spec — the server sends a `climate` block in the welcome's
 * WorldInfo; the client falls back to DEFAULT_CLIMATE when absent.
 */

import type { WorldMap } from "@mmo-engine/protocol";
import type { WorkerRequester } from "../../workers/pool.js";
import type { WeatherResultPayload } from "../../workers/types.js";
import { WeatherField, type WeatherFieldParams, type WeatherKind, type WeatherSample } from "./field.js";

/**
 * Climate parameters for the weather field simulation. Mirrors the
 * `climate` block of the world spec (packages/engine-core/worlds/default.world.json).
 * The server sends this in the welcome's WorldInfo; the client falls back
 * to DEFAULT_CLIMATE when absent.
 */
export interface ClimateParams {
  /** Prevailing wind direction, unit XZ. */
  windX: number;
  windZ: number;
  /** Sea surface temperature (°C). */
  seaTempC: number;
  /** Inland cooling (°C) — used by the server's biome assignment. */
  inlandCoolingC: number;
  /** Inland cooling curve exponent — used by the server's biome assignment. */
  inlandCoolingCurve: number;
  /** Temperature lapse rate (°C/km) with height. */
  lapseCPerKm: number;
  /** Annual rainfall (mm) — used by the server's biome assignment. */
  rainMm: number;
  /** Metres over flat land in which the wind loses most of its moisture. */
  dryDistance: number;
  /** Extra rain wrung out per metre the wind climbs (orographic lift). */
  orographic: number;
  /** Fraction of moisture recycled locally each step (0..1). */
  recycling: number;
  /** Inland humidity (0..1) — used by the server's biome assignment. */
  inlandHumidity: number;
}

/**
 * Default climate params, mirroring the default world spec's climate
 * block (packages/engine-core/worlds/default.world.json). Used when the
 * server doesn't send a climate block in the welcome's WorldInfo.
 * The wind "west" becomes a vector pointing west (−x).
 */
export const DEFAULT_CLIMATE: ClimateParams = {
  windX: -1,
  windZ: 0,
  seaTempC: 16,
  inlandCoolingC: 28,
  inlandCoolingCurve: 3,
  lapseCPerKm: 45,
  rainMm: 1100,
  dryDistance: 2500,
  orographic: 0.006,
  recycling: 0.35,
  inlandHumidity: 0.35,
};

/** Biome temperature offsets (°C), keyed by biome id. */
const BIOME_TEMP_OFFSETS: Record<string, number> = {
  sea: 0,
  lake: 0,
  beach: 2,
  rainforest: 5,
  forest: 2,
  swamp: 3,
  plains: 0,
  desert: 8,
  mountains: -10,
  snow: -15,
  tundra: -8,
  glacier: -20,
  volcanic: 10,
};

/** Biome moisture offsets (0..1), keyed by biome id. */
const BIOME_MOISTURE_OFFSETS: Record<string, number> = {
  sea: 0.3,
  lake: 0.3,
  beach: 0.1,
  rainforest: 0.3,
  forest: 0.1,
  swamp: 0.2,
  plains: 0,
  desert: -0.3,
  mountains: 0,
  snow: 0.1,
  tundra: 0,
  glacier: 0.2,
  volcanic: -0.2,
};

/**
 * Build the static climatology from the world map into `temp` and `moist`
 * (both Float32Array of length map.width * map.depth).
 *
 * Temperature: sea temp at sea level, cooling with height via the lapse
 * rate, plus a biome offset. Moisture: falls off with distance from water
 * (BFS), plus a biome offset, clamped to 0..1.
 */
export function buildClimatology(map: WorldMap, temp: Float32Array, moist: Float32Array, climate: ClimateParams = DEFAULT_CLIMATE): void {
  const n = map.width * map.depth;
  const waterDist = distanceToWater(map);

  for (let i = 0; i < n; i++) {
    const h = map.heights[i];
    const biome = map.biomes[map.biome[i]] ?? "";

    // Temperature: sea temp at sea level, lapse rate with height, biome offset.
    const lapse = (h * climate.lapseCPerKm) / 1000;
    const tempOffset = BIOME_TEMP_OFFSETS[biome] ?? 0;
    temp[i] = climate.seaTempC - lapse + tempOffset;

    // Moisture: falls off with distance from water, biome offset.
    const dist = waterDist[i];
    const falloff = Number.isFinite(dist) ? Math.max(0, 1 - dist / climate.dryDistance) : 0;
    const moistOffset = BIOME_MOISTURE_OFFSETS[biome] ?? 0;
    moist[i] = Math.min(1, Math.max(0, falloff + moistOffset));
  }
}

/**
 * Distance (metres) from each cell to the nearest water cell, via BFS.
 * Returns Infinity for cells with no water on the map.
 */
function distanceToWater(map: WorldMap): Float32Array {
  const n = map.width * map.depth;
  const dist = new Float32Array(n).fill(Infinity);
  if (!map.water) return dist;

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(map.water[i])) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const u = i % map.width;
    const v = (i / map.width) | 0;
    const d = dist[i] + map.cell;
    if (u > 0 && dist[i - 1] === Infinity) { dist[i - 1] = d; queue.push(i - 1); }
    if (u < map.width - 1 && dist[i + 1] === Infinity) { dist[i + 1] = d; queue.push(i + 1); }
    if (v > 0 && dist[i - map.width] === Infinity) { dist[i - map.width] = d; queue.push(i - map.width); }
    if (v < map.depth - 1 && dist[i + map.width] === Infinity) { dist[i + map.width] = d; queue.push(i + map.width); }
  }
  return dist;
}

/**
 * The main-thread weather service. Owns a WeatherField, builds the static
 * climatology from the world map, and advances the field each frame.
 */
export class FieldService {
  private readonly sim: WeatherField;
  private readonly map: WorldMap;
  private readonly workers: WorkerRequester | null;
  private readonly params: WeatherFieldParams;
  private readonly seed: number;
  private readonly climate: ClimateParams;
  private override: WeatherKind | null = null;

  constructor(map: WorldMap, workers: WorkerRequester | null, seed: number, climate?: ClimateParams | null) {
    this.map = map;
    this.workers = workers;
    this.seed = seed;
    this.climate = climate ?? DEFAULT_CLIMATE;

    const n = map.width * map.depth;
    const temp = new Float32Array(n);
    const moist = new Float32Array(n);
    buildClimatology(map, temp, moist, this.climate);

    const params: WeatherFieldParams = {
      cell: map.cell,
      size: map.width,
      originX: map.originX,
      originZ: map.originZ,
      windX: this.climate.windX,
      windZ: this.climate.windZ,
      dryDistance: this.climate.dryDistance,
      orographic: this.climate.orographic,
      recycling: this.climate.recycling,
      climatologyTemp: temp,
      climatologyMoisture: moist,
    };
    this.params = params;
    this.sim = new WeatherField(params, seed);
  }

  /**
   * The weather at world (x, z). When an override is set, returns the
   * forced kind at full intensity; otherwise delegates to the field.
   */
  sample(x: number, z: number): WeatherSample {
    if (this.override !== null) {
      return { kind: this.override, intensity: 1, windX: this.climate.windX, windZ: this.climate.windZ };
    }
    return this.sim.sample(x, z);
  }

  /** The raw field for rendering (moisture, temperature arrays). */
  field(): { moisture: Float32Array; temperature: Float32Array } {
    return this.sim.field();
  }

  /** Moisture (0..1) at world (x, z), from the field's climatology. */
  moistureAt(x: number, z: number): number {
    const u = Math.round((x - this.map.originX) / this.map.cell);
    const v = Math.round((z - this.map.originZ) / this.map.cell);
    if (u < 0 || v < 0 || u >= this.map.width || v >= this.map.depth) return 0;
    return this.sim.field().moisture[v * this.map.width + u];
  }

  /** Force a weather kind (null: back to the simulation). */
  setOverride(kind: WeatherKind | null): void {
    this.override = kind;
  }

  /**
   * Advance the field by `dt` seconds. Tries the worker first; falls back to
   * inline stepping on any error (no worker, task type missing, etc.).
   *
   * The worker transfers the arrays it is handed, so the field's own
   * references are detached for the duration of the call — adopt the result's
   * fresh copies afterwards, never the ones that were sent.
   */
  async step(dt: number): Promise<void> {
    if (this.workers) {
      try {
        const { moisture, temperature } = this.sim.field();
        const res = (await this.workers.request("weather", {
          moisture,
          temperature,
          params: this.params,
          seed: this.seed,
          steps: 1,
          dt,
        })) as WeatherResultPayload;
        // The climatology arrays ride inside `params` and were transferred too,
        // so the copies in this.params are detached now — take the fresh ones
        // from the result, or the next call would transfer a dead buffer.
        this.params.climatologyTemp = res.climatologyTemp;
        this.params.climatologyMoisture = res.climatologyMoisture;
        this.sim.adopt(res.moisture, res.temperature);
        return;
      } catch {
        // No worker (tests, SSR) or the task is unavailable: step inline.
      }
    }
    this.sim.step(dt);
  }
}
