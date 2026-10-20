/**
 * Plains and terraces pass of the terrain bake: rolling plains, flat treads
 * separated by short risers, river and coast flats, mountains left alone,
 * and no stranded flats (walkable from the spawn). Synthetic grids with
 * measurable properties; the survey-level opt-in is checked against the
 * old output.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPlains } from "../../src/terrain/plains.js";
import { reachableLand } from "../../src/terrain/reach.js";
import { fillDepressions, LAND, SEA } from "../../src/terrain/hydrology.js";
import { slopeDegrees } from "../../src/terrain/grid-ops.js";
import { surveyWorld, type CoarseGrid } from "../../src/terrain/survey.js";
import { spawnPoint } from "../../src/terrain/world-bake.js";
import { parseWorldSpec } from "../../src/terrain/world-spec.js";

const hashOf = (a: Float32Array): string => createHash("sha1").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

const BIOMES = [
  { id: "sea", when: { water: "sea" }, roughness: 0.2 },
  { id: "lake", when: { water: "lake" }, roughness: 0.1 },
  { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
];

const SPEC = (plains?: object) =>
  parseWorldSpec({
    name: "plains",
    seed: 5,
    sizeChunks: 64,
    regionsPerSide: 2,
    land: { coast: { wander: 40, wanderScale: 150 }, rise: 15, riseDistance: 200, relief: 6, reliefScale: 300, shelfWidth: 60, minIslandArea: 2000 },
    ranges: { count: 1, spurs: 0, height: 120, width: 140, length: 300, ridgeScale: 120, coastClearance: 60 },
    climate: { dryDistance: 800, orographic: 0.01 },
    erosion: { droplets: 3000, thermalPasses: 10, fluvialPasses: 4 },
    rivers: { minCatchment: 20_000, maxDepth: 3 },
    lakes: { minArea: 2000 },
    minBiomeArea: 1000,
    biomes: BIOMES,
    ...(plains === undefined ? {} : { plains }),
  });

// ---- synthetic grid: sea in the west, a long gentle ramp east, mountains beyond ----

const N = 128;
const CELL = 8;
const grid: CoarseGrid = { width: N, depth: N, cell: CELL, originX: 0, originZ: 0 };
const at = (u: number, v: number): number => v * N + u;
const SEA_COLS = 8;
const MOUNTAIN_FROM = 100;

interface Scene {
  base: Float32Array;
  water: Uint8Array;
  waterLevel: Float32Array;
  river: Uint8Array;
  und: Float32Array;
  ramps: Float32Array;
}

function scene(): Scene {
  const base = new Float32Array(N * N);
  const water = new Uint8Array(N * N);
  const waterLevel = new Float32Array(N * N).fill(Number.NaN);
  const river = new Uint8Array(N * N);
  const und = new Float32Array(N * N);
  const ramps = new Float32Array(N * N);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const i = at(u, v);
      und[i] = Math.sin(u * 0.11) * Math.cos(v * 0.07);
      ramps[i] = Math.sin(u * 0.05 + 1) * Math.sin(v * 0.09);
      if (u < SEA_COLS) {
        base[i] = -5;
        water[i] = SEA;
        waterLevel[i] = 0;
        continue;
      }
      const x = (u - SEA_COLS) * CELL;
      // 2% ramp with a swell of a couple of metres, mountains from MOUNTAIN_FROM
      base[i] = 0.6 + 0.02 * x + 2 * Math.sin(u * 0.09 + v * 0.05) + (u > MOUNTAIN_FROM ? (u - MOUNTAIN_FROM) * 15 : 0);
      if (v === 64 && u < MOUNTAIN_FROM) river[i] = 1;
    }
  }
  return { base, water, waterLevel, river, und, ramps };
}

/** Scaled to the 1 km synthetic grid (the shipped defaults are for a 4 km world). */
const plainsOn = (extra: object = {}) =>
  SPEC({ enabled: true, smoothM: 60, undulationM: 0.5, treads: { treadWidthM: 250, stepMaxM: 10 }, floodplain: { widthM: 80 }, coast: { widthM: 100 }, ...extra }).plains;

