/**
 * Sun — how much sunlight each slope gets over a day, and the UV that
 * comes with it.
 *
 * The sun stands over the sea edge (`sunFrom`): high there at noon, low
 * toward the far edge — the world's latitude. Over the day it swings from
 * east to west (an equinox path, sampled a few times); each slope takes
 * the beam at the angle it faces it, ridges cast shadows, and the day's
 * mean is compared with flat open ground at the same latitude: 1 = as
 * sunny as flat ground, > 1 a slope facing the sun, < 1 a shaded one.
 *
 * UV intensity (a UV index) follows the sun's height, rises with
 * altitude (thinner air), is cut by cloud where it rains a lot, and is
 * boosted by snow and ice reflecting it.
 */

import type { CoarseGrid } from "./survey.js";
import { sampleBilinear } from "./grid-ops.js";
import { coastFrame } from "./landmass.js";
import type { Side, WorldSpec } from "./world-spec.js";

/** Hour angles sampled over the day, degrees from noon. */
const HOURS = [-75, -45, -15, 15, 45, 75];
/** Shadows are traced this far toward the sun, metres, in steps of 3 cells. */
const SHADOW_REACH_M = 600;

const SUNWARD: Record<Side, [number, number]> = {
  south: [0, 1],
  north: [0, -1],
  east: [1, 0],
  west: [-1, 0],
};

/** Noon sun elevation (degrees) at coast-frame t (0 far edge, 1 sea edge). */
function noonElevation(spec: WorldSpec, t: number): number {
  const C = spec.climate;
  const k = Math.min(1, Math.max(0, t));
  return C.sunNoonAtFarDeg + (C.sunNoonAtSeaDeg - C.sunNoonAtFarDeg) * k;
}

/** The day's sun positions at a latitude: unit vectors toward the sun (x east, y up, z south). */
function sunPath(spec: WorldSpec, noonDeg: number): Array<{ x: number; y: number; z: number; tanE: number }> {
  const [sx, sz] = SUNWARD[spec.climate.sunFrom];
  const [px, pz] = [-sz, sx]; // across the sunward direction
  const phi = ((90 - noonDeg) * Math.PI) / 180; // equinox: noon elevation = 90° - latitude
  const out: Array<{ x: number; y: number; z: number; tanE: number }> = [];
  for (const hour of HOURS) {
    const H = (hour * Math.PI) / 180;
    const sinE = Math.cos(phi) * Math.cos(H);
    if (sinE <= 0.02) continue;
    const cosE = Math.sqrt(1 - sinE * sinE);
    const sinA = Math.max(-1, Math.min(1, Math.sin(H) / cosE));
    const cosA = Math.sqrt(1 - sinA * sinA);
    const dx = cosA * sx + sinA * px;
    const dz = cosA * sz + sinA * pz;
    out.push({ x: cosE * dx, y: sinE, z: cosE * dz, tanE: sinE / cosE });
  }
  return out;
}

/**
 * The day's sunlight per cell: `sun` relative to flat open ground at the
 * same latitude (shadows included), and `flat`, that ground's mean sun
 * (the mean sine of the sun's elevation over the day).
 */
export function sunlight(spec: WorldSpec, grid: CoarseGrid, h: Float32Array): { sun: Float32Array; flat: Float32Array } {
  const W = grid.width;
  const D = grid.depth;
  const sun = new Float32Array(W * D);
  const flat = new Float32Array(W * D);
  let top = -Infinity;
  for (let i = 0; i < h.length; i++) top = Math.max(top, h[i]);
  const stepCells = 3;
  const steps = Math.ceil(SHADOW_REACH_M / (stepCells * grid.cell));
  // Latitude varies smoothly: cache the path per noon elevation (0.5° bins).
  const paths = new Map<number, ReturnType<typeof sunPath>>();
  for (let v = 0; v < D; v++) {
    const z = grid.originZ + v * grid.cell;
    for (let u = 0; u < W; u++) {
      const x = grid.originX + u * grid.cell;
      const i = v * W + u;
      const noon = Math.round(noonElevation(spec, coastFrame(spec, x, z).t) * 2) / 2;
      let path = paths.get(noon);
      if (!path) paths.set(noon, (path = sunPath(spec, noon)));
      const l = u > 0 ? i - 1 : i;
      const r = u < W - 1 ? i + 1 : i;
      const t = v > 0 ? i - W : i;
      const b = v < D - 1 ? i + W : i;
      const gx = (h[r] - h[l]) / (grid.cell * (r - l));
      const gz = (h[b] - h[t]) / (grid.cell * ((b - t) / W));
      const nl = Math.hypot(gx, 1, gz);
      let direct = 0;
      let open = 0;
      for (const s of path) {
        open += s.y;
        const facing = (-gx * s.x + s.y - gz * s.z) / nl;
        if (facing <= 0) continue;
        // Shadow: march toward the sun until the ray clears everything.
        const hx = s.x / Math.hypot(s.x, s.z);
        const hz = s.z / Math.hypot(s.x, s.z);
        let lit = true;
        for (let k = 1; k <= steps; k++) {
          const dist = k * stepCells * grid.cell;
          const ray = h[i] + dist * s.tanE;
          if (ray > top) break;
          const fu = u + hx * k * stepCells;
          const fv = v + hz * k * stepCells;
          if (fu < 0 || fv < 0 || fu > W - 1 || fv > D - 1) break;
          if (sampleBilinear(h, W, D, fu, fv) > ray + 0.5) {
            lit = false;
            break;
          }
        }
        if (lit) direct += facing;
      }
      flat[i] = open / HOURS.length;
      sun[i] = open > 0 ? direct / open : 0;
    }
  }
  return { sun, flat };
}

/** UV index per cell (see the module note); `snowy` marks snow- or ice-covered cells. */
export function uvIndex(
  spec: WorldSpec,
  grid: CoarseGrid,
  h: Float32Array,
  light: { sun: Float32Array; flat: Float32Array },
  rainMm: Float32Array,
  snowy: (i: number) => boolean,
): Float32Array {
  const U = spec.climate.uv;
  const sea = spec.land.seaLevel;
  const seaPath = sunPath(spec, noonElevation(spec, 1));
  const flatAtSea = seaPath.reduce((a, s) => a + s.y, 0) / HOURS.length;
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const latitude = light.flat[i] / flatAtSea;
    // Diffuse UV (about half) reaches every slope; the direct part follows the sun.
    const slope = 0.6 + 0.4 * Math.min(1.6, light.sun[i]);
    const altitude = 1 + (U.altitudeGainPerKm * Math.max(0, h[i] - sea)) / 1000;
    const cloud = 1 - U.cloudCut * Math.min(1, rainMm[i] / (2 * spec.climate.rainMm));
    const reflection = snowy(i) ? 1 + U.snowReflection : 1;
    out[i] = U.atSeaEdge * latitude * slope * altitude * cloud * reflection;
  }
  return out;
}
