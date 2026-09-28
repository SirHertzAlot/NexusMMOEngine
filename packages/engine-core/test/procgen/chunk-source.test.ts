import test from "node:test";
import assert from "node:assert/strict";
import { hasComponent } from "bitecs";
import {
  Chunk,
  chunkIdFor,
  createCachedChunkSource,
  DEFAULT_TERRAIN_AMPLITUDE,
  makeProcgenChunkSource,
  SimWorld,
  spawnChunk,
  splitU64,
  terrainOptionsFromEnv,
} from "../../src/index.js";
import type { ChunkDataSource } from "../../src/index.js";

const SEED = 0xabcdef0123456789n;

/** Pure-JS stub source: proves the wrapper depends only on the interface. */
function stubSource(): ChunkDataSource {
  return {
    chunkSamples: 256,
    generateChunk(seed, cx, cz, lod, out) {
      out.fill(Number(seed & 0xffffn) / 65536 + cx * 0.01 + cz * 0.001 + lod);
    },
  };
}

test("chunkIdFor packs (cx, cz) into a u64 round-trip", () => {
  const id = chunkIdFor(3, -7);
  const { hi, lo } = splitU64(id);
  // Two's complement preserved through the hi/lo split.
  assert.equal((hi | 0) >> 0, 3);
  assert.equal((lo | 0) >> 0, -7);
});

test("spawnChunk fills the Chunk component metadata", () => {
  const world = new SimWorld();
  const { eid } = spawnChunk(world, stubSource(), SEED, 3, -7, 2);
  assert.ok(hasComponent(world.ecs, Chunk, eid));
  const { hi, lo } = splitU64(chunkIdFor(3, -7));
  assert.equal(Chunk.chunkIdHi[eid], hi);
  assert.equal(Chunk.chunkIdLo[eid], lo);
  const s = splitU64(SEED);
  assert.equal(Chunk.seedHi[eid], s.hi);
  assert.equal(Chunk.seedLo[eid], s.lo);
  assert.equal(Chunk.lod[eid], 2);
});

test("spawnChunk returns heights from the source", () => {
  const world = new SimWorld();
  const { heights } = spawnChunk(world, stubSource(), SEED, 3, -7, 0);
  assert.equal(heights.length, 256);
  assert.ok(heights.every((v) => v === heights[0]), "stub fills uniformly");
});

test("addon source: chunk data originates from the native addon", () => {
  const world = new SimWorld();
  const source = makeProcgenChunkSource();
  assert.equal(source.chunkSamples, 256);
  const a = spawnChunk(world, source, SEED, 3, -7, 0);
  const b = spawnChunk(world, source, SEED, 3, -7, 0);
  // Deterministic: same inputs -> bit-identical heights.
  assert.deepStrictEqual(a.heights, b.heights);
  // Real terrain: varied, bounded by the world-unit amplitude.
  const distinct = new Set(a.heights).size;
  assert.ok(distinct > 200, `expected varied terrain, got ${distinct}`);
  for (const v of a.heights) {
    assert.ok(Math.abs(v) < source.amplitude, `height ${v} exceeds amplitude`);
  }
  // Chunk metadata matches the addon inputs.
  const s = splitU64(SEED);
  assert.equal(Chunk.seedHi[a.eid], s.hi);
  assert.equal(Chunk.seedLo[a.eid], s.lo);
});

test("addon source: different seeds give different chunks", () => {
  const world = new SimWorld();
  const source = makeProcgenChunkSource();
  const a = spawnChunk(world, source, SEED, 0, 0, 0);
  const b = spawnChunk(world, source, SEED + 1n, 0, 0, 0);
  assert.notDeepStrictEqual(a.heights, b.heights);
});

