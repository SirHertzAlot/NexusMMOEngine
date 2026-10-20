/**
 * Incremental world bake (roadmap WX2): content-addressed survey,
 * skip-unchanged tiles, regional re-bake, survey-only, and a full
 * end-to-end bake of a tiny world.
 */

import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TerrainCache } from "../src/persist/terrain-cache.js";
import { TerrainTileStore } from "../src/persist/terrain-tiles.js";
import { bakeWorldTerrain, regionChunks, regionOf, surveyHash } from "../src/terrain/world-bake.js";
import { parseWorldSpec, type WorldSpec } from "../src/terrain/world-spec.js";

// A tiny world spec: 8x8 chunks of 16 m = 128 m square, 1 region per side.
// Small enough to bake in a second, large enough to exercise the pipeline.
const TINY_SPEC: WorldSpec = parseWorldSpec({
  name: "tiny",
  seed: 42,
  sizeChunks: 8,
  chunkWorldSize: 16,
  coarseCell: 8,
  regionsPerSide: 1,
  land: {
    seaLevel: 0,
    coast: { side: "south", waterEdge: 0.5, tip: 0.85, taper: 0.7, wander: 100, wanderScale: 200 },
    shelfDepth: 20,
    shelfWidth: 100,
    rise: 15,
    riseDistance: 400,
    relief: 10,
    reliefScale: 300,
    minIslandArea: 5000,
  },
  ranges: {
    count: 1,
    height: 100,
    width: 300,
    length: 800,
    spurs: 1,
    spurLength: 400,
    spurScale: 0.75,
    ridgeScale: 200,
    ridges: 0.45,
    coastClearance: 100,
  },
  climate: {
    wind: "south-west",
    seaTempC: 20,
    inlandCoolingC: 5,
    rainMm: 800,
    dryDistance: 1500,
  },
  erosion: {
    droplets: 5000,
    strength: 0.3,
    thermalPasses: 5,
    fluvialPasses: 3,
  },
  biomes: [
    {
      id: "plains",
      when: { water: "land", height: { min: 0, max: 80 } },
      surface: { shape: "rolling", relief: 3, scale: 50 },
      roughness: 0.3,
    },
    {
      id: "catch-all",
      surface: { shape: "rolling", relief: 5, scale: 80 },
      roughness: 0.5,
    },
  ],
  minBiomeArea: 500,
});

// Two regions per side, so a regional re-bake has neighbours to preserve.
const TWO_REGION_SPEC: WorldSpec = parseWorldSpec({
  ...JSON.parse(JSON.stringify(TINY_SPEC)),
  regionsPerSide: 2,
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmo-bake-test-"));
}

function makeSpecDbPath(dir: string): string {
  return path.join(dir, "world.db");
}

// ---------------------------------------------------------------------------
// surveyHash
// ---------------------------------------------------------------------------

describe("surveyHash", () => {
  it("is stable for an equal spec", () => {
    const a = surveyHash(TINY_SPEC);
    const b = surveyHash(parseWorldSpec(JSON.parse(JSON.stringify(TINY_SPEC))));
    assert.equal(a, b);
  });

  it("is different for a changed spec", () => {
    const a = surveyHash(TINY_SPEC);
    const changed = { ...TINY_SPEC, seed: 43 };
    const b = surveyHash(changed);
    assert.notEqual(a, b);
  });

  it("is different when a nested field changes", () => {
    const a = surveyHash(TINY_SPEC);
    const changed = { ...TINY_SPEC, land: { ...TINY_SPEC.land, seaLevel: 5 } };
    const b = surveyHash(changed);
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// regionOf / regionChunks
// ---------------------------------------------------------------------------

describe("regionOf / regionChunks", () => {
  it("maps a chunk to its region", () => {
    const [rx, rz] = regionOf(TINY_SPEC, 0, 0);
    assert.deepEqual([rx, rz], [0, 0]);
  });

  it("maps a region to its chunk range", () => {
    const rc = regionChunks(TINY_SPEC, 0, 0);
    assert.equal(rc.minCx, -4);
    assert.equal(rc.maxCx, 3);
    assert.equal(rc.minCz, -4);
    assert.equal(rc.maxCz, 3);
  });
});

// ---------------------------------------------------------------------------
// Full bake of a tiny world
// ---------------------------------------------------------------------------

describe("full bake", () => {
  it("produces tiles + maps + catalog in world.db", async () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);
    const logLines: string[] = [];

    const report = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null, // skip SurrealDB catalog for tests
      log: (l) => logLines.push(l),
      terrainVersion: 1,
    });

    assert.equal(report.chunks, 64); // 8x8
    assert.ok(report.surveyHash.length === 64); // sha256 hex
    assert.equal(report.surveySkipped, false);
    assert.equal(report.tilesGenerated, 64);
    assert.equal(report.tilesSkipped, 0);

    // Tiles are in the db.
    const store = new TerrainTileStore(dbPath);
    const tiles = store.list();
    assert.equal(tiles.length, 64);
    for (const t of tiles) {
      assert.equal(t.heights.length, 256);
    }

    // Maps are in the db.
    const elevation = store.getMap("elevation");
    assert.ok(elevation);
    assert.ok(elevation.width > 0);
    assert.ok(elevation.depth > 0);

    const biome = store.getMap("biome");
    assert.ok(biome);

    store.close();

    // Clean up.
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Incremental: second bake skips survey and tiles
// ---------------------------------------------------------------------------

describe("incremental bake", () => {
  it("skips the survey and rewrites no tiles when the spec is unchanged", async () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);

    // First bake.
    const report1 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
    });
    assert.equal(report1.surveySkipped, false);
    assert.equal(report1.tilesGenerated, 64);

    // Read the stored survey hash.
    const cache = new TerrainCache({ dbPath, terrainVersion: 1 });
    // The cache should have all tiles.
    assert.ok(cache.has(0, 0, 0, BigInt(42), report1.surveyHash));
    cache.close();

    // Second bake with the same spec.
    const logLines2: string[] = [];
    const report2 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: (l) => logLines2.push(l),
      terrainVersion: 1,
      existingSurveyHash: report1.surveyHash,
    });

    assert.equal(report2.surveySkipped, true);
    assert.equal(report2.tilesGenerated, 0);
    assert.equal(report2.tilesSkipped, 64);
    assert.ok(logLines2.some((l) => l.includes("survey skipped")));

    // Clean up.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("regenerates tiles when the spec changes", async () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);

    // First bake.
    const report1 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
    });

    // Second bake with a changed spec.
    const changedSpec = { ...TINY_SPEC, seed: 43 };
    const report2 = await bakeWorldTerrain(changedSpec, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
      existingSurveyHash: report1.surveyHash,
    });

    assert.equal(report2.surveySkipped, false);
    assert.equal(report2.tilesGenerated, 64);
    assert.equal(report2.tilesSkipped, 0);

    // Clean up.
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Regional re-bake
// ---------------------------------------------------------------------------

