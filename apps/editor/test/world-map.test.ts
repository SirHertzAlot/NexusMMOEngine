import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldMap } from "@mmo-engine/protocol";
import {
  areaAround,
  brushRadius,
  brushSlider,
  chunkAt,
  describeAt,
  followCamera,
  mapToWorld,
  regionAt,
  shadeMap,
  worldToMap,
} from "../src/inspectors/world-map.js";

// A 4×4 map of 16 m cells from (-32, -32): a slope rising east, a lake cell.
function map(): WorldMap {
  const heights = Float32Array.from({ length: 16 }, (_, i) => (i % 4) * 10);
  const water = new Float32Array(16).fill(Number.NaN);
  water[5] = 15;
  return {
    cell: 16,
    width: 4,
    depth: 4,
    originX: -32,
    originZ: -32,
    heights,
    biome: Uint8Array.from({ length: 16 }, (_, i) => (i < 8 ? 0 : 1)),
    biomes: ["plains", "desert"],
    river: Uint8Array.from({ length: 16 }, (_, i) => (i === 10 ? 1 : 0)),
    water,
  };
}

test("map pixels and world metres convert both ways", () => {
  const m = map();
  assert.deepEqual(worldToMap(m, 0, 16), { u: 2, v: 3 });
  assert.deepEqual(mapToWorld(m, 2, 3), { x: 0, z: 16 });
  assert.deepEqual(chunkAt(-1, 31.9, 16), { cx: -1, cz: 1 });
  assert.deepEqual(describeAt(m, -10, -10), { biome: "plains", height: 10, river: false });
  assert.deepEqual(describeAt(m, 2, 2), { biome: "desert", height: 20, river: true });
  assert.equal(describeAt(m, 40, 0), null);
});

test("the shaded map is the ground lit by slope, with water over it", () => {
  const m = map();
  const ground = new Uint8Array(16 * 4).fill(100);
  const px = shadeMap(m, ground);
  assert.equal(px.length, 64);
  assert.ok(px.every((_, i) => i % 4 !== 3 || px[i] === 255));
  // Rising east = facing away from the north-west light: darker than flat ground.
  assert.ok(px[4 * 4] < 100);
  // The lake cell is bluer than the dry one beside it.
  assert.ok(px[4 * 5 + 2] > px[4 * 5] && px[4 * 6 + 2] <= px[4 * 6]);
});

test("the area follows the camera once it wanders half a radius, never over unsaved edits", () => {
  const bounds = { minChunk: -125, maxChunk: 124 };
  const area = { cx: 0, cz: 0, radius: 8 };
  assert.equal(followCamera(area, { x: 60, z: 60 }, 16, bounds, false), null, "3 chunks off: stay");
  assert.deepEqual(followCamera(area, { x: 100, z: -20 }, 16, bounds, false), { cx: 6, cz: -2, radius: 8 });
  assert.equal(followCamera(area, { x: 100, z: -20 }, 16, bounds, true), null);
  // Kept inside the world.
  assert.deepEqual(areaAround(124, -200, 8, bounds), { cx: 116, cz: -117, radius: 8 });
  assert.equal(followCamera({ cx: 116, cz: 0, radius: 8 }, { x: 124 * 16 + 8, z: 8 }, 16, bounds, false), null);
});

test("regions and the log brush scale", () => {
  const regions = [
    { rx: 0, rz: 0, range: [-125, -125, -1, -1] as [number, number, number, number] },
    { rx: 1, rz: 0, range: [0, -125, 124, -1] as [number, number, number, number] },
  ];
  assert.equal(regionAt(regions, 5, -3)?.rx, 1);
  assert.equal(regionAt(regions, 5, 3), null);
  assert.equal(brushRadius(0), 1);
  assert.equal(brushRadius(1), 256);
  assert.equal(brushRadius(brushSlider(4)), 4);
  assert.equal(brushRadius(brushSlider(128)), 128);
});
