// DetourCrowd through the addon: agents steer to targets over the mesh
// and around what blocks them, pass each other without overlapping, get
// re-placed when the simulation moves them a long way, and report their
// state. The tests play the part of the game: each tick they move every
// agent by the velocity crowdStep returned, as the engine's intent does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createService,
  CrowdAddStatus,
  CrowdTargetStatus,
  CrowdAgentState,
} = require('../index.js');

const PROFILE = { id: 0, agentHeight: 2, agentRadius: 0.4, agentMaxClimb: 0.9 };
const BAKE_CFG = {
  tileX: 0, tileZ: 0, cellSize: 0.2, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.4,
  agentMaxClimb: 0.9, walkableSlopeAngle: 45, regionMinSize: 2, regionMergeSize: 20,
  edgeMaxLen: 12, edgeMaxError: 1.3, vertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1,
};
const DT = 1 / 30;

/** Flat rectangles at y=0 (counter-clockwise from above), as one mesh. */
function rects(list) {
  const verts = [];
  const idx = [];
  for (const [x0, x1, z0, z1] of list) {
    const b = verts.length / 3;
    verts.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

function world(list, crowd) {
  const svc = createService({ originX: 0, originZ: 0, tileWorldSize: 10, profiles: [PROFILE], crowd });
  const { verts, idx } = rects(list);
  svc.loadTiles([svc.bakeTile(BAKE_CFG, verts, idx).blob]);
  return svc;
}

function add(svc, agents) {
  const n = agents.length;
  return svc.crowdAdd({
    count: n,
    entityIds: BigUint64Array.from(agents.map((a) => BigInt(a.id))),
    pos: Float32Array.from(agents.flatMap((a) => a.pos)),
    radius: new Float32Array(n).fill(0.4),
    height: new Float32Array(n).fill(1.8),
    maxSpeed: new Float32Array(n).fill(3),
    maxAcceleration: new Float32Array(n).fill(8),
  });
}

function target(svc, ids, targets) {
  return svc.crowdTarget({
    count: ids.length,
    entityIds: BigUint64Array.from(ids.map(BigInt)),
    target: Float32Array.from(targets.flat()),
  });
}

/** Run `ticks` ticks, moving each agent by its steering (the game's part). Returns the trajectories. */
function run(svc, agents, ticks) {
  const n = agents.length;
  const sync = { count: n, entityIds: BigUint64Array.from(agents.map((a) => BigInt(a.id))), pos: new Float32Array(n * 3) };
  const out = { vel: new Float32Array(n * 3), pos: new Float32Array(n * 3), state: new Uint8Array(n) };
  const paths = agents.map(() => []);
  for (let t = 0; t < ticks; t++) {
    agents.forEach((a, i) => sync.pos.set(a.pos, i * 3));
    svc.crowdStep(DT, sync, out);
    agents.forEach((a, i) => {
      a.pos = [a.pos[0] + out.vel[i * 3] * DT, out.pos[i * 3 + 1], a.pos[2] + out.vel[i * 3 + 2] * DT];
      a.state = out.state[i];
      paths[i].push([...a.pos]);
    });
  }
  return paths;
}

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

test('crowd: an agent walks to its target and arrives', () => {
  const svc = world([[0, 10, 0, 10]]);
  try {
    const a = { id: 1, pos: [1.5, 0, 1.5] };
    assert.deepEqual([...add(svc, [a])], [CrowdAddStatus.Added]);
    assert.deepEqual([...target(svc, [1], [[8.5, 0, 8.5]])], [CrowdTargetStatus.Ok]);
    run(svc, [a], 150);
    assert.equal(a.state, CrowdAgentState.Arrived);
    assert.ok(dist2(a.pos, [8.5, 0, 8.5]) < 0.5, `arrived at ${a.pos}`);
  } finally {
    svc.destroy();
  }
});

test('crowd: goes round a wall, not through it', () => {
  // A U: two strips joined at the bottom (z < 3); the middle column is a wall.
  const svc = world([[0, 4, 0, 10], [6, 10, 0, 10], [4, 6, 0, 3]]);
  try {
    const a = { id: 7, pos: [2, 0, 8.5] };
    add(svc, [a]);
    target(svc, [7], [[8, 0, 8.5]]);
    const [path] = run(svc, [a], 400);
    assert.equal(a.state, CrowdAgentState.Arrived, `ended ${a.state} at ${a.pos}`);
    assert.ok(Math.min(...path.map((p) => p[2])) < 3.2, 'it went down and round the wall');
    for (const p of path) assert.ok(!(p[0] > 4.3 && p[0] < 5.7 && p[2] > 3.3), `never inside the wall: ${p}`);
  } finally {
    svc.destroy();
  }
});

test('crowd: two agents walking at each other pass without overlapping', () => {
  const svc = world([[0, 10, 0, 10]]);
  try {
    const a = { id: 1, pos: [1, 0, 5] };
    const b = { id: 2, pos: [9, 0, 5] };
    add(svc, [a, b]);
    target(svc, [1, 2], [[9, 0, 5], [1, 0, 5]]);
    const [pa, pb] = run(svc, [a, b], 240);
    const closest = Math.min(...pa.map((p, i) => dist2(p, pb[i])));
    assert.ok(closest > 0.6, `kept apart (closest ${closest.toFixed(2)} m, radii 0.4 + 0.4)`);
    assert.equal(a.state, CrowdAgentState.Arrived);
    assert.equal(b.state, CrowdAgentState.Arrived);
  } finally {
    svc.destroy();
  }
});

test('crowd: a teleport re-places the agent, and it still heads for its target', () => {
  const svc = world([[0, 10, 0, 10]]);
  try {
    const a = { id: 3, pos: [1, 0, 1] };
    add(svc, [a]);
    target(svc, [3], [[9, 0, 9]]);
    run(svc, [a], 10);
    a.pos = [8, 0, 1]; // the game moved it (a respawn, a knockback)
    run(svc, [a], 120);
    assert.equal(a.state, CrowdAgentState.Arrived);
  } finally {
    svc.destroy();
  }
});

test('crowd: statuses — updated, full, unknown, cleared, off the mesh, removed', () => {
  const svc = world([[0, 10, 0, 10]], { maxAgents: 2 });
  try {
    assert.deepEqual([...add(svc, [{ id: 1, pos: [2, 0, 2] }, { id: 2, pos: [3, 0, 3] }])], [0, 0]);
    assert.deepEqual([...add(svc, [{ id: 1, pos: [2, 0, 2] }, { id: 3, pos: [4, 0, 4] }])], [CrowdAddStatus.Updated, CrowdAddStatus.Full]);
    assert.equal(svc.crowdCount(), 2);
    assert.deepEqual([...target(svc, [9], [[5, 0, 5]])], [CrowdTargetStatus.UnknownAgent]);
    assert.deepEqual([...target(svc, [1], [[50, 0, 50]])], [CrowdTargetStatus.NoPoly]);
    target(svc, [1], [[8, 0, 8]]);
    const a = { id: 1, pos: [2, 0, 2] };
    run(svc, [a], 5);
    assert.equal(a.state, CrowdAgentState.Moving);
    assert.deepEqual([...target(svc, [1], [[NaN, 0, 0]])], [CrowdTargetStatus.Cleared]);
    run(svc, [a], 30);
    assert.equal(a.state, CrowdAgentState.Idle);
    const lost = { id: 2, pos: [40, 0, 40] }; // walked off the mesh
    run(svc, [lost], 2);
    assert.equal(lost.state, CrowdAgentState.Invalid);
    svc.crowdRemove(new BigUint64Array([1n, 2n, 99n]));
    assert.equal(svc.crowdCount(), 0);
  } finally {
    svc.destroy();
  }
});

test('crowd: the same inputs steer the same way', () => {
  const once = () => {
    const svc = world([[0, 10, 0, 10]]);
    try {
      const agents = [1, 2, 3, 4].map((id) => ({ id, pos: [1 + id, 0, 1] }));
      add(svc, agents);
      target(svc, [1, 2, 3, 4], [[8, 0, 9], [2, 0, 9], [5, 0, 9], [9, 0, 5]]);
      return run(svc, agents, 90);
    } finally {
      svc.destroy();
    }
  };
  assert.deepEqual(once(), once());
});

test('crowd: validates its inputs', () => {
  const svc = world([[0, 10, 0, 10]]);
  try {
    assert.throws(() => svc.crowdStep(0, { count: 0, entityIds: new BigUint64Array(0), pos: new Float32Array(0) }, { vel: new Float32Array(0), pos: new Float32Array(0), state: new Uint8Array(0) }), /dt must be > 0/);
    assert.throws(() => svc.crowdAdd({ count: 2, entityIds: new BigUint64Array(1) }), /entityIds/);
    assert.throws(() => createService({ originX: 0, originZ: 0, tileWorldSize: 10, profiles: [PROFILE], crowd: { maxAgents: 0 } }), /maxAgents/);
  } finally {
    svc.destroy();
  }
  assert.throws(() => svc.crowdCount(), /destroyed/);
});
