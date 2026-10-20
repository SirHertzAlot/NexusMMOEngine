/**
 * Relief passes of the terrain bake: sharp range crests (crest profile and
 * ridged multifractal detail), stream-power incision, and thermal/talus
 * erosion with a steeper angle for bare rock. Synthetic grids, measurable
 * properties; the survey-level opt-in is checked against the old output.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { streamPowerIncision, thermalErosion } from "../../src/terrain/erosion.js";
import { crestProfile, ridgedMultifractal } from "../../src/terrain/relief.js";
import { raiseVolcanoes, rangeUplift, type RangeAxis } from "../../src/terrain/landmass.js";
import { surveyWorld, type CoarseGrid } from "../../src/terrain/survey.js";
import { parseWorldSpec } from "../../src/terrain/world-spec.js";

const hashOf = (a: Float32Array): string => createHash("sha1").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

function gridOf(n: number, cell = 8): CoarseGrid {
  const o = -((n - 1) / 2) * cell; // the centre cell sits at the world origin
  return { width: n, depth: n, cell, originX: o, originZ: o };
}

/** A rough cone: height falls with distance, plus deterministic ridged gullies. */
function cone(grid: CoarseGrid, peak: number, radius: number, gullies = 0): Float32Array {
  const h = new Float32Array(grid.width * grid.depth);
  const cx = (grid.width - 1) / 2;
  for (let v = 0; v < grid.depth; v++) {
    for (let u = 0; u < grid.width; u++) {
      const r = Math.hypot(u - cx, v - cx) * grid.cell;
      const a = Math.atan2(v - cx, u - cx);
      const base = Math.max(0, 1 - r / radius);
      h[v * grid.width + u] = peak * base * (1 + gullies * Math.sin(7 * a) * Math.min(1, r / 80)) + 0.01 * ((u * 7 + v * 13) % 5);
    }
  }
  return h;
}

/** Ridge-to-valley contrast: height range around a ring of `radiusCells` about the centre. */
function ringContrast(h: Float32Array, grid: CoarseGrid, radiusCells: number): number {
  const c = (grid.width - 1) / 2;
  let mx = -Infinity;
  let mn = Infinity;
  for (let k = 0; k < 360; k += 2) {
    const t = (k * Math.PI) / 180;
    const x = h[Math.round(c + radiusCells * Math.sin(t)) * grid.width + Math.round(c + radiusCells * Math.cos(t))];
    mx = Math.max(mx, x);
    mn = Math.min(mn, x);
  }
  return mx - mn;
}
function maxSlopeDeg(h: Float32Array, grid: CoarseGrid, from = 1): number {
  let m = 0;
  for (let v = from; v < grid.depth - from; v++) {
    for (let u = from; u < grid.width - from; u++) {
      const i = v * grid.width + u;
      for (const [du, dv] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const d = Math.hypot(du, dv) * grid.cell;
        m = Math.max(m, Math.abs(h[i] - h[(v + dv) * grid.width + u + du]) / d);
      }
    }
  }
  return (Math.atan(m) * 180) / Math.PI;
}

