/**
 * Whole-world terrain: the spec, the coarse survey (landmass, erosion,
 * water, climate, emergent biomes), the fine heights built on it, and the
 * bake into world.db + the SurrealDB catalog. Small worlds (512 m, 1 km)
 * keep it fast; the default 4 km world runs the same code.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { decodeWorldMap, HeightGrid, type TerrainTile } from "@mmo-engine/protocol";
import { TerrainTileStore } from "../../src/persist/terrain-tiles.js";
import { closeWorldCatalogs, readCatalogSummary, rocksdbUrl } from "../../src/persist/world-catalog.js";
import { classifyBiomes, smoothBiomes, type BiomeInputs } from "../../src/terrain/biomes.js";
import { thermalErosion } from "../../src/terrain/erosion.js";
import { glaciate } from "../../src/terrain/glaciers.js";
import { labelComponents } from "../../src/terrain/grid-ops.js";
import { findLakes } from "../../src/terrain/hydrology.js";
import { coastFrame } from "../../src/terrain/landmass.js";
import { fillDepressions, LAKE, LAND, SEA, surveyWorld, type CoarseGrid, type Survey } from "../../src/terrain/survey.js";
import { bakeWorldTerrain, regionOf, spawnPoint } from "../../src/terrain/world-bake.js";
import { WorldHeights } from "../../src/terrain/world-heights.js";
import { worldInfoFor } from "../../src/terrain/world-info.js";
import { parseWorldSpec, windVector, worldBounds } from "../../src/terrain/world-spec.js";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mmo-world-"));

const SMALL_WORLD = {
  name: "small",
  seed: 77,
  sizeChunks: 32,
  regionsPerSide: 2,
  land: { coast: { wander: 40, wanderScale: 150 }, rise: 15, riseDistance: 200, relief: 6, reliefScale: 300, shelfWidth: 60, minIslandArea: 2000 },
  ranges: { count: 1, spurs: 0, height: 120, width: 140, length: 300, ridgeScale: 120, coastClearance: 60 },
  climate: { dryDistance: 800, orographic: 0.01 },
  erosion: { droplets: 3000, thermalPasses: 10, fluvialPasses: 4 },
  rivers: { minCatchment: 20_000, maxDepth: 3 },
  lakes: { minArea: 2000 },
  minBiomeArea: 1000,
  biomes: [
    { id: "sea", when: { water: "sea" }, roughness: 0.2 },
    { id: "lake", when: { water: "lake" }, roughness: 0.1 },
    { id: "mountains", when: { height: { min: 60 } }, surface: { shape: "ridged", relief: 4, scale: 60 }, roughness: 1 },
    { id: "desert", when: { rainMm: { max: 400 } }, surface: { shape: "dunes", relief: 3, scale: 30 }, roughness: 0.3 },
    { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
  ],
};
const SMALL = parseWorldSpec(SMALL_WORLD);

describe("world spec", () => {
  test("defaults, bounds, and validation", () => {
    assert.equal(SMALL.chunkWorldSize, 16);
    assert.deepEqual(worldBounds(parseWorldSpec({ ...SMALL_WORLD, sizeChunks: 250 })), {
      minChunk: -125,
      maxChunk: 124,
      min: -2000,
      max: 2000,
    });
    // Nested sections take their defaults.
    const bare = parseWorldSpec({ name: "bare", seed: 1, sizeChunks: 4, biomes: [{ id: "plains", roughness: 0.5 }] });
    assert.equal(bare.land.coast.side, "south");
    assert.equal(bare.land.coast.waterEdge, 0.6);
    assert.equal(bare.climate.wind, "south-west");
    assert.equal(bare.erosion.talusDeg, 38);

    const biomes = SMALL_WORLD.biomes;
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, sizeChunks: 33 }), /divisible by regionsPerSide/);
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, biomes: biomes.slice(0, -1) }), /must be a catch-all/);
    assert.throws(
      () => parseWorldSpec({ ...SMALL_WORLD, biomes: [{ id: "early", roughness: 0 }, ...biomes] }),
      /could never form/,
    );
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, biomes: [biomes[0], ...biomes] }), /duplicate biome id/);
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, spawn: { biome: "tundra" } }), /not one of the world's biomes/);
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, land: { coast: { waterEdge: 0.9 } } }));
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, land: { coast: { waterEdge: 0.6, tip: 0.2 } } }), /must reach past/);
  });

  test("the wind blows away from where it comes from", () => {
    const sw = windVector("south-west");
    assert.ok(sw.x > 0 && sw.z < 0, "a south-westerly blows north-east (+x, -z)");
    assert.ok(Math.abs(Math.hypot(sw.x, sw.z) - 1) < 1e-12);
    assert.deepEqual(windVector("south"), { x: 0, z: -1 });
  });

  test("regionOf splits the world into regionsPerSide^2 equal squares", () => {
    assert.deepEqual(regionOf(SMALL, -16, -16), [0, 0]);
    assert.deepEqual(regionOf(SMALL, -1, 0), [0, 1]);
    assert.deepEqual(regionOf(SMALL, 15, 15), [1, 1]);
  });
});

describe("survey", () => {
  test("fillDepressions: every inner cell drains to a strictly lower neighbour", () => {
    const grid: CoarseGrid = { width: 12, depth: 10, cell: 8, originX: 0, originZ: 0 };
    // A bowl with a deeper pit inside, plus noise: many enclosed hollows.
    const h = Float32Array.from({ length: 120 }, (_, i) => {
      const u = i % 12;
      const v = Math.floor(i / 12);
      return Math.hypot(u - 6, v - 5) * 3 - (u === 4 && v === 4 ? 20 : 0) + ((i * 7919) % 13) * 0.1;
    });
    const filled = fillDepressions(h, grid);
    for (let v = 1; v < 9; v++) {
      for (let u = 1; u < 11; u++) {
        const i = v * 12 + u;
        assert.ok(filled[i] >= h[i], "filling only raises");
        let lower = false;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dz) && filled[(v + dz) * 12 + u + dx] < filled[i]) lower = true;
        }
        assert.ok(lower, `cell (${u},${v}) has an exit`);
      }
    }
  });

  test("deterministic, and every cell gets a biome", () => {
    const a = surveyWorld(SMALL);
    const b = surveyWorld(SMALL);
    for (const key of ["height", "roughness", "biome", "region", "moisture", "rain", "temperature", "water", "flow", "river"] as const) {
      assert.deepStrictEqual(a[key], b[key], `${key} is reproducible`);
    }
    for (const v of a.height) assert.ok(Number.isFinite(v));
    assert.ok(a.biome.every((x) => x < SMALL.biomes.length));
    // Different seed, different world.
    const c = surveyWorld(parseWorldSpec({ ...SMALL_WORLD, seed: 78 }));
    assert.notDeepStrictEqual(c.height, a.height);
  });
});

/** Cells inside the world's edges, with their coast frame. */
function worldCells(s: Survey): Array<{ i: number; t: number; a: number }> {
  const b = worldBounds(s.spec);
  const out: Array<{ i: number; t: number; a: number }> = [];
  for (let v = 0; v < s.grid.depth; v++) {
    const z = s.grid.originZ + v * s.grid.cell;
    for (let u = 0; u < s.grid.width; u++) {
      const x = s.grid.originX + u * s.grid.cell;
      if (x < b.min || z < b.min || x >= b.max || z >= b.max) continue;
      out.push({ i: v * s.grid.width + u, ...coastFrame(s.spec, x, z) });
    }
  }
  return out;
}

