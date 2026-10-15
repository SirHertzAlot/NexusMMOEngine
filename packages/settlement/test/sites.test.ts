/**
 * Site selection (spec §9 to §10): where a settlement can stand, read from
 * the world bake's fields. The terrain here is small and made by hand, so
 * each test says exactly what the land is and what the selector should do
 * about it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, selectSites, type TerrainFields } from "../src/index.js";

const N = 40;
const CELL = 100;
const idx = (x: number, z: number): number => z * N + x;

/** Flat plains, a river down column 10, sea along the east edge, a steep ridge in the north-west corner. */
function land(): TerrainFields {
  const height = new Float32Array(N * N).fill(20);
  const water = new Uint8Array(N * N);
  const river = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N).fill(1);
  for (let z = 0; z < N; z++) {
    river[idx(10, z)] = 1;
    for (let x = 36; x < N; x++) {
      water[idx(x, z)] = 1;
      height[idx(x, z)] = -5;
      biome[idx(x, z)] = 0;
    }
  }
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
    height[idx(x, z)] = 20 + (x + z) * 60;
    biome[idx(x, z)] = 2;
  }
  return { grid: { width: N, depth: N, cell: CELL, originX: 0, originZ: 0 }, height, water, river, ice: new Uint8Array(N * N), biome, biomeIds: ["sea", "plains", "mountains"], seaLevel: 0 };
}

const cellOf = (s: { x: number; z: number }): { cx: number; cz: number } => ({ cx: Math.round(s.x / CELL), cz: Math.round(s.z / CELL) });

describe("selectSites", () => {
  const t = land();
  const sites = selectSites(t, BUILTIN_RULES.sites, 6);

  it("finds sites on dry, flat, fertile ground and none on water, rivers or the ridge", () => {
    assert.ok(sites.length >= 3);
    for (const s of sites) {
      const { cx, cz } = cellOf(s);
      assert.equal(t.water[idx(cx, cz)], 0, "not in the sea");
      assert.equal(t.river[idx(cx, cz)], 0, "not on the river");
      assert.ok(!(cx < 8 && cz < 8), "not on the ridge");
      assert.ok(t.biomeIds[t.biome[idx(cx, cz)]!] === "plains");
    }
  });

  it("prefers land near water, but not on the bank", () => {
    const best = sites[0]!;
    assert.ok(best.waterDistanceM >= BUILTIN_RULES.sites.waterRangeM[0] && best.waterDistanceM <= BUILTIN_RULES.sites.waterRangeM[1] * 2, `water ${best.waterDistanceM} m`);
  });

  it("returns the best first, keeps the spacing, and never more than asked", () => {
    assert.ok(sites.length <= 6);
    for (let i = 1; i < sites.length; i++) assert.ok(sites[i - 1]!.pressurePermille >= sites[i]!.pressurePermille);
    for (const a of sites) for (const b of sites) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= BUILTIN_RULES.sites.minSpacingM);
  });

  it("is deterministic, and finds nothing on bare ice", () => {
    assert.deepEqual(selectSites(land(), BUILTIN_RULES.sites, 6), sites);
    const iced = land();
    iced.ice!.fill(1);
    assert.deepEqual(selectSites(iced, BUILTIN_RULES.sites, 6), []);
  });
});

/** All plains and dry; `shape(x, z)` is the height in metres. A 100 m cell, so a 150 m town reaches two cells each way. */
function relief(shape: (x: number, z: number) => number): TerrainFields {
  const height = new Float32Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) height[idx(x, z)] = shape(x, z);
  const river = new Uint8Array(N * N);
  river[0] = 1; // one wet cell, so water distance exists; waterRangeM below makes it count the same everywhere
  return { grid: { width: N, depth: N, cell: CELL, originX: 0, originZ: 0 }, height, water: new Uint8Array(N * N), river, ice: new Uint8Array(N * N), biome: new Uint8Array(N * N).fill(1), biomeIds: ["sea", "plains"], seaLevel: 0 };
}
const TOWN_M = 150;
const rulesOf = (over: Partial<typeof BUILTIN_RULES.sites>): typeof BUILTIN_RULES.sites => ({ ...BUILTIN_RULES.sites, minSpacingM: 400, waterRangeM: [1, 1e7], minPressurePermille: 0, ...over });

