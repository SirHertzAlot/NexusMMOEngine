/**
 * Plains and terraces: the land a town can stand on.
 *
 * The erosion and surface passes leave low ground as a continuous ramp from
 * the shore to the hills, rolling by several metres, with nowhere flat for
 * a few hundred metres at a time. This pass (off unless the spec opts in)
 * re-cuts that ground, deterministically and on typed arrays:
 *
 *  - Terraces: the climb is smoothed, then remapped through a monotone
 *    curve of steps: a long tread that keeps `tilt` of the land's climb
 *    (it drains) and a short riser that takes the rest. The step height
 *    follows the local climb, so a tread is `treadWidthM` wide on a gentle
 *    slope and on a steeper one alike (within the step bounds). The map is
 *    strictly increasing, so water still runs downhill: no new sinks.
 *  - Ramps: low-frequency noise dissolves the terracing back into the plain
 *    slope in places, so every riser has somewhere to walk up.
 *  - Rolling plains: a few decimetres of long-wavelength undulation.
 *  - Floodplain and shelf: near rivers and the water's edge the ground is
 *    blended toward a surface graded gently up from the water, so valleys
 *    and coasts are flat rather than a ramp. Valley walls keep their shape.
 *  - Mountain safety: everything fades out between `fadeFromM` and `fadeToM`
 *    above the sea and on steep ground; above that nothing changes.
 *
 * Runs after the biome surface pass and before the river beds are carved,
 * reading the land as it was before the surface noise (`base`), so the
 * plains are cut from the smooth land, not from the rolling noise.
 */

import type { CoarseGrid } from "./survey.js";
import { boxBlur, distanceTo, smoothstep } from "./grid-ops.js";
import { fillDepressions, LAND } from "./hydrology.js";
import type { WorldSpec } from "./world-spec.js";

/** Dry land never ends up closer than this to the sea (the survey keeps the same margin). */
const SHORE_M = 0.3;

export type PlainsSpec = WorldSpec["plains"];

/**
 * Smooth datum for the flats: the average of `value` over the source cells
 * within about `radius` cells of each cell (normalised, so it follows the
 * river bed or the water level nearby without the seams a nearest-source
 * lookup leaves where two sources meet). NaN where no source is near.
 */
function datum(W: number, D: number, radius: number, isSource: (i: number) => boolean, value: (i: number) => number): Float32Array {
  const num = new Float32Array(W * D);
  const den = new Float32Array(W * D);
  for (let i = 0; i < W * D; i++) {
    if (isSource(i)) {
      num[i] = value(i);
      den[i] = 1;
    }
  }
  const n = boxBlur(num, W, D, radius);
  const d = boxBlur(den, W, D, radius);
  for (let i = 0; i < W * D; i++) n[i] = d[i] > 1e-4 ? n[i] / d[i] : Number.NaN;
  return n;
}

/**
 * Re-cut the low ground of `h` in place. `base` is the land before the
 * biome surface pass; `water` the survey's water map (LAND / SEA / LAKE)
 * with `waterLevel` on its water cells; `und` and `ramps` are noise fields
 * (-1..1) for the undulation and the ramp gaps. Does nothing when the
 * spec leaves the pass off.
 */
