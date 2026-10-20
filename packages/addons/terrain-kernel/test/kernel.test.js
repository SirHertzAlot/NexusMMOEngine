"use strict";
// Unit tests for @mmo-engine/addon-terrain-kernel (node:test, no framework).
//
// P2: grid API shape, identity round-trip, cross-process determinism,
//     input validation.
// P3: tectonics determinism, golden outputs, structural properties
//     (uplift/strain ranges, ridge continuity).
// P4: per-operator validation + JS-parity lives in test/parity.test.js
//     (needs the compiled JS reference; see scripts/build-jsref.sh).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const addon = require("../index.js");

// FNV-1a over the raw float bits — a compact exact-equality fingerprint.
function fingerprint(arr) {
  const u32 = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u32.length; i++) {
    h ^= u32[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Deterministic synthetic heightfield: sum of sines + a seeded bump.
function synthHeight(W, D, cell, seed) {
  const h = new Float32Array(W * D);
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0;
    return ((s >>> 0) % 1000) / 1000;
  };
  const bumps = [];
  for (let i = 0; i < 12; i++) bumps.push([rnd() * W, rnd() * D, 40 + rnd() * 160, 8 + rnd() * 30]);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      let z =
        60 * Math.sin(u * 0.11) * Math.cos(v * 0.07) +
        25 * Math.sin(u * 0.031 + 1.7) * Math.sin(v * 0.043 + 0.4);
      for (const [bu, bv, bh, br] of bumps) {
        const d2 = (u - bu) ** 2 + (v - bv) ** 2;
        z += bh * Math.exp(-d2 / (2 * br * br));
      }
      h[v * W + u] = z - 30; // some cells below sea level
    }
  }
  return h;
}

function rainField(W, D) {
  const r = new Float32Array(W * D);
  for (let v = 0; v < D; v++)
    for (let u = 0; u < W; u++) r[v * W + u] = 0.5 + 0.5 * Math.sin(u * 0.05) * Math.cos(v * 0.09);
  return r;
}

describe("exports", () => {
  test("all entry points present", () => {
    for (const f of ["bakeHeightfield", "computeTectonics", "thermalErode", "fluvialErode", "dropletErode", "computeFlow", "libraryInfo"])
      assert.equal(typeof addon[f], "function", f);
    assert.match(addon.libraryInfo(), /terrain-kernel/);
  });
});

