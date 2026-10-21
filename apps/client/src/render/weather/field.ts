/**
 * Weather field — a coarse, runtime moisture/temperature simulation that
 * replaces the static biome/tick hash in fx/weather.ts as the source of
 * truth for what falls from the sky (roadmap WX1).
 *
 * The world is covered by its OWN coarse lattice (250–500 m cells, NOT the
 * terrain grid). Two fields live on it: `moisture` (0..1 — how much water
 * the air holds) and `temperature` (°C). Each step:
 *   1. moisture is advected along the prevailing wind (semi-Lagrangian,
 *      unconditionally stable, no CFL limit);
 *   2. the air is dried over flat land (`dryDistance`) and wrung out faster
 *      where it climbs (orographic lift — height is derived from the
 *      temperature climatology via the lapse rate, so cold cells are high
 *      cells; where the climatology is uniform the derived height is uniform
 *      and the orographic term vanishes, the "else a constant" case);
 *   3. a fraction of what falls evaporates straight back (`recycling`);
 *   4. both fields relax toward their static climatology — the term that
 *      stops the simulation drifting into permanent rain or permanent drought;
 *   5. a small deterministic per-cell turbulence (seeded integer hash)
 *      keeps the pattern alive without ever calling Math.random().
 *
 * Precipitation where moisture crosses a threshold; the kind is set by
 * temperature (below 0 °C snow, else rain). `ash` is only reachable through
 * force() — a debug/admin override, like the old server-forced sky.
 *
 * Determinism: the same (seed, step count, params) produces byte-identical
 * fields. All randomness comes from an integer hash of (seed, cell, step).
 *
 * No per-frame allocation: every array is allocated once in the constructor;
 * step() only writes into preallocated buffers.
 */

export type WeatherKind = "clear" | "rain" | "snow" | "ash";

export interface WeatherFieldParams {
  /** Grid cell size in metres (250-500). */
  cell: number;
  /** Grid is size x size cells. */
  size: number;
  /** World metres of grid cell (0,0)'s corner. */
  originX: number;
  originZ: number;
  /** Prevailing wind direction, unit XZ. */
  windX: number;
  windZ: number;
  /** Metres over flat land in which the wind loses most of its moisture. */
  dryDistance: number;
  /** Extra rain wrung out per metre the wind climbs (orographic lift). */
  orographic: number;
  /** Fraction of moisture recycled locally each step (0..1). */
  recycling: number;
  /** Static temperature per cell (deg C) — the climatology to relax toward. */
  climatologyTemp: Float32Array;
  /** Static moisture availability per cell (0..1). */
  climatologyMoisture: Float32Array;
}

export interface WeatherSample {
  kind: WeatherKind;
  /** 0..1 */
  intensity: number;
  windX: number;
  windZ: number;
}

// --- Module constants (simulation tuning; the contract fixes the params). ---
/** Prevailing wind speed in m/s (windX/windZ give the direction only). */
const WIND_SPEED_MPS = 10;
/** /s — moisture picked up over water cells. */
const EVAP_RATE = 0.01;
/** /s — pull of moisture toward climatologyMoisture (the anti-drift term). */
const RELAX_MOISTURE = 0.002;
/** /s — pull of temperature toward climatologyTemp. */
const RELAX_TEMP = 0.001;
/** /s — amplitude of the deterministic turbulence forcing. */
const TURBULENCE = 0.002;
/** Moisture at/above which a cell precipitates. */
const PRECIP_THRESHOLD = 0.6;
/** climatologyMoisture at/above which a cell counts as water (evaporates). */
const WATER_THRESHOLD = 0.5;
/** 6.5 °C/km — the lapse rate used to derive a height field from the
 *  temperature climatology (cold cells are high cells). */
const LAPSE_RATE_C_PER_M = 0.0065;

/** Mutable simulation state, allocated once and reused across steps. */
interface WeatherState {
  moisture: Float32Array;
  temperature: Float32Array;
  /** Advection scratch (semi-Lagrangian reads one array, writes the other). */
  scratch: Float32Array;
  /** Precomputed metres of climb per metre travelled, from the height field. */
  climbRate: Float32Array;
  seed: number;
  stepCount: number;
}

/** Deterministic 0..1 hash of (seed, cell, step) — integer ops only, so it
 *  is byte-identical on every platform and never touches Math.random(). */
