/**
 * The welcome's world map survives the JSON round trip: heights within
 * the u16 quantization step, biome and river bytes exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeWorldMap, encodeWorldMap, type WorldMap } from "../src/index.js";

describe("world map codec", () => {
  it("round-trips through JSON", () => {
    const width = 40;
    const depth = 30;
    const n = width * depth;
    const map: WorldMap = {
      cell: 16,
      width,
      depth,
      originX: -2024,
      originZ: -2024,
      heights: Float32Array.from({ length: n }, (_, i) => -20 + 300 * Math.abs(Math.sin(i * 0.37))),
      biome: Uint8Array.from({ length: n }, (_, i) => i % 5),
      biomes: ["mountains", "swamp", "desert", "forest", "plains"],
      river: Uint8Array.from({ length: n }, (_, i) => (i % 17 === 0 ? 1 : 0)),
    };
    const back = decodeWorldMap(JSON.parse(JSON.stringify(encodeWorldMap(map))));
    const step = 320 / 65535;
    for (let i = 0; i < n; i++) assert.ok(Math.abs(back.heights[i] - map.heights[i]) <= step, `height ${i}`);
    assert.deepEqual(back.biome, map.biome);
    assert.deepEqual(back.river, map.river);
    assert.deepEqual(
      [back.cell, back.width, back.depth, back.originX, back.originZ, back.biomes],
      [map.cell, map.width, map.depth, map.originX, map.originZ, map.biomes],
    );
  });

  it("carries the water surface: levels within a step, dry ground as NaN", () => {
    const n = 6;
    const map: WorldMap = {
      cell: 16, width: 3, depth: 2, originX: 0, originZ: 0,
      heights: Float32Array.from([-20, -3, 4, 12, 40, 80]),
      biome: new Uint8Array(n), biomes: ["sea"], river: new Uint8Array(n),
      // The sea at 0, a lake at 95 m (above every height), dry cells.
      water: Float32Array.from([0, 0, NaN, NaN, 95, NaN]),
    };
    const back = decodeWorldMap(JSON.parse(JSON.stringify(encodeWorldMap(map))));
    const step = 115 / 65535;
    const water = back.water;
    assert.ok(water, "water layer decoded");
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(map.water![i])) assert.ok(Number.isNaN(water[i]), `cell ${i} dry`);
      else assert.ok(Math.abs(water[i] - map.water![i]) <= step, `cell ${i}: ${water[i]}`);
    }
    for (let i = 0; i < n; i++) assert.ok(Math.abs(back.heights[i] - map.heights[i]) <= step, `height ${i}`);
  });

  it("maps sent without water decode without it", () => {
    const map: WorldMap = {
      cell: 8, width: 1, depth: 1, originX: 0, originZ: 0,
      heights: new Float32Array(1), biome: new Uint8Array(1), biomes: [], river: new Uint8Array(1),
    };
    const wire = encodeWorldMap(map);
    assert.equal("water" in wire, false);
    assert.equal(decodeWorldMap(wire).water, undefined);
  });

  it("rejects layers of the wrong size", () => {
    const map: WorldMap = {
      cell: 8, width: 2, depth: 2, originX: 0, originZ: 0,
      heights: new Float32Array(4), biome: new Uint8Array(3), biomes: [], river: new Uint8Array(4),
    };
    assert.throws(() => encodeWorldMap(map), /2x2/);
  });
});
