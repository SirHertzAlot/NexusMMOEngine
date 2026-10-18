import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TerrainCache } from "../src/persist/terrain-cache.js";

/** Deterministic 256-float heightfield filled with `fill`. */
function makeHeights(fill: number): Float32Array {
  const h = new Float32Array(256);
  h.fill(fill);
  return h;
}

/** Create a temp db path and return it (caller must clean up). */
function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-cache-"));
  const dbPath = path.join(dir, "world.db");
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

test("put then has with same inputs returns true; different seed/surveyHash/terrainVersion returns false", () => {
  const { dbPath, cleanup } = tmpDb();
  const cache = new TerrainCache({ dbPath, terrainVersion: 1 });
  const heights = makeHeights(1);

  // Not yet stored
  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), false);

  // Store and verify
  assert.equal(cache.put(0, 0, 0, 123n, "survey-a", heights), true);
  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), true);

  // Different seed
  assert.equal(cache.has(0, 0, 0, 456n, "survey-a"), false);
  // Different surveyHash
  assert.equal(cache.has(0, 0, 0, 123n, "survey-b"), false);
  // Different lod
  assert.equal(cache.has(0, 0, 1, 123n, "survey-a"), false);

  cache.close();
  cleanup();
});

test("put twice with same inputs writes once (second is no-op returning false)", () => {
  const { dbPath, cleanup } = tmpDb();
  const cache = new TerrainCache({ dbPath, terrainVersion: 1 });
  const heights = makeHeights(1);

  assert.equal(cache.put(0, 0, 0, 123n, "survey-a", heights), true);
  assert.equal(cache.put(0, 0, 0, 123n, "survey-a", heights), false);

  cache.close();
  cleanup();
});

test("invalidateSurvey drops only tiles from other survey hashes and returns count", () => {
  const { dbPath, cleanup } = tmpDb();
  const cache = new TerrainCache({ dbPath, terrainVersion: 1 });

  cache.put(0, 0, 0, 123n, "survey-a", makeHeights(1));
  cache.put(1, 0, 0, 123n, "survey-a", makeHeights(2));
  cache.put(0, 1, 0, 123n, "survey-b", makeHeights(3));
  cache.put(1, 1, 0, 123n, "survey-b", makeHeights(4));

  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(0, 1, 0, 123n, "survey-b"), true);

  // Invalidate survey-b tiles (2 tiles)
  const dropped = cache.invalidateSurvey("survey-a");
  assert.equal(dropped, 2);

  // survey-a tiles survive
  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(1, 0, 0, 123n, "survey-a"), true);
  // survey-b tiles are gone
  assert.equal(cache.has(0, 1, 0, 123n, "survey-b"), false);
  assert.equal(cache.has(1, 1, 0, 123n, "survey-b"), false);

  cache.close();
  cleanup();
});

test("invalidateRegion drops only that region's tiles", () => {
  const { dbPath, cleanup } = tmpDb();
  // World: 4x4 chunks, minChunk = -2, sizeChunks = 4
  // regionsPerSide = 2, so each region is 2x2 chunks
  // Region (0,0): cx in [-2,-1], cz in [-2,-1]
  // Region (1,0): cx in [0,1],  cz in [-2,-1]
  // Region (0,1): cx in [-2,-1], cz in [0,1]
  // Region (1,1): cx in [0,1],  cz in [0,1]
  const cache = new TerrainCache({ dbPath, terrainVersion: 1, minChunk: -2, sizeChunks: 4 });

  // Fill all 16 chunks
  for (let cz = -2; cz <= 1; cz++) {
    for (let cx = -2; cx <= 1; cx++) {
      cache.put(cx, cz, 0, 123n, "survey-a", makeHeights(cx * 10 + cz));
    }
  }

  // Invalidate region (0, 0): cx in [-2,-1], cz in [-2,-1] — 4 tiles
  const dropped = cache.invalidateRegion(0, 0, 2);
  assert.equal(dropped, 4);

  // Region (0,0) tiles are gone
  assert.equal(cache.has(-2, -2, 0, 123n, "survey-a"), false);
  assert.equal(cache.has(-1, -2, 0, 123n, "survey-a"), false);
  assert.equal(cache.has(-2, -1, 0, 123n, "survey-a"), false);
  assert.equal(cache.has(-1, -1, 0, 123n, "survey-a"), false);

  // Other regions survive
  assert.equal(cache.has(0, -2, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(1, -2, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(0, -1, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(1, -1, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(-2, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(-1, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(1, 0, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(-2, 1, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(-1, 1, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(0, 1, 0, 123n, "survey-a"), true);
  assert.equal(cache.has(1, 1, 0, 123n, "survey-a"), true);

  cache.close();
  cleanup();
});

test("tile survives close() and is still has()-true from a fresh instance on the same dbPath", () => {
  const { dbPath, cleanup } = tmpDb();
  const cache = new TerrainCache({ dbPath, terrainVersion: 1 });
  const heights = makeHeights(1);

  cache.put(0, 0, 0, 123n, "survey-a", heights);
  cache.close();

  // Reopen from the same dbPath
  const cache2 = new TerrainCache({ dbPath, terrainVersion: 1 });
  assert.equal(cache2.has(0, 0, 0, 123n, "survey-a"), true);
  cache2.close();

  cleanup();
});

test("terrainVersion bump invalidates everything", () => {
  const { dbPath, cleanup } = tmpDb();
  const cache = new TerrainCache({ dbPath, terrainVersion: 1 });
  const heights = makeHeights(1);

  cache.put(0, 0, 0, 123n, "survey-a", heights);
  assert.equal(cache.has(0, 0, 0, 123n, "survey-a"), true);
  cache.close();

  // Reopen with a different terrainVersion — the key no longer matches
  const cache2 = new TerrainCache({ dbPath, terrainVersion: 2 });
  assert.equal(cache2.has(0, 0, 0, 123n, "survey-a"), false);
  cache2.close();

  cleanup();
});
