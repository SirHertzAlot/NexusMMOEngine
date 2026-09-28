/**
 * Glaciers — ice where it is cold enough and enough snow falls, flowing
 * downhill until it melts, carving as it goes.
 *
 * Each pass routes ice over the land's drainage (highest cells first):
 * a cell at or below `formBelowC` with at least `minSnowMm` of snow adds
 * it to the ice (drier cold ground stays bare — tundra); ice
 * crossing warmer ground loses meltwater in proportion to how warm it is,
 * how much sun the slope gets (shaded ice lasts), and how wide the
 * glacier is (width grows with the ice it carries), and
 * the glacier ends where the ice runs out — its snout. Ice reaching the
 * sea calves into it. Along the way it grinds a wide, round-bottomed
 * (U-shaped) valley, deeper under more ice; at the snout it drops a
 * moraine ridge (lakes pool behind them). The meltwater feeds the rivers.
 *
 * Units: ice and meltwater in m³ of water a year; heights in metres.
 */

import type { CoarseGrid } from "./survey.js";
import { drainage, fillDepressions } from "./hydrology.js";
import type { WorldSpec } from "./world-spec.js";

export interface GlacierResult {
  /** 1 where ice lies (glacier or ice cap). */
  ice: Uint8Array;
  /** Meltwater released per cell, m³/yr. */
  melt: Float32Array;
  /** Glacier snouts (where ice runs out on land). */
  snouts: number;
  /** Deepest glacial cut, metres. */
  deepestCutM: number;
}

/** Glacier width for an ice flux (m³/yr): wider under more ice. */
function glacierWidth(flux: number, cell: number): number {
  return Math.min(400, Math.max(2 * cell, 0.25 * Math.sqrt(flux)));
}

export function glaciate(
  spec: WorldSpec,
  grid: CoarseGrid,
  h: Float32Array,
  tempC: Float32Array,
  precipMm: Float32Array,
  isSea: (i: number) => boolean,
  sun?: Float32Array,
): GlacierResult {
  const G = spec.glaciers;
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const area = grid.cell * grid.cell;
  const before = Float32Array.from(h);
  const flux = new Float64Array(N);
  /** Largest ice flow upstream of each cell: what a glacier carries to its snout. */
  const peak = new Float64Array(N);
  let ice = new Uint8Array(N);
  let melt = new Float32Array(N);
  let snouts = 0;
  /** Moraine already dropped: later passes top it up to the tallest, never stack. */
  const deposited = new Float32Array(N);

  for (let pass = 0; pass < Math.max(1, G.passes); pass++) {
    const flow = drainage(fillDepressions(h, grid), grid);
    flux.fill(0);
    peak.fill(0);
    ice = new Uint8Array(N);
    melt = new Float32Array(N);
    snouts = 0;
    const carve = new Float32Array(N);
    const moraine = new Float32Array(N);
    const disc = (target: Float32Array, cu: number, cv: number, radius: number, depth: number): void => {
      const reach = Math.ceil(radius / grid.cell);
      for (let dv = -reach; dv <= reach; dv++) {
        for (let du = -reach; du <= reach; du++) {
          const u = cu + du;
          const v = cv + dv;
          if (u < 0 || v < 0 || u >= W || v >= D) continue;
          const r = (Math.hypot(du, dv) * grid.cell) / radius;
          if (r >= 1) continue;
          const j = v * W + u;
          const d = depth * (1 - r * r);
          if (d > target[j]) target[j] = d;
        }
      }
    };

    for (const i of flow.order) {
      if (isSea(i)) {
        flux[i] = 0; // calved into the sea
        continue;
      }
      const incoming = flux[i];
      const snow = tempC[i] <= G.formBelowC && precipMm[i] >= G.minSnowMm ? (precipMm[i] / 1000) * area : 0;
      let q = incoming + snow;
      if (q <= 0) continue;
      ice[i] = 1;
      peak[i] = Math.max(peak[i], q);
      const width = glacierWidth(q, grid.cell);
      // Metres of ice a year: warmth melts it, sunshine speeds that up.
      const sunny = sun ? Math.max(0.1, 1 + G.sunMelt * (sun[i] - 1)) : 1;
      const ablation = G.meltRate * sunny * Math.max(0, tempC[i] - G.meltAboveC);
      const melted = Math.min(q, ablation * width * grid.cell);
      melt[i] += melted;
      q -= melted;
      const r = flow.receiver[i];
      const u = i % W;
      const v = (i - u) / W;
      if (q <= 0) {
        // The snout: what the ice carried down piles up just beyond it (a
        // terminal moraine).
        if (incoming > 0) {
          snouts++;
          const at = r >= 0 ? r : i;
          const au = at % W;
          disc(moraine, au, (at - au) / W, Math.max(width / 2, 2.5 * grid.cell), Math.min(G.moraineM, G.moraineM * Math.sqrt(peak[i] / 1e5)));
        }
        continue;
      }
      if (r >= 0) {
        flux[r] += q;
        peak[r] = Math.max(peak[r], peak[i]);
        const slope = Math.max(0, h[i] - h[r]) / flow.distance[i];
        // Ice grinds even on gentle slopes (sliding), more under more ice.
        const cut = Math.min(G.maxCutPerPassM, G.strength * Math.sqrt(q) * (0.1 + slope));
        disc(carve, u, v, width / 2, cut);
      }
    }
    for (let i = 0; i < N; i++) {
      h[i] -= carve[i];
      if (!ice[i] && moraine[i] > deposited[i]) {
        h[i] += moraine[i] - deposited[i];
        deposited[i] = moraine[i];
      }
    }
  }
  let deepestCutM = 0;
  for (let i = 0; i < N; i++) deepestCutM = Math.max(deepestCutM, before[i] - h[i]);
  return { ice, melt, snouts, deepestCutM };
}
