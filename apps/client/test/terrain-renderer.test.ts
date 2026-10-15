/**
 * TerrainRenderer bookkeeping: chunks come and go by wire id, a flat
 * stand-in is rebuilt once its heights arrive, and the far horizon hides
 * itself exactly over the loaded chunks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChunkRow, WorldMap } from "@mmo-engine/protocol";
import { chunkCoords, farGeometry, TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const chunkId = (cx: number, cz: number): bigint => (BigInt.asUintN(32, BigInt(cx)) << 32n) | BigInt.asUintN(32, BigInt(cz));

function chunk(cx: number, cz: number, heights: Float32Array | null): ChunkRow {
  return { wireId: 0n, chunkId: chunkId(cx, cz), seed: 1n, lod: 0, heights };
}

function world(): { map: WorldMap; bounds: { minCx: number; minCz: number; maxCx: number; maxCz: number } } {
  const W = 8;
  return {
    map: {
      cell: 16, width: W, depth: W, originX: -56, originZ: -56,
      heights: Float32Array.from({ length: W * W }, (_, i) => (i % W) * 2),
      biome: new Uint8Array(W * W), biomes: ["plains"], river: new Uint8Array(W * W),
    },
    bounds: { minCx: -4, minCz: -4, maxCx: 3, maxCz: 3 },
  };
}

describe("TerrainRenderer", () => {
  it("decodes negative chunk coordinates from the chunk id", () => {
    assert.deepEqual(chunkCoords(chunkId(-3, 2)), { cx: -3, cz: 2 });
  });

  it("the far horizon hides over loaded chunks and returns when they unload", () => {
    const r = new TerrainRenderer(16);
    r.setWorld(world());
    assert.equal(r.hasFar, true);
    r.ensureChunk(10n, chunk(-1, 2, new Float32Array(256).fill(3)));
    assert.equal(r.chunkCount, 1);
    assert.equal(r.maskedAt(-1, 2), true);
    assert.equal(r.maskedAt(0, 2), false);
    assert.deepEqual(r.loadedChunkAt(-10, 40), { cx: -1, cz: 2 });
    r.removeChunk(10n);
    assert.equal(r.chunkCount, 0);
    assert.equal(r.maskedAt(-1, 2), false);
    r.dispose();
  });

  it("a flat stand-in keeps the horizon showing until its heights arrive", () => {
    const r = new TerrainRenderer(16);
    r.setWorld(world());
    r.ensureChunk(11n, chunk(0, 0, null));
    assert.equal(r.maskedAt(0, 0), false, "flat stand-in: the far map still shows the real shape");
    r.ensureChunk(11n, chunk(0, 0, new Float32Array(256).fill(5)));
    assert.equal(r.maskedAt(0, 0), true);
    assert.deepEqual([...r.chunkWireIds()], [11n]);
    r.dispose();
  });

  it("rebuilds a chunk whose wire id outlived it (a newer entity took the cell, then went)", () => {
    const r = new TerrainRenderer(16);
    r.setWorld(world());
    r.ensureChunk(20n, chunk(0, 0, new Float32Array(256).fill(1)));
    r.ensureChunk(21n, chunk(0, 0, new Float32Array(256).fill(2)));
    r.removeChunk(21n);
    assert.equal(r.chunkCount, 0);
    assert.doesNotThrow(() => r.ensureChunk(20n, chunk(0, 0, new Float32Array(256).fill(3))));
    assert.equal(r.chunkCount, 1);
    r.dispose();
  });

  it("builds the far mesh with one vertex per map cell, facing up", () => {
    const { map } = world();
    const g = farGeometry(map);
    assert.equal(g.getAttribute("position").count, map.width * map.depth);
    const n = g.getAttribute("normal").array as Float32Array;
    for (let i = 1; i < n.length; i += 3) assert.ok(n[i] > 0.9, "normals point up");
  });
});
