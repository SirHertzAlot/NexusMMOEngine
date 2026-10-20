/**
 * preview-world: survey a world spec and draw it — no bake, nothing
 * written but the picture. For tuning a spec: change a number, look.
 *
 * Usage (from packages/engine-core, after `npm run build`):
 *   npm run preview:world -- [spec.json] [out.png] [--squares]
 *
 * Defaults: worlds/default.world.json -> world-preview.png. Four panels,
 * north up: biomes (hillshaded; rivers blue, range axes dotted, spawn
 * ringed red), yearly rainfall (brown dry → purple soaked), temperature
 * (white cold → red hot), and UV index (green low → violet extreme, the
 * UV-index colour scale). The wind arrow is top-left.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { GREEN_BIOMES, GREEN_MIN_CELLS, greenMask, greenSquares } from "./terrain/green.js";
import { LAND, surveyWorld, type Survey } from "./terrain/survey.js";
import { biomeShares, spawnPoint } from "./terrain/world-bake.js";
import { STRUCTURE_MARGIN_M } from "./procgen/habitat.js";
import { loadWorldSpec, windVector } from "./terrain/world-spec.js";

type RGB = [number, number, number];

/** Map colour per biome id; unknown biomes are grey. */
const BIOME_COLOUR: Record<string, RGB> = {
  sea: [38, 78, 128],
  lake: [60, 110, 170],
  glacier: [196, 226, 244],
  snow: [240, 244, 248],
  tundra: [150, 156, 128],
  volcanic: [70, 58, 56],
  mountains: [138, 128, 118],
  beach: [226, 210, 160],
  swamp: [78, 96, 62],
  desert: [214, 186, 128],
  rainforest: [30, 96, 44],
  forest: [56, 118, 56],
  plains: [132, 172, 88],
};

function ramp(t: number, stops: RGB[]): RGB {
  const k = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const a = Math.min(Math.floor(k), stops.length - 2);
  const f = k - a;
  return stops[a].map((x, j) => x + (stops[a + 1][j] - x) * f) as RGB;
}

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Biomes | rainfall | temperature | UV, side by side, as RGB. */
export function drawSurvey(s: Survey): { width: number; height: number; rgb: Uint8Array } {
  const { grid, height, rain, temperature, uv, biome, water, river, spec } = s;
  const PANELS = 4;
  const W = grid.width;
  const D = grid.depth;
  const width = W * PANELS;
  const rgb = new Uint8Array(width * D * 3);
  const put = (panel: number, u: number, v: number, c: RGB): void => {
    const o = (v * width + panel * W + u) * 3;
    for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, Math.round(c[k])));
  };
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const gx = u > 0 && u < W - 1 ? (height[i + 1] - height[i - 1]) / (2 * grid.cell) : 0;
      const gz = v > 0 && v < D - 1 ? (height[i + W] - height[i - W]) / (2 * grid.cell) : 0;
      const shade = water[i] === LAND ? Math.max(0.35, Math.min(1.35, 0.9 - 1.2 * (gx + gz))) : 1;
      const lit = (c: RGB): RGB => c.map((x) => x * shade) as RGB;
      const base = river[i] ? ([70, 120, 190] as RGB) : (BIOME_COLOUR[spec.biomes[biome[i]].id] ?? [128, 128, 128]);
      put(0, u, v, lit(base));
      const under: RGB = [20, 30, 50];
      put(1, u, v, water[i] !== LAND ? under : lit(ramp(rain[i] / 2500, [[150, 90, 40], [230, 210, 120], [90, 180, 90], [30, 90, 170], [60, 30, 140]])));
      put(2, u, v, water[i] !== LAND ? under : lit(ramp((temperature[i] + 10) / 35, [[250, 250, 255], [120, 160, 230], [120, 200, 120], [240, 200, 80], [220, 70, 40]])));
      put(3, u, v, water[i] !== LAND ? under : lit(ramp(uv[i] / 14, [[60, 150, 60], [230, 220, 60], [240, 140, 40], [210, 40, 40], [140, 60, 170]])));
    }
  }
  const ring = (x: number, z: number, r: number, c: RGB): void => {
    const cu = Math.round((x - grid.originX) / grid.cell);
    const cv = Math.round((z - grid.originZ) / grid.cell);
    for (let dv = -r - 1; dv <= r + 1; dv++) {
      for (let du = -r - 1; du <= r + 1; du++) {
        if (Math.abs(Math.hypot(du, dv) - r) > 0.8) continue;
        const u = cu + du;
        const v = cv + dv;
        if (u >= 0 && v >= 0 && u < W && v < D) for (let p = 0; p < PANELS; p++) put(p, u, v, c);
      }
    }
  };
  const sp = spawnPoint(spec, s);
  ring(sp.x, sp.z, 5, [255, 30, 30]);
  for (const r of s.ranges) for (const p of r.points) ring(p.x, p.z, 1, [0, 0, 0]);
  const wind = windVector(spec.climate.wind);
  for (let k = 0; k < 40; k++) {
    for (let p = 0; p < PANELS; p++) put(p, 30 + Math.round(wind.x * k), 30 + Math.round(wind.z * k), [255, 255, 255]);
  }
  return { width, height: D, rgb };
}