const SPEC = (ranges: object = {}): ReturnType<typeof parseWorldSpec> =>
  parseWorldSpec({
    name: "relief",
    seed: 5,
    sizeChunks: 32,
    regionsPerSide: 2,
    land: { coast: { wander: 40, wanderScale: 150 }, rise: 15, riseDistance: 200, relief: 6, reliefScale: 300, shelfWidth: 60, minIslandArea: 2000 },
    ranges: { count: 1, spurs: 0, height: 120, width: 140, length: 300, ridgeScale: 120, coastClearance: 60, ...ranges },
    climate: { dryDistance: 800, orographic: 0.01 },
    erosion: { droplets: 3000, thermalPasses: 10, fluvialPasses: 4 },
    rivers: { minCatchment: 20_000, maxDepth: 3 },
    lakes: { minArea: 2000 },
    minBiomeArea: 1000,
    biomes: [
      { id: "sea", when: { water: "sea" }, roughness: 0.2 },
      { id: "lake", when: { water: "lake" }, roughness: 0.1 },
      { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
    ],
  });

describe("crest shaping", () => {
  test("crestProfile: same ends, sharper crest, stays monotone", () => {
    for (const s of [0, 0.5, 1]) {
      assert.equal(crestProfile(0, s), 1);
      assert.equal(crestProfile(1, s), 0);
      let last = 1;
      for (let r = 0; r <= 1; r += 0.05) {
        const p = crestProfile(r, s);
        assert.ok(p <= last + 1e-12, `monotone at r=${r} s=${s}`);
        last = p;
      }
    }
    // Rounded profile has a flat crown; the sharp one drops at once.
    assert.ok(crestProfile(0.1, 1) < crestProfile(0.1, 0) - 0.03);
    // sharpness 0 is exactly the old quartic profile.
    assert.equal(crestProfile(0.4, 0), (1 - 0.16) * (1 - 0.16));
  });

  test("ridgedMultifractal: 0..1, deterministic, more octaves add crest detail", () => {
    const n = 4096;
    const mk = (seed: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.013 * seed + seed) * Math.cos(i * 0.0071 * seed));
    const fields = [mk(1), mk(4), mk(16)];
    const one = ridgedMultifractal(fields.slice(0, 1), 0.5);
    const three = ridgedMultifractal(fields, 0.5);
    for (const v of three) assert.ok(v >= 0 && v <= 1, `range ${v}`);
    assert.equal(hashOf(three), hashOf(ridgedMultifractal(fields, 0.5)));
    let rough1 = 0;
    let rough3 = 0;
    for (let i = 1; i < n; i++) {
      rough1 += Math.abs(one[i] - one[i - 1]);
      rough3 += Math.abs(three[i] - three[i - 1]);
    }
    assert.ok(rough3 > rough1 * 1.1);
  });

  test("rangeUplift: crest sharpness rounds the cross-section less, same peak height", () => {
    const grid = gridOf(101);
    const zero = new Float32Array(101 * 101);
    const axis: RangeAxis = {
      points: Array.from({ length: 17 }, (_, k) => ({ x: -300 + 37.5 * k, z: 0 })),
      height: 120,
      width: 140,
      spur: false,
    };
    const crossSection = (sharpness: number): { up: Float32Array; crest: number } => {
      const up = rangeUplift(SPEC({ crest: { sharpness } }), grid, [axis], zero, zero, zero, zero, zero);
      const c = 50 * 101 + 50;
      const d = 3 * 101; // 3 cells = 24 m across the axis
      return { up, crest: up[c] - 0.5 * (up[c - d] + up[c + d]) };
    };
    const round = crossSection(0);
    const sharp = crossSection(0.9);
    assert.ok(sharp.crest > round.crest * 1.8, `crest drop ${sharp.crest} vs ${round.crest}`);
    const peak = (a: Float32Array): number => a.reduce((m, x) => Math.max(m, x), 0);
    assert.ok(Math.abs(peak(sharp.up) - peak(round.up)) < 1e-3 * peak(round.up));
    // Defaults leave the old profile untouched.
    assert.equal(hashOf(rangeUplift(SPEC(), grid, [axis], zero, zero, zero, zero, zero)), hashOf(round.up));
  });
});