describe("survey: land and water", () => {
  const small = surveyWorld(SMALL);

  test("a peninsula: sea on the south edge and the lower sides, land along the north", () => {
    const cells = worldCells(small);
    const edge = (c: { t: number; a: number }): boolean => c.t < 0.02 || c.t > 0.98 || Math.abs(c.a) > 0.97;
    const share = (pick: (c: { t: number; a: number }) => boolean): number => {
      const e = cells.filter((c) => edge(c) && pick(c));
      return e.filter((c) => small.water[c.i] === SEA).length / e.length;
    };
    assert.equal(share((c) => c.t < 0.02), 0, "the north edge is land");
    assert.equal(share((c) => c.t > 0.98), 1, "the south edge is sea");
    assert.equal(share((c) => Math.abs(c.a) > 0.97 && c.t < 0.2), 0, "the upper sides are land");
    assert.equal(share((c) => Math.abs(c.a) > 0.97 && c.t > 0.45), 1, "the lower sides are sea");
    const land = cells.filter((c) => small.water[c.i] !== SEA).length / cells.length;
    assert.ok(land > 0.4 && land < 0.75, `land share ${land.toFixed(2)}`);
    assert.ok(Math.abs(land - small.stats.landFraction) < 1e-9);
  });

  test("one landmass, sea below sea level, land above it", () => {
    const { grid, water, height } = small;
    const parts = labelComponents(grid.width, grid.depth, (i) => water[i] !== SEA);
    const total = parts.sizes.reduce((a, b) => a + b, 0);
    assert.ok(Math.max(...parts.sizes) / total > 0.95, "the land is one piece (tiny islands sink)");
    for (let i = 0; i < water.length; i++) {
      if (water[i] === SEA) assert.ok(height[i] < 0, `sea cell ${i} above sea level`);
      if (water[i] === LAND && !small.river[i]) assert.ok(height[i] >= 0.3 - 1e-4, `land cell ${i} below the shore margin`);
      if (water[i] === LAKE) assert.ok(height[i] <= small.waterLevel[i], `lake cell ${i} above its water`);
    }
  });

  test("lakes form in wet hollows; dry hollows stay dry", () => {
    const grid: CoarseGrid = { width: 20, depth: 20, cell: 8, originX: 0, originZ: 0 };
    const h = Float32Array.from({ length: 400 }, (_, i) => 10 + Math.max(0, 40 - Math.hypot((i % 20) - 10, Math.floor(i / 20) - 10) ** 2) * -0.1);
    const filled = fillDepressions(h, grid);
    const noSea = new Uint8Array(400);
    const opts = { minDepth: 0.8, minArea: 1000, minRainMm: 350 };
    const wet = findLakes(h, filled, grid, noSea, new Float32Array(400).fill(900), opts);
    const dry = findLakes(h, filled, grid, noSea, new Float32Array(400).fill(150), opts);
    const lakeCells = wet.lake.reduce((a, b) => a + b, 0);
    assert.ok(lakeCells * 64 >= 1000, `a lake formed (${lakeCells} cells)`);
    assert.equal(wet.level[10 * 20 + 10], filled[10 * 20 + 10], "at the hollow's spill level");
    assert.equal(dry.lake.reduce((a, b) => a + b, 0), 0, "too dry for a lake");
    assert.equal(findLakes(h, filled, grid, noSea, new Float32Array(400).fill(900), { ...opts, minDepth: 50 }).lake.reduce((a, b) => a + b, 0), 0, "too shallow");
  });

  test("glaciers: ice where it's cold and snowy, melting downhill, carving a valley, leaving a moraine", () => {
    // A long slope, 200 m high at the north (v = 0) down to the sea at the south.
    const grid: CoarseGrid = { width: 30, depth: 120, cell: 8, originX: 0, originZ: 0 };
    const N = 30 * 120;
    // A V across it so the ice gathers into one valley glacier down the middle.
    const slope = (): Float32Array => Float32Array.from({ length: N }, (_, i) => 200 - Math.floor(i / 30) * 1.8 + Math.abs((i % 30) - 15) * 3);
    const h = slope();
    const tempC = h.map((z) => 10 - z * 0.08); // -6 °C at the top, +8 °C at the bottom
    const spec = parseWorldSpec({ ...SMALL_WORLD, glaciers: { passes: 3 } });
    const wet = glaciate(spec, grid, h, tempC, new Float32Array(N).fill(1500), () => false);
    const iceAt = (row: number): number => wet.ice.slice(row * 30, row * 30 + 30).reduce((a, b) => a + b, 0);
    assert.ok(iceAt(2) > 0, "ice in the cold, snowy heights");
    assert.equal(iceAt(110), 0, "none down in the warm lowland");
    assert.ok(wet.melt.reduce((a, b) => a + b, 0) > 0, "the ice melts on its way down");
    assert.ok(wet.snouts > 0, "the glacier ends in a snout");
    assert.ok(wet.deepestCutM > 0.2, `ice carved ${wet.deepestCutM.toFixed(2)} m`);
    // The valley is cut deepest under the glacier's centre line (column 15).
    const cutAt = (u: number): number => slope()[10 * 30 + u] - h[10 * 30 + u];
    assert.ok(cutAt(15) > cutAt(3) + 0.1, `centre cut ${cutAt(15).toFixed(2)} m vs flank ${cutAt(3).toFixed(2)} m`);
    const raised = h.some((z, i) => z > slope()[i] + 0.5 && !wet.ice[i]);
    assert.ok(raised, "a moraine stands beyond the ice");

    const dry = glaciate(spec, grid, slope(), tempC, new Float32Array(N).fill(200), () => false);
    assert.equal(dry.ice.reduce((a, b) => a + b, 0), 0, "too little snow: bare cold ground (tundra), no ice");
  });

  test("thermal erosion relaxes slopes to the angle of repose and keeps the ground", () => {
    const grid: CoarseGrid = { width: 24, depth: 24, cell: 8, originX: 0, originZ: 0 };
    const h = Float32Array.from({ length: 576 }, (_, i) => ((i % 24) - 12) ** 2 + (Math.floor(i / 24) - 12) ** 2 < 9 ? 80 : 0);
    const before = h.reduce((a, b) => a + b, 0);
    thermalErosion(h, grid, 35, 400);
    const limit = Math.tan((35 * Math.PI) / 180) * 8;
    let steepest = 0;
    for (let v = 1; v < 23; v++) for (let u = 1; u < 23; u++) {
      const i = v * 24 + u;
      steepest = Math.max(steepest, Math.abs(h[i] - h[i + 1]), Math.abs(h[i] - h[i + 24]));
    }
    assert.ok(steepest <= limit * 1.1, `steepest step ${steepest.toFixed(2)} m vs ${limit.toFixed(2)} m`);
    assert.ok(Math.abs(h.reduce((a, b) => a + b, 0) - before) < before * 1e-5, "material moves, none is lost");
  });
});