function hash01(seed: number, i: number, step: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(step + 1, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Bilinear sample of a row-major (X inner) field at fractional index space,
 *  clamped to the edges. Allocates nothing. */
function sampleBilinear(f: Float32Array, size: number, sx: number, sz: number): number {
  if (sx < 0) sx = 0;
  else if (sx > size - 1) sx = size - 1;
  if (sz < 0) sz = 0;
  else if (sz > size - 1) sz = size - 1;
  const x0 = Math.floor(sx);
  const z0 = Math.floor(sz);
  const x1 = x0 + 1 < size ? x0 + 1 : size - 1;
  const z1 = z0 + 1 < size ? z0 + 1 : size - 1;
  const tx = sx - x0;
  const tz = sz - z0;
  const i00 = z0 * size + x0;
  const i10 = z0 * size + x1;
  const i01 = z1 * size + x0;
  const i11 = z1 * size + x1;
  const top = f[i00] + (f[i10] - f[i00]) * tx;
  const bot = f[i01] + (f[i11] - f[i01]) * tx;
  return top + (bot - top) * tz;
}

/**
 * Derive a height field (metres) from the temperature climatology via the
 * lapse rate: the warmest cell is at sea level, colder cells are higher. This
 * is how the runtime field gets an orographic term without a terrain grid —
 * a temperature gradient across the wind becomes a slope the wind climbs.
 */
function deriveHeight(params: WeatherFieldParams): Float32Array {
  const { size, climatologyTemp } = params;
  const n = size * size;
  const height = new Float32Array(n);
  let tMax = -Infinity;
  for (let i = 0; i < n; i++) if (climatologyTemp[i] > tMax) tMax = climatologyTemp[i];
  for (let i = 0; i < n; i++) {
    const h = (tMax - climatologyTemp[i]) / LAPSE_RATE_C_PER_M;
    height[i] = h > 0 ? h : 0;
  }
  return height;
}

/** Metres of climb per metre travelled = height gradient dotted with the wind. */
function computeClimbRate(height: Float32Array, size: number, windX: number, windZ: number): Float32Array {
  const climb = new Float32Array(size * size);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x;
      const xl = x > 0 ? height[i - 1] : height[i];
      const xr = x < size - 1 ? height[i + 1] : height[i];
      const zt = z > 0 ? height[i - size] : height[i];
      const zb = z < size - 1 ? height[i + size] : height[i];
      const gx = (xr - xl) * 0.5;
      const gz = (zb - zt) * 0.5;
      climb[i] = gx * windX + gz * windZ;
    }
  }
  return climb;
}

function validateParams(params: WeatherFieldParams): void {
  if (!Number.isInteger(params.size) || params.size <= 0) {
    throw new Error("WeatherField: size must be a positive integer");
  }
  if (!(params.cell > 0)) throw new Error("WeatherField: cell must be positive");
  const n = params.size * params.size;
  if (params.climatologyTemp.length !== n) {
    throw new Error(`WeatherField: climatologyTemp length mismatch (want ${n}, got ${params.climatologyTemp.length})`);
  }
  if (params.climatologyMoisture.length !== n) {
    throw new Error(`WeatherField: climatologyMoisture length mismatch (want ${n}, got ${params.climatologyMoisture.length})`);
  }
  if (!(params.dryDistance > 0)) throw new Error("WeatherField: dryDistance must be positive");
  if (params.recycling < 0 || params.recycling > 1) {
    throw new Error("WeatherField: recycling must be in [0,1]");
  }
  if (params.windX === 0 && params.windZ === 0) {
    throw new Error("WeatherField: wind direction must be non-zero");
  }
}

function createState(
  params: WeatherFieldParams,
  seed: number,
  moisture?: Float32Array,
  temperature?: Float32Array,
): WeatherState {
  const n = params.size * params.size;
  const height = deriveHeight(params);
  const climbRate = computeClimbRate(height, params.size, params.windX, params.windZ);
  return {
    moisture: moisture ?? new Float32Array(n),
    temperature: temperature ?? new Float32Array(n),
    scratch: new Float32Array(n),
    climbRate,
    seed,
    stepCount: 0,
  };
}

/** Advance the state by dt seconds. Writes only into preallocated buffers. */
function stepWeather(state: WeatherState, params: WeatherFieldParams, dt: number): void {
  const { size, cell, windX, windZ, dryDistance, orographic, recycling, climatologyTemp, climatologyMoisture } = params;
  const { moisture, temperature, scratch, climbRate, seed } = state;

  // 1. Advect moisture along the wind (semi-Lagrangian): each cell samples
  //    its upwind position. Unconditionally stable, so dt is not CFL-limited.
  const dx = (windX * WIND_SPEED_MPS * dt) / cell;
  const dz = (windZ * WIND_SPEED_MPS * dt) / cell;
  for (let z = 0; z < size; z++) {
    const row = z * size;
    for (let x = 0; x < size; x++) {
      scratch[row + x] = sampleBilinear(moisture, size, x - dx, z - dz);
    }
  }

  // 2. Sources, sinks and relaxation.
  const dist = WIND_SPEED_MPS * dt;
  const flatRate = dist / dryDistance;
  const evap = EVAP_RATE * dt;
  const relaxM = RELAX_MOISTURE * dt;
  const relaxT = RELAX_TEMP * dt;
  const turb = TURBULENCE * dt;
  const step = state.stepCount;
  for (let z = 0; z < size; z++) {
    const row = z * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      const qIn = scratch[i];

      // Orographic lift: extra rain wrung out per metre the wind climbs.
      const climb = climbRate[i] * dist;
      const orog = climb > 0 ? orographic * climb : 0;
      const fraction = 1 - Math.exp(-(flatRate + orog));
      const fall = qIn * fraction;
      let q = qIn - fall * (1 - recycling);

      // Evaporation from water cells (high climatologyMoisture = water).
      if (climatologyMoisture[i] >= WATER_THRESHOLD) {
        q += (1 - q) * evap;
      }

      // Deterministic turbulence (seeded hash, zero-mean per cell).
      q += (hash01(seed, i, step) - 0.5) * turb;

      // Relax toward the static climatology — the anti-drift term.
      q += (climatologyMoisture[i] - q) * relaxM;

      // Clamp to the documented range (a safety net; relaxation keeps it there).
      moisture[i] = q < 0 ? 0 : q > 1 ? 1 : q;

      // Temperature is a slow field: it just relaxes toward its climatology.
      temperature[i] += (climatologyTemp[i] - temperature[i]) * relaxT;
    }
  }
  state.stepCount = step + 1;
}

