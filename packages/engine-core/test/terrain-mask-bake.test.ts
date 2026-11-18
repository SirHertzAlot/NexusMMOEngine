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

describe("path channel: the second pass after the settlements", () => {
  // A road across the tiny world (world metres; the world spans -64..64 on both axes).
  const ROAD: Array<[number, number]> = [[-40, -20], [0, -5], [30, 10]];
  const res = DEFAULT_TERRAIN_MASK_SPEC.resolution;

  async function bakeWith(extra: Parameters<typeof bakeWorldTerrain>[1] extends infer O ? Partial<O> : never) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-mask-road-"));
    const dbPath = path.join(dir, "region.db");
    await bakeWorldTerrain(TINY, { dbPath, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, ...extra });
    const store = new TerrainTileStore(dbPath);
    const maps: Record<string, { width: number; depth: number; cell: number; originX: number; originZ: number; data: Uint8Array }> = {};
    for (const c of CHANNELS) maps[c] = store.getMap(`mask_${c}`) as never;
    return maps;
  }

  it("bakes the roads into the path channel and leaves the other three byte-identical", async () => {
    const without = await bakeWith({});
    const withRoad = await bakeWith({ roads: () => [ROAD] });
    for (const c of ["base", "rock", "wet"] as const) assert.equal(maskHash(new Uint8Array(withRoad[c].data)), maskHash(new Uint8Array(without[c].data)), `${c} unchanged`);
    const p = withRoad.path;
    const at = (x: number, z: number) => new Uint8Array(p.data)[Math.floor((z - p.originZ) / p.cell) * p.width + Math.floor((x - p.originX) / p.cell)];
    assert.ok(at(0, -5) > 200, "on the road");
    assert.ok(at(-20, -12.5) > 200, "on the first leg");
    assert.equal(at(-50, 50), 0, "far from the road");
    assert.ok(new Uint8Array(p.data).some((b) => b > 0 && b < 255), "the feather gives soft edges");
    assert.notEqual(maskHash(new Uint8Array(p.data)), maskHash(new Uint8Array(without.path.data)));
  });

  it("is deterministic", async () => {
    const a = await bakeWith({ roads: () => [ROAD] });
    const b = await bakeWith({ roads: () => [ROAD] });
    assert.equal(maskHash(new Uint8Array(a.path.data)), maskHash(new Uint8Array(b.path.data)));
  });

  it("an empty road list changes nothing", async () => {
    const without = await bakeWith({});
    const none = await bakeWith({ roads: () => [] });
    assert.equal(maskHash(new Uint8Array(none.path.data)), maskHash(new Uint8Array(without.path.data)));
  });

  it("a wider road covers more samples", async () => {
    const narrow = await bakeWith({ roads: () => [ROAD], roadWidthMetres: 2 });
    const wide = await bakeWith({ roads: () => [ROAD], roadWidthMetres: 6 });
    const sum = (m: { data: Uint8Array }) => new Uint8Array(m.data).reduce((a, b) => a + b, 0);
    assert.ok(sum(wide.path) > sum(narrow.path));
  });

  it("chunk seams agree: a road across a chunk edge is continuous", async () => {
    const { bakeWorldPathMask } = await import("../src/terrain/mask-bake.js");
    const bounds = { minChunk: -4, maxChunk: 3 };
    const whole = bakeWorldPathMask(16, DEFAULT_TERRAIN_MASK_SPEC, bounds, [[[-60, 0.3], [60, 0.3]]], 3);
    const n = 8 * res;
    // Walk the row through the road's middle: no sample may jump more than one feather step from its neighbour.
    const row = Math.floor((0.3 + 64) / (16 / res));
    let worst = 0;
    for (let x = 10; x < n - 10; x++) worst = Math.max(worst, Math.abs(whole[row * n + x] - whole[row * n + x - 1]));
    assert.ok(worst < 40, `no seam step across chunk edges (worst ${worst})`);
    // And down a column crossing the road: the profile is the same in every chunk column it passes.
    const colA = [], colB = [];
    for (let z = 0; z < n; z++) { colA.push(whole[z * n + 3 * res + 5]); colB.push(whole[z * n + 5 * res + 5]); }
    assert.deepEqual(colA, colB, "the cross-section is identical in different chunk columns");
  });

  it("a road outside the world bakes nothing", async () => {
    const { bakeWorldPathMask } = await import("../src/terrain/mask-bake.js");
    const out = bakeWorldPathMask(16, DEFAULT_TERRAIN_MASK_SPEC, { minChunk: -4, maxChunk: 3 }, [[[500, 500], [600, 520]]], 3);
    assert.equal(out.reduce((a, b) => a + b, 0), 0);
  });
});
