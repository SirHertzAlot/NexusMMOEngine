/**
 * The terrain masks through the real world bake: baked after the survey,
 * stored per channel, deterministic, and each channel changes only with its
 * own parameters. Golden hashes pin the tiny world's masks.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TERRAIN_MASK_SPEC, type TerrainMaskSpec } from "@mmo-engine/art/browser";
import { bakeWorldTerrain } from "../src/terrain/world-bake.js";
import { TerrainTileStore } from "../src/persist/terrain-tiles.js";
import { parseWorldSpec, type WorldSpec } from "../src/terrain/world-spec.js";
import { maskHash } from "../src/terrain/terrain-mask.js";

const TINY: WorldSpec = parseWorldSpec({
  name: "tiny-mask",
  seed: 42,
  sizeChunks: 8,
  chunkWorldSize: 16,
  coarseCell: 8,
  regionsPerSide: 1,
  land: {
    seaLevel: 0,
    coast: { side: "south", waterEdge: 0.5, tip: 0.85, taper: 0.7, wander: 100, wanderScale: 200 },
    shelfDepth: 20, shelfWidth: 100, rise: 15, riseDistance: 400, relief: 10, reliefScale: 300, minIslandArea: 5000,
  },
  ranges: { count: 1, height: 100, width: 300, length: 800, spurs: 1, spurLength: 400, spurScale: 0.75, ridgeScale: 200, ridges: 0.45, coastClearance: 100 },
  climate: { wind: "south-west", seaTempC: 20, inlandCoolingC: 5, rainMm: 800, dryDistance: 1500 },
  erosion: { droplets: 5000, strength: 0.3, thermalPasses: 5, fluvialPasses: 3 },
  biomes: [
    { id: "plains", when: { water: "land", height: { min: 0, max: 80 } }, surface: { shape: "rolling", relief: 3, scale: 50 }, roughness: 0.3 },
    { id: "catch-all", surface: { shape: "rolling", relief: 5, scale: 80 }, roughness: 0.5 },
  ],
  minBiomeArea: 500,
});

const CHANNELS = ["base", "rock", "wet", "path"] as const;

/** Bake the tiny world into a fresh db and hash each mask channel read back from it. */
async function bakeHashes(masks?: TerrainMaskSpec | false): Promise<{ hashes: Record<string, string>; maskMs: number | null }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-mask-test-"));
  const dbPath = path.join(dir, "region.db");
  const report = await bakeWorldTerrain(TINY, { dbPath, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, masks });
  const store = new TerrainTileStore(dbPath);
  const hashes: Record<string, string> = {};
  for (const c of CHANNELS) {
    const m = store.getMap(`mask_${c}`);
    hashes[c] = m ? maskHash(new Uint8Array(m.data as Uint8Array)) : "absent";
  }
  return { hashes, maskMs: report.maskMs };
}

describe("terrain masks through the world bake", () => {
  let baseline: Record<string, string>;
  before(async () => {
    baseline = (await bakeHashes()).hashes;
  });

  it("stores one mask map per channel, sized to the world", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-mask-size-"));
    const dbPath = path.join(dir, "region.db");
    await bakeWorldTerrain(TINY, { dbPath, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1 });
    const store = new TerrainTileStore(dbPath);
    const res = DEFAULT_TERRAIN_MASK_SPEC.resolution;
    for (const c of CHANNELS) {
      const m = store.getMap(`mask_${c}`);
      assert.ok(m, `mask_${c} stored`);
      assert.equal(m!.width, 8 * res, "width in samples");
      assert.equal(m!.depth, 8 * res);
    }
  });

  it("is deterministic: a second bake of the same world gives the same bytes", async () => {
    const again = await bakeHashes();
    assert.deepEqual(again.hashes, baseline);
  });

  it("golden hashes for the tiny world (fixed seed, default mask spec)", () => {
    assert.deepEqual(baseline, GOLDEN);
  });

  it("masks:false stores no masks and reports no mask time", async () => {
    const off = await bakeHashes(false);
    assert.equal(off.maskMs, null);
    for (const c of CHANNELS) assert.equal(off.hashes[c], "absent");
  });

  it("a rock threshold change moves only the rock channel", async () => {
    const d = DEFAULT_TERRAIN_MASK_SPEC;
    const moved = await bakeHashes({ ...d, rock: { ...d.rock, slope: { ...d.rock.slope, from: 5, to: 15 } } });
    assert.notEqual(moved.hashes.rock, baseline.rock, "rock moved");
    for (const c of ["base", "wet", "path"] as const) assert.equal(moved.hashes[c], baseline[c], `${c} unchanged`);
  });

  it("a wet threshold change moves only the wet channel", async () => {
    const d = DEFAULT_TERRAIN_MASK_SPEC;
    const moved = await bakeHashes({ ...d, wet: { ...d.wet, moisture: { ...d.wet.moisture, from: 0.1, to: 0.3 } } });
    assert.notEqual(moved.hashes.wet, baseline.wet, "wet moved");
    for (const c of ["base", "rock", "path"] as const) assert.equal(moved.hashes[c], baseline[c], `${c} unchanged`);
  });

  it("the mask bake time is reported", async () => {
    const r = await bakeHashes();
    assert.ok(r.maskMs !== null && r.maskMs >= 0);
  });
});

// FNV-1a of each channel's bytes for the tiny world, default mask spec. Changing
// these is changing the mask data: say why in the PR.
const GOLDEN: Record<string, string> = {
  // Re-pinned when procgen moved to a strict-IEEE build (no fast-math, no -march, FMA off): the
  // procgen swell noise is now the same bits on every runner (local 1d2cac87; the old fast-math build
  // gave c85212f1 locally and 2c0db823 on the AMD runner). Base, rock and wet move with it; path is unchanged.
  base: "cd45512a",
  rock: "6eade513",
  wet: "4e365432",
  path: "38699dc5",
};

describe("overworld detail layers through the world bake", () => {
  it("stores a detail map per overworld layer, placed only on the chosen wet channel", async () => {
    const { parseDetailLayer } = await import("@mmo-engine/art/browser");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-detail-bake-"));
    const dbPath = path.join(dir, "region.db");
    const moss = parseDetailLayer({ id: "moss", assetSet: "moss", surface: "terrain", channel: "wet", density: 0.8, noise: { scale: 6, threshold: 0.2 }, band: { min: 0.3, max: 1 }, affinity: { weight: 0, preference: 1 }, cluster: { size: 0, falloff: 0 }, seed: 9, budget: 100000 });
    const report = await bakeWorldTerrain(TINY, { dbPath, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, detailLayers: [moss] });
    assert.ok((report.detailPlaced.moss ?? 0) > 0, "moss placed");
    const store = new TerrainTileStore(dbPath);
    const map = store.getMap("detail_moss");
    assert.ok(map, "detail_moss stored");
    const wet = store.getMap("mask_wet")!;
    const grid = new Uint8Array(map!.data as Uint8Array);
    const wetBytes = new Uint8Array(wet.data as Uint8Array);
    for (let i = 0; i < grid.length; i++) if (grid[i]) assert.ok(wetBytes[i] / 255 >= 0.3, "placed only where the wet channel passes the band");
  });
});
