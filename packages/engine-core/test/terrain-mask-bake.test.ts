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
  base: "0fb28e9b", // repinned: base takes the biome input (rock, wet, path unchanged)
  rock: "abdbd432",
  wet: "5495cfa9",
  path: "38699dc5", // no road field in the survey yet: this channel is empty
};
