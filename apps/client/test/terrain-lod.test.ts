/**
 * Terrain LOD rings and block batching: chunks drop to coarser sample
 * strides by ring, every level keeps the tile's border samples (so corners
 * meet and the skirts cover the rest), and a streamed ring draws as a
 * handful of block meshes instead of one mesh per chunk.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChunkRow } from "@mmo-engine/protocol";
import { buildChunkGeometry } from "../src/render/terrain/terrain-mesh.js";
import { buildBlockBuffers, buildBlockGeometry, chunkCost, ringOf, strideForRing } from "../src/render/terrain/terrain-lod.js";
import { TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const SIZE = 16;
const surface = (gx: number, gz: number): number => Math.fround(3 * Math.sin(gx * 0.21) + 2 * Math.cos(gz * 0.17 + 1));
const tile = (cx: number, cz: number): Float32Array =>
  Float32Array.from({ length: 256 }, (_, i) => surface(cx * 15 + (i % 16), cz * 15 + Math.floor(i / 16)));
const chunkId = (cx: number, cz: number): bigint => ((BigInt(cx) & 0xffffffffn) << 32n) | (BigInt(cz) & 0xffffffffn);
const row = (cx: number, cz: number): ChunkRow => ({ wireId: 0n, chunkId: chunkId(cx, cz), seed: 1n, lod: 0, heights: tile(cx, cz) });

/** Load the 17 x 17 ring round chunk (0, 0), as the server streams it. */
function ring(t: TerrainRenderer, radius = 8): void {
  let wire = 1n;
  for (let cz = -radius; cz <= radius; cz++) for (let cx = -radius; cx <= radius; cx++) t.ensureChunk(wire++, row(cx, cz));
}

describe("terrain LOD", () => {
  it("strides by ring: full detail near, coarser out, all dividing the tile's 15 cells", () => {
    assert.deepEqual([0, 3, 4, 5, 6, 8, 9].map(strideForRing), [1, 1, 3, 3, 5, 5, 15]);
    for (const r of [0, 4, 6, 20]) assert.equal(15 % strideForRing(r), 0);
    assert.equal(ringOf(5, -2, 1, 1), 4);
  });

  it("stride 1 is the full-detail chunk mesh, vertex for vertex", () => {
    const heights = tile(2, 3);
    const normals = new Float32Array(768).fill(0.5);
    const block = buildBlockGeometry([{ cx: 2, cz: 3, heights, normals, stride: 1 }], SIZE, 32, 48);
    const full = buildChunkGeometry(heights, SIZE);
    const a = block.getAttribute("position").array as Float32Array;
    const b = full.getAttribute("position").array as Float32Array;
    assert.equal(block.getAttribute("position").count, full.getAttribute("position").count);
    for (let i = 0; i < b.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-5, `position ${i}`);
    assert.deepEqual(block.getIndex()!.array, full.getIndex()!.array);
  });

  it("a coarse chunk's border vertices all sit on its finer neighbour's border vertices", () => {
    const n = new Float32Array(768);
    const fine = buildBlockGeometry([{ cx: 0, cz: 0, heights: tile(0, 0), normals: n, stride: 1 }], SIZE, 0, 0);
    for (const stride of [3, 5, 15]) {
      const coarse = buildBlockGeometry([{ cx: 1, cz: 0, heights: tile(1, 0), normals: n, stride }], SIZE, 0, 0);
      const fp = fine.getAttribute("position");
      const cp = coarse.getAttribute("position");
      const fineEdge: Array<[number, number]> = [];
      for (let i = 0; i < fp.count; i++) if (Math.abs(fp.getX(i) - SIZE) < 1e-4) fineEdge.push([fp.getY(i), fp.getZ(i)]);
      const side = 15 / stride + 1;
      let checked = 0;
      for (let i = 0; i < side * side; i++) {
        if (Math.abs(cp.getX(i) - SIZE) > 1e-4) continue; // the coarse chunk's west edge, at x = 16
        assert.ok(fineEdge.some(([y, z]) => Math.abs(y - cp.getY(i)) < 1e-5 && Math.abs(z - cp.getZ(i)) < 1e-4), `stride ${stride} vertex ${i}`);
        checked++;
      }
      assert.equal(checked, side);
    }
  });

  it("a 17 x 17 ring draws as 25 block meshes, and LOD cuts its triangles", () => {
    const t = new TerrainRenderer(SIZE);
    ring(t);
    t.update();
    const flat = t.stats;
    assert.equal(flat.chunks, 289);
    assert.equal(flat.drawCalls, 25, "4 x 4 chunk blocks over chunks -8..8: 5 x 5");
    assert.deepEqual(flat.chunksPerStride, { 1: 289 }, "no camera yet: full detail");
    t.update({ x: 8, z: 8 }); // the camera over chunk (0, 0)
    const lod = t.stats;
    assert.equal(lod.drawCalls, 25);
    assert.deepEqual(lod.chunksPerStride, { 1: 49, 3: 72, 5: 168 });
    assert.ok(lod.triangles < flat.triangles / 3, `${lod.triangles} vs ${flat.triangles}`);
    assert.equal(lod.triangles, 49 * chunkCost(1).triangles + 72 * chunkCost(3).triangles + 168 * chunkCost(5).triangles);
    t.dispose();
  });

  it("moving the camera re-rings the chunks; unloading empties blocks", () => {
    const t = new TerrainRenderer(SIZE);
    ring(t, 4);
    t.update({ x: 8, z: 8 });
    assert.deepEqual(t.stats.chunksPerStride, { 1: 49, 3: 32 });
    t.update({ x: 8 + 4 * SIZE, z: 8 }); // four chunks east
    const s: Record<number, number> = { ...t.stats.chunksPerStride };
    assert.equal(s[1] + s[3] + (s[5] ?? 0), 81);
    assert.ok((s[5] ?? 0) > 0, "the far west side coarsened");
    for (let w = 1n; w <= 81n; w++) t.removeChunk(w);
    t.update({ x: 8, z: 8 });
    assert.equal(t.stats.drawCalls, 0);
    assert.equal(t.group.children.length, 0);
    t.dispose();
  });
});

describe("TerrainRenderer with workers", () => {
  const viaBuffers = (delay = 0): any => ({
    request: async (_t: string, p: any) => {
      await new Promise((r) => setTimeout(r, delay));
      return buildBlockBuffers(p.chunks, p.chunkWorldSize, p.originX, p.originZ);
    },
  });

  it("shows a block once the worker answers, and sends copies", async () => {
    const sent: any[] = [];
    const w = { request: async (t: string, p: any) => (sent.push(p), viaBuffers().request(t, p)) };
    const t = new TerrainRenderer(SIZE, w as any);
    ring(t, 1);
    t.update();
    assert.equal(t.stats.drawCalls, 0, "nothing until the worker answers");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.stats.drawCalls, 4, "chunks -1..1 straddle 2 x 2 blocks");
    const first = sent[0].chunks[0];
    const own = [...(t as any).chunks.values()].find((c: any) => c.cx === first.cx && c.cz === first.cz).heights;
    assert.notEqual(first.heights, own);
    t.dispose();
  });

  it("drops a stale answer when the block changed meanwhile, and one that lands after dispose", async () => {
    const t = new TerrainRenderer(SIZE, viaBuffers(10));
    ring(t, 1);
    t.update();
    (t as any).markBlock(0, 0);
    t.update(); // second request; the first is stale
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.group.children.length, 4);
    t.update();
    t.dispose();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.group.children.length, 0);
  });
});
