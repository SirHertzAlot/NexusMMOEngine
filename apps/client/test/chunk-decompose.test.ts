import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decomposeToTiles, chunkDecomposeHandler } from "../src/workers/handlers/chunk-decompose.js";

describe("chunk decompose", () => {
  it("cuts a 30x30 region into 4 tiles with shared borders", () => {
    // 30 samples = gx 0..29: chunks 0 and 1 per axis (boundaries at multiples of 15).
    const w = 30, d = 30;
    const heights = new Float32Array(w * d);
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) heights[z * w + x] = x + z * 100;
    const tiles = decomposeToTiles({ heights, width: w, depth: d, originGX: 0, originGZ: 0 });
    assert.equal(tiles.length, 4);
    const keys = tiles.map((t) => `${t.cx},${t.cz}`).sort();
    assert.deepEqual(keys, ["0,0", "0,1", "1,0", "1,1"]);
    for (const t of tiles) assert.equal(t.heights.length, 256);
    // Shared border: chunk (0,0) right edge == chunk (1,0) left edge.
    const a = tiles.find((t) => t.cx === 0 && t.cz === 0)!;
    const b = tiles.find((t) => t.cx === 1 && t.cz === 0)!;
    for (let j = 0; j < 16; j++) {
      assert.equal(a.heights[j * 16 + 15], b.heights[j * 16 + 0]);
    }
    // Spot check values: tile (1,1) sample (0,0) is gx=15, gz=15.
    const c = tiles.find((t) => t.cx === 1 && t.cz === 1)!;
    assert.equal(c.heights[0], 15 + 15 * 100);
  });

  it("fills out-of-region samples with NaN", () => {
    // Region starts mid-chunk: origin gx=7 -> first chunk cx=0 covers gx -8..7.
    const w = 8, d = 8;
    const heights = new Float32Array(w * d).fill(3);
    const tiles = decomposeToTiles({ heights, width: w, depth: d, originGX: 7, originGZ: 7 });
    assert.equal(tiles.length, 1);
    const t = tiles[0];
    assert.equal(t.cx, 0);
    assert.ok(Number.isNaN(t.heights[0])); // gx=0, outside region
    assert.equal(t.heights[14 * 16 + 14], 3); // gx=14, gz=14: in-region corner
  });

  it("handler routes through the worker task type", async () => {
    const heights = new Float32Array(16 * 16).fill(1);
    const r = await chunkDecomposeHandler.handle({ heights, width: 16, depth: 16, originGX: 0, originGZ: 0 });
    assert.equal(r.length, 4); // 16 samples span gx 0..15 -> chunks 0 and 1 in each axis
    assert.equal(chunkDecomposeHandler.type, "chunkDecompose");
  });

  it("rejects mismatched buffer sizes", () => {
    assert.throws(
      () => decomposeToTiles({ heights: new Float32Array(10), width: 4, depth: 4, originGX: 0, originGZ: 0 }),
      /heights length mismatch/,
    );
  });
});
