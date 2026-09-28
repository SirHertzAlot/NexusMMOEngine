/**
 * Water surface geometry: one sheet per wet map cell at its level, open
 * sea past the edges where the map's edge is sea, nothing without water.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import { waterGeometry, WaterRenderer } from "../src/render/water.js";

/** 3 x 2 cells of 16 m centred at (0, 0), (16, 0), …: sea in the south row, a lake up north-east. */
function map(water?: number[]): WorldMap {
  return {
    cell: 16, width: 3, depth: 2, originX: 0, originZ: 0,
    heights: new Float32Array(6), biome: new Uint8Array(6), biomes: [], river: new Uint8Array(6),
    ...(water ? { water: Float32Array.from(water) } : {}),
  };
}

/** Quads as [minX, minZ, maxX, maxZ, y] (two triangles, six vertices each). */
function quads(g: THREE.BufferGeometry): number[][] {
  const p = g.getAttribute("position").array as Float32Array;
  const out: number[][] = [];
  for (let q = 0; q < p.length; q += 18) {
    const xs = [0, 3, 6, 9, 12, 15].map((k) => p[q + k]);
    const zs = [0, 3, 6, 9, 12, 15].map((k) => p[q + k + 2]);
    out.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), p[q + 1]]);
  }
  return out;
}

describe("waterGeometry", () => {
  it("lays a sheet over each wet cell at its surface, facing up", () => {
    const g = waterGeometry(map([NaN, NaN, 7, 0, 0, NaN]), null)!;
    assert.deepEqual(quads(g), [
      [24, -8, 40, 8, 7], // the lake, cell (2, 0)
      [-8, 8, 8, 24, 0], // the sea, cells (0, 1) and (1, 1)
      [8, 8, 24, 24, 0],
    ]);
    const n = g.getAttribute("normal").array as Float32Array;
    for (let i = 0; i < n.length; i += 3) assert.deepEqual([n[i], n[i + 1], n[i + 2]], [0, 1, 0]);
  });

  it("runs the open sea past the edges where the edge is sea, never past a lake", () => {
    const g = waterGeometry(map([NaN, NaN, 7, 0, 0, NaN]), 0, 1000)!;
    const open = quads(g).slice(3);
    assert.deepEqual(open, [
      [-8, 24, 8, 1024, 0], // south, below cell (0, 1)
      [8, 24, 24, 1024, 0], // south, below cell (1, 1)
      [-1008, 8, -8, 24, 0], // west, beside cell (0, 1)
      [-1008, 24, -8, 1024, 0], // the south-west corner
    ]);
  });

  it("no water layer (older servers) or no wet cell: no geometry", () => {
    assert.equal(waterGeometry(map(), 0), null);
    assert.equal(waterGeometry(map([NaN, NaN, NaN, NaN, NaN, NaN]), 0), null);
    const r = new WaterRenderer();
    r.setWorld(map(), 0);
    assert.equal(r.hasWater, false);
    r.setWorld(map([0, 0, 0, 0, 0, 0]), 0);
    assert.equal(r.hasWater, true);
    r.setWorld(null, null);
    assert.equal(r.hasWater, false);
    r.dispose();
  });
});
