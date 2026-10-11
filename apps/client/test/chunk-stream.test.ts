import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChunkStreamManager, chunkIdFor, type ChunkSource } from "../src/render/terrain/chunk-stream.js";
import type { TerrainTile } from "@mmo-engine/protocol";
import { RegionCoordinator, keysInRange, type RegionInfo } from "../src/render/terrain/region-coordinator.js";

const tile = (cx: number, cz: number): TerrainTile => ({ cx, cz, heights: new Float32Array(256).fill(1) });

function source(tiles: TerrainTile[], log?: string[]): ChunkSource {
  return {
    fetchTiles: async (keys: string[]) => {
      log?.push(...keys);
      await new Promise((r) => setTimeout(r, 1));
      const want = new Set(keys);
      return tiles.filter((t) => want.has(`${t.cx},${t.cz}`));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

describe("ChunkStreamManager", () => {
  it("fetches nearest-first and caches", async () => {
    const seen: TerrainTile[] = [];
    const evicted: string[] = [];
    const src = source([tile(0, 0), tile(1, 0), tile(0, 1), tile(-1, -1)]);
    const m = new ChunkStreamManager(src, {
      onTile: (t) => seen.push(t),
      onEvict: (cx, cz) => evicted.push(`${cx},${cz}`),
    });
    m.update(0, 0, 1);
    await flush();
    // radius 1 -> 9 chunks wanted; source only has 4.
    assert.equal(seen.length, 4);
    // (0,0) is nearest: it must arrive (order across batches isn't strict, presence is).
    assert.ok(seen.some((t) => t.cx === 0 && t.cz === 0));
    assert.equal(m.cachedCount, 4);
    // Second update: everything cached, no refetch.
    seen.length = 0;
    m.update(0, 0, 1);
    await flush();
    assert.equal(seen.length, 0);
    m.dispose();
  });

  it("dedups in-flight requests", async () => {
    const log: string[] = [];
    const src = source([tile(0, 0)], log);
    const m = new ChunkStreamManager(src, { onTile: () => {}, onEvict: () => {} }, { batchSize: 4 });
    m.update(0, 0, 0);
    m.update(0, 0, 0); // same demand while in flight
    await flush();
    assert.equal(log.filter((k) => k === "0,0").length, 1);
    m.dispose();
  });

  it("evicts farthest-first beyond maxCached", async () => {
    const evicted: string[] = [];
    const tiles = [tile(0, 0), tile(10, 0), tile(20, 0)];
    const src = source(tiles);
    const m = new ChunkStreamManager(
      src,
      { onTile: () => {}, onEvict: (cx, cz) => evicted.push(`${cx},${cz}`) },
      { maxCached: 2, batchSize: 8 },
    );
    // Force all three into cache via prefetch, camera at origin.
    m.prefetch(["0,0", "10,0", "20,0"]);
    await flush();
    assert.equal(m.cachedCount, 2);
    assert.deepEqual(evicted, ["20,0"]); // farthest goes first
    m.dispose();
  });

  it("setSource routes new demand to the new source", async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const srcA = source([tile(0, 0)], seenA);
    const srcB = source([tile(9, 9)], seenB);
    const got: TerrainTile[] = [];
    const m = new ChunkStreamManager(srcA, { onTile: (t) => got.push(t), onEvict: () => {} });
    m.update(0, 0, 0);
    await flush();
    assert.ok(got.some((t) => t.cx === 0));
    m.setSource(srcB);
    m.update(9, 9, 0);
    await flush();
    assert.ok(got.some((t) => t.cx === 9 && t.cz === 9));
    assert.ok(seenB.includes("9,9"));
    assert.ok(!seenA.includes("9,9"));
    m.dispose();
  });

  it("failed batches are lossy-ok and retryable", async () => {
    let fail = true;
    const src: ChunkSource = {
      fetchTiles: async (keys: string[]) => {
        await new Promise((r) => setTimeout(r, 1));
        if (fail) throw new Error("boom");
        return keys.map((k) => { const [cx, cz] = k.split(",").map(Number); return tile(cx, cz); });
      },
    };
    const got: TerrainTile[] = [];
    const m = new ChunkStreamManager(src, { onTile: (t) => got.push(t), onEvict: () => {} });
    m.update(0, 0, 0);
    await flush();
    assert.equal(got.length, 0);
    assert.equal(m.inflightCount, 0);
    fail = false;
    m.update(0, 0, 0); // retry
    await flush();
    assert.equal(got.length, 1);
    m.dispose();
  });
});

describe("chunkIdFor", () => {
  it("round-trips through the renderer's chunkCoords", async () => {
    const { chunkCoords } = await import("../src/render/terrain/terrain-renderer.js");
    for (const [cx, cz] of [[0, 0], [5, -3], [-100, 42]] as const) {
      const back = chunkCoords(chunkIdFor(cx, cz));
      assert.deepEqual(back, { cx, cz });
    }
  });
});

describe("RegionCoordinator", () => {
  const region = (id: string, minCx: number, maxCx: number, tiles: TerrainTile[]): RegionInfo => ({
    regionId: id,
    range: { minCx, minCz: 0, maxCx, maxCz: 0 },
    source: source(tiles),
  });

  it("routes each key to its owning region", async () => {
    const prefetched: string[] = [];
    const c = new RegionCoordinator((keys) => prefetched.push(...keys));
    c.setRegion(region("a", 0, 4, [tile(1, 0)]));
    c.setRegion(region("b", 5, 9, [tile(7, 0)]));
    const rs = c.routingSource();
    const got = await rs.fetchTiles(["1,0", "7,0", "99,0"]);
    assert.deepEqual(got.map((t) => `${t.cx},${t.cz}`).sort(), ["1,0", "7,0"]);
    // 99,0 has no owner: omitted, not an error.
  });

  it("handoff prefetches from the gaining region, then flips routing on commit", async () => {
    const prefetched: string[] = [];
    const c = new RegionCoordinator((keys) => prefetched.push(...keys));
    c.setRegion(region("a", 0, 9, [tile(8, 0), tile(9, 0)]));
    c.setRegion(region("b", 10, 19, [tile(8, 0), tile(9, 0)]));
    // Migration: chunks 8..9 move from a to b.
    const range = { minCx: 8, minCz: 0, maxCx: 9, maxCz: 0 };
    c.announceHandoff(range, "b");
    assert.equal(c.pendingHandoffs, 1);
    assert.ok(prefetched.includes("8,0") && prefetched.includes("9,0"));
    // Before commit, routing still goes to a.
    assert.equal(c.ownerOf(8, 0)?.regionId, "a");
    c.commitHandoff(range, "b");
    assert.equal(c.pendingHandoffs, 0);
    assert.equal(c.ownerOf(8, 0)?.regionId, "b");
    assert.equal(c.ownerOf(9, 0)?.regionId, "b");
    assert.equal(c.ownerOf(7, 0)?.regionId, "a"); // a keeps the rest
  });

  it("duplicate/unknown commits are no-ops", () => {
    const c = new RegionCoordinator(() => {});
    c.setRegion(region("a", 0, 9, []));
    c.commitHandoff({ minCx: 0, minCz: 0, maxCx: 1, maxCz: 0 }, "ghost");
    assert.equal(c.ownerOf(0, 0)?.regionId, "a");
    c.commitHandoff({ minCx: 0, minCz: 0, maxCx: 1, maxCz: 0 }, "ghost");
    assert.equal(c.pendingHandoffs, 0);
  });

  it("keysInRange enumerates the range", () => {
    assert.deepEqual(keysInRange({ minCx: 0, minCz: 0, maxCx: 1, maxCz: 1 }).sort(), ["0,0", "0,1", "1,0", "1,1"]);
  });
});