describe("survey: climate and biomes", () => {
  // 1 km, one range across a south wind: the rain shadow falls north of it.
  const MID = parseWorldSpec({
    ...SMALL_WORLD,
    name: "mid",
    seed: 5,
    sizeChunks: 64,
    land: { ...SMALL_WORLD.land, coast: { wander: 60, wanderScale: 250 }, riseDistance: 400 },
    ranges: { count: 1, spurs: 0, height: 200, width: 260, length: 600, ridgeScale: 200, coastClearance: 100 },
    climate: { wind: "south", dryDistance: 1500, orographic: 0.012, inlandCoolingCurve: 2 },
  });
  const mid = surveyWorld(MID);

  test("the wind drops its rain on the windward side of a range; the lee is dry", () => {
    assert.equal(mid.ranges.length, 1);
    const axis = mid.ranges[0].points;
    const wind = windVector(MID.climate.wind);
    const { grid } = mid;
    const band = (lo: number, hi: number): number[] => {
      const rain: number[] = [];
      for (let i = 0; i < mid.rain.length; i++) {
        if (mid.water[i] !== LAND) continue;
        const x = grid.originX + (i % grid.width) * grid.cell;
        const z = grid.originZ + Math.floor(i / grid.width) * grid.cell;
        let best = 0;
        let bestD = Infinity;
        axis.forEach((p, k) => {
          const d = Math.hypot(x - p.x, z - p.z);
          if (d < bestD) [best, bestD] = [k, d];
        });
        if (best < 3 || best > axis.length - 4) continue; // away from the range's ends
        const downwind = (x - axis[best].x) * wind.x + (z - axis[best].z) * wind.z;
        if (downwind >= lo && downwind <= hi) rain.push(mid.rain[i]);
      }
      return rain;
    };
    const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
    const windward = band(-240, -120);
    const lee = band(120, 240);
    assert.ok(windward.length > 20 && lee.length > 20);
    assert.ok(mean(lee) < 0.6 * mean(windward), `lee ${mean(lee).toFixed(0)} mm vs windward ${mean(windward).toFixed(0)} mm`);
  });

  test("temperature: warmest by the sea, cooling inland and with height", () => {
    const C = MID.climate;
    for (const { i, t } of worldCells(mid)) {
      if (mid.water[i] !== LAND) continue;
      const inland = Math.pow(1 - Math.min(1, Math.max(0, t)), C.inlandCoolingCurve);
      const expected = C.seaTempC - C.inlandCoolingC * inland - (C.lapseCPerKm * mid.height[i]) / 1000;
      assert.ok(Math.abs(mid.temperature[i] - expected) < 0.5, `cell ${i}: ${mid.temperature[i]} vs ${expected}`);
    }
  });

  test("biomes form where their rules say, water biomes on the water", () => {
    const id = (i: number): string => MID.biomes[mid.biome[i]].id;
    let desert = 0;
    let dryDesert = 0;
    for (let i = 0; i < mid.biome.length; i++) {
      if (mid.water[i] === SEA) assert.equal(id(i), "sea");
      if (mid.water[i] === LAKE) assert.equal(id(i), "lake");
      if (mid.water[i] === LAND) assert.ok(!["sea", "lake"].includes(id(i)), `land cell ${i} is ${id(i)}`);
      if (id(i) === "desert") {
        desert++;
        if (mid.rain[i] <= 450) dryDesert++; // smoothing may pull a few border cells in
      }
    }
    assert.ok(desert > 0, "the rain shadow grew a desert");
    assert.ok(dryDesert / desert > 0.85, `${dryDesert}/${desert} desert cells are dry`);
    assert.ok(mid.regions.every((r) => r.cells > 0));
  });

  test("ranges connect: spurs grow out of the chain at an angle", () => {
    const branched = surveyWorld(parseWorldSpec({ ...MID, ranges: { ...MID.ranges, spurs: 3, spurLength: 400 } }));
    const chains = branched.ranges.filter((r) => !r.spur);
    const spurs = branched.ranges.filter((r) => r.spur);
    assert.equal(chains.length, 1);
    assert.ok(spurs.length >= 2, `${spurs.length} spurs fit`);
    for (const spur of spurs) {
      const root = spur.points[0];
      const parent = branched.ranges.find((r) => r !== spur && r.points.some((p) => p.x === root.x && p.z === root.z));
      assert.ok(parent, "a spur starts on another range's axis");
      const k = parent.points.findIndex((p) => p.x === root.x && p.z === root.z);
      const along = Math.atan2(parent.points[k + 1].z - parent.points[k - 1].z, parent.points[k + 1].x - parent.points[k - 1].x);
      const out = Math.atan2(spur.points[1].z - root.z, spur.points[1].x - root.x);
      const angle = Math.abs(((out - along + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      const off = Math.min(angle, Math.PI - angle);
      assert.ok(off >= (25 * Math.PI) / 180, `spur leaves at ${((off * 180) / Math.PI).toFixed(0)}°, not along the chain`);
      assert.ok(spur.height < parent.height && spur.width < parent.width, "spurs are lower and narrower");
    }
  });

  test("a volcano: the highest peak, a crater at its top, a warm vent", () => {
    const withVolcano = parseWorldSpec({ ...MID, volcano: { count: 1, height: 300, radius: 250, craterRadius: 40, craterDepth: 25, heatC: 12 } });
    const v = surveyWorld(withVolcano);
    assert.equal(v.volcanoes.length, 1);
    const { grid } = v;
    let top = 0;
    for (let i = 1; i < v.height.length; i++) if (v.height[i] > v.height[top]) top = i;
    assert.ok(v.ventDistance[top] < 250, `the highest cell is on the cone (${v.ventDistance[top].toFixed(0)} m from the vent)`);
    const vent = v.volcanoes[0];
    const at = (x: number, z: number): number =>
      Math.round((z - grid.originZ) / grid.cell) * grid.width + Math.round((x - grid.originX) / grid.cell);
    assert.ok(v.height[at(vent.x, vent.z)] < v.height[top] - 10, "the vent sits in a crater below the rim");
    const noHeat = parseWorldSpec({ ...withVolcano, volcano: { ...withVolcano.volcano, heatC: 0 } });
    const warm = v.temperature[at(vent.x, vent.z)];
    const plain = surveyWorld(noHeat).temperature[at(vent.x, vent.z)];
    assert.ok(Math.abs(warm - plain - 12) < 0.5, `vent heat ${(warm - plain).toFixed(1)} °C`);
  });

  test("spawn: on dry land in the spawn biome, off the rivers", () => {
    const sp = spawnPoint(MID, mid);
    assert.equal(sp.biome, "plains");
    const g = mid.grid;
    const i = Math.round((sp.z - g.originZ) / g.cell) * g.width + Math.round((sp.x - g.originX) / g.cell);
    assert.equal(mid.water[i], LAND);
    assert.equal(mid.river[i], 0);
    assert.equal(MID.biomes[mid.biome[i]].id, "plains");
  });
});

describe("biome rules", () => {
  const spec = parseWorldSpec({
    ...SMALL_WORLD,
    biomes: [
      { id: "sea", when: { water: "sea" }, roughness: 0 },
      { id: "volcanic", when: { volcanoDistance: { max: 100 } }, roughness: 0 },
      { id: "glacier", when: { ice: { min: 1 } }, roughness: 0 },
      { id: "swamp", when: [{ freshwaterDistance: { max: 50 }, height: { max: 3 } }, { seaExposure: { max: 0.2 }, coastDistance: { max: 60 } }], roughness: 0 },
      { id: "desert", when: { rainMm: { max: 300 } }, roughness: 0 },
      { id: "plains", roughness: 0 },
    ],
  });
  const inputs = (n: number, over: Partial<Record<keyof BiomeInputs, number[]>>): BiomeInputs => {
    const f = (k: keyof BiomeInputs, d: number) => Float32Array.from(over[k] ?? new Array(n).fill(d));
    return {
      water: Uint8Array.from(over.water ?? new Array(n).fill(LAND)),
      tempC: f("tempC", 15),
      rainMm: f("rainMm", 900),
      height: f("height", 20),
      slopeDeg: f("slopeDeg", 2),
      coastDistance: f("coastDistance", 1000),
      waterDistance: f("waterDistance", 1000),
      freshwaterDistance: f("freshwaterDistance", 1000),
      seaExposure: f("seaExposure", 0),
      ice: Uint8Array.from(over.ice ?? new Array(n).fill(0)),
      volcanoDistance: f("volcanoDistance", Infinity),
    };
  };
  const ids = (b: Uint8Array): string[] => [...b].map((k) => spec.biomes[k].id);

  test("first match wins; any alternative is enough; the catch-all takes the rest", () => {
    const f = inputs(8, {
      water: [SEA, LAND, LAND, LAND, LAND, LAND, LAND, LAND],
      rainMm: [100, 100, 900, 900, 100, 900, 900, 900],
      freshwaterDistance: [10, 10, 10, 1000, 1000, 1000, 1000, 1000],
      height: [0, 2, 10, 2, 20, 20, 20, 20],
      coastDistance: [0, 1000, 1000, 40, 1000, 1000, 1000, 1000],
      seaExposure: [1, 0, 0, 0.1, 0, 0, 0, 0],
      ice: [0, 0, 0, 0, 0, 0, 1, 1],
      volcanoDistance: [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, 50],
    });
    assert.deepEqual(ids(classifyBiomes(spec, f)), ["sea", "swamp", "plains", "swamp", "desert", "plains", "glacier", "volcanic"]);
  });

  test("smoothing removes specks and small patches but never touches water", () => {
    const W = 12;
    const D = 12;
    const biome = new Uint8Array(W * D).fill(5); // plains
    const water = new Uint8Array(W * D);
    biome[5 * W + 5] = 4; // a one-cell desert speck
    for (let u = 0; u < W; u++) [biome[u], water[u]] = [0, SEA]; // a sea row
    smoothBiomes(biome, water, W, D, 4);
    assert.equal(biome[5 * W + 5], 5, "the speck joins the plains");
    for (let u = 0; u < W; u++) assert.equal(biome[u], 0, "the sea stays sea");
  });
});

describe("WorldHeights", () => {
  test("every chunk of the world meets its neighbours exactly", () => {
    const heights = new WorldHeights(surveyWorld(SMALL));
    const { minChunk, maxChunk } = worldBounds(SMALL);
    const tiles: TerrainTile[] = [];
    for (let cz = minChunk; cz <= maxChunk; cz++) {
      for (let cx = minChunk; cx <= maxChunk; cx++) {
        const out = new Float32Array(256);
        heights.generateChunk(0n, cx, cz, 0, out);
        tiles.push({ cx, cz, heights: out });
      }
    }
    // Throws on any shared sample two tiles disagree on.
    const grid = HeightGrid.fromTiles(tiles);
    assert.equal(grid.chunkCoords().length, 32 * 32);
  });
});

describe("bakeWorldTerrain", () => {
  test("tiles, survey maps, and the SurrealDB catalog", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "world.db");
    const catalogDir = path.join(dir, "surreal");
    const report = await bakeWorldTerrain(SMALL, { dbPath, catalogDir });
    assert.equal(report.chunks, 32 * 32);
    assert.ok(report.heightRange.max > report.heightRange.min);

    const store = new TerrainTileStore(dbPath);
    try {
      assert.equal(store.count(), 32 * 32);
      const area = store.getRange(-2, -1, 1, 1);
      assert.equal(area.length, 4 * 3);
      assert.ok(area.every((t) => t.cx >= -2 && t.cx <= 1 && t.cz >= -1 && t.cz <= 1));
      assert.equal(store.getRange(100, 100, 110, 110).length, 0, "outside the world");
      const elevation = store.getMap("elevation");
      const biome = store.getMap("biome");
      assert.ok(elevation && elevation.data instanceof Float32Array);
      assert.ok(biome && biome.data instanceof Uint8Array);
      assert.ok(store.getMap("rain")?.data instanceof Float32Array);
      assert.ok(store.getMap("temperature")?.data instanceof Float32Array);
      assert.ok(store.getMap("water")?.data instanceof Uint8Array);
      assert.equal(elevation.data.length, elevation.width * elevation.depth);
      assert.equal(store.getMap("nope"), null);
    } finally {
      store.close();
    }

    // The catalog lands exactly where asked (the engine's URL parsing has
    // mangled paths before: drive letters, "..").
    assert.ok(fs.existsSync(catalogDir), "catalog directory created in place");
    // Same process as the write: the shared connection is reused (the
    // engine can't reopen a store it closed).
    try {
      const catalog = await readCatalogSummary(rocksdbUrl(catalogDir));
      assert.equal(catalog.chunks, 32 * 32);
      assert.equal(catalog.regions, 4);
      assert.equal(Object.values(catalog.biomes).reduce((a, b) => a + b, 0), 32 * 32);
      const c = await catalog.chunk(15, -16);
      assert.ok(c);
      assert.deepEqual(c.region, [1, 0]);
      assert.ok(c.maxHeight >= c.minHeight);
    } finally {
      await closeWorldCatalogs();
    }
    // After closing, reconnecting fails fast instead of hanging.
    await assert.rejects(readCatalogSummary(rocksdbUrl(catalogDir)), /can't reopen/);
  });
});

describe("worldInfoFor (the welcome's world map)", () => {
  test("16 m map of the baked survey, with bounds and biome ids", { timeout: 120_000 }, async () => {
    const dbPath = path.join(tmpDir(), "world.db");
    await bakeWorldTerrain(SMALL, { dbPath, catalogDir: null });
    const meta = new Map<string, string>([
      ["world_bounds", JSON.stringify({ minChunk: -16, maxChunk: 15 })],
      ["world_spec", "small"],
      ["world_biomes", JSON.stringify(SMALL.biomes.map((b) => b.id))],
    ]);
    const store = new TerrainTileStore(dbPath);
    try {
      const info = worldInfoFor({ getMeta: (k) => meta.get(k) ?? null }, store, 16);
      assert.ok(info);
      assert.deepEqual(info.bounds, { minCx: -16, minCz: -16, maxCx: 15, maxCz: 15 });
      assert.deepEqual(info.map.biomes, ["sea", "lake", "mountains", "desert", "plains"]);
      const map = decodeWorldMap(info.map);
      const survey = store.getMap("elevation")!;
      assert.equal(map.cell, 16);
      assert.equal(map.width, Math.floor(survey.width / 2));
      // Cell (u, v) is the mean of survey cells 2u..2u+1, 2v..2v+1, placed at their centre.
      const [u, v] = [20, 13];
      const s = (du: number, dv: number): number => survey.data[(2 * v + dv) * survey.width + 2 * u + du];
      const mean = (s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1)) / 4;
      assert.ok(Math.abs(map.heights[v * map.width + u] - mean) < 0.01);
      assert.equal(map.originX + u * map.cell, survey.originX + (2 * u + 0.5) * survey.cell);
      assert.ok(map.biome.every((b) => b < SMALL.biomes.length));
      assert.equal(worldInfoFor({ getMeta: () => null }, store, 16), null, "legacy world: none");
    } finally {
      store.close();
    }
  });
});

describe("TerrainTileStore storage", () => {
  test("migrates a WITHOUT ROWID tile table in place (tiles kept)", () => {
    const dbPath = path.join(tmpDir(), "world.db");
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TABLE terrain_tiles (cx INTEGER NOT NULL, cz INTEGER NOT NULL, heights BLOB NOT NULL, PRIMARY KEY (cx, cz)) WITHOUT ROWID",
    );
    const heights = Float32Array.from({ length: 256 }, (_, i) => i * 0.5);
    raw.prepare("INSERT INTO terrain_tiles VALUES (?, ?, ?)").run(3, -4, Buffer.from(heights.buffer));
    raw.close();

    const store = new TerrainTileStore(dbPath);
    assert.deepStrictEqual(store.get(3, -4), heights);
    store.putMany([{ cx: 0, cz: 0, heights }]);
    assert.equal(store.count(), 2);
    store.close();

    const check = new Database(dbPath, { readonly: true });
    const { sql } = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'terrain_tiles'").get() as { sql: string };
    check.close();
    assert.doesNotMatch(sql, /WITHOUT\s+ROWID/i);
  });

  test("survey maps round-trip each dtype", () => {
    const store = new TerrainTileStore(path.join(tmpDir(), "world.db"));
    const base = { width: 3, depth: 2, cell: 8, originX: -24, originZ: 16 };
    store.putMap("f", { ...base, data: Float32Array.of(1.5, -2, 3, 4, 5, 6) });
    store.putMap("b", { ...base, data: Uint8Array.of(0, 1, 2, 3, 4, 255) });
    store.putMap("s", { ...base, data: Uint16Array.of(0, 1, 2, 3, 4, 65535) });
    assert.deepStrictEqual(store.getMap("f"), { ...base, data: Float32Array.of(1.5, -2, 3, 4, 5, 6) });
    assert.deepStrictEqual(store.getMap("b"), { ...base, data: Uint8Array.of(0, 1, 2, 3, 4, 255) });
    assert.deepStrictEqual(store.getMap("s"), { ...base, data: Uint16Array.of(0, 1, 2, 3, 4, 65535) });
    store.putMap("f", { ...base, data: Float32Array.of(0, 0, 0, 0, 0, 7) });
    assert.equal(store.getMap("f")?.data[5], 7, "replaced");
    store.close();
  });
});