describe("regional re-bake", () => {
  it("regenerates only the specified region's tiles", async () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);

    // First bake the whole world.
    const report1 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
    });
    assert.equal(report1.tilesGenerated, 64);

    // Re-bake only region 0,0 (which is the whole world in this tiny spec,
    // but the code path is the same). The survey is re-run because a
    // regional bake needs it for tile generation.
    const report2 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
      region: [0, 0],
      existingSurveyHash: report1.surveyHash,
    });

    // The survey is re-run for a regional bake.
    assert.equal(report2.surveySkipped, false);
    // All 64 tiles are in the region; some may be skipped if cached.
    assert.ok(report2.tilesGenerated + report2.tilesSkipped === 64);

    // Clean up.
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Survey-only
// ---------------------------------------------------------------------------

describe("survey-only", () => {
  it("re-runs the survey and invalidates the tile cache", async () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);

    // First bake.
    const report1 = await bakeWorldTerrain(TINY_SPEC, {
      dbPath,
      catalogDir: null,
      log: () => {},
      terrainVersion: 1,
    });

    // Verify the cache has tiles.
    const cache1 = new TerrainCache({ dbPath, terrainVersion: 1 });
    assert.ok(cache1.has(0, 0, 0, BigInt(42), report1.surveyHash));
    cache1.close();

    // Survey-only re-bake with a CHANGED spec so the survey hash differs
    // and the old tiles are invalidated.
    const changedSpec = { ...TINY_SPEC, seed: 43 };
    const logLines: string[] = [];
    const report2 = await bakeWorldTerrain(changedSpec, {
      dbPath,
      catalogDir: null,
      log: (l) => logLines.push(l),
      terrainVersion: 1,
      surveyOnly: true,
      existingSurveyHash: report1.surveyHash,
    });

    assert.equal(report2.surveySkipped, false);
    assert.equal(report2.tilesGenerated, 0);
    assert.ok(logLines.some((l) => l.includes("survey-only")));

    // The cache should have been invalidated for the old survey hash.
    const cache2 = new TerrainCache({ dbPath, terrainVersion: 1 });
    assert.ok(!cache2.has(0, 0, 0, BigInt(42), report1.surveyHash));
    cache2.close();

    // Clean up.
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Regional re-bake must not destroy the rest of the world
// ---------------------------------------------------------------------------

const ENGINE_CORE = fileURLToPath(new URL("../../", import.meta.url));
const BAKE_CLI = path.join(ENGINE_CORE, "dist", "src", "bake-world.js");

function bakeCli(args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, [BAKE_CLI, ...args], {
    env,
    cwd: ENGINE_CORE,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `bake ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
}

describe("regional re-bake preserves other regions", () => {
  it("keeps every region's tiles, regenerating only the requested one", () => {
    const dir = tmpDir();
    const dbPath = makeSpecDbPath(dir);

    // A spec file on disk: the CLI reads MMO_WORLD_SPEC as a path.
    const specPath = path.join(dir, "spec.json");
    fs.writeFileSync(specPath, JSON.stringify(JSON.parse(JSON.stringify(TWO_REGION_SPEC))));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MMO_DATA_DIR: dir,
      MMO_WORLD_SPEC: specPath,
      MMO_BAKE_RADIUS: "1",
    };

    const meta = (): { surveyHash: string; terrainVersion: number } => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = (sql: string) => (db.prepare(sql).get() as { value: string }).value;
        return {
          surveyHash: row("SELECT value FROM meta WHERE key = 'survey_hash'"),
          terrainVersion: Number(row("SELECT value FROM meta WHERE key = 'terrain_version'")),
        };
      } finally {
        db.close();
      }
    };

    bakeCli([], env);
    const { surveyHash, terrainVersion } = meta();

    // Re-bake only region 0,0 (chunks -4..1 × -4..1 = 16 tiles).
    bakeCli(["--region=0,0"], env);

    // All 64 tiles are still in the db — the world was not wiped.
    const store = new TerrainTileStore(dbPath);
    assert.equal(store.list().length, 64);
    store.close();

    // A tile in region (1,1) is still cached and unchanged.
    const cache = new TerrainCache({ dbPath, terrainVersion, minChunk: -4, sizeChunks: 8 });
    assert.ok(cache.has(2, 2, 0, BigInt(42), surveyHash), "region (1,1) tile survives");
    cache.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
