"use strict";
// P4 acceptance: the C++ erosion ports are bit-identical to the JS
// reference (the ACTUAL terrain/erosion.ts, compiled by
// scripts/build-jsref.sh — not a reimplementation) on fixed seeds,
// and faster (benchmark gate: improvement or neutral, never regression).
//
// Run: bash scripts/build-jsref.sh && node --test test/parity.test.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const fs = require("node:fs");

const addon = require("../index.js");

const jsrefDir = path.join(__dirname, "jsref");
if (!fs.existsSync(path.join(jsrefDir, "erosion.js"))) {
  console.error(
    "missing test/jsref/erosion.js — run `bash scripts/build-jsref.sh` first",
  );
  process.exit(1);
}
const jsErosion = require("./jsref/erosion.js");
const jsHydro = require("./jsref/hydrology.js");

// mulberry32 verbatim from packages/engine-core/src/terrain/survey.ts
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

function synthHeight(W, D, seed) {
  const h = new Float32Array(W * D);
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0;
    return ((s >>> 0) % 1000) / 1000;
  };
  const bumps = [];
  for (let i = 0; i < 10; i++)
    bumps.push([rnd() * W, rnd() * D, 40 + rnd() * 160, 6 + rnd() * 24]);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      let z =
        60 * Math.sin(u * 0.11) * Math.cos(v * 0.07) +
        25 * Math.sin(u * 0.031 + 1.7) * Math.sin(v * 0.043 + 0.4);
      for (const [bu, bv, bh, br] of bumps) {
        const d2 = (u - bu) ** 2 + (v - bv) ** 2;
        z += bh * Math.exp(-d2 / (2 * br * br));
      }
      h[v * W + u] = z - 30;
    }
  }
  return h;
}

function rainField(W, D) {
  const r = new Float32Array(W * D);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++)
      r[v * W + u] = 0.5 + 0.5 * Math.sin(u * 0.05) * Math.cos(v * 0.09);
  return r;
}

const grid = (W, D, cell) => ({ width: W, depth: D, cell });

function bench(label, jsFn, kFn) {
  const t0 = performance.now();
  const jsOut = jsFn();
  const tJs = performance.now() - t0;
  const t1 = performance.now();
  const kOut = kFn();
  const tK = performance.now() - t1;
  const speedup = tJs / tK;
  console.log(
    `  bench ${label}: js=${tJs.toFixed(1)}ms kernel=${tK.toFixed(1)}ms speedup=${speedup.toFixed(2)}x`,
  );
  return { jsOut, kOut, speedup };
}

describe("P4 parity: C++ vs JS reference (bit-identical)", () => {
  const W = 64, D = 48, cell = 8, SEED = 1234;

  test("thermalErosion", () => {
    const { kOut, speedup } = bench(
      "thermal/6 passes",
      () => {
        const h = synthHeight(W, D, 5);
        jsErosion.thermalErosion(h, grid(W, D, cell), 38, 6);
        return h;
      },
      () => {
        const h = synthHeight(W, D, 5);
        addon.thermalErode(h, W, D, cell, 38, 6);
        return h;
      },
    );
    const hJs = synthHeight(W, D, 5);
    jsErosion.thermalErosion(hJs, grid(W, D, cell), 38, 6);
    assert.equal(fingerprint(kOut), fingerprint(hJs), "thermal bit-identical");
    assert.ok(speedup >= 1, "benchmark gate: no regression");
  });

  test("fluvialErosion", () => {
    const rain = rainField(W, D);
    const hJs = synthHeight(W, D, 6);
    const deepestJs = jsErosion.fluvialErosion(hJs, grid(W, D, cell), 0, rain, 3, 0.004);
    const hK = synthHeight(W, D, 6);
    const t0 = performance.now();
    const deepestK = addon.fluvialErode(hK, W, D, cell, 0, rain, 3, 0.004);
    const tK = performance.now() - t0;
    console.log(`  bench fluvial/3 passes: kernel=${tK.toFixed(1)}ms`);
    assert.equal(fingerprint(hK), fingerprint(hJs), "fluvial bit-identical");
    assert.equal(deepestK, deepestJs, "deepest cut identical");
  });

  test("dropletErosion", () => {
    const rain = rainField(W, D);
    const hJs = synthHeight(W, D, 7);
    const t0 = performance.now();
    const sJs = jsErosion.dropletErosion(
      hJs, grid(W, D, cell), 0, rain, 4000, 0.35, mulberry32(SEED ^ 0xe20d),
    );
    const tJs = performance.now() - t0;
    const hK = synthHeight(W, D, 7);
    const t1 = performance.now();
    const sK = addon.dropletErode(hK, W, D, cell, 0, rain, 4000, 0.35, BigInt(SEED));
    const tK = performance.now() - t1;
    console.log(
      `  bench droplet/4000: js=${tJs.toFixed(1)}ms kernel=${tK.toFixed(1)}ms speedup=${(tJs / tK).toFixed(2)}x`,
    );
    assert.equal(fingerprint(hK), fingerprint(hJs), "droplet bit-identical");
    assert.equal(sK.meanM, sJs.meanM, "meanM identical");
    assert.equal(sK.maxM, sJs.maxM, "maxM identical");
    assert.ok(tJs / tK >= 1, "benchmark gate: no regression");
  });

  test("hydrology: fillDepressions + drainage + accumulate via computeFlow", () => {
    const h = synthHeight(W, D, 8);
    const rain = rainField(W, D);
    const t0 = performance.now();
    const filled = jsHydro.fillDepressions(h, grid(W, D, cell));
    const flow = jsHydro.accumulate(
      jsHydro.drainage(filled, grid(W, D, cell)), grid(W, D, cell), (i) => rain[i],
    );
    const tJs = performance.now() - t0;
    const flowK = new Float32Array(W * D);
    const t1 = performance.now();
    addon.computeFlow(h, W, D, cell, rain, flowK);
    const tK = performance.now() - t1;
    console.log(
      `  bench flow-accum: js=${tJs.toFixed(1)}ms kernel=${tK.toFixed(1)}ms speedup=${(tJs / tK).toFixed(2)}x`,
    );
    assert.equal(fingerprint(flowK), fingerprint(flow), "flow accumulation bit-identical");
  });
});
