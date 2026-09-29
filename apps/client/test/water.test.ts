/**
 * Water surface geometry: one sheet per wet map cell at its level, open
 * sea past the edges where the map's edge is sea, nothing without water.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import { waterGeometry, waterSurfaceAt, WaterRenderer } from "../src/render/water.js";
import { underwaterAmount } from "../src/render/effects/underwater-effect.js";
import * as THREE_ from "three";
import { waterDepthRect, waterDepthTexture } from "../src/render/water-material.js";
import { createSkyUniforms } from "../src/render/sky/sky-glsl.js";

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

describe("waterSurfaceAt", () => {
  // Sea (0) in the south row, a lake (7) at cell (2, 0), dry elsewhere.
  const m = map([NaN, NaN, 7, 0, 0, NaN]);

  it("reads the surface of the cell under the point, null on dry ground", () => {
    assert.equal(waterSurfaceAt(m, 0, 32, 0), 7, "the lake");
    assert.equal(waterSurfaceAt(m, 0, 20, 14), 0, "the sea");
    assert.equal(waterSurfaceAt(m, 0, 0, 0), null, "dry");
    assert.equal(waterSurfaceAt(map(), 0, 0, 0), null, "no water layer");
  });

  it("continues the open sea past a sea edge, never past a lake or dry edge", () => {
    assert.equal(waterSurfaceAt(m, 0, -500, 900), 0, "beyond the sea corner");
    assert.equal(waterSurfaceAt(m, 0, 900, -500), null, "beyond the lake: lakes don't spill");
    assert.equal(waterSurfaceAt(m, null, -500, 900), null, "no sea level: no open sea");
  });

  it("WaterRenderer answers for the world it was given", () => {
    const w = new WaterRenderer();
    assert.equal(w.surfaceAt(32, 0), null);
    w.setWorld(m, 0);
    assert.equal(w.surfaceAt(32, 0), 7);
    w.setWorld(null, null);
    assert.equal(w.surfaceAt(32, 0), null);
    w.dispose();
  });
});

describe("underwaterAmount", () => {
  it("is off above the surface, full a little below, and smooth between", () => {
    assert.equal(underwaterAmount(-1), 0);
    assert.equal(underwaterAmount(-0.05), 0);
    assert.equal(underwaterAmount(0.25), 1);
    assert.equal(underwaterAmount(3), 1);
    const mid = underwaterAmount(0.1);
    assert.ok(mid > 0.3 && mid < 0.7, `halfway through the band: ${mid}`);
  });
});

describe("water depth for the shader", () => {
  it("is the surface above the ground per cell, 0 on dry ground, as half floats", () => {
    const m = map([NaN, NaN, 7, 0, 0, NaN]);
    m.heights.set([3, 3, 2, -4, -0.5, 1]);
    const tex = waterDepthTexture(m)!;
    const depth = [...(tex.image.data as Uint16Array)].map((h) => THREE_.DataUtils.fromHalfFloat(h));
    assert.deepEqual(depth, [0, 0, 5, 4, 0.5, 0]);
    assert.equal(tex.type, THREE_.HalfFloatType);
    assert.equal(tex.magFilter, THREE_.LinearFilter, "filtered, so the shallows grade smoothly");
    assert.equal(waterDepthTexture(map()), null, "no water layer, no depth");
    tex.dispose();
  });

  it("covers the map's cells edge to edge", () => {
    assert.deepEqual(waterDepthRect(map()).toArray(), [-8, -8, 48, 32]);
  });

  it("the water shares the sky's uniforms, so reflections follow the time of day", () => {
    const sky = createSkyUniforms();
    const w = new WaterRenderer(sky);
    w.setWorld(map([NaN, NaN, 7, 0, 0, NaN]), 0);
    const mesh = w.group.children[0] as THREE_.Mesh;
    const material = mesh.material as THREE_.ShaderMaterial;
    assert.equal(material.uniforms.uSunDir, sky.uSunDir, "the same uniform object, not a copy");
    assert.equal(material.uniforms.uHasDepth.value, 1);
    w.setWorld(null, null);
    assert.equal(material.uniforms.uHasDepth.value, 0, "cleared with the world");
    w.dispose();
  });
});
