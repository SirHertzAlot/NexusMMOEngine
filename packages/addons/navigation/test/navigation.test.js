// @mmo-engine/addon-navigation tests (Phase 2).
//
// Covers the N-API boundary contract: bake pipeline (canonical Recast
// flow + validation asserts), tile load/unload lifetime, bulk findPaths
// (SoA in/out, statuses), input validation, and the no-frand rule.
// Cross-process determinism lives in determinism.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createService, PathStatus } = require('../index.js');

const PROFILE = { id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 };

function makeService() {
  return createService({
    originX: 0,
    originZ: 0,
    tileWorldSize: 10,
    profiles: [PROFILE],
  });
}

const BAKE_CFG = {
  tileX: 0,
  tileZ: 0,
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2,
  agentRadius: 0.6,
  agentMaxClimb: 0.9,
  walkableSlopeAngle: 45,
  regionMinSize: 8,
  regionMergeSize: 20,
  edgeMaxLen: 12,
  edgeMaxError: 1.3,
  vertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

/**
 * Flat 10x10 plane at y=0 with counter-clockwise winding viewed from
 * above (+Y) — the winding Recast requires for walkable surfaces.
 */
function flatPlane(x0, x1, z0, z1) {
  const verts = new Float32Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]);
  const idx = new Uint32Array([0, 2, 1, 0, 3, 2]);
  return { verts, idx };
}

function queryArena(n, maxWp) {
  return {
    status: new Int32Array(n),
    waypointCount: new Uint32Array(n),
    polyCount: new Uint32Array(n),
    waypoints: new Float32Array(3 * maxWp * n),
  };
}

test('bakeTile: flat plane bakes to a non-empty tile', () => {
  const svc = makeService();
  try {
    const { verts, idx } = flatPlane(0, 10, 0, 10);
    const { blob, stats } = svc.bakeTile(BAKE_CFG, verts, idx);
    assert.ok(blob.length > 0, 'blob must be non-empty');
    assert.ok(stats.spanCount > 0, 'must rasterize spans');
    assert.ok(stats.contourCount > 0, 'must produce contours');
    assert.ok(stats.polyCount > 0, 'must produce polys');
    assert.equal(stats.blobBytes, blob.length);
  } finally {
    svc.destroy();
  }
});

test('bakeTile: downward winding fails loudly (0 spans), not silently', () => {
  const svc = makeService();
  try {
    // Same plane, clockwise winding viewed from above -> faces point down.
    const verts = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    assert.throws(() => svc.bakeTile(BAKE_CFG, verts, idx), /0 spans/);
  } finally {
    svc.destroy();
  }
});

test('bakeTile: empty geometry throws', () => {
  const svc = makeService();
  try {
    assert.throws(
      () => svc.bakeTile(BAKE_CFG, new Float32Array(0), new Uint32Array(0)),
      /shorter than required/,
    );
  } finally {
    svc.destroy();
  }
});

test('bakeTile: triangle index out of range throws', () => {
  const svc = makeService();
  try {
    const { verts } = flatPlane(0, 10, 0, 10);
    assert.throws(
      () => svc.bakeTile(BAKE_CFG, verts, new Uint32Array([0, 1, 99])),
      /out of vertex range/,
    );
  } finally {
    svc.destroy();
  }
});

test('loadTiles/unloadTiles: tile lifetime', () => {
  const svc = makeService();
  try {
    const { verts, idx } = flatPlane(0, 10, 0, 10);
    const { blob } = svc.bakeTile(BAKE_CFG, verts, idx);
    assert.equal(svc.tileCount(), 0);
    const refs = svc.loadTiles([blob]);
    assert.equal(refs.length, 1);
    assert.ok(refs[0] !== 0n, 'tile ref must be non-zero');
    assert.equal(svc.tileCount(), 1);
    svc.unloadTiles(refs);
    assert.equal(svc.tileCount(), 0);
  } finally {
    svc.destroy();
  }
});

function loadedService() {
  const svc = makeService();
  const { verts, idx } = flatPlane(0, 10, 0, 10);
  const { blob } = svc.bakeTile(BAKE_CFG, verts, idx);
  svc.loadTiles([blob]);
  return svc;
}

test('findPaths: straight path across a flat plane', () => {
  const svc = loadedService();
  try {
    const n = 1;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([7n]),
      start: new Float32Array([1, 0.5, 1]),
      end: new Float32Array([9, 0.5, 9]),
      profile: new Uint8Array([0]),
      maxWaypoints: maxWp,
    };
    const arena = queryArena(n, maxWp);
    svc.findPaths(batch, arena);
    assert.equal(arena.status[0], PathStatus.Ok);
    assert.ok(arena.waypointCount[0] >= 2, 'path needs start + end');
    assert.ok(arena.polyCount[0] > 0, 'corridor must be non-empty');
    const wps = arena.waypoints;
    const m = arena.waypointCount[0];
    // First waypoint snaps to the start, last to the end.
    assert.ok(Math.abs(wps[0] - 1) < 0.5 && Math.abs(wps[2] - 1) < 0.5);
    assert.ok(
      Math.abs(wps[(m - 1) * 3] - 9) < 0.5 &&
        Math.abs(wps[(m - 1) * 3 + 2] - 9) < 0.5,
    );
  } finally {
    svc.destroy();
  }
});