describe("P2: bakeHeightfield", () => {
  const W = 64, D = 48, cell = 8;
  const base = () => ({
    seed: 1234n,
    width: W,
    depth: D,
    cell,
    seaLevel: 0,
    stages: [{ op: "identity" }],
  });

  test("identity stage round-trips the heightfield bit-identically", () => {
    const h = synthHeight(W, D, cell, 7);
    const before = fingerprint(h);
    const flow = new Float32Array(W * D);
    addon.bakeHeightfield(base(), h, flow);
    assert.equal(fingerprint(h), before, "height must pass through untouched");
    for (let i = 0; i < flow.length; i++) {
      assert.ok(Number.isFinite(flow[i]), "flow finite");
      assert.ok(flow[i] >= cell * cell, "flow >= own cell area");
    }
  });

  test("cross-process determinism: same params -> identical bytes", () => {
    const script = `
      const addon = require(${JSON.stringify(require.resolve("../index.js"))});
      const W=64,D=48;
      const h = new Float32Array(W*D);
      let s=99; for(let i=0;i<h.length;i++){ s=(Math.imul(s,1103515245)+12345)&0x7fffffff; h[i]=((s%2000)/10)-100; }
      const flow = new Float32Array(W*D);
      addon.bakeHeightfield({seed:4242n,width:W,depth:D,cell:8,seaLevel:0,stages:[{op:'identity'}]}, h, flow);
      const u32=new Uint32Array(h.buffer); let fph=0x811c9dc5;
      for(let i=0;i<u32.length;i++){fph^=u32[i];fph=Math.imul(fph,0x01000193)>>>0;}
      const u32f=new Uint32Array(flow.buffer); let fpf=0x811c9dc5;
      for(let i=0;i<u32f.length;i++){fpf^=u32f[i];fpf=Math.imul(fpf,0x01000193)>>>0;}
      console.log(fph.toString(16)+'/'+fpf.toString(16));
    `;
    const a = execFileSync(process.execPath, ["-e", script]).toString().trim();
    const b = execFileSync(process.execPath, ["-e", script]).toString().trim();
    assert.equal(a, b, "two processes must agree bit-for-bit");
  });

  test("invalid inputs throw JS exceptions, never crash", () => {
    const h = new Float32Array(W * D);
    const flow = new Float32Array(W * D);
    assert.throws(() => addon.bakeHeightfield({ ...base(), seed: 1234 }, h, flow), /bigint/);
    assert.throws(() => addon.bakeHeightfield({ ...base(), width: 0 }, h, flow), /width/);
    assert.throws(() => addon.bakeHeightfield({ ...base(), width: 5000 }, h, flow), /width/);
    assert.throws(() => addon.bakeHeightfield({ ...base(), cell: -1 }, h, flow), /cell/);
    assert.throws(() => addon.bakeHeightfield({ ...base(), stages: [{ op: "nope" }] }, h, flow), /unknown stage/);
    assert.throws(() => addon.bakeHeightfield({ ...base(), stages: "x" }, h, flow), /array/);
    assert.throws(() => addon.bakeHeightfield(base(), new Float32Array(10), flow), /width\*depth/);
    assert.throws(() => addon.bakeHeightfield(base(), h, new Float64Array(W * D)), /Float32Array/);
    // fluvial without rainShare must throw, not crash
    assert.throws(
      () => addon.bakeHeightfield({ ...base(), stages: [{ op: "fluvial", passes: 1, strength: 0.004 }] }, h, flow),
      /rainShare/,
    );
  });

  test("erosion stages run inside bakeHeightfield", () => {
    const h = synthHeight(W, D, cell, 11);
    const before = Float32Array.from(h);
    const flow = new Float32Array(W * D);
    const rain = rainField(W, D);
    addon.bakeHeightfield(
      { ...base(), rainShare: rain, stages: [
        { op: "thermal", talusDeg: 38, passes: 4 },
        { op: "fluvial", passes: 2, strength: 0.004 },
        { op: "droplet", droplets: 2000, strength: 0.35 },
      ] },
      h, flow,
    );
    let changed = 0;
    for (let i = 0; i < h.length; i++) if (h[i] !== before[i]) changed++;
    assert.ok(changed > h.length * 0.05, "stages must move material");
    for (let i = 0; i < flow.length; i++) assert.ok(flow[i] >= 0 && Number.isFinite(flow[i]));
  });
});

describe("P3: computeTectonics", () => {
  const W = 96, D = 72, cell = 8000; // 8 km cells: continental scale
  const params = (over = {}) => ({ seed: 777n, width: W, depth: D, cell, plateCount: 10, ...over });

  test("determinism + golden outputs", () => {
    const run = () => {
      const up = new Float32Array(W * D), st = new Float32Array(W * D);
      addon.computeTectonics(params(), up, st);
      return fingerprint(up) + "/" + fingerprint(st);
    };
    const a = run(), b = run();
    assert.equal(a, b, "in-process determinism");
    // Golden file: recorded on first green run, asserted thereafter.
    // (Tectonics has no JS equivalent; the golden pins the exact fields.)
    const fs = require("node:fs");
    const path = require("node:path");
    const goldenPath = path.join(__dirname, "golden.json");
    let golden = {};
    try {
      golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    } catch { /* first run: record */ }
    const key = "tectonics/seed777/10plates/96x72@8km";
    if (!(key in golden)) {
      golden[key] = a;
      fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + "\n");
      console.log("  (recorded golden " + key + " = " + a + ")");
    } else {
      assert.equal(a, golden[key], "golden tectonics fingerprint mismatch");
    }
  });

  test("uplift/strain ranges and ridge continuity", () => {
    const up = new Float32Array(W * D), st = new Float32Array(W * D);
    addon.computeTectonics(params(), up, st);
    let pos = 0, neg = 0, badStrain = 0;
    for (let i = 0; i < up.length; i++) {
      assert.ok(up[i] <= 600 && up[i] >= -250, `uplift in range, got ${up[i]}`);
      assert.ok(st[i] >= 0 && st[i] <= 1, `strain in [0,1], got ${st[i]}`);
      if (up[i] > 300) pos++;
      if (up[i] < -125) neg++;
      if (st[i] < 0 || st[i] > 1) badStrain++;
    }
    assert.equal(badStrain, 0);
    assert.ok(pos > 0, "some convergent uplift expected");
    assert.ok(neg > 0, "some rift subsidence expected");
    // Ridge continuity: high-uplift cells should mostly touch another
    // high-uplift cell (ranges, not speckle).
    let ridge = 0, lonely = 0;
    for (let v = 1; v < D - 1; v++) {
      for (let u = 1; u < W - 1; u++) {
        const i = v * W + u;
        if (up[i] <= 300) continue;
        ridge++;
        let touches = false;
        for (let dz = -1; dz <= 1 && !touches; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            if (up[(v + dz) * W + (u + dx)] > 300) { touches = true; break; }
          }
        if (!touches) lonely++;
      }
    }
    assert.ok(ridge > 0);
    assert.ok(lonely / ridge < 0.1, `ridges must be continuous (lonely ${lonely}/${ridge})`);
  });

  test("seed sensitivity: different seed -> different fields", () => {
    const run = (seed) => {
      const up = new Float32Array(W * D), st = new Float32Array(W * D);
      addon.computeTectonics(params({ seed }), up, st);
      return fingerprint(up);
    };
    assert.notEqual(run(777n), run(778n));
  });

  test("invalid inputs throw", () => {
    const up = new Float32Array(W * D), st = new Float32Array(W * D);
    assert.throws(() => addon.computeTectonics({ ...params(), plateCount: 1 }, up, st), /plateCount/);
    assert.throws(() => addon.computeTectonics({ ...params(), seed: 5 }, up, st), /bigint/);
    assert.throws(() => addon.computeTectonics(params(), new Float32Array(4), st), /width\*depth/);
  });
});