describe("stream-power incision", () => {
  const grid = gridOf(97);
  const rain = new Float32Array(97 * 97).fill(1);
  const sea = 0;

  test("deepens valleys, keeps the summit, never raises, bounded cut, deterministic", () => {
    const before = cone(grid, 300, 380, 0.18);
    const h = Float32Array.from(before);
    const cut = streamPowerIncision(h, grid, sea, rain, 24, 0.01, 0.5, 40);
    let summitBefore = 0;
    let summitAfter = 0;
    let removed = 0;
    for (let i = 0; i < h.length; i++) {
      assert.ok(h[i] <= before[i] + 1e-4, "never raises");
      assert.ok(before[i] - h[i] <= 40 + 1e-3, "cut bounded");
      summitBefore = Math.max(summitBefore, before[i]);
      summitAfter = Math.max(summitAfter, h[i]);
      removed += before[i] - h[i];
    }
    assert.ok(summitBefore - summitAfter < 0.02 * summitBefore, `summit kept (${summitBefore} -> ${summitAfter})`);
    assert.ok(cut > 5 * (summitBefore - summitAfter) && cut <= 40 + 1e-3, `valleys cut far deeper than the summit: ${cut}`);
    assert.ok(removed > 0, "mass only leaves");
    // Valleys deeper relative to the ridges between them.
    assert.ok(
      ringContrast(h, grid, 25) > ringContrast(before, grid, 25) * 1.1,
      "ridge-to-valley contrast on the flank grows",
    );
    const again = Float32Array.from(before);
    streamPowerIncision(again, grid, sea, rain, 24, 0.01, 0.5, 40);
    assert.equal(hashOf(again), hashOf(h));
  });

  test("valley floors still drain: no new sinks above the sea", () => {
    const sinks = (a: Float32Array): number => {
      let n = 0;
      for (let v = 1; v < grid.depth - 1; v++) {
        for (let u = 1; u < grid.width - 1; u++) {
          const i = v * grid.width + u;
          if (a[i] <= sea + 0.5) continue;
          let lower = false;
          for (let dv = -1; dv <= 1 && !lower; dv++) for (let du = -1; du <= 1; du++) if ((du || dv) && a[i + dv * grid.width + du] < a[i] + 1e-3) lower = true;
          if (!lower) n++;
        }
      }
      return n;
    };
    const before = cone(grid, 300, 380, 0.18);
    const h = Float32Array.from(before);
    streamPowerIncision(h, grid, sea, rain, 24, 0.01, 0.5, 40);
    assert.ok(sinks(h) <= sinks(before), `sinks ${sinks(before)} -> ${sinks(h)}`);
  });

  test("zero passes or zero strength change nothing", () => {
    const before = cone(grid, 300, 380, 0.18);
    const a = Float32Array.from(before);
    assert.equal(streamPowerIncision(a, grid, sea, rain, 0, 0.001, 0.5, 40), 0);
    assert.equal(streamPowerIncision(a, grid, sea, rain, 5, 0, 0.5, 40), 0);
    assert.equal(hashOf(a), hashOf(before));
  });
});

describe("thermal / talus", () => {
  const grid = gridOf(49);

  test("slopes relax to the talus angle (within tolerance), mass is conserved", () => {
    const h = cone(grid, 500, 150, 0); // far steeper than 38 degrees
    const sum0 = h.reduce((a, b) => a + b, 0);
    thermalErosion(h, grid, 38, 400);
    const sum1 = h.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum1 - sum0) / sum0 < 1e-5, "mass conserved");
    assert.ok(maxSlopeDeg(h, grid, 2) <= 38 * 1.1, `max slope ${maxSlopeDeg(h, grid, 2)}`);
  });

  test("a bare-rock angle keeps the summit sharp while the foot still weathers to scree", () => {
    const peak = (a: Float32Array): number => a.reduce((m, x) => Math.max(m, x), 0);
    const soil = cone(grid, 400, 300, 0);
    const rock = Float32Array.from(soil);
    thermalErosion(soil, grid, 36, 60);
    thermalErosion(rock, grid, 36, 60, { deg: 52, fromM: 150, spanM: 100 });
    assert.ok(peak(rock) > peak(soil) + 15, `rock peak ${peak(rock)} vs soil ${peak(soil)}`);
    // Below the rock line the same talus angle applies: foot slopes match.
    const foot = (a: Float32Array): number => {
      let s = 0;
      for (let v = 1; v < grid.depth - 1; v++) for (let u = 1; u < grid.width - 1; u++) if (a[v * grid.width + u] < 60) s = Math.max(s, Math.abs(a[v * grid.width + u + 1] - a[v * grid.width + u]));
      return s;
    };
    assert.ok(foot(rock) <= (foot(soil) + 0.5) * 1.15);
  });

  test("deterministic", () => {
    const a = cone(grid, 400, 300, 0.1);
    const b = Float32Array.from(a);
    thermalErosion(a, grid, 36, 20, { deg: 52, fromM: 150, spanM: 100 });
    thermalErosion(b, grid, 36, 20, { deg: 52, fromM: 150, spanM: 100 });
    assert.equal(hashOf(a), hashOf(b));
  });
});