test("addon source: adjacent chunks share their border samples exactly", () => {
  const source = makeProcgenChunkSource();
  const gen = (cx: number, cz: number): Float32Array => {
    const out = new Float32Array(256);
    source.generateChunk(SEED, cx, cz, 0, out);
    return out;
  };
  // Includes negative coordinates and both axes: sample 15 of a chunk
  // and sample 0 of its +X / +Z neighbour are the same world point.
  for (const [cx, cz] of [[0, 0], [-1, -1], [5, -3], [-8, 2]]) {
    const c = gen(cx, cz);
    const east = gen(cx + 1, cz);
    const south = gen(cx, cz + 1);
    for (let k = 0; k < 16; k++) {
      assert.equal(c[k * 16 + 15], east[k * 16], `x seam (${cx},${cz}) row ${k}`);
      assert.equal(c[15 * 16 + k], south[k], `z seam (${cx},${cz}) col ${k}`);
    }
  }
});

test("addon source: amplitude scales heights; terrainVersion fingerprints the shape", () => {
  const unit = makeProcgenChunkSource({ amplitude: 1 });
  const tall = makeProcgenChunkSource({ amplitude: 3 });
  const a = new Float32Array(256);
  const b = new Float32Array(256);
  unit.generateChunk(SEED, 2, 2, 0, a);
  tall.generateChunk(SEED, 2, 2, 0, b);
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(b[i] - a[i] * 3) < 1e-5);

  const broad = makeProcgenChunkSource({ amplitude: 1, frequency: 0.005 });
  assert.equal(unit.terrainVersion, makeProcgenChunkSource({ amplitude: 1 }).terrainVersion);
  assert.notEqual(unit.terrainVersion, tall.terrainVersion);
  assert.notEqual(unit.terrainVersion, broad.terrainVersion);
  assert.ok(Number.isInteger(unit.terrainVersion) && unit.terrainVersion >= 0);
});

test("terrainOptionsFromEnv parses, defaults, and rejects typos", () => {
  assert.deepEqual(terrainOptionsFromEnv({}), {});
  assert.deepEqual(
    terrainOptionsFromEnv({ MMO_TERRAIN_AMPLITUDE: "6", MMO_TERRAIN_FREQUENCY: "0.01" }),
    { amplitude: 6, frequency: 0.01 },
  );
  assert.throws(() => terrainOptionsFromEnv({ MMO_TERRAIN_AMPLITUDE: "tall" }), /AMPLITUDE/);
  assert.throws(() => terrainOptionsFromEnv({ MMO_TERRAIN_AMPLITUDE: "-1" }), /AMPLITUDE/);
  assert.throws(() => terrainOptionsFromEnv({ MMO_TERRAIN_FREQUENCY: "2" }), /FREQUENCY/);
  assert.equal(makeProcgenChunkSource().amplitude, DEFAULT_TERRAIN_AMPLITUDE);
});

test("createCachedChunkSource: same heights, one generation per chunk, bounded", () => {
  let calls = 0;
  const inner = stubSource();
  const counting: ChunkDataSource = {
    chunkSamples: inner.chunkSamples,
    generateChunk(seed, cx, cz, lod, out) {
      calls++;
      inner.generateChunk(seed, cx, cz, lod, out);
    },
  };
  const cached = createCachedChunkSource(counting, 2);
  const a = new Float32Array(256);
  const b = new Float32Array(256);
  cached.generateChunk(SEED, 1, 1, 0, a);
  cached.generateChunk(SEED, 1, 1, 0, b);
  assert.equal(calls, 1, "second request is served from cache");
  assert.deepStrictEqual(a, b);
  // Callers own `out`: mutating it must not corrupt the cache.
  a.fill(999);
  cached.generateChunk(SEED, 1, 1, 0, b);
  assert.notEqual(b[0], 999);

  // Capacity 2: touching (1,1) keeps it; (2,2) is evicted by (3,3).
  cached.generateChunk(SEED, 2, 2, 0, b);
  cached.generateChunk(SEED, 1, 1, 0, b);
  cached.generateChunk(SEED, 3, 3, 0, b);
  const before = calls;
  cached.generateChunk(SEED, 1, 1, 0, b);
  assert.equal(calls, before, "recently used chunk stayed resident");
  cached.generateChunk(SEED, 2, 2, 0, b);
  assert.equal(calls, before + 1, "least recently used chunk was evicted");

  assert.throws(() => createCachedChunkSource(counting, 0), /capacity/);
});
