// DetourTileCache through the addon: tiles baked to layers and built by
// the cache, obstacles (cylinders and turned boxes) cut the navmesh and
// paths go round them, removing one restores the way, the crowd walks
// round them, big batches get through the cache's request queue, and
// layers unload with their navmesh tiles.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, PathStatus, CrowdAgentState } = require('../index.js');

const TILE = 10;
const TC = { cellSize: 0.25, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.4, agentMaxClimb: 0.9, edgeMaxError: 1.3, maxObstacles: 512, maxLayers: 2 };
const PROFILE = { id: 0, agentHeight: 2, agentRadius: 0.4, agentMaxClimb: 0.9 };
const BAKE = (tileX, tileZ) => ({
  tileX, tileZ, cellSize: 0.25, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.4, agentMaxClimb: 0.9,
  walkableSlopeAngle: 45, regionMinSize: 2, regionMergeSize: 20, edgeMaxLen: 12, edgeMaxError: 1.3,
  vertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1,
});

/** A flat plane at y=0 from (x0, z0) to (x1, z1), counter-clockwise from above. */
function plane(x0, x1, z0, z1) {
  return {
    verts: new Float32Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]),
    idx: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

/** A 2x1-tile flat world (x 0-20, z 0-10), each tile baked with a border of the other. */
function world() {
  const svc = createService({ originX: 0, originZ: 0, tileWorldSize: TILE, maxTiles: 16, maxPolys: 1024, profiles: [PROFILE], tileCache: TC });
  const { verts, idx } = plane(-2, 22, -2, 12);
  const refs = [];
  for (const tx of [0, 1]) refs.push(svc.loadLayers(tx, 0, svc.bakeTileLayers(BAKE(tx, 0), verts, idx)));
  return { svc, refs };
}

function path(svc, from, to) {
  const arena = { status: new Int32Array(1), waypointCount: new Uint32Array(1), polyCount: new Uint32Array(1), waypoints: new Float32Array(3 * 32) };
  svc.findPaths({ count: 1, entityIds: new BigUint64Array([1n]), start: Float32Array.from(from), end: Float32Array.from(to), profile: new Uint8Array([0]), maxWaypoints: 32 }, arena);
  const pts = [];
  for (let i = 0; i < arena.waypointCount[0]; i++) pts.push([arena.waypoints[i * 3], arena.waypoints[i * 3 + 2]]);
  const length = pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  return { status: arena.status[0], pts, length };
}

function obstacles(svc, list) {
  const n = list.length;
  return svc.addObstacles({
    count: n,
    kind: Uint8Array.from(list.map((o) => (o.box ? 1 : 0))),
    pos: Float32Array.from(list.flatMap((o) => o.pos)),
    radius: Float32Array.from(list.map((o) => o.radius ?? 0)),
    height: Float32Array.from(list.map((o) => o.height ?? 2)),
    halfExtents: Float32Array.from(list.flatMap((o) => o.box ?? [0, 0, 0])),
    yaw: Float32Array.from(list.map((o) => o.yaw ?? 0)),
  });
}

function settle(svc) {
  for (let i = 0; i < 100; i++) if (svc.updateObstacles(8)) return;
  assert.fail('the cache never caught up');
}

test('tile cache: layers bake and build navmesh tiles; paths cross between tiles', () => {
  const { svc, refs } = world();
  try {
    assert.equal(svc.tileCount(), 2);
    for (const r of refs) assert.ok(r.length >= 1);
    const p = path(svc, [1, 0, 5], [19, 0, 5]);
    assert.equal(p.status, PathStatus.Ok);
    assert.ok(Math.abs(p.length - 18) < 0.5, `straight across the seam (${p.length.toFixed(2)} m)`);
  } finally {
    svc.destroy();
  }
});

test('tile cache: a wall of boxes turns the path round it; removing it straightens it again', () => {
  const { svc } = world();
  try {
    // A wall across the world at x = 10, gap only at the top (z > 8.5).
    const wall = obstacles(svc, [{ box: [0.3, 1, 4.25], pos: [10, 1, 4.25] }]);
    assert.ok(wall[0] > 0);
    assert.equal(svc.obstacleCount(), 1);
    settle(svc);
    const round = path(svc, [5, 0, 2], [15, 0, 2]);
    assert.equal(round.status, PathStatus.Ok);
    assert.ok(round.length > 15, `goes round the wall (${round.length.toFixed(2)} m)`);
    assert.ok(round.pts.some(([, z]) => z > 8.4), 'through the gap at the top');
    svc.removeObstacles(wall);
    settle(svc);
    assert.equal(svc.obstacleCount(), 0);
    const straight = path(svc, [5, 0, 2], [15, 0, 2]);
    assert.ok(Math.abs(straight.length - 10) < 0.5, `straight again (${straight.length.toFixed(2)} m)`);
  } finally {
    svc.destroy();
  }
});