describe("P4: operator entry points", () => {
  const W = 64, D = 48, cell = 8;

  test("thermalErode moves material downhill only", () => {
    const h = synthHeight(W, D, cell, 21);
    let sumBefore = 0;
    for (const v of h) sumBefore += v;
    addon.thermalErode(h, W, D, cell, 38, 6);
    let sumAfter = 0;
    for (const v of h) sumAfter += v;
    // Mass conserved up to float32 rounding (material only moves).
    assert.ok(Math.abs(sumAfter - sumBefore) < h.length * 1e-3, `mass conserved: ${sumBefore} -> ${sumAfter}`);
    assert.throws(() => addon.thermalErode(new Float32Array(4), W, D, cell, 38, 1), /width\*depth/);
    assert.throws(() => addon.thermalErode(h, W, D, cell, 38, -1), /passes/);
  });

  test("fluvialErode returns deepest cut, never raises cells", () => {
    const h = synthHeight(W, D, cell, 22);
    const before = Float32Array.from(h);
    const rain = rainField(W, D);
    const deepest = addon.fluvialErode(h, W, D, cell, 0, rain, 3, 0.004);
    assert.ok(deepest >= 0, "deepest cut >= 0");
    for (let i = 0; i < h.length; i++) assert.ok(h[i] <= before[i] + 1e-6, "fluvial only incises");
  });

  test("dropletErode returns stats and is deterministic", () => {
    const mk = () => synthHeight(W, D, cell, 23);
    const rain = rainField(W, D);
    const h1 = mk(), h2 = mk();
    const s1 = addon.dropletErode(h1, W, D, cell, 0, rain, 3000, 0.35, 1234n);
    const s2 = addon.dropletErode(h2, W, D, cell, 0, rain, 3000, 0.35, 1234n);
    assert.equal(fingerprint(h1), fingerprint(h2), "same seed -> bit-identical");
    assert.ok(s1.meanM >= 0 && s1.maxM >= s1.meanM);
    assert.equal(s1.meanM, s2.meanM);
    assert.equal(s1.maxM, s2.maxM);
    const h3 = mk();
    addon.dropletErode(h3, W, D, cell, 0, rain, 3000, 0.35, 9999n);
    assert.notEqual(fingerprint(h1), fingerprint(h3), "different seed -> different result");
  });

  test("computeFlow: uniform weight gives >= cell area everywhere", () => {
    const h = synthHeight(W, D, cell, 24);
    const flow = new Float32Array(W * D);
    addon.computeFlow(h, W, D, cell, null, flow);
    for (let i = 0; i < flow.length; i++) {
      assert.ok(flow[i] >= cell * cell - 1e-3, "each cell drains at least itself");
      assert.ok(Number.isFinite(flow[i]));
    }
    const w = rainField(W, D);
    const flow2 = new Float32Array(W * D);
    addon.computeFlow(h, W, D, cell, w, flow2);
    assert.notEqual(fingerprint(flow), fingerprint(flow2), "weight changes accumulation");
  });
});