function run(s: Scene, extra: object = {}): Float32Array {
  const h = Float32Array.from(s.base);
  applyPlains(plainsOn(extra), 0, grid, h, s.base, s.water, s.waterLevel, s.river, undefined, s.und, s.ramps);
  return h;
}

/** Highest minus lowest height over the window of `r` cells around (u, v). */
function relief(h: Float32Array, u: number, v: number, r: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) {
    const x = h[at(u + du, v + dv)];
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return hi - lo;
}

/** Share of low, gentle land cells (away from the edges) whose ~150 m window rises and falls at most `limit` m. */
function flatShare(h: Float32Array, limit: number): number {
  let n = 0;
  let flat = 0;
  const r = 9;
  for (let v = r; v < N - r; v++) for (let u = SEA_COLS + r; u < MOUNTAIN_FROM - r; u++) {
    n++;
    if (relief(h, u, v, r) <= limit) flat++;
  }
  return flat / n;
}

describe("plains pass: rolling plains and terraces", () => {
  const s = scene();
  const before = flatShare(s.base, 1.5);
  const out = run(s);

  test("treads are flat enough to build on where the land was a ramp (several times the flat land)", () => {
    const after = flatShare(out, 1.5);
    // A demanding scene (2% ramp under a 2 m swell, 150 m windows): the shipped world measures far better (docs/WORLD-BUILDING.md).
    assert.ok(after > 0.1 && after > 3 * before, `flat share ${before.toFixed(3)} -> ${after.toFixed(3)}`);
  });

  test("not dead flat: the plains undulate, and treads sit at several levels", () => {
    // Some relief survives between neighbouring cells on a tread...
    const row = 40;
    const seen = new Set<number>();
    for (let u = SEA_COLS + 2; u < MOUNTAIN_FROM - 4; u++) seen.add(Math.round(out[at(u, row)] * 4));
    assert.ok(seen.size > 20, "heights are not quantised to one flat value");
    // ...and the climb from the coast to the hills is made of steps: there are flat stretches (slope < 1 deg) and steeper risers.
    const slope = slopeDegrees(out, N, N, CELL);
    let flat = 0;
    let riser = 0;
    for (let u = SEA_COLS + 4; u < MOUNTAIN_FROM - 8; u++) {
      const sl = slope[at(u, row)];
      if (sl < 1) flat++;
      else if (sl > 2.5) riser++;
    }
    assert.ok(flat > 15, `flat stretches (${flat})`);
    assert.ok(riser > 3, `risers between them (${riser})`);
  });

  test("risers stay walkable: no cliffs on the climb", () => {
    const slope = slopeDegrees(out, N, N, CELL);
    for (let v = 12; v < N - 12; v++) for (let u = SEA_COLS + 12; u < MOUNTAIN_FROM - 12; u++) {
      assert.ok(slope[at(u, v)] < 25, `slope ${slope[at(u, v)].toFixed(1)} deg at ${u},${v}`);
    }
  });

  test("deterministic: same inputs, identical bytes", () => {
    assert.equal(hashOf(run(scene())), hashOf(out));
  });

  test("changes nothing unless enabled in the spec's numbers: strength is the mask", () => {
    const h = Float32Array.from(s.base);
    applyPlains(SPEC().plains, 0, grid, h, s.base, s.water, s.waterLevel, s.river, undefined, s.und, s.ramps);
    assert.equal(hashOf(h), hashOf(s.base), "enabled: false is a no-op");
  });

  test("the sea floor and water cells are never touched", () => {
    for (let i = 0; i < N * N; i++) if (s.water[i] !== LAND) assert.equal(out[i], s.base[i]);
  });
});

describe("plains pass: mountain safety", () => {
  test("ground above the fade height is exactly as it was", () => {
    const s = scene();
    const P = plainsOn();
    const out = run(s);
    let checked = 0;
    for (let i = 0; i < N * N; i++) {
      if (s.water[i] === LAND && s.base[i] > P.fadeToM + 40) {
        assert.equal(out[i], s.base[i]);
        checked++;
      }
    }
    assert.ok(checked > 200, `some mountain cells were checked (${checked})`);
  });

  test("a lower fade height keeps lower hills as they were", () => {
    const s = scene();
    const out = run(s, { fadeFromM: 10, fadeToM: 20 });
    for (let i = 0; i < N * N; i++) if (s.water[i] === LAND && s.base[i] > 60) assert.equal(out[i], s.base[i]);
  });
});

