/**
 * Terrain surfaces: the manifest is checked, .pbr files are sliced to
 * their top level, every map cell gets its biome's layer (rivers as mud),
 * and the terrain switches to textured ground and back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import {
  buildSurfaceTextures,
  parseSurfaceManifest,
  pbrTopLevel,
  surfaceLayerMap,
  type SurfaceManifest,
  type Surfaces,
} from "../src/render/terrain/surfaces.js";
import { TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const layer = (id: string, tint: [number, number, number] = [1, 1, 1]) =>
  ({ id, file: `${id}.pbr`, resolution: 4, levels: 3, tileMetres: 3, tint });

function manifest(): SurfaceManifest {
  return {
    version: 1,
    encoding: "deflate-rgba8-mips-v1",
    layers: [layer("grass"), layer("mud", [0.7, 0.7, 0.7]), layer("rock"), layer("snow")],
    biomes: { plains: "grass", lake: "mud", mountains: "rock" },
    rock: "rock",
    snow: "snow",
  };
}

function map(): WorldMap {
  return {
    cell: 16, width: 3, depth: 2, originX: 0, originZ: 0,
    heights: new Float32Array(6),
    biome: Uint8Array.from([0, 0, 1, 2, 0, 1]),
    biomes: ["plains", "mountains", "tundra"],
    river: Uint8Array.from([0, 1, 0, 0, 0, 0]),
  };
}

describe("parseSurfaceManifest", () => {
  it("accepts a good manifest and names what is wrong with a bad one", () => {
    assert.doesNotThrow(() => parseSurfaceManifest(manifest()));
    assert.throws(() => parseSurfaceManifest({ ...manifest(), version: 2 }), /version/);
    assert.throws(() => parseSurfaceManifest({ ...manifest(), rock: "lava" }), /no layer "lava"/);
    assert.throws(() => parseSurfaceManifest({ ...manifest(), layers: [layer("grass"), { ...layer("mud"), resolution: 8 }] }), /same resolution/);
    assert.throws(() => parseSurfaceManifest({ ...manifest(), layers: [] }), /layers/);
  });
});

describe("pbrTopLevel", () => {
  it("is the first colour level, then the first props level", () => {
    const res = 2;
    const n = res * res * 4;
    const bytes = new Uint8Array(3 * n).map((_, i) => i % 251);
    const { color, props } = pbrTopLevel(bytes, res);
    assert.deepEqual([...color], [...bytes.subarray(0, n)]);
    assert.deepEqual([...props], [...bytes.subarray(n, 2 * n)]);
    assert.throws(() => pbrTopLevel(new Uint8Array(n), res), /too short/);
  });
});

describe("surfaceLayerMap", () => {
  it("gives each cell its biome's layer, rivers the lake's, unknown biomes the plains'", () => {
    // Layers: 0 grass, 1 mud, 2 rock. Cell 1 is a river; tundra has no rule.
    assert.deepEqual([...surfaceLayerMap(map(), manifest())], [0, 1, 2, 0, 0, 2]);
  });
});

describe("TerrainRenderer surfaces", () => {
  const surfaces = (): Surfaces => {
    const n = 4 * 4 * 4;
    const level = { color: new Uint8Array(n), props: new Uint8Array(n) };
    const { albedo, props } = buildSurfaceTextures([level, level, level, level], 4);
    return { manifest: manifest(), albedo, props, dispose: () => (albedo.dispose(), props.dispose()) };
  };

  it("builds sRGB colour and linear props arrays, one layer per material", () => {
    const s = surfaces();
    assert.equal(s.albedo.image.depth, 4);
    assert.equal(s.albedo.colorSpace, THREE.SRGBColorSpace);
    assert.equal(s.props.colorSpace, THREE.NoColorSpace);
    assert.equal(s.albedo.wrapS, THREE.RepeatWrapping);
    s.dispose();
  });

  it("textures the ground once it has both a world and surfaces, and goes back without either", () => {
    const t = new TerrainRenderer(16);
    const s = surfaces();
    t.setSurfaces(s);
    assert.equal(t.textured, false, "no world yet: nothing to map");
    t.setWorld({ map: map(), bounds: { minCx: 0, minCz: 0, maxCx: 2, maxCz: 1 } });
    assert.equal(t.textured, true);
    t.setWorld(null);
    assert.equal(t.textured, false, "world cleared");
    t.setWorld({ map: map(), bounds: { minCx: 0, minCz: 0, maxCx: 2, maxCz: 1 } });
    t.setSurfaces(null);
    assert.equal(t.textured, false, "surfaces removed: flat colours again");
    t.dispose();
    s.dispose();
  });
});
