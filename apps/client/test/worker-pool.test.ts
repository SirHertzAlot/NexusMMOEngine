import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerPool } from "../src/workers/pool.js";
import { WorkerRuntime, type WorkerScope } from "../src/workers/runtime.js";
import { terrainBlockHandler } from "../src/workers/handlers/terrain-block.js";
import { buildBlockBuffers } from "../src/render/terrain/terrain-lod.js";

/** A real worker-side runtime wired to a main-side scope by in-memory message passing. */
function loopbackWorker(onTask?: () => void): WorkerScope {
  const main: WorkerScope = {
    onmessage: null, onerror: null,
    postMessage: (m) => void queueMicrotask(() => void (side.onmessage as any)({ data: m })),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const side: WorkerScope = {
    onmessage: null, onerror: null,
    postMessage: (m) => void queueMicrotask(() => void (main.onmessage as any)({ data: m })),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const rt = new WorkerRuntime({}, side);
  rt.registerHandler("terrainBlock", { type: "terrainBlock", handle: async (p) => (onTask?.(), terrainBlockHandler.handle(p)) });
  return main;
}

const chunk = (cx: number, stride: number) => ({
  cx, cz: 0, stride,
  heights: new Float32Array(256).fill(cx + 1),
  normals: new Float32Array(768).map((_, i) => (i % 3 === 1 ? 1 : 0)),
});

describe("WorkerPool", () => {
  it("builds a terrain block off-thread identical to building it inline", async () => {
    const pool = new WorkerPool(() => loopbackWorker(), 2);
    const chunks = [chunk(0, 1), chunk(1, 5)];
    const expected = buildBlockBuffers(chunks.map((c) => ({ ...c })), 16, 0, 0);
    const got = await pool.request("terrainBlock", { chunks, chunkWorldSize: 16, originX: 0, originZ: 0 });
    assert.deepEqual(got.position, expected.position);
    assert.deepEqual(got.normal, expected.normal);
    assert.deepEqual(got.index, expected.index);
  });

  it("spreads concurrent requests over its workers", async () => {
    const used = [0, 0, 0];
    let n = 0;
    const pool = new WorkerPool(() => { const w = n++; return loopbackWorker(() => void used[w]++); }, 3);
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => pool.request("terrainBlock", { chunks: [chunk(0, 5)], chunkWorldSize: 16, originX: 0, originZ: 0 })));
    assert.deepEqual(used, [2, 2, 2]);
  });
});