describe("plains pass: water", () => {
  test("no new sinks: the filled surface is no higher over the plains than it was, rivers still reach the sea", () => {
    const s = scene();
    const out = run(s);
    const g = (h: Float32Array): Float32Array => fillDepressions(h, grid);
    const depth = (h: Float32Array): number => {
      const f = g(h);
      let m = 0;
      for (let i = 0; i < N * N; i++) if (s.water[i] === LAND) m = Math.max(m, f[i] - h[i]);
      return m;
    };
    assert.ok(depth(out) <= depth(s.base) + 0.1, `deepest hollow after ${depth(out)} vs before ${depth(s.base)}`);
  });

  test("a river row sits in no pit and its mouth stays above the sea", () => {
    const s = scene();
    // a river valley: the bed falls steadily east to west
    for (let u = SEA_COLS; u < MOUNTAIN_FROM; u++) s.base[at(u, 64)] = 0.6 + 0.03 * (u - SEA_COLS) * CELL;
    const out = run(s);
    const filled = fillDepressions(out, grid);
    for (let u = SEA_COLS; u < MOUNTAIN_FROM - 20; u++) assert.ok(filled[at(u, 64)] - out[at(u, 64)] <= 0.05, `bed in a pit at ${u}`);
    assert.ok(out[at(SEA_COLS, 64)] > 0.2, "mouth above the sea");
    // and it still falls toward the sea overall, terrace by terrace
    assert.ok(out[at(MOUNTAIN_FROM - 25, 64)] > out[at(SEA_COLS + 2, 64)] + 5);
  });

  test("the shore stays above the water level", () => {
    const s = scene();
    const out = run(s);
    for (let v = 0; v < N; v++) for (let u = SEA_COLS; u < SEA_COLS + 40; u++) assert.ok(out[at(u, v)] > 0.25, `${u},${v}: ${out[at(u, v)]}`);
  });
});

describe("reachableLand", () => {
  const flat = (): Float32Array => new Float32Array(N * N).fill(10);

  test("flood fills walkable cells, steep steps block, a ramp in the step lets it through", () => {
    const h = flat();
    // a plateau 12 m up (cliffs: 12 m over one 8 m cell is ~56 deg), cells 40..79 square
    for (let v = 40; v < 80; v++) for (let u = 40; u < 80; u++) h[at(u, v)] = 22;
    let r = reachableLand(h, grid, 30, at(10, 10));
    assert.equal(r[at(10, 10)], 1);
    assert.equal(r[at(100, 100)], 1);
    assert.equal(r[at(60, 60)], 0, "the plateau is stranded");
    // a ramp up its west face: 12 m over 12 cells, ~7 deg
    for (let k = 0; k < 12; k++) h[at(39 - k, 60)] = 22 - ((k + 1) * 12) / 13;
    r = reachableLand(h, grid, 30, at(10, 10));
    assert.equal(r[at(60, 60)], 1, "the ramp reaches the plateau");
  });

  test("water blocks and the start must be open", () => {
    const h = flat();
    const wall = (i: number): boolean => i % N === 64;
    const r = reachableLand(h, grid, 30, at(10, 10), wall);
    assert.equal(r[at(100, 10)], 0);
    assert.equal(r[at(10, 100)], 1);
    assert.equal(reachableLand(h, grid, 30, at(64, 10), wall).reduce((a, b) => a + b, 0), 0);
  });

  test("a steeper limit admits more", () => {
    const h = flat();
    for (let v = 40; v < 80; v++) for (let u = 40; u < 80; u++) h[at(u, v)] = 22;
    assert.equal(reachableLand(h, grid, 80, at(10, 10))[at(60, 60)], 1);
  });
});