test('findPaths: bulk batch of 3 requests in one call', () => {
  const svc = loadedService();
  try {
    const n = 3;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([1n, 2n, 3n]),
      start: new Float32Array([1, 0.5, 1, 1, 0.5, 9, 5, 0.5, 5]),
      end: new Float32Array([9, 0.5, 9, 9, 0.5, 1, 6, 0.5, 5]),
      profile: new Uint8Array([0, 0, 0]),
      maxWaypoints: maxWp,
    };
    const arena = queryArena(n, maxWp);
    svc.findPaths(batch, arena);
    for (let i = 0; i < n; i++) {
      assert.equal(arena.status[i], PathStatus.Ok, `request ${i}`);
      assert.ok(arena.waypointCount[i] >= 2, `request ${i} waypoints`);
    }
  } finally {
    svc.destroy();
  }
});

test('findPaths: disconnected regions report NoPath', () => {
  const svc = makeService();
  try {
    // Two separate planes in one tile with a gap between them.
    const v1 = flatPlane(0, 4, 0, 10);
    const v2 = flatPlane(6, 10, 0, 10);
    const verts = new Float32Array([...v1.verts, ...v2.verts]);
    const idx = new Uint32Array([...v1.idx, ...[...v2.idx].map((i) => i + 4)]);
    const { blob } = svc.bakeTile(BAKE_CFG, verts, idx);
    svc.loadTiles([blob]);
    const n = 1;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([1n]),
      start: new Float32Array([2, 0.5, 5]),
      end: new Float32Array([8, 0.5, 5]),
      profile: new Uint8Array([0]),
      maxWaypoints: maxWp,
    };
    const arena = queryArena(n, maxWp);
    svc.findPaths(batch, arena);
    assert.equal(arena.status[0], PathStatus.NoPath);
    assert.equal(arena.waypointCount[0], 0);
  } finally {
    svc.destroy();
  }
});

test('findPaths: point outside any tile reports NoStartPoly', () => {
  const svc = loadedService();
  try {
    const n = 1;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([1n]),
      start: new Float32Array([500, 0.5, 500]),
      end: new Float32Array([9, 0.5, 9]),
      profile: new Uint8Array([0]),
      maxWaypoints: maxWp,
    };
    const arena = queryArena(n, maxWp);
    svc.findPaths(batch, arena);
    assert.equal(arena.status[0], PathStatus.NoStartPoly);
  } finally {
    svc.destroy();
  }
});

test('findPaths: unknown profile id reports UnknownProfile', () => {
  const svc = loadedService();
  try {
    const n = 1;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([1n]),
      start: new Float32Array([1, 0.5, 1]),
      end: new Float32Array([9, 0.5, 9]),
      profile: new Uint8Array([9]),
      maxWaypoints: maxWp,
    };
    const arena = queryArena(n, maxWp);
    svc.findPaths(batch, arena);
    assert.equal(arena.status[0], PathStatus.UnknownProfile);
  } finally {
    svc.destroy();
  }
});

test('findPaths: same inputs give identical outputs (in-process)', () => {
  const svc = loadedService();
  try {
    const n = 2;
    const maxWp = 16;
    const batch = {
      count: n,
      entityIds: new BigUint64Array([1n, 2n]),
      start: new Float32Array([1, 0.5, 1, 2, 0.5, 8]),
      end: new Float32Array([9, 0.5, 9, 8, 0.5, 2]),
      profile: new Uint8Array([0, 0]),
      maxWaypoints: maxWp,
    };
    const a1 = queryArena(n, maxWp);
    const a2 = queryArena(n, maxWp);
    svc.findPaths(batch, a1);
    svc.findPaths(batch, a2);
    assert.deepEqual([...a1.status], [...a2.status]);
    assert.deepEqual([...a1.waypointCount], [...a2.waypointCount]);
    assert.deepEqual([...a1.waypoints], [...a2.waypoints]);
  } finally {
    svc.destroy();
  }
});

test('bakeTile is deterministic: identical inputs -> identical bytes', () => {
  const svc = makeService();
  try {
    const { verts, idx } = flatPlane(0, 10, 0, 10);
    const r1 = svc.bakeTile(BAKE_CFG, verts, idx);
    const r2 = svc.bakeTile(BAKE_CFG, verts, idx);
    assert.ok(r1.blob.equals(r2.blob), 'tile blobs must be byte-identical');
  } finally {
    svc.destroy();
  }
});

test('no frand() usage anywhere in the native shim', () => {
  // Determinism posture: the only randomness in the Recast/Detour
  // pipeline is the caller-supplied frand() callback. This addon must
  // never reference it.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'navigation.cc'),
    'utf8',
  );
  assert.ok(!/frand/.test(src), 'src/navigation.cc must not reference frand');
});

test('methods after destroy() throw', () => {
  const svc = makeService();
  svc.destroy();
  assert.throws(() => svc.tileCount(), /destroyed/);
});
