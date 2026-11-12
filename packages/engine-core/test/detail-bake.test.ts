/**
 * Detail bake output: geometry per placement, and the two layers baked end to
 * end: overworld moss from a real survey's wet channel, and indoor wall-band
 * rubble from a fixture room.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { DetailLayer, TerrainMaskSpec } from "@mmo-engine/art/browser";
import { DEFAULT_TERRAIN_MASK_SPEC } from "@mmo-engine/art/browser";
import { bakeDetailLayer } from "../src/terrain/detail-bake.js";
import { terrainSamples, wallBandSamples } from "@mmo-engine/placement";
import { surveyWorld } from "../src/terrain/survey.js";
import { maskSourceOf, bakeWorldMasks } from "../src/terrain/mask-bake.js";
import { parseWorldSpec, worldBounds, type WorldSpec } from "../src/terrain/world-spec.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LAYER_BASE: Omit<DetailLayer, "id" | "surface" | "band" | "affinity" | "density"> = {
  assetSet: "test-set",
  noise: { scale: 4, threshold: 0 },
  cluster: { size: 0, falloff: 0 },
  seed: 11,
  budget: 100000,
};

describe("detail bake: geometry", () => {
  it("two quads per placement, four vertices each, six indices each", () => {
    const samples = [{ x: 1, z: 1, band: 0.5, affinity: 0.5 }, { x: 5, z: 5, band: 0.5, affinity: 0.5 }];
    const layer: DetailLayer = { ...LAYER_BASE, id: "g", surface: "terrain", density: 1, band: { min: 0, max: 1 }, affinity: { weight: 0, preference: 1 } };
    const bake = bakeDetailLayer(layer, samples, { size: 0.5 });
    const n = bake.placements.length;
    assert.equal(bake.geometry.quads, n * 2);
    assert.equal(bake.geometry.positions.length, n * 8 * 3);
    assert.equal(bake.geometry.uvs.length, n * 8 * 2);
    assert.equal(bake.geometry.indices.length, n * 12);
  });

  it("the quads sit around their placement, within half the size", () => {
    const layer: DetailLayer = { ...LAYER_BASE, id: "g", surface: "terrain", density: 1, band: { min: 0, max: 1 }, affinity: { weight: 0, preference: 1 } };
    const bake = bakeDetailLayer(layer, [{ x: 10, z: 20, band: 0.5, affinity: 0.5 }], { size: 1, height: () => 3 });
    const p = bake.geometry.positions;
    for (let i = 0; i < p.length; i += 3) {
      assert.ok(Math.abs(p[i] - 10) <= 0.5 + 1e-6 && Math.abs(p[i + 2] - 20) <= 0.5 + 1e-6, "xz within half");
      assert.ok(p[i + 1] >= 3 - 1e-6 && p[i + 1] <= 4 + 1e-6, "y on the ground, up to the size");
    }
  });

  it("the budget limits the geometry too", () => {
    const samples = Array.from({ length: 200 }, (_, i) => ({ x: i, z: 0, band: 0.5, affinity: 0.5 }));
    const layer: DetailLayer = { ...LAYER_BASE, id: "b", surface: "terrain", density: 1, budget: 7, band: { min: 0, max: 1 }, affinity: { weight: 0, preference: 1 } };
    assert.equal(bakeDetailLayer(layer, samples, { size: 0.5 }).geometry.quads, 14);
  });
});

describe("detail bake: overworld moss on the wet channel (real survey)", () => {
  let spec: WorldSpec;
  let moss: DetailBake;
  let bounds: { minChunk: number; maxChunk: number };
  let maskSpec: TerrainMaskSpec;
  let wetCells: number;
  let wetChannel: Uint8Array;
  let wetWidth: number;
  let wetCell: number;
  let wetOrigin: number;
  before(() => {
    const SPEC = readFileSync(fileURLToPath(new URL("../../worlds/tiny-test.world.json", import.meta.url)), "utf8");
    spec = parseWorldSpec(JSON.parse(SPEC));
    const survey = surveyWorld(spec);
    bounds = worldBounds(spec);
    maskSpec = { ...DEFAULT_TERRAIN_MASK_SPEC, resolution: 8 };
    const masks = bakeWorldMasks(maskSourceOf(survey), maskSpec, bounds);
    wetCells = masks.channels.wet.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    wetChannel = masks.channels.wet;
    wetWidth = masks.width;
    wetCell = masks.cell;
    wetOrigin = masks.originX;
    const samples = terrainSamples({
      width: masks.width,
      depth: masks.depth,
      cell: masks.cell,
      originX: masks.originX,
      originZ: masks.originZ,
      channel: masks.channels.wet,
      moisture: masks.channels.wet,
    });
    const layer: DetailLayer = {
      ...LAYER_BASE,
      id: "moss",
      surface: "terrain",
      density: 0.5,
      band: { min: 0.4, max: 1 },
      affinity: { weight: 0.5, preference: 1 },
      noise: { scale: 6, threshold: 0.3 },
      seed: 21,
      budget: 5000,
    };
    moss = bakeDetailLayer(layer, samples, { size: 0.6 });
  });

  it("places moss, and only where the wet channel passes the band", () => {
    assert.ok(moss.placements.length > 0, "moss placed");
    assert.ok(wetCells > 0, "the survey has wet ground");
    for (const p of moss.placements) {
      const i = Math.floor((p.z - wetOrigin) / wetCell) * wetWidth + Math.floor((p.x - wetOrigin) / wetCell);
      assert.ok(wetChannel[i] / 255 >= 0.4, `wet ${wetChannel[i]} at (${p.x}, ${p.z})`);
    }
  });

  it("the geometry carries exactly the placements (two quads each)", () => {
    assert.equal(moss.geometry.quads, moss.placements.length * 2);
  });
});

describe("detail bake: indoor wall-band rubble (fixture room)", () => {
  it("rubble sits within 1.5 m of a wall, and the bake carries the geometry", () => {
    const w = 16, d = 16;
    const solid = new Uint8Array(w * d).fill(1);
    for (let z = 1; z < 15; z++) for (let x = 1; x < 15; x++) solid[z * w + x] = 0;
    const samples = wallBandSamples({ width: w, depth: d, cell: 1, solid });
    const rubble: DetailLayer = {
      ...LAYER_BASE,
      id: "rubble",
      surface: "floor",
      density: 0.8,
      band: { min: 0, max: 1.5 },
      affinity: { weight: 0.3, preference: 1 },
      seed: 31,
      budget: 500,
    };
    const bake = bakeDetailLayer(rubble, samples, { size: 0.4 });
    assert.ok(bake.placements.length > 0 && bake.placements.length <= 500, "placed within budget");
    assert.ok(bake.placements.every((p) => p.x < 2.5 || p.x > 13.5 || p.z < 2.5 || p.z > 13.5), "near a wall");
    assert.equal(bake.geometry.quads, bake.placements.length * 2);
  });
});

type DetailBake = ReturnType<typeof bakeDetailLayer>;
