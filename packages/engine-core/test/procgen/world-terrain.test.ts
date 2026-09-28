/**
 * Whole-world terrain: the spec, the coarse survey (biomes, drainage,
 * rivers), the fine heights built on it, and the bake into world.db + the
 * SurrealDB catalog. A small world (32x32 chunks, 512 m) keeps it fast;
 * the default 4 km world runs the same code.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { HeightGrid, type TerrainTile } from "@mmo-engine/protocol";
import { TerrainTileStore } from "../../src/persist/terrain-tiles.js";
import { closeWorldCatalogs, readCatalogSummary, rocksdbUrl } from "../../src/persist/world-catalog.js";
import { fillDepressions, surveyWorld, type CoarseGrid } from "../../src/terrain/survey.js";
import { bakeWorldTerrain, regionOf } from "../../src/terrain/world-bake.js";
import { WorldHeights } from "../../src/terrain/world-heights.js";
import { parseWorldSpec, worldBounds } from "../../src/terrain/world-spec.js";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mmo-world-"));

const SMALL_WORLD = {
  name: "small",
  seed: 77,
  sizeChunks: 32,
  regionsPerSide: 2,
  erosion: { droplets: 3000, strength: 0.35 },
  rivers: { minCatchment: 20_000, maxDepth: 3 },
  biomes: [
    { id: "mountains", count: 1, pick: "highest", shape: "ridged", base: 20, relief: 120, scale: 200, roughness: 1 },
    { id: "swamp", count: 1, pick: "lowest-wet", shape: "flat", base: -3, relief: 2, scale: 60, roughness: 0.2 },
    { id: "plains", count: 2, pick: "rest", shape: "rolling", base: 2, relief: 6, scale: 200, roughness: 0.4 },
  ],
};
const SMALL = parseWorldSpec(SMALL_WORLD);

describe("world spec", () => {
  test("defaults, bounds, and validation", () => {
    assert.equal(SMALL.chunkWorldSize, 16);
    assert.deepEqual(worldBounds(parseWorldSpec({ ...SMALL_WORLD, sizeChunks: 250 })), {
      minChunk: -125,
      maxChunk: 124,
      min: -2000,
      max: 2000,
    });
    assert.throws(() => parseWorldSpec({ ...SMALL_WORLD, sizeChunks: 33 }), /divisible by regionsPerSide/);
    assert.throws(
      () => parseWorldSpec({ ...SMALL_WORLD, biomes: SMALL_WORLD.biomes.filter((b) => b.pick !== "rest") }),
      /one biome must use pick/,
    );
    assert.throws(
      () => parseWorldSpec({ ...SMALL_WORLD, biomes: [...SMALL_WORLD.biomes, SMALL_WORLD.biomes[0]] }),
      /duplicate biome id/,
    );
  });

  test("regionOf splits the world into regionsPerSide^2 equal squares", () => {
    assert.deepEqual(regionOf(SMALL, -16, -16), [0, 0]);
    assert.deepEqual(regionOf(SMALL, -1, 0), [0, 1]);
    assert.deepEqual(regionOf(SMALL, 15, 15), [1, 1]);
  });
});

describe("survey", () => {
  test("fillDepressions: every inner cell drains to a strictly lower neighbour", () => {
    const grid: CoarseGrid = { width: 12, depth: 10, cell: 8, originX: 0, originZ: 0 };
    // A bowl with a deeper pit inside, plus noise: many enclosed hollows.
    const h = Float32Array.from({ length: 120 }, (_, i) => {
      const u = i % 12;
      const v = Math.floor(i / 12);
      return Math.hypot(u - 6, v - 5) * 3 - (u === 4 && v === 4 ? 20 : 0) + ((i * 7919) % 13) * 0.1;
    });
    const filled = fillDepressions(h, grid);
    for (let v = 1; v < 9; v++) {
      for (let u = 1; u < 11; u++) {
        const i = v * 12 + u;
        assert.ok(filled[i] >= h[i], "filling only raises");
        let lower = false;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dz) && filled[(v + dz) * 12 + u + dx] < filled[i]) lower = true;
        }
        assert.ok(lower, `cell (${u},${v}) has an exit`);
      }
    }
  });

  test("deterministic, and places exactly the spec's biome regions", () => {
    const a = surveyWorld(SMALL);
    const b = surveyWorld(SMALL);
    for (const key of ["height", "roughness", "biome", "region", "moisture", "flow", "river"] as const) {
      assert.deepStrictEqual(a[key], b[key], `${key} is reproducible`);
    }
    const counts = new Map<string, number>();
    for (const r of a.regions) {
      const id = SMALL.biomes[r.biome].id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(counts), { mountains: 1, swamp: 1, plains: 2 });
    for (const v of a.height) assert.ok(Number.isFinite(v));
    // Different seed, different world.
    const c = surveyWorld(parseWorldSpec({ ...SMALL_WORLD, seed: 78 }));
    assert.notDeepStrictEqual(c.height, a.height);
  });
});

describe("WorldHeights", () => {
  test("every chunk of the world meets its neighbours exactly", () => {
    const heights = new WorldHeights(surveyWorld(SMALL));
    const { minChunk, maxChunk } = worldBounds(SMALL);
    const tiles: TerrainTile[] = [];
    for (let cz = minChunk; cz <= maxChunk; cz++) {
      for (let cx = minChunk; cx <= maxChunk; cx++) {
        const out = new Float32Array(256);
        heights.generateChunk(0n, cx, cz, 0, out);
        tiles.push({ cx, cz, heights: out });
      }
    }
    // Throws on any shared sample two tiles disagree on.
    const grid = HeightGrid.fromTiles(tiles);
    assert.equal(grid.chunkCoords().length, 32 * 32);
  });
});

describe("bakeWorldTerrain", () => {
  test("tiles, survey maps, and the SurrealDB catalog", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "world.db");
    const catalogDir = path.join(dir, "surreal");
    const report = await bakeWorldTerrain(SMALL, { dbPath, catalogDir });
    assert.equal(report.chunks, 32 * 32);
    assert.ok(report.heightRange.max > report.heightRange.min);

    const store = new TerrainTileStore(dbPath);
    try {
      assert.equal(store.count(), 32 * 32);
      const area = store.getRange(-2, -1, 1, 1);
      assert.equal(area.length, 4 * 3);
      assert.ok(area.every((t) => t.cx >= -2 && t.cx <= 1 && t.cz >= -1 && t.cz <= 1));
      assert.equal(store.getRange(100, 100, 110, 110).length, 0, "outside the world");
      const elevation = store.getMap("elevation");
      const biome = store.getMap("biome");
      assert.ok(elevation && elevation.data instanceof Float32Array);
      assert.ok(biome && biome.data instanceof Uint8Array);
      assert.equal(elevation.data.length, elevation.width * elevation.depth);
      assert.equal(store.getMap("nope"), null);
    } finally {
      store.close();
    }

    // The catalog lands exactly where asked (the engine's URL parsing has
    // mangled paths before: drive letters, "..").
    assert.ok(fs.existsSync(catalogDir), "catalog directory created in place");
    // Same process as the write: the shared connection is reused (the
    // engine can't reopen a store it closed).
    try {
      const catalog = await readCatalogSummary(rocksdbUrl(catalogDir));
      assert.equal(catalog.chunks, 32 * 32);
      assert.equal(catalog.regions, 4);
      assert.equal(Object.values(catalog.biomes).reduce((a, b) => a + b, 0), 32 * 32);
      const c = await catalog.chunk(15, -16);
      assert.ok(c);
      assert.deepEqual(c.region, [1, 0]);
      assert.ok(c.maxHeight >= c.minHeight);
    } finally {
      await closeWorldCatalogs();
    }
    // After closing, reconnecting fails fast instead of hanging.
    await assert.rejects(readCatalogSummary(rocksdbUrl(catalogDir)), /can't reopen/);
  });
});

describe("TerrainTileStore storage", () => {
  test("migrates a WITHOUT ROWID tile table in place (tiles kept)", () => {
    const dbPath = path.join(tmpDir(), "world.db");
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TABLE terrain_tiles (cx INTEGER NOT NULL, cz INTEGER NOT NULL, heights BLOB NOT NULL, PRIMARY KEY (cx, cz)) WITHOUT ROWID",
    );
    const heights = Float32Array.from({ length: 256 }, (_, i) => i * 0.5);
    raw.prepare("INSERT INTO terrain_tiles VALUES (?, ?, ?)").run(3, -4, Buffer.from(heights.buffer));
    raw.close();

    const store = new TerrainTileStore(dbPath);
    assert.deepStrictEqual(store.get(3, -4), heights);
    store.putMany([{ cx: 0, cz: 0, heights }]);
    assert.equal(store.count(), 2);
    store.close();

    const check = new Database(dbPath, { readonly: true });
    const { sql } = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'terrain_tiles'").get() as { sql: string };
    check.close();
    assert.doesNotMatch(sql, /WITHOUT\s+ROWID/i);
  });

  test("survey maps round-trip each dtype", () => {
    const store = new TerrainTileStore(path.join(tmpDir(), "world.db"));
    const base = { width: 3, depth: 2, cell: 8, originX: -24, originZ: 16 };
    store.putMap("f", { ...base, data: Float32Array.of(1.5, -2, 3, 4, 5, 6) });
    store.putMap("b", { ...base, data: Uint8Array.of(0, 1, 2, 3, 4, 255) });
    store.putMap("s", { ...base, data: Uint16Array.of(0, 1, 2, 3, 4, 65535) });
    assert.deepStrictEqual(store.getMap("f"), { ...base, data: Float32Array.of(1.5, -2, 3, 4, 5, 6) });
    assert.deepStrictEqual(store.getMap("b"), { ...base, data: Uint8Array.of(0, 1, 2, 3, 4, 255) });
    assert.deepStrictEqual(store.getMap("s"), { ...base, data: Uint16Array.of(0, 1, 2, 3, 4, 65535) });
    store.putMap("f", { ...base, data: Float32Array.of(0, 0, 0, 0, 0, 7) });
    assert.equal(store.getMap("f")?.data[5], 7, "replaced");
    store.close();
  });
});