test('tile cache: a turned box and a cylinder cut the mesh where they stand', () => {
  const { svc } = world();
  try {
    obstacles(svc, [
      { pos: [5, 0, 5], radius: 1.5, height: 2 },
      { box: [2, 1, 0.3], pos: [15, 1, 5], yaw: Math.PI / 2 }, // turned: now a wall along x
    ]);
    settle(svc);
    // Asked for the cylinder's centre, the path ends on the nearest ground
    // outside it (to within a cell: obstacles are rasterised at cellSize,
    // and not grown by the agent's radius, which is the caller's to add).
    const inside = path(svc, [1, 0, 5], [5, 0, 5]);
    const end = inside.pts[inside.pts.length - 1];
    assert.ok(Math.hypot(end[0] - 5, end[1] - 5) >= 1.5 - TC.cellSize, `ends outside the cylinder (${end.map((v) => v.toFixed(2))})`);
    const across = path(svc, [13, 0, 5], [17, 0, 5]);
    assert.equal(across.status, PathStatus.Ok);
    assert.ok(across.length > 4.3, `round the turned box (${across.length.toFixed(2)} m)`);
  } finally {
    svc.destroy();
  }
});

test('tile cache: the crowd walks round an obstacle', () => {
  const { svc } = world();
  try {
    obstacles(svc, [{ pos: [10, 0, 5], radius: 1.2, height: 2 }]);
    settle(svc);
    svc.crowdAdd({ count: 1, entityIds: new BigUint64Array([7n]), pos: new Float32Array([4, 0, 5]), radius: new Float32Array([0.4]), height: new Float32Array([1.8]), maxSpeed: new Float32Array([3]), maxAcceleration: new Float32Array([8]) });
    svc.crowdTarget({ count: 1, entityIds: new BigUint64Array([7n]), target: new Float32Array([16, 0, 5]) });
    let pos = [4, 0, 5];
    let closest = Infinity;
    const out = { vel: new Float32Array(3), pos: new Float32Array(3), state: new Uint8Array(1) };
    for (let t = 0; t < 300; t++) {
      svc.crowdStep(1 / 30, { count: 1, entityIds: new BigUint64Array([7n]), pos: Float32Array.from(pos) }, out);
      pos = [pos[0] + out.vel[0] / 30, out.pos[1], pos[2] + out.vel[2] / 30];
      closest = Math.min(closest, Math.hypot(pos[0] - 10, pos[2] - 5));
    }
    assert.equal(out.state[0], CrowdAgentState.Arrived);
    assert.ok(closest > 1.2, `kept off the obstacle (closest ${closest.toFixed(2)} m from its centre, radius 1.2)`);
  } finally {
    svc.destroy();
  }
});

test('tile cache: hundreds of obstacles in one batch get through the request queue', () => {
  const { svc } = world();
  try {
    const list = [];
    for (let i = 0; i < 200; i++) list.push({ pos: [0.5 + (i % 20), 0, 0.5 + Math.floor(i / 20) * 0.9], radius: 0.1, height: 1 });
    const refs = obstacles(svc, list);
    assert.equal(refs.filter((r) => r > 0).length, 200);
    settle(svc);
    assert.equal(svc.obstacleCount(), 200);
  } finally {
    svc.destroy();
  }
});

test('tile cache: layers unload with their navmesh tiles; misuse is refused', () => {
  const { svc, refs } = world();
  try {
    svc.unloadLayers(refs[1]);
    assert.equal(svc.tileCount(), 1);
    assert.equal(path(svc, [1, 0, 5], [19, 0, 5]).status, PathStatus.NoEndPoly);
    const { verts, idx } = plane(-2, 22, -2, 12);
    assert.throws(() => svc.bakeTileLayers({ ...BAKE(0, 0), cellSize: 0.3 }, verts, idx), /must match config.tileCache/);
    assert.throws(() => svc.loadLayers(0, 0, svc.bakeTileLayers(BAKE(0, 0), verts, idx)), /already loaded/);
    assert.throws(() => svc.loadLayers(5, 5, svc.bakeTileLayers(BAKE(0, 0), verts, idx)), /another tile/);
    const far = plane(100, 101, 100, 101);
    assert.throws(() => svc.bakeTileLayers(BAKE(0, 0), far.verts, far.idx), /0 layers/);
  } finally {
    svc.destroy();
  }
  const plain = createService({ originX: 0, originZ: 0, tileWorldSize: TILE, profiles: [PROFILE] });
  assert.throws(() => plain.updateObstacles(1), /no tile cache/);
  plain.destroy();
  assert.throws(() => createService({ originX: 0, originZ: 0, tileWorldSize: TILE, profiles: [PROFILE], tileCache: { ...TC, cellSize: 0.3 } }), /cellSize/);
});
