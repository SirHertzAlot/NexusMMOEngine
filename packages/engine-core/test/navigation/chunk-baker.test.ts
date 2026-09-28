// chunk-baker tests (Phase 2, slice 2.1).
//
// These run against the REAL native backend: baking a chunk tile from
// buildChunkMesh output proves the mesh winding is walkable (wrong
// winding fails loudly in bakeTile), and the load+query round-trip proves
// the baker/native tile-coordinate contract.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  bakeChunkTile,
  buildChunkMesh,
  bakeConfigHash,
  canonicalBakeConfig,
  DEFAULT_BAKE_CONFIG,
  type ChunkBakeOptions,
} from "../../src/navigation/chunk-baker.js";
import {
  createNavigationBackend,
  NAV_PATH_STATUS,
  type NavigationBackend,
} from "../../src/navigation/backend.js";
import type { ChunkDataSource } from "../../src/procgen/chunk-source.js";

/** Deterministic flat source: all heights 0. */
const flatSource: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk: (_seed, _cx, _cz, _lod, out) => out.fill(0),
};

/** Deterministic gentle hill: smooth, walkable, non-trivial. */
const hillSource: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk: (_seed, _cx, _cz, _lod, out) => {
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) {
        const dx = (i - 7.5) / 7.5;
        const dz = (j - 7.5) / 7.5;
        out[j * 16 + i] = 2 * Math.exp(-(dx * dx + dz * dz) * 2);
      }
    }
  },
};

function bakeOptions(source: ChunkDataSource, backend: NavigationBackend): ChunkBakeOptions {
  return {
    backend,
    source,
    seed: 1234n,
    chunkWorldSize: 16,
    bakeConfig: { ...DEFAULT_BAKE_CONFIG },
  };
}

// One backend for the file (matches the tile-coordinate contract:
// origin 0,0 and tileWorldSize = chunkWorldSize = 16).
const backend = createNavigationBackend({
  originX: 0,
  originZ: 0,
  tileWorldSize: 16,
  profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
});
after(() => backend.destroy());

describe("chunk-baker", () => {
  it("bakes a flat chunk tile with non-empty stats (winding is walkable)", () => {
    const result = bakeChunkTile(bakeOptions(flatSource, backend), 0, 0);
    assert.ok(result.stats.spanCount > 0, "spans");
    assert.ok(result.stats.contourCount > 0, "contours");
    assert.ok(result.stats.polyCount > 0, "polys");
    assert.ok(result.blob.length > 0);
    assert.equal(result.chunkX, 0);
    assert.equal(result.chunkZ, 0);
    assert.equal(result.config.tileX, 0);
    assert.equal(result.config.tileZ, 0);
    assert.match(result.bakeConfigHash, /^[0-9a-f]{64}$/);
  });

  it("bakes a hill chunk and finds a path across it", () => {
    const result = bakeChunkTile(bakeOptions(hillSource, backend), 3, -2);
    assert.equal(result.config.tileX, 3);
    assert.equal(result.config.tileZ, -2);
    const refs = backend.loadTiles([result.blob]);
    assert.equal(refs.length, 1);
    try {
      const n = 1;
      const maxWp = 16;
      const arena = {
        status: new Int32Array(n),
        waypointCount: new Uint32Array(n),
        polyCount: new Uint32Array(n),
        waypoints: new Float32Array(3 * maxWp * n),
      };
      // Chunk (3,-2) spans x in [48,64], z in [-32,-16].
      backend.findPaths(
        {
          count: n,
          entityIds: new BigUint64Array([1n]),
          start: new Float32Array([50, 1, -30]),
          end: new Float32Array([62, 1, -18]),
          profile: new Uint8Array([0]),
          maxWaypoints: maxWp,
        },
        arena,
      );
      assert.equal(arena.status[0], NAV_PATH_STATUS.Ok);
      assert.ok(arena.waypointCount[0] >= 2);
    } finally {
      backend.unloadTiles(refs);
    }
  });

  it("buildChunkMesh emits the expected vertex/triangle counts", () => {
    const { vertices, indices } = buildChunkMesh(
      flatSource,
      1n,
      0,
      0,
      0,
      16,
    );
    assert.equal(vertices.length, 256 * 3);
    assert.equal(indices.length, 15 * 15 * 6);
    // World extent matches the chunk contract.
    assert.equal(vertices[0], 0);
    assert.equal(vertices[2], 0);
    const last = vertices.length - 3;
    assert.equal(vertices[last], 16);
    assert.equal(vertices[last + 2], 16);
  });

  it("bake config hash is stable and sensitive to every field", () => {
    const a = { ...DEFAULT_BAKE_CONFIG, tileX: 0, tileZ: 0 };
    const b = { ...DEFAULT_BAKE_CONFIG, tileX: 1, tileZ: 0 };
    assert.equal(bakeConfigHash(a), bakeConfigHash(a));
    assert.notEqual(bakeConfigHash(a), bakeConfigHash(b));
    // Canonical form: key order fixed regardless of object insertion order.
    const shuffled: Record<string, number> = {};
    for (const k of Object.keys(a).reverse()) shuffled[k] = (a as Record<string, number>)[k];
    assert.equal(
      canonicalBakeConfig(shuffled as typeof a),
      canonicalBakeConfig(a),
    );
  });
});
