/**
 * World heightmap grid: tiles are overlapping windows into ONE grid, so
 * edits can never open a seam, and tiles that disagree are rejected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyBrush,
  HeightGrid,
  sampleNearest,
  TILE_CELLS,
  type TerrainTile,
} from "../src/index.js";

/** Tiles cut from a smooth global function, so shared edges agree. */
function tilesFrom(f: (gx: number, gz: number) => number, coords: Array<[number, number]>): TerrainTile[] {
  return coords.map(([cx, cz]) => {
    const heights = new Float32Array(256);
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) heights[j * 16 + i] = f(cx * TILE_CELLS + i, cz * TILE_CELLS + j);
    }
    return { cx, cz, heights };
  });
}

const wave = (gx: number, gz: number): number => Math.fround(Math.sin(gx * 0.3) + Math.cos(gz * 0.2));
const THREE_BY_THREE: Array<[number, number]> = [];
for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) THREE_BY_THREE.push([cx, cz]);

/** Every shared border sample of every adjacent pair of tiles is identical. */
function assertSeamless(grid: HeightGrid): void {
  for (const [cx, cz] of grid.chunkCoords()) {
    const t = grid.tile(cx, cz).heights;
    if (grid.hasChunk(cx + 1, cz)) {
      const e = grid.tile(cx + 1, cz).heights;
      for (let k = 0; k < 16; k++) assert.equal(t[k * 16 + 15], e[k * 16], `x seam at ${cx},${cz}`);
    }
    if (grid.hasChunk(cx, cz + 1)) {
      const s = grid.tile(cx, cz + 1).heights;
      for (let k = 0; k < 16; k++) assert.equal(t[15 * 16 + k], s[k], `z seam at ${cx},${cz}`);
    }
  }
}

describe("HeightGrid", () => {
  it("round-trips tiles exactly, including negative chunks", () => {
    const tiles = tilesFrom(wave, THREE_BY_THREE);
    const grid = HeightGrid.fromTiles(tiles);
    assert.equal(grid.chunkCoords().length, 9);
    for (const t of tiles) assert.deepStrictEqual(grid.tile(t.cx, t.cz).heights, t.heights);
    // 3 chunks of 15 cells + the closing edge = 46 samples per side.
    assert.equal(grid.width, 46);
    assert.equal(grid.depth, 46);
  });

  it("rejects tiles that disagree on a shared border sample", () => {
    const tiles = tilesFrom(wave, [[0, 0], [1, 0]]);
    tiles[1].heights[3 * 16 + 0] += 0.5; // east tile's shared west column
    assert.throws(() => HeightGrid.fromTiles(tiles), /disagree on shared sample \(15,3\)/);
  });

  it("rejects malformed tiles", () => {
    assert.throws(() => HeightGrid.fromTiles([]), /no tiles/);
    assert.throws(() => HeightGrid.fromTiles([{ cx: 0, cz: 0, heights: new Float32Array(255) }]), /255 samples/);
    const bad = new Float32Array(256);
    bad[7] = Number.NaN;
    assert.throws(() => HeightGrid.fromTiles([{ cx: 0, cz: 0, heights: bad }]), /non-finite/);
    const [t] = tilesFrom(wave, [[0, 0]]);
    assert.throws(() => HeightGrid.fromTiles([t, t]), /duplicate tile/);
  });

  it("maps shared samples to every chunk that contains them", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(wave, THREE_BY_THREE));
    assert.deepEqual(grid.chunksAt(5, 5), [[0, 0]]);
    assert.deepEqual(grid.chunksAt(15, 5).sort(), [[0, 0], [1, 0]]);
    assert.deepEqual(grid.chunksAt(0, 0).sort(), [[-1, -1], [-1, 0], [0, -1], [0, 0]]);
  });
});