describe("world spec opt-in", () => {
  test("new passes default off and validate", () => {
    const spec = SPEC();
    assert.equal(spec.ranges.crest.sharpness, 0);
    assert.equal(spec.ranges.crest.detailOctaves, 0);
    assert.equal(spec.erosion.incision.passes, 0);
    assert.equal(spec.erosion.rockTalusDeg, undefined);
    assert.throws(() => SPEC({ crest: { sharpness: 1.5 } }));
    assert.throws(() => SPEC({ crest: { bogus: 1 } }));
    assert.throws(() => parseWorldSpec({ ...JSON.parse(JSON.stringify(SPEC())), erosion: { incision: { passes: -1 } } }));
  });

  test("a world that does not opt in bakes the same survey as spelling the defaults out", () => {
    const plain = SPEC();
    const explicit = parseWorldSpec({
      ...JSON.parse(JSON.stringify(plain)),
      ranges: { ...plain.ranges, crest: { sharpness: 0, detailOctaves: 0 } },
      erosion: { ...plain.erosion, incision: { passes: 0 } },
    });
    assert.equal(hashOf(surveyWorld(plain).height), hashOf(surveyWorld(explicit).height));
  });

  test("opting in changes the baked heights and keeps the land above the sea valid", () => {
    const base = surveyWorld(SPEC());
    const on = surveyWorld(
      parseWorldSpec({
        ...JSON.parse(JSON.stringify(SPEC())),
        ranges: { ...SPEC().ranges, crest: { sharpness: 0.7, detailOctaves: 3 } },
        erosion: { ...SPEC().erosion, incision: { passes: 8 }, rockTalusDeg: 50 },
      }),
    );
    assert.notEqual(hashOf(on.height), hashOf(base.height));
    assert.ok(on.stats.landFraction > 0.1);
  });
});

describe("volcano flank gullies", () => {
  const grid = gridOf(121);
  const n = 121 * 121;
  const zero = new Float32Array(n);
  const spec = (gullies?: number) =>
    parseWorldSpec({
      ...JSON.parse(JSON.stringify(SPEC())),
      volcano: { count: 1, height: 200, radius: 400, craterRadius: 40, craterDepth: 20, ...(gullies === undefined ? {} : { gullies }) },
    });
  const noise = Float32Array.from({ length: n }, (_, i) => Math.sin((i % 121) * 0.35) * Math.cos(Math.floor(i / 121) * 0.21));
  const raise = (gullies: number | undefined, field?: Float32Array): Float32Array => {
    const h = new Float32Array(n);
    raiseVolcanoes(spec(gullies), grid, h, zero, [{ x: 0, z: 0 }], zero, field);
    return h;
  };
  const ring = (a: Float32Array, cells: number): number => {
    const vals: number[] = [];
    for (let k = 0; k < 360; k += 3) vals.push(a[(60 + Math.round(cells * Math.sin((k * Math.PI) / 180))) * 121 + 60 + Math.round(cells * Math.cos((k * Math.PI) / 180))]);
    return Math.max(...vals) - Math.min(...vals);
  };

  test("default leaves the smooth cone; gullies cut radial valleys but keep the crater rim", () => {
    const smooth = raise(undefined, noise);
    assert.equal(hashOf(smooth), hashOf(raise(undefined)));
    const gullied = raise(0.5, noise);
    assert.equal(gullied[60 * 121 + 60], smooth[60 * 121 + 60], "crater untouched");
    assert.ok(ring(gullied, 30) > ring(smooth, 30) + 8, `flank contrast ${ring(gullied, 30)} vs ${ring(smooth, 30)}`);
    for (let i = 0; i < n; i++) assert.ok(gullied[i] <= smooth[i] + 1e-4, "gullies only remove");
    assert.equal(hashOf(gullied), hashOf(raise(0.5, noise)));
  });
});