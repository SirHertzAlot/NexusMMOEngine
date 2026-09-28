/**
 * Climate — temperature and rainfall over the landform.
 *
 * Temperature: warmest on the sea edge at sea level, cooling toward the
 * far land edge and with height (an exaggerated lapse rate, so a 400 m
 * range can hold snow).
 *
 * Rainfall: the prevailing wind is marched across the grid from upwind.
 * Over water the air takes up moisture; over land it rains a little all
 * the time (drying the air over `dryDistance`) and much more where the
 * wind is pushed uphill (orographic lift), and part of what falls
 * evaporates back into it. Windward slopes get soaked, and the air that
 * crosses a range is spent — the rain shadow behind it is where deserts
 * form.
 */

import type { CoarseGrid } from "./survey.js";
import { boxBlur } from "./grid-ops.js";
import { coastFrame } from "./landmass.js";
import { windVector, type WorldSpec } from "./world-spec.js";

/** Mean temperature per cell, °C. */
export function temperature(spec: WorldSpec, grid: CoarseGrid, h: Float32Array): Float32Array {
  const C = spec.climate;
  const sea = spec.land.seaLevel;
  const W = grid.width;
  const out = new Float32Array(h.length);
  for (let v = 0; v < grid.depth; v++) {
    const z = grid.originZ + v * grid.cell;
    for (let u = 0; u < W; u++) {
      const x = grid.originX + u * grid.cell;
      const i = v * W + u;
      const t = Math.min(1, Math.max(0, coastFrame(spec, x, z).t));
      out[i] = C.seaTempC - C.inlandCoolingC * (1 - t) - (C.lapseCPerKm * Math.max(0, h[i] - sea)) / 1000;
    }
  }
  return out;
}

/** Air picks up moisture over this much open water, metres. */
const SEA_RECHARGE_M = 250;

/**
 * Yearly rainfall (mm) and the wind's humidity (0..1) per cell. `water`
 * marks cells that feed the wind moisture (sea and lakes).
 */
export function rainfall(
  spec: WorldSpec,
  grid: CoarseGrid,
  h: Float32Array,
  water: (i: number) => boolean,
): { rainMm: Float32Array; humidity: Float32Array } {
  const C = spec.climate;
  const W = grid.width;
  const D = grid.depth;
  const wind = windVector(C.wind);
  // Two cells per step: the upwind sample's four corners then always lie
  // strictly upwind, so they are final when this cell is computed.
  const step = 2 * grid.cell;
  const bx = (wind.x * step) / grid.cell;
  const bz = (wind.z * step) / grid.cell;
  const flatFraction = 1 - Math.exp(-step / C.dryDistance);
  const recharge = 1 - Math.exp(-step / SEA_RECHARGE_M);

  const order = Uint32Array.from({ length: W * D }, (_, i) => i);
  const key = new Float64Array(W * D);
  for (let i = 0; i < W * D; i++) key[i] = (i % W) * wind.x + Math.floor(i / W) * wind.z;
  order.sort((a, b) => key[a] - key[b] || a - b);

  const q = new Float32Array(W * D);
  const rain = new Float32Array(W * D);
  const bilinear = (f: Float32Array, fu: number, fv: number): number => {
    const u = Math.min(W - 2, Math.floor(fu));
    const v = Math.min(D - 2, Math.floor(fv));
    const tu = fu - u;
    const tv = fv - v;
    const i = v * W + u;
    return (f[i] * (1 - tu) + f[i + 1] * tu) * (1 - tv) + (f[i + W] * (1 - tu) + f[i + W + 1] * tu) * tv;
  };

  for (const i of order) {
    const u = i % W;
    const v = (i - u) / W;
    const fu = u - bx;
    const fv = v - bz;
    let qIn: number;
    let hBack: number;
    if (fu < 0 || fv < 0 || fu > W - 1 || fv > D - 1) {
      // Air blowing in over the world's edge: sea air is saturated, land air
      // arrives with `inlandHumidity`.
      const e = Math.min(D - 1, Math.max(0, Math.round(fv))) * W + Math.min(W - 1, Math.max(0, Math.round(fu)));
      qIn = water(e) ? 1 : C.inlandHumidity;
      hBack = h[e];
    } else {
      qIn = bilinear(q, fu, fv);
      hBack = bilinear(h, fu, fv);
    }
    if (water(i)) {
      q[i] = qIn + (1 - qIn) * recharge;
      rain[i] = C.rainMm * qIn;
      continue;
    }
    const climb = Math.max(0, h[i] - hBack);
    const fraction = 1 - Math.exp(-(step / C.dryDistance + C.orographic * climb));
    const fall = qIn * fraction;
    q[i] = qIn - fall * (1 - C.recycling);
    rain[i] = (C.rainMm * fall) / flatFraction;
  }
  // Wind lines are independent: blur across them so a range's end doesn't
  // cut a knife-edge shadow.
  return { rainMm: boxBlur(rain, W, D, 40 / grid.cell), humidity: q };
}