/** Dry footing a settlement needs over the sea: the spawner's structure margin plus the world's detail noise. */
const GREEN_FLOOR_M = (spec: { detailAmplitude: number }): number => STRUCTURE_MARGIN_M + spec.detailAmplitude;

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const specFile = path.resolve(args[0] ?? path.join(here, "../../worlds/default.world.json"));
  const out = path.resolve(args[1] ?? "world-preview.png");
  const spec = loadWorldSpec(specFile);
  const t0 = performance.now();
  const survey = surveyWorld(spec);
  const { width, height, rgb } = drawSurvey(survey);
  if (process.argv.includes("--squares")) {
    const squares = greenSquares(greenMask(survey, spec.biomes.map((b) => b.id), GREEN_BIOMES, GREEN_FLOOR_M(spec)), survey.grid, GREEN_MIN_CELLS);
    for (const q of squares) {
      for (let k = 0; k < q.cells; k++) {
        for (const [u, v] of [[q.cx + k, q.cz], [q.cx + k, q.cz + q.cells - 1], [q.cx, q.cz + k], [q.cx + q.cells - 1, q.cz + k]] as const) rgb.fill(255, (v * width + u) * 3, (v * width + u) * 3 + 3);
      }
    }
    const file = out.replace(/\.png$/, "") + ".squares.json";
    fs.writeFileSync(file, JSON.stringify({ cell: survey.grid.cell, originX: survey.grid.originX, originZ: survey.grid.originZ, squares }, null, 1));
    console.log(`[preview] ${squares.length} green square(s), largest ${squares[0] ? `${squares[0].cells} cells (${squares[0].cells * survey.grid.cell} m) at x ${squares[0].x0}..${squares[0].x1}, z ${squares[0].z0}..${squares[0].z1}` : "none"}; wrote ${file}`);
  }
  fs.writeFileSync(out, png(width, height, rgb));
  const sp = spawnPoint(spec, survey);
  console.log(`[preview] ${path.basename(specFile)}: survey ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(
    `[preview] land ${(100 * survey.stats.landFraction).toFixed(1)}%, ${survey.ranges.length} mountain range(s), ` +
      `${survey.stats.riverCells} river cells, ${survey.stats.lakeCells} lake cells; spawn (${sp.x}, ${sp.z}) in ${sp.biome}`,
  );
  console.log(`[preview] biomes (% of the world): ${Object.entries(biomeShares(survey)).map(([id, p]) => `${id} ${p}`).join(", ")}`);
  console.log(
    `[preview] glaciers: ${survey.stats.glacierCells} ice cells, ${survey.stats.glacierSnouts} snouts, ` +
      `${(survey.stats.meltwaterM3 / 1e6).toFixed(2)} million m³ of meltwater a year`,
  );
  console.log(`[preview] wrote ${out} (biomes | rainfall | temperature | UV)`);
}

main();
