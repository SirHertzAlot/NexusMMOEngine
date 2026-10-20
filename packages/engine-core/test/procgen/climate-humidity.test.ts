/**
 * The global humidity dial (climate.humidity) scales the rain that falls
 * over a synthetic land grid: more humidity, more rain; less, less. At the
 * default of 1 the output is the spec's own rainfall.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { rainfall } from "../../src/terrain/climate.js";
import { parseWorldSpec } from "../../src/terrain/world-spec.js";
import type { CoarseGrid } from "../../src/terrain/survey.js";

const grid: CoarseGrid = { width: 40, depth: 40, cell: 200, originX: 0, originZ: 0 };
// Flat ground; the first row is open sea, the rest land.
const height = new Float32Array(grid.width * grid.depth).fill(10);
const water = (i: number): boolean => i < grid.width;

const BIOMES = [
  { id: "sea", when: { water: "sea" }, roughness: 0.2 },
  { id: "lake", when: { water: "lake" }, roughness: 0.1 },
  { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
];

const totalRain = (humidity?: number): number => {
  const spec = parseWorldSpec({
    name: "humidity",
    seed: 3,
    sizeChunks: 64,
    biomes: BIOMES,
    climate: humidity === undefined ? {} : { humidity },
  });
  const { rainMm } = rainfall(spec, grid, height, water);
  let sum = 0;
  for (const r of rainMm) sum += r;
  return sum;
};

describe("climate humidity dial", () => {
  test("more humidity brings more rain, less brings less", () => {
    const dry = totalRain(0.5);
    const base = totalRain();
    const wet = totalRain(1.5);
    assert.ok(dry > 0, "a dry world still gets some rain");
    assert.ok(dry < base, `dry ${dry} should be below the default ${base}`);
    assert.ok(wet > base, `wet ${wet} should be above the default ${base}`);
  });

  test("the default humidity is the spec's own rainfall", () => {
    assert.equal(totalRain(1), totalRain());
  });

  test("the dial is capped at 2", () => {
    assert.throws(() => parseWorldSpec({ name: "humidity", seed: 3, sizeChunks: 64, biomes: BIOMES, climate: { humidity: 2.5 } }));
  });
});
