/** Regenerating part of a world: region ranges, edge blending, survey-map patches. */

import test from "node:test";
import assert from "node:assert/strict";
import { blendTile, patchMap, regionRange, worldRegions } from "../../src/terrain/region-regen.js";

test("regions tile the world's chunk range", () => {
  const spec = { sizeChunks: 250, regionsPerSide: 2 };
  assert.deepEqual(regionRange(spec, 0, 0), [-125, -125, -1, -1]);
  assert.deepEqual(regionRange(spec, 1, 1), [0, 0, 124, 124]);
  assert.equal(worldRegions(spec).length, 4);
  assert.throws(() => regionRange(spec, 2, 0), /no region 2,0/);
});

test("the blend keeps stored samples on edges with neighbours and fresh ones a band in", () => {
  const world = { minChunk: -8, maxChunk: 7 };
  const range: [number, number, number, number] = [0, 0, 3, 3];
  const old = new Float32Array(256).fill(10);
  const edge = blendTile(new Float32Array(256).fill(20), old, 0, 1, range, world, 16, 16);
  // Chunk (0, 1) sits on the west edge: column 0 is the edge itself.
  for (let j = 0; j < 16; j++) assert.equal(edge[j * 16], 10);
  assert.ok(edge[8] > 10 && edge[8] < 20, "half a band in, half blended");
  assert.equal(edge[15], 20, "a band in, all fresh");
  const inner = blendTile(new Float32Array(256).fill(20), old, 1, 1, range, world, 16, 16);
  assert.ok(inner.every((v) => v === 20));
  // On the world's edge there is no neighbour to meet.
  const rim = blendTile(new Float32Array(256).fill(20), old, -8, -6, [-8, -8, -5, -5], world, 16, 16);
  assert.equal(rim[16], 20);
});

test("a survey map takes the fresh cells inside the range only", () => {
  const grid = { width: 4, depth: 4, cell: 8, originX: -16, originZ: -16 };
  const stored = { ...grid, data: new Float32Array(16) };
  const out = patchMap(stored, new Float32Array(16).fill(1), grid, 0, -16, 16, 0)!;
  assert.deepEqual(Array.from(out.data), [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(patchMap(stored, new Float32Array(16), { ...grid, cell: 4 }, 0, 0, 1, 1), null);
  assert.equal(patchMap(stored, new Uint8Array(16), grid, 0, 0, 1, 1), null);
});
