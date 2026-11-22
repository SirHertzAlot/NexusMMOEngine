/**
 * Offline map render of a surveyed world and its opportunity report, for
 * reviews and comparisons: left panel = provinces (or landform classes on a
 * baseline world), right panel = terrain with rivers, deposits, settlement
 * pair, routes and the bridge. Hillshade is quantised into three bands (the
 * cel look the client uses). North up, x east.
 */

import { slopeDegrees } from "../grid-ops.js";
import { LAND } from "../hydrology.js";
import { ramp, type RGB } from "../png.js";
import type { Survey } from "../survey.js";
import type { OpportunityReport } from "./opportunities.js";
import { PROVINCE_KINDS, type ProvinceKind } from "./snapshot.js";

export const PROVINCE_COLOUR: Record<ProvinceKind, RGB> = {
  ocean: [40, 70, 120],
  platform: [176, 168, 120],
  craton: [150, 110, 160],
  orogen: [176, 82, 64],
  foreland: [214, 196, 110],
  rift: [70, 150, 150],
  arc: [200, 120, 40],
  suture: [120, 120, 140],
  transform: [120, 160, 90],
};

const LANDFORM: RGB[] = [[0, 0, 0], [150, 120, 110], [180, 160, 120], [90, 140, 110], [200, 170, 130], [150, 190, 120], [170, 180, 130]];

export function drawGeologyMap(s: Survey, report: OpportunityReport | null, title?: { geology: boolean }): { width: number; height: number; rgb: Uint8Array } {
  const { grid, height, water, river, spec } = s;
  const W = grid.width;
  const D = grid.depth;
  const width = W * 2 + 8;
  const rgb = new Uint8Array(width * D * 3).fill(255);
  const sea = spec.land.seaLevel;
  const put = (panel: number, u: number, v: number, c: RGB): void => {
    if (u < 0 || v < 0 || u >= W || v >= D) return;
    const o = (v * width + panel * (W + 8) + u) * 3;
    for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, Math.round(c[k])));
  };
  const slope = slopeDegrees(height, W, D, grid.cell);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const gx = u > 0 && u < W - 1 ? (height[i + 1] - height[i - 1]) / (2 * grid.cell) : 0;
      const gz = v > 0 && v < D - 1 ? (height[i + W] - height[i - W]) / (2 * grid.cell) : 0;
      const raw = 0.9 - 1.4 * (gx + gz);
      const band = raw < 0.6 ? 0.62 : raw < 1.0 ? 0.86 : 1.08; // cel bands
      const shade = water[i] === LAND ? band : 1;
      const lit = (c: RGB): RGB => c.map((x) => x * shade) as RGB;
      let left: RGB;
      if (water[i] !== LAND) left = [52, 92, 140];
      else if (s.geology) left = lit(PROVINCE_COLOUR[PROVINCE_KINDS[s.geology.kind[i]]]);
      else {
        const above = height[i] - sea;
        left = lit(LANDFORM[slope[i] > 25 || above > 220 ? 1 : above > 90 ? 2 : above < 20 ? 5 : 6]);
      }
      if (river[i]) left = [70, 120, 190];
      put(0, u, v, left);
      const above = height[i] - sea;
      const terrain: RGB =
        water[i] !== LAND
          ? ([46, 86, 134] as RGB)
          : river[i]
            ? ([70, 130, 200] as RGB)
            : lit(ramp(above / 520, [[118, 160, 84], [160, 176, 96], [176, 150, 104], [150, 132, 120], [236, 236, 240]]));
      put(1, u, v, terrain);
    }
  }
  // Province borders (thin dark lines) on the left panel.
  if (s.geology) {
    const p = s.geology.province;
    for (let v = 1; v < D; v++) for (let u = 1; u < W; u++) {
      const i = v * W + u;
      if (water[i] === LAND && (p[i] !== p[i - 1] || p[i] !== p[i - W])) put(0, u, v, [40, 34, 30]);
    }
  }
  const toUV = (x: number, z: number): [number, number] => [Math.round((x - grid.originX) / grid.cell), Math.round((z - grid.originZ) / grid.cell)];
  const dot = (panel: number, x: number, z: number, r: number, c: RGB): void => {
    const [cu, cv] = toUV(x, z);
    for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) if (du * du + dv * dv <= r * r) put(panel, cu + du, cv + dv, c);
  };
  const ring = (panel: number, x: number, z: number, r: number, c: RGB): void => {
    const [cu, cv] = toUV(x, z);
    for (let dv = -r - 2; dv <= r + 2; dv++) for (let du = -r - 2; du <= r + 2; du++) {
      const d = Math.sqrt(du * du + dv * dv);
      if (d >= r - 1 && d <= r + 1) put(panel, cu + du, cv + dv, c);
    }
  };
  const line = (panel: number, a: { x: number; z: number }, b: { x: number; z: number }, c: RGB, w: number): void => {
    const [u0, v0] = toUV(a.x, a.z);
    const [u1, v1] = toUV(b.x, b.z);
    const n = Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0), 1);
    for (let k = 0; k <= n; k++) {
      const u = Math.round(u0 + ((u1 - u0) * k) / n);
      const v = Math.round(v0 + ((v1 - v0) * k) / n);
      for (let dv = -w; dv <= w; dv++) for (let du = -w; du <= w; du++) put(panel, u + du, v + dv, c);
    }
  };
  if (report) {
    const colours: RGB[] = [[255, 230, 60], [255, 150, 40], [250, 120, 200], [180, 240, 255]];
    report.routes.forEach((r, k) => {
      for (let s2 = 1; s2 < r.points.length; s2++) for (const panel of [0, 1]) line(panel, r.points[s2 - 1], r.points[s2], colours[k % colours.length], k === 0 ? 1 : 0);
    });
    for (const d of report.deposits) for (const panel of [0, 1]) dot(panel, d.x, d.z, 3, d.resource === "ore" ? [200, 30, 30] : [20, 20, 20]);
    if (report.bridge) for (const panel of [0, 1]) line(panel, report.bridge.a, report.bridge.b, [255, 0, 255], 2);
    if (report.sites) for (const st of report.sites) for (const panel of [0, 1]) {
      ring(panel, st.x, st.z, 9, [255, 255, 255]);
      ring(panel, st.x, st.z, 7, [20, 20, 20]);
    }
  }
  void title;
  return { width, height: D, rgb };
}
