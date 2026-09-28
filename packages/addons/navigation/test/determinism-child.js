// Cross-process determinism probe for the navigation addon.
//
// Bakes a fixed tile and runs a fixed path query in a FRESH process,
// printing a fingerprint of exact bytes. The parent test runs this three
// times; identical fingerprints prove the bake + query pipeline is
// deterministic across processes (no hidden global state, no unseeded
// randomness).

'use strict';

const crypto = require('node:crypto');
const { createService } = require('../index.js');

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const svc = createService({
  originX: 0,
  originZ: 0,
  tileWorldSize: 10,
  profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
});

const cfg = {
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

// Deterministic scene: flat plane + one box obstacle (fixed literals,
// no Math.random, no Date).
const verts = new Float32Array([
  0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, // plane
  4, 0, 4, 6, 0, 4, 6, 0, 6, 4, 0, 6, // box base (walkable top at y=1)
  4, 1, 4, 6, 1, 4, 6, 1, 6, 4, 1, 6, // box top
]);
const idx = new Uint32Array([
  0, 2, 1, 0, 3, 2, // plane, CCW from above
  4, 6, 5, 4, 7, 6, // box base
  8, 9, 10, 8, 10, 11, // box top (walkable, climb 0.9 < 1.0 so it blocks)
]);

const { blob } = svc.bakeTile(cfg, verts, idx);
svc.loadTiles([blob]);

const n = 2;
const maxWp = 16;
const batch = {
  count: n,
  entityIds: new BigUint64Array([1n, 2n]),
  start: new Float32Array([1, 0.5, 1, 1, 0.5, 9]),
  end: new Float32Array([9, 0.5, 9, 9, 0.5, 1]),
  profile: new Uint8Array([0, 0]),
  maxWaypoints: maxWp,
};
const arena = {
  status: new Int32Array(n),
  waypointCount: new Uint32Array(n),
  polyCount: new Uint32Array(n),
  waypoints: new Float32Array(3 * maxWp * n),
};
svc.findPaths(batch, arena);

// Fingerprint over exact bytes: tile blob + statuses + waypoint bits.
const fp = sha(
  Buffer.concat([
    blob,
    Buffer.from(arena.status.buffer),
    Buffer.from(arena.waypointCount.buffer),
    Buffer.from(arena.waypoints.buffer),
  ]),
);
console.log(
  `tiles=1 polys=${arena.polyCount[0]}+${arena.polyCount[1]} fp=${fp}`,
);
svc.destroy();