/**
 * Run `steps` simulation steps of `dt` seconds on field arrays the caller
 * owns, in place. This is the worker entry point: stateless, it allocates
 * only its own scratch/climb buffers and mutates `moisture`/`temperature`.
 */
export function runWeatherSteps(
  moisture: Float32Array,
  temperature: Float32Array,
  params: WeatherFieldParams,
  seed: number,
  steps: number,
  dt: number,
): void {
  validateParams(params);
  const n = params.size * params.size;
  if (moisture.length !== n) {
    throw new Error(`runWeatherSteps: moisture length mismatch (want ${n}, got ${moisture.length})`);
  }
  if (temperature.length !== n) {
    throw new Error(`runWeatherSteps: temperature length mismatch (want ${n}, got ${temperature.length})`);
  }
  if (!(dt > 0)) throw new Error("runWeatherSteps: dt must be positive");
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error("runWeatherSteps: steps must be a non-negative integer");
  }
  const state = createState(params, seed, moisture, temperature);
  for (let s = 0; s < steps; s++) stepWeather(state, params, dt);
}

export class WeatherField {
  private readonly state: WeatherState;
  private readonly params: WeatherFieldParams;
  private forcedKind: WeatherKind | null = null;
  private forcedIntensity = 0;

  constructor(params: WeatherFieldParams, seed: number) {
    validateParams(params);
    this.params = params;
    const n = params.size * params.size;
    // Start at the climate equilibrium.
    const moisture = new Float32Array(n);
    const temperature = new Float32Array(n);
    moisture.set(params.climatologyMoisture);
    temperature.set(params.climatologyTemp);
    this.state = createState(params, seed, moisture, temperature);
  }

  /** Advance the simulation by dt seconds. Deterministic given (seed, total steps). */
  step(dt: number): void {
    if (!(dt > 0)) throw new Error("WeatherField: dt must be positive");
    stepWeather(this.state, this.params, dt);
  }

  /** The weather at a world position. */
  sample(x: number, z: number): WeatherSample {
    const { size, cell, originX, originZ, windX, windZ } = this.params;
    if (this.forcedKind !== null) {
      return { kind: this.forcedKind, intensity: this.forcedIntensity, windX, windZ };
    }
    // Nearest cell, clamped to the grid.
    let gx = Math.round((x - originX) / cell);
    let gz = Math.round((z - originZ) / cell);
    if (gx < 0) gx = 0;
    else if (gx > size - 1) gx = size - 1;
    if (gz < 0) gz = 0;
    else if (gz > size - 1) gz = size - 1;
    const i = gz * size + gx;
    const q = this.state.moisture[i];
    const t = this.state.temperature[i];
    if (q >= PRECIP_THRESHOLD) {
      const intensity = (q - PRECIP_THRESHOLD) / (1 - PRECIP_THRESHOLD);
      return { kind: t < 0 ? "snow" : "rain", intensity, windX, windZ };
    }
    return { kind: "clear", intensity: 0, windX, windZ };
  }

  /** Raw field access for rendering. */
  field(): { moisture: Float32Array; temperature: Float32Array } {
    return { moisture: this.state.moisture, temperature: this.state.temperature };
  }

  /**
   * Take arrays computed elsewhere (the weather worker) as the field's own.
   *
   * The worker transfers the arrays it is handed, so the caller's references
   * are detached by the time its result arrives. Adopt the result's arrays —
   * never the ones that were sent.
   */
  adopt(moisture: Float32Array, temperature: Float32Array): void {
    const n = this.params.size * this.params.size;
    if (moisture.length !== n || temperature.length !== n) {
      throw new Error(`WeatherField.adopt: length mismatch (want ${n})`);
    }
    this.state.moisture = moisture;
    this.state.temperature = temperature;
  }

  /** Force a condition (debug / admin override). */
  force(kind: WeatherKind, intensity: number): void {
    if (intensity < 0 || intensity > 1) {
      throw new Error("WeatherField: intensity must be in [0,1]");
    }
    this.forcedKind = kind;
    this.forcedIntensity = intensity;
  }
}
