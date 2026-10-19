/**
 * Island topology (land.coast.shape = "island"): one main island with open
 * sea on every edge, optional satellites offshore, deterministic per seed.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { landMask } from "../../src/terrain/landmass.js";
import { parseWorldSpec } from "../../src/terrain/world-spec.js";
import type { CoarseGrid } from "../../src/terrain/survey.js";

const grid: CoarseGrid = { width: 100, depth: 100, cell: 40, originX: -2000, originZ: -2000 };
const flat = new Float32Array(grid.width * grid.depth);
const BIOMES = [
  { id: "sea", when: { water: "sea" }, roughness: 0.2 },
  { id: "lake", when: { water: "lake" }, roughness: 0.1 },
  { id: "plains", surface: { shape: "rolling", relief: 3, scale: 150 }, roughness: 0.4 },
];
const make = (coast: Record<string, unknown>, seed = 5) =>
  parseWorldSpec({ name: "isle", seed, sizeChunks: 250, biomes: BIOMES, land: { coast: { shape: "island", wander: 100, ...coast } } });
const mask = (coast: Record<string, unknown>, seed = 5) => landMask(make(coast, seed), grid, flat, flat);
const count = (m: Uint8Array) => m.reduce((n, c) => n + c, 0);

describe("island topology", () => {
  test("every edge of the world is open sea", () => {
    const m = mask({ islandRadius: 0.8, satellites: 4 });
    const W = grid.width;
    for (let k = 0; k < W; k++) {
      assert.equal(m[k], 0);
      assert.equal(m[(grid.depth - 1) * W + k], 0);
      assert.equal(m[k * W], 0);
      assert.equal(m[k * W + W - 1], 0);
    }
    assert.ok(count(m) > 0);
  });

  test("a bigger radius makes more land", () => {
    assert.ok(count(mask({ islandRadius: 0.9 })) > count(mask({ islandRadius: 0.5 })));
  });

  test("satellites add land beyond the main island and the same seed repeats", () => {
    const bare = mask({ islandRadius: 0.5, satellites: 0 });
    const withSats = mask({ islandRadius: 0.5, satellites: 8 });
    assert.ok(count(withSats) > count(bare));
    assert.deepEqual(mask({ islandRadius: 0.5, satellites: 8 }), withSats);
    assert.notDeepEqual(mask({ islandRadius: 0.5, satellites: 8 }, 6), withSats);
  });

  test("the peninsula stays the default shape", () => {
    assert.equal(parseWorldSpec({ name: "p", seed: 1, sizeChunks: 64, biomes: BIOMES }).land.coast.shape, "peninsula");
  });
});
