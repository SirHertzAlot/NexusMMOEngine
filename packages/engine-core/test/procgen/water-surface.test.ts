import test from "node:test";
import assert from "node:assert/strict";
import { waterSurfaceFromMaps } from "../../src/index.js";
import { LAND, SEA } from "../../src/terrain/hydrology.js";

/** 3×2 cells of 8 m from (0, 0): a lake at 5 m in the west, land, the sea at 0 in the east. */
const grid = { width: 3, depth: 2, cell: 8, originX: 0, originZ: 0 };

test("water_level: the highest surface among the four cells around a point", () => {
  const level = { ...grid, data: Float32Array.from([5, NaN, 0, 5, NaN, 0]) };
  const at = waterSurfaceFromMaps({ level, water: null }, 0)!;
  assert.equal(at(1, 4), 5, "on the lake");
  assert.equal(at(4, 4), 5, "between the lake and the land: the lake reaches its shore");
  assert.equal(at(12, 4), 0, "between the land and the sea: the sea's shore");
  assert.equal(at(20, 4), 0, "the sea");
  assert.equal(at(-20, 4), null, "off the map");
});

test("worlds baked before water_level fall back to the sea from the water map", () => {
  const water = { ...grid, data: Uint8Array.from([LAND, LAND, SEA, LAND, LAND, SEA]) };
  const at = waterSurfaceFromMaps({ level: null, water }, -2)!;
  assert.equal(at(1, 4), null, "lakes aren't known");
  assert.equal(at(12, 4), -2);
  assert.equal(waterSurfaceFromMaps({ level: null, water: null }, 0), null, "no maps, no water");
});
