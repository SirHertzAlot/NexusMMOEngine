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

  it("rejects layers of the wrong size", () => {
    const map: WorldMap = {
      cell: 8, width: 2, depth: 2, originX: 0, originZ: 0,
      heights: new Float32Array(4), biome: new Uint8Array(3), biomes: [], river: new Uint8Array(4),
    };
    assert.throws(() => encodeWorldMap(map), /2x2/);
  });
});