describe("world spec opt-in", () => {
  test("the pass defaults off, validates strictly, and documents its defaults", () => {
    const spec = SPEC();
    assert.equal(spec.plains.enabled, false);
    assert.ok(spec.plains.treads.treadWidthM > 0);
    assert.throws(() => SPEC({ bogus: 1 }));
    assert.throws(() => SPEC({ treads: { treadShare: 1 } }));
    assert.throws(() => SPEC({ fadeFromM: 100, fadeToM: 50 }));
    assert.throws(() => SPEC({ undulationM: -1 }));
  });

  test("a world that does not opt in bakes the same survey as spelling the defaults out", () => {
    const plain = SPEC();
    const explicit = SPEC({ enabled: false, undulationM: 0.5 });
    assert.equal(hashOf(surveyWorld(plain).height), hashOf(surveyWorld(explicit).height));
  });

  test("opting in changes the baked heights, keeps land valid, and keeps the flats reachable from the spawn", () => {
    const off = surveyWorld(SPEC());
    const spec = SPEC({ enabled: true, smoothM: 24, treads: { treadWidthM: 80, stepMinM: 1, stepMaxM: 6 }, floodplain: { widthM: 60 }, coast: { widthM: 80 } });
    const on = surveyWorld(spec);
    assert.notEqual(hashOf(on.height), hashOf(off.height));
    assert.ok(on.stats.landFraction > 0.1);
    for (const v of on.height) assert.ok(Number.isFinite(v));
    // flat land the pass made: dry, gentle, below the fade height
    const slope = slopeDegrees(on.height, on.grid.width, on.grid.depth, on.grid.cell);
    const sp = spawnPoint(spec, on);
    const from = Math.round((sp.z - on.grid.originZ) / on.grid.cell) * on.grid.width + Math.round((sp.x - on.grid.originX) / on.grid.cell);
    const reach = reachableLand(on.height, on.grid, 25, from, (i) => on.water[i] !== LAND);
    let flatCells = 0;
    let reachable = 0;
    for (let i = 0; i < on.height.length; i++) {
      if (on.water[i] !== LAND || slope[i] >= 2 || on.height[i] > spec.plains.fadeFromM) continue;
      flatCells++;
      reachable += reach[i];
    }
    assert.ok(flatCells > 100, `flat land exists (${flatCells})`);
    assert.ok(reachable / flatCells >= 0.97, `reachable share ${(reachable / flatCells).toFixed(3)}`);
  });
});

describe("the shipped default world (4 x 4 km, seed 1234)", () => {
  const spec = parseWorldSpec(JSON.parse(readFileSync(fileURLToPath(new URL("../../../worlds/default.world.json", import.meta.url)), "utf8")));
  const sv = surveyWorld(spec);
  const slope = slopeDegrees(sv.height, sv.grid.width, sv.grid.depth, sv.grid.cell);
  const sp = spawnPoint(spec, sv);
  const from = Math.round((sp.z - sv.grid.originZ) / sv.grid.cell) * sv.grid.width + Math.round((sp.x - sv.grid.originX) / sv.grid.cell);
  const sea = (i: number): boolean => sv.water[i] !== LAND;
  const flatLand = (i: number): boolean => !sea(i) && slope[i] < 2 && sv.height[i] - spec.land.seaLevel <= spec.plains.fadeFromM;

  test("opts in, and the low ground is mostly flat, graded and walkable", () => {
    assert.equal(spec.plains.enabled, true);
    let land = 0;
    let flat = 0;
    for (let i = 0; i < sv.height.length; i++) {
      if (sea(i)) continue;
      land++;
      if (flatLand(i)) flat++;
    }
    assert.ok(flat / land > 0.4, `flat low land is ${(100 * flat / land).toFixed(1)}% of the land (was 14% before the pass)`);
  });

  test("no flat land the pass made is stranded: it is walkable from the spawn wherever the land is connected", () => {
    const connected = reachableLand(sv.height, sv.grid, 89, from, sea);
    const walkable = reachableLand(sv.height, sv.grid, 25, from, sea);
    let linked = 0;
    let walked = 0;
    for (let i = 0; i < sv.height.length; i++) {
      if (!flatLand(i) || !connected[i]) continue;
      linked++;
      walked += walkable[i];
    }
    assert.ok(linked > 10_000, `flat land to check (${linked})`);
    assert.ok(walked / linked >= 0.995, `walkable share of the connected flat land ${(100 * walked / linked).toFixed(2)}%`);
  });
});