export function applyPlains(
  P: PlainsSpec,
  sea: number,
  grid: CoarseGrid,
  h: Float32Array,
  base: Float32Array,
  water: Uint8Array,
  waterLevel: Float32Array,
  river: Uint8Array,
  ice: Uint8Array | undefined,
  und: Float32Array,
  ramps: Float32Array,
): void {
  if (!P.enabled) return;
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const cell = grid.cell;
  const T = P.treads;
  const orig = Float32Array.from(h);

  // The smooth land the plains are cut from: base heights averaged over the low, dry land only (so
  // neither the sea floor nor the hills pull it).
  const low = new Float32Array(N);
  const weighted = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i] === LAND && base[i] - sea < P.fadeToM) {
      low[i] = 1;
      weighted[i] = base[i];
    }
  }
  const radius = P.smoothM / cell;
  const num = boxBlur(weighted, W, D, radius);
  const den = boxBlur(low, W, D, radius);
  const hs = new Float32Array(N);
  for (let i = 0; i < N; i++) hs[i] = den[i] > 1e-4 ? base[i] + smoothstep(0.02, 0.25, den[i]) * (num[i] / den[i] - base[i]) : base[i]; // little low land around: keep the cell as it is

  // How much of the pass applies: not on water or ice, and fading out with height and on steep ground.
  // The steep-ground cut-off is blurred so the terraces meet the hills over a few hundred metres, not a step.
  const slope = new Float32Array(N);
  const gentle = new Float32Array(N);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const u0 = Math.max(0, u - 1);
      const u1 = Math.min(W - 1, u + 1);
      const v0 = Math.max(0, v - 1);
      const v1 = Math.min(D - 1, v + 1);
      slope[i] = Math.hypot((hs[v * W + u1] - hs[v * W + u0]) / (cell * (u1 - u0)), (hs[v1 * W + u] - hs[v0 * W + u]) / (cell * (v1 - v0)));
      if (low[i]) gentle[i] = 1 - smoothstep(P.slopeFromPct / 100, P.slopeToPct / 100, slope[i]);
    }
  }
  const gNum = boxBlur(gentle, W, D, radius / 2);
  const gDen = boxBlur(low, W, D, radius / 2);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i] !== LAND || ice?.[i]) continue;
    const own = 1 - smoothstep(P.fadeFromM, P.fadeToM, h[i] - sea);
    w[i] = own * (gDen[i] > 1e-4 ? (gNum[i] / gDen[i]) * smoothstep(0.02, 0.25, gDen[i]) : 0);
  }

  // Step height by altitude: tall enough that a tread is treadWidthM wide at the typical climb there.
  const top = Math.ceil(P.fadeToM) + 1;
  const bins = top + Math.ceil(T.stepMaxM) + 3;
  const gSum = new Float64Array(bins);
  const gCount = new Float64Array(bins);
  let gAll = 0;
  let nAll = 0;
  for (let i = 0; i < N; i++) {
    if (w[i] < 0.5) continue;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(hs[i] - sea)));
    gSum[b] += slope[i];
    gCount[b]++;
    gAll += slope[i];
    nAll++;
  }
  const gGlobal = nAll > 0 ? gAll / nAll : 0.02;
  const phi = new Float64Array(bins + 1);
  const stepAt = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, b - 3); k <= Math.min(top, b + 3); k++) {
      s += gSum[k];
      c += gCount[k];
    }
    const g = c >= 10 ? s / c : gGlobal;
    stepAt[b] = Math.min(T.stepMaxM, Math.max(T.stepMinM, (T.treadWidthM * g) / T.treadShare));
    phi[b + 1] = phi[b] + 1 / stepAt[b];
  }
  // Height at which each whole step number begins.
  const steps = Math.floor(phi[bins]) + 1;
  const level = new Float64Array(steps + 1);
  for (let k = 0, b = 0; k <= steps; k++) {
    while (b < bins - 1 && phi[b + 1] <= k) b++;
    level[k] = b + (k - phi[b]) * stepAt[b];
  }

  // Ramp gaps: where the ramp noise is among its top `rampShare` of the plains, the steps dissolve.
  let rampAt = Infinity;
  if (T.rampShare > 0) {
    const hist = new Float64Array(64);
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (w[i] < 0.5) continue;
      hist[Math.min(63, Math.max(0, Math.floor(((ramps[i] + 1) / 2) * 64)))]++;
      total++;
    }
    let acc = 0;
    rampAt = 1;
    for (let b = 63; b >= 0; b--) {
      acc += hist[b];
      if (acc >= T.rampShare * total) {
        rampAt = (b / 64) * 2 - 1;
        break;
      }
    }
  }

  // Flats along rivers and the water's edge: distance to them and a smooth datum to grade up from.
  const isRiver = (i: number): boolean => river[i] === 1 && water[i] === LAND;
  const isWater = (i: number): boolean => water[i] !== LAND;
  const bedDist = P.floodplain.widthM > 0 ? distanceTo(W, D, cell, isRiver) : undefined;
  const bedLevel = bedDist ? datum(W, D, P.floodplain.widthM / cell / 2, isRiver, (i) => hs[i]) : undefined;
  const shoreDist = P.coast.widthM > 0 ? distanceTo(W, D, cell, isWater) : undefined;
  const shoreLevel = shoreDist ? datum(W, D, P.coast.widthM / cell / 2, isWater, (i) => (Number.isFinite(waterLevel[i]) ? waterLevel[i] : sea)) : undefined;

  const tf = T.treadShare;
  // The steepest a riser gets is the climb times this (the curve's steepest point).
  const riserGain = T.tilt + (1.5 * (1 - T.tilt)) / (1 - tf);
  const maxRiser = Math.tan((T.maxRiserDeg * Math.PI) / 180);
  // Terraced target per cell, and (apart) what the river and shore flats add to it. The flats' share is blurred
  // before it is applied: a graded surface from the water has a crease where two shores' distances meet, which
  // would show as a line across the land.
  const target = new Float32Array(N);
  const flat = new Float32Array(N); // flats' pull on the target, metres
  const hold = new Float32Array(N); // how firmly the flats hold the cell, 0..1
  for (let i = 0; i < N; i++) {
    if (w[i] <= 0) continue;
    const a = Math.max(0, hs[i] - sea);
    const b = Math.min(bins - 1, Math.floor(a));
    const p = phi[b] + (a - b) / stepAt[b];
    const k = Math.min(steps - 1, Math.floor(p));
    const f = p - k;
    const terraced = sea + P.coast.marginM + level[k] + (level[k + 1] - level[k]) * (T.tilt * f + (1 - T.tilt) * smoothstep(tf, 1, f));
    const ramp = T.rampShare > 0 ? smoothstep(rampAt - 0.1, rampAt + 0.1, ramps[i]) : 0;
    const strength = Math.min(1, maxRiser / Math.max(1e-9, riserGain * slope[i]));
    let t = hs[i] + (1 - ramp) * strength * (terraced - hs[i]);
    target[i] = t;
    if (bedDist && bedLevel) {
      const d = bedDist[i];
      if (d < P.floodplain.widthM && Number.isFinite(bedLevel[i])) {
        const F = bedLevel[i] + P.floodplain.gradient * d;
        const k2 = (1 - smoothstep(0.5 * P.floodplain.widthM, P.floodplain.widthM, d)) * (1 - smoothstep(0.5 * P.floodplain.riseM, P.floodplain.riseM, Math.abs(t - F)));
        t += k2 * (F - t);
        flat[i] += k2 * (F - target[i]);
        hold[i] = Math.max(hold[i], k2);
      }
    }
    if (shoreDist && shoreLevel) {
      const d = shoreDist[i];
      if (d < P.coast.widthM && Number.isFinite(shoreLevel[i])) {
        const F = shoreLevel[i] + P.coast.marginM + P.coast.gradient * d;
        const k2 = (1 - smoothstep(0.5 * P.coast.widthM, P.coast.widthM, d)) * (1 - smoothstep(0.5 * P.coast.riseM, P.coast.riseM, Math.abs(t - F)));
        flat[i] += k2 * (F - t);
        hold[i] = Math.max(hold[i], k2);
      }
    }
  }
  const flatSoft = boxBlur(flat, W, D, 5);
  const holdSoft = boxBlur(hold, W, D, 5);
  for (let i = 0; i < N; i++) {
    if (w[i] <= 0) continue;
    const t = target[i] + flatSoft[i] + (1 - holdSoft[i]) * P.undulationM * und[i];
    h[i] += w[i] * (t - h[i]);
    if (h[i] < sea + SHORE_M && orig[i] >= sea + SHORE_M) h[i] = sea + SHORE_M;
  }

  // No new sinks: a hollow the pass opened (the undulation, a tread's edge) fills to its spill level, so water
  // still runs to the sea. Hollows that were already there (lakes, dry basins) are left as they were.
  const was = fillDepressions(orig, grid);
  const now = fillDepressions(h, grid);
  for (let i = 0; i < N; i++) {
    if (water[i] === LAND && now[i] - h[i] > 0 && was[i] - orig[i] <= 0.05) h[i] = now[i];
  }
}