describe("applyBrush", () => {
  it("a dab across a chunk border moves both tiles identically (no seam)", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(() => 0, THREE_BY_THREE));
    // x = 16 is the border between chunk 0 and chunk 1.
    const touched = applyBrush(grid, { tool: "raise", x: 16, z: 8, radius: 4, strength: 2 });
    assert.deepEqual([...touched].sort(), ["0,0", "1,0"]);
    const west = grid.tile(0, 0).heights;
    const east = grid.tile(1, 0).heights;
    assert.ok(west[7 * 16 + 15] > 1.9, "border sample raised near full strength");
    assert.equal(west[7 * 16 + 15], east[7 * 16 + 0]);
    assertSeamless(grid);
  });

  it("a dab on a 4-chunk corner touches all four and stays seamless", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(wave, THREE_BY_THREE));
    const touched = applyBrush(grid, { tool: "lower", x: 0, z: 0, radius: 3, strength: 1 });
    assert.deepEqual([...touched].sort(), ["-1,-1", "-1,0", "0,-1", "0,0"]);
    assertSeamless(grid);
  });

  it("falls off to zero at the radius and leaves far samples alone", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(() => 0, [[0, 0]]));
    const onSample = (7 * 16) / 15; // world position of grid sample 7
    applyBrush(grid, { tool: "raise", x: onSample, z: onSample, radius: 3, strength: 1 });
    assert.equal(sampleNearest(grid, 1, 1), 0, "outside the radius");
    assert.equal(grid.get(7, 7), 1, "full strength exactly at the centre");
    assert.ok(grid.get(8, 7) > 0 && grid.get(8, 7) < 1, "partial strength inside the radius");
  });

  it("flatten pulls toward the target; smooth reduces a spike", () => {
    const flat = HeightGrid.fromTiles(tilesFrom(wave, [[0, 0]]));
    for (let k = 0; k < 20; k++) {
      applyBrush(flat, { tool: "flatten", x: 8, z: 8, radius: 4, strength: 0.5, target: 3 });
    }
    assert.ok(Math.abs(sampleNearest(flat, 8, 8) - 3) < 1e-3, "centre reaches the target");

    const spiky = HeightGrid.fromTiles(tilesFrom(() => 0, [[0, 0]]));
    spiky.set(7, 7, 10);
    applyBrush(spiky, { tool: "smooth", x: (7 * 16) / 15, z: (7 * 16) / 15, radius: 3, strength: 1 });
    assert.ok(spiky.get(7, 7) < 10, "spike lowered");
    assert.ok(spiky.get(8, 7) > 0, "neighbours raised");
  });

  it("never writes outside the tiles and reports nothing for a zero dab", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(() => 0, [[0, 0]]));
    assert.equal(applyBrush(grid, { tool: "raise", x: 100, z: 100, radius: 5, strength: 1 }).size, 0);
    assert.equal(applyBrush(grid, { tool: "raise", x: 8, z: 8, radius: 5, strength: 0 }).size, 0);
    assert.equal(grid.get(99, 99), Number.NaN);
  });
});

describe("HeightGrid.pinBorders", () => {
  it("brushes never move samples shared with unloaded chunks", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(wave, THREE_BY_THREE));
    grid.pinBorders();
    // gx = -15 is the loaded area's west edge, shared with chunk (-2, *);
    // gx = 0 is shared by two loaded chunks.
    const edge = grid.get(-15, 7);
    const inner = grid.get(-14, 7);
    const shared = grid.get(0, 7);
    for (let k = 0; k < 3; k++) applyBrush(grid, { tool: "raise", x: -16, z: 8, radius: 20, strength: 1 });
    assert.equal(grid.get(-15, 7), edge, "outer edge pinned");
    assert.ok(grid.get(-14, 7) > inner, "one sample in: edited");
    assert.ok(grid.get(0, 7) > shared, "border between loaded chunks: edited");
    assert.equal(grid.isPinned(-15, 7), true);
    assert.equal(grid.isPinned(0, 7), false);
  });

  it("is off by default (a fully loaded world edits to its edge)", () => {
    const grid = HeightGrid.fromTiles(tilesFrom(wave, THREE_BY_THREE));
    const edge = grid.get(-15, 7);
    applyBrush(grid, { tool: "raise", x: -16, z: 8, radius: 20, strength: 1 });
    assert.ok(grid.get(-15, 7) > edge);
    assert.equal(grid.isPinned(-15, 7), false);
  });
});