describe("selectSites: flat, low land", () => {
  it("accepts a low plateau", () => {
    assert.ok(selectSites(relief(() => 12), rulesOf({}), 3, TOWN_M).length > 0);
  });

  it("rejects a long gentle ramp: it passes the slope limit but climbs too far across a town", () => {
    const ramp = relief((x) => 2 * x); // 20 permille, far under maxSlopePermille
    assert.ok(20 < BUILTIN_RULES.sites.maxSlopePermille);
    assert.deepEqual(selectSites(ramp, rulesOf({ maxElevationM: 1000, mountainClearanceM: 0 }), 3, TOWN_M), []);
    // with the relief limit lifted the ramp is a site: relief is what rejected it
    assert.ok(selectSites(ramp, rulesOf({ maxElevationM: 1000, mountainClearanceM: 0, maxReliefM: 100 }), 3, TOWN_M).length > 0);
  });

  it("rejects a ridge that coarse slope hides, and keeps a margin from it", () => {
    // a 40 m step between two cells: slope reads it at one cell only, the footprint window sees it from two cells away
    const step = relief((x) => (x >= 20 ? 40 : 5));
    const s = selectSites(step, rulesOf({ maxElevationM: 1000, mountainClearanceM: 0 }), 20, TOWN_M);
    assert.ok(s.length > 0);
    for (const site of s) assert.ok(site.x <= 1700 || site.x >= 2200, `site at x=${site.x} sees the step`);
  });

  it("never builds above maxElevationM, even on perfectly flat ground", () => {
    assert.deepEqual(selectSites(relief(() => 90), rulesOf({ maxElevationM: 60 }), 3, TOWN_M), []);
  });

  it("keeps clear of mountains: nothing within mountainClearanceM of ground above ridgeHeightM", () => {
    const peak = relief((x, z) => (x === 30 && z === 20 ? 300 : 10));
    const rules = rulesOf({ ridgeHeightM: 150, mountainClearanceM: 600, maxReliefM: 1000 });
    const s = selectSites(peak, rules, 50, TOWN_M);
    assert.ok(s.length > 0);
    for (const site of s) assert.ok(Math.max(Math.abs(site.x - 3000), Math.abs(site.z - 2000)) > 600, `site (${site.x}, ${site.z}) is under the peak`);
  });

  it("prefers a low flat valley floor over higher ground", () => {
    const valley = relief((x) => 4 + Math.min(Math.abs(x - 20) * 0.4, 30)); // floor at x=20 (2000 m); sides rise gently
    const best = selectSites(valley, rulesOf({ maxReliefM: 100 }), 1, TOWN_M)[0]!;
    assert.ok(Math.abs(best.x - 2000) <= 300, `best site x=${best.x}`);
    assert.ok(best.elevationM <= 8 && best.reliefM <= 1, `elevation ${best.elevationM}, relief ${best.reliefM}`);
  });

  it("reports each site's elevation and relief, in whole metres", () => {
    const s = selectSites(relief(() => 12), rulesOf({}), 1, TOWN_M)[0]!;
    assert.equal(s.elevationM, 12);
    assert.equal(s.reliefM, 0);
  });
});

/** An 8 m cell grid (a 2 m-per-cell climb is 14 deg; a 14 m step between two cells is a 60 deg cliff). */
function plateauWorld(): TerrainFields {
  const n = 80;
  const cell = 8;
  const height = new Float32Array(n * n).fill(20);
  // a 14 m high plateau, 24 cells (192 m) square, ringed by cliffs
  for (let z = 40; z < 64; z++) for (let x = 40; x < 64; x++) height[z * n + x] = 34;
  const river = new Uint8Array(n * n);
  river[0] = 1;
  return { grid: { width: n, depth: n, cell, originX: 0, originZ: 0 }, height, water: new Uint8Array(n * n), river, ice: new Uint8Array(n * n), biome: new Uint8Array(n * n).fill(1), biomeIds: ["sea", "plains"], seaLevel: 0 };
}
const onPlateau = (s: { x: number; z: number }): boolean => s.x >= 8 * 40 - 8 && s.x < 8 * 64 + 8 && s.z >= 8 * 40 - 8 && s.z < 8 * 64 + 8;

describe("selectSites: reachability", () => {
  const rules = { ...BUILTIN_RULES.sites, minSpacingM: 60, waterRangeM: [1, 1e7] as [number, number], minPressurePermille: 0 };

  it("a plateau ringed by cliffs passes relief but is not a site: nobody can walk up to it", () => {
    const t = plateauWorld();
    const lenient = selectSites(t, { ...rules, requireReachable: false }, 200, 40);
    assert.ok(lenient.some(onPlateau), "without the walk rule the plateau is a site (it is flat and low)");
    const strict = selectSites(t, rules, 200, 40);
    assert.ok(strict.length > 0, "the plain around it is still a site");
    assert.ok(!strict.some(onPlateau), "no site on the stranded plateau");
  });

  it("a ramp up the plateau makes it reachable again", () => {
    const t = plateauWorld();
    for (let k = 0; k < 7; k++) for (let dz = 0; dz < 3; dz++) t.height[(50 + dz) * 80 + 39 - k] = 34 - 2 * (k + 1); // 14 deg ramp, 3 cells wide
    assert.ok(selectSites(t, rules, 200, 40).some(onPlateau));
  });

  it("walks from the spawn when the world has one, else from the largest land", () => {
    const t = plateauWorld();
    // a spawn on the plateau makes the plateau the reachable land, and the plain around it the stranded one
    const fromPlateau = selectSites({ ...t, spawn: { x: 8 * 52, z: 8 * 52 } }, rules, 200, 40);
    assert.ok(fromPlateau.length > 0 && fromPlateau.every(onPlateau), "only the spawn's land");
    const fromPlain = selectSites({ ...t, spawn: { x: 100, z: 100 } }, rules, 200, 40);
    assert.ok(fromPlain.length > 0 && !fromPlain.some(onPlateau));
  });

  it("a steeper walk limit is data: with 80 degrees the cliffs are climbable", () => {
    assert.ok(selectSites(plateauWorld(), { ...rules, walkSlopeDeg: 80 }, 200, 40).some(onPlateau));
  });

  it("the sea is not walkable: land cut off by water is stranded too", () => {
    const t = plateauWorld();
    for (let z = 0; z < 80; z++) for (let x = 20; x < 24; x++) t.water[z * 80 + x] = 1; // a strait down the west side
    const s = selectSites(t, rules, 200, 40);
    assert.ok(s.length > 0 && s.every((site) => site.x > 24 * 8), "west of the strait is not reachable from the larger east");
  });
});
