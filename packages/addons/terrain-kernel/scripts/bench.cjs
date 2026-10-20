// Full-scale benchmark: the survey's erosion sequence
// (terrain/survey.ts) on a default-world-size grid, JS vs kernel.
//
// Sequence mirrors survey.ts with default.world.json budgets:
//   thermal(15) -> fluvial(12, 0.004) -> droplet(150000, 0.35) -> thermal(15)
// rainShare plays the role of `share`; seaLevel = 0.
//
// Usage: bash scripts/build-jsref.sh && node scripts/bench.cjs
// (takes minutes on the JS droplet leg — that IS the headline.)

"use strict";

const { performance } = require("node:perf_hooks");
const path = require("node:path");
const fs = require("node:fs");

const addon = require("../index.js");
const jsrefDir = path.join(__dirname, "..", "test", "jsref");
if (!fs.existsSync(path.join(jsrefDir, "erosion.js"))) {
  console.error("run `bash scripts/build-jsref.sh` first");
  process.exit(1);
}
const jsErosion = require("../test/jsref/erosion.js");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fingerprint(arr) {
  const u32 = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u32.length; i++) {
    h ^= u32[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Default world: 250x250 chunks @ 8m coarse cells -> ~506x506 survey grid.
const W = 506, D = 506, CELL = 8, SEED = 1234;
const grid = { width: W, depth: D, cell: CELL };

function makeHeight() {
  // Deterministic rolling terrain with real relief (not white noise:
  // erosion must have slopes to work on).
  const h = new Float32Array(W * D);
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0;
    return ((s >>> 0) % 10000) / 10000;
  };
  const ridges = [];
  for (let i = 0; i < 40; i++)
    ridges.push([rnd() * W, rnd() * D, 150 + rnd() * 500, 20 + rnd() * 60, rnd() * Math.PI]);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      let z = 120 * Math.sin(u * 0.02) * Math.cos(v * 0.017) - 40;
      for (const [ru, rv, rh, rw, ra] of ridges) {
        const dx = u - ru, dz = v - rv;
        const along = dx * Math.cos(ra) + dz * Math.sin(ra);
        const across = -dx * Math.sin(ra) + dz * Math.cos(ra);
        z += rh * Math.exp(-(across * across) / (2 * rw * rw)) * Math.exp(-(along * along) / (2 * (rw * 6) ** 2));
      }
      h[v * W + u] = z;
    }
  }
  return h;
}

function makeRain() {
  const r = new Float32Array(W * D);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++)
      r[v * W + u] = Math.max(0, 0.6 + 0.4 * Math.sin(u * 0.013 + 1) * Math.cos(v * 0.011));
  return r;
}

function runJs(h, rain) {
  const t = {};
  let t0 = performance.now();
  jsErosion.thermalErosion(h, grid, 38, 15);
  t.thermal1 = performance.now() - t0;
  t0 = performance.now();
  const deepest = jsErosion.fluvialErosion(h, grid, 0, rain, 12, 0.004);
  t.fluvial = performance.now() - t0;
  t0 = performance.now();
  const stats = jsErosion.dropletErosion(h, grid, 0, rain, 150000, 0.35, mulberry32(SEED ^ 0xe20d));
  t.droplet = performance.now() - t0;
  t0 = performance.now();
  jsErosion.thermalErosion(h, grid, 38, 15);
  t.thermal2 = performance.now() - t0;
  return { t, deepest, stats, fp: fingerprint(h) };
}

function runKernel(h, rain) {
  const t = {};
  let t0 = performance.now();
  addon.thermalErode(h, W, D, CELL, 38, 15);
  t.thermal1 = performance.now() - t0;
  t0 = performance.now();
  const deepest = addon.fluvialErode(h, W, D, CELL, 0, rain, 12, 0.004);
  t.fluvial = performance.now() - t0;
  t0 = performance.now();
  const stats = addon.dropletErode(h, W, D, CELL, 0, rain, 150000, 0.35, BigInt(SEED));
  t.droplet = performance.now() - t0;
  t0 = performance.now();
  addon.thermalErode(h, W, D, CELL, 38, 15);
  t.thermal2 = performance.now() - t0;
  return { t, deepest, stats, fp: fingerprint(h) };
}

console.log(`grid ${W}x${D} (${((W * D) / 1e6).toFixed(2)}M cells), cell ${CELL}m`);
const rain = makeRain();
console.log("--- JS reference ---");
const js = runJs(makeHeight(), rain);
console.log("--- kernel ---");
const k = runKernel(makeHeight(), rain);
console.log("--- results ---");
for (const leg of ["thermal1", "fluvial", "droplet", "thermal2"]) {
  const tj = js.t[leg], tk = k.t[leg];
  console.log(
    `${leg}: js=${(tj / 1000).toFixed(1)}s kernel=${(tk / 1000).toFixed(1)}s speedup=${(tj / tk).toFixed(2)}x`,
  );
}
const totalJs = Object.values(js.t).reduce((a, b) => a + b, 0);
const totalK = Object.values(k.t).reduce((a, b) => a + b, 0);
console.log(`total: js=${(totalJs / 1000).toFixed(1)}s kernel=${(totalK / 1000).toFixed(1)}s speedup=${(totalJs / totalK).toFixed(2)}x`);
console.log(`fingerprint js=${js.fp} kernel=${k.fp} ${js.fp === k.fp ? "IDENTICAL" : "MISMATCH"}`);
console.log(`deepestCut js=${js.deepest.toFixed(4)} kernel=${k.deepest.toFixed(4)}`);
console.log(`droplet meanM js=${js.stats.meanM.toFixed(4)} kernel=${k.stats.meanM.toFixed(4)}`);
console.log(`droplet maxM js=${js.stats.maxM.toFixed(4)} kernel=${k.stats.maxM.toFixed(4)}`);
if (js.fp !== k.fp) process.exitCode = 1;
