import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  attachChunkHeights,
  Chunk,
  chunkCoordsFor,
  chunkIdFor,
  collectDeltaState,
  collectFullState,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  SimWorld,
  splitU64,
  type ChunkDataSource,
  type CollectedState,
} from "../src/index.js";

/** Deterministic stub source: height[i] = i * 0.25 + cx (encodes coords). */
const stubSource: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk: (_seed, cx, _cz, _lod, out) => {
    for (let i = 0; i < out.length; i++) out[i] = i * 0.25 + cx;
  },
};

function makeChunkWorld(cx: number, cz: number): SimWorld {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Chunk, eid);
  const cid = splitU64(chunkIdFor(cx, cz));
  const seed = splitU64(1234n);
  Chunk.chunkIdHi[eid] = cid.hi;
  Chunk.chunkIdLo[eid] = cid.lo;
  Chunk.seedHi[eid] = seed.hi;
  Chunk.seedLo[eid] = seed.lo;
  Chunk.lod[eid] = 0;
  return sim;
}

test("chunkCoordsFor inverts chunkIdFor, including negative coords", () => {
  for (const [cx, cz] of [[0, 0], [3, -5], [-7, 12], [2147483647, -2147483648]] as const) {
    assert.deepEqual(chunkCoordsFor(chunkIdFor(cx, cz)), { cx, cz });
  }
});

test("attachChunkHeights fills 256 heights from the chunk source", () => {
  const sim = makeChunkWorld(3, -5);
  // Lean by default: the persistence path never carries heights.
  assert.equal(collectFullState(sim, 1).chunks[0].heights, null);
  const state: CollectedState = collectFullState(sim, 1);
  assert.equal(state.chunks.length, 1);
  attachChunkHeights(state, stubSource);
  const h = state.chunks[0].heights;
  assert.ok(h instanceof Float32Array);
  assert.equal(h.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(h[i], i * 0.25 + 3);
});

test("snapshot round-trips chunk heights bit-exact", () => {
  const sim = makeChunkWorld(-2, 9);
  const state = collectFullState(sim, 7);
  attachChunkHeights(state, stubSource);
  const decoded = decodeSnapshot(encodeSnapshot(state));
  assert.equal(decoded.chunks.length, 1);
  const h = decoded.chunks[0].heights;
  assert.ok(h instanceof Float32Array);
  assert.equal(h.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(h[i], i * 0.25 + -2);
  // metadata survives alongside heights
  assert.equal(decoded.chunks[0].lod, 0);
});

test("snapshot decodes heights from a misaligned wire buffer", () => {
  // WebSocket Buffers are often views into a pool with a non-zero
  // byteOffset; the decoder must not rely on 4-alignment.
  const sim = makeChunkWorld(3, -1);
  const state = collectFullState(sim, 7);
  attachChunkHeights(state, stubSource);
  const bytes = encodeSnapshot(state);
  const pooled = new Uint8Array(bytes.length + 3);
  pooled.set(bytes, 3); // force byteOffset % 4 === 3
  const view = new Uint8Array(pooled.buffer, 3, bytes.length);
  assert.equal(view.byteOffset % 4, 3);
  const decoded = decodeSnapshot(view);
  assert.equal(decoded.chunks.length, 1);
  const h = decoded.chunks[0].heights;
  assert.ok(h instanceof Float32Array);
  assert.equal(h.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(h[i], i * 0.25 + 3);
});

test("snapshots without attached heights decode heights as null", () => {
  const sim = makeChunkWorld(0, 0);
  const decoded = decodeSnapshot(encodeSnapshot(collectFullState(sim, 1)));
  assert.equal(decoded.chunks.length, 1);
  assert.equal(decoded.chunks[0].heights, null);
});

test("delta round-trips chunk heights for newly spawned chunks", () => {
  const sim = makeChunkWorld(4, 4);
  const tracker = new DeltaTracker();
  tracker.commit(sim); // baseline: empty, so the chunk diffs as spawned
  const delta = collectDeltaState(sim, 2, 1, tracker);
  attachChunkHeights(delta, stubSource);
  const decoded = decodeDelta(encodeDelta(delta));
  assert.equal(decoded.chunks.length, 1);
  const h = decoded.chunks[0].heights;
  assert.ok(h instanceof Float32Array);
  assert.equal(h.length, 256);
  assert.equal(h[100], 100 * 0.25 + 4);
});
