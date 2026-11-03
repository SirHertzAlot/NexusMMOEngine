/**
 * Position-only transform rows (protocol v29): the tracker classifies a transform whose only change is the
 * position, sector deltas carry it in Delta.positions, a receiver merges it into the entity's baseline
 * (rotation and scale kept), and the chain of sector deltas reproduces the server's transforms exactly.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { applyDelta, decodeDelta, DeltaTracker, SimWorld, Transform, Velocity } from "../../src/index.js";
import { spawnedSlotsOf } from "../../src/snapshot.js";
import type { WorldState } from "../../src/index.js";
import { SectorIndex } from "../../src/net/interest.js";

afterEach(() => {
  delete process.env.MMO_POSITION_ROWS;
});

function world(n: number): { sim: SimWorld; eids: number[] } {
  const sim = new SimWorld();
  const eids: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    Transform.px[e] = (i % 5) * 20;
    Transform.pz[e] = Math.floor(i / 5) * 20;
    Transform.qw[e] = 1;
    Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 1;
    eids.push(e);
  }
  return { sim, eids };
}

it("the tracker marks a transform position-only only when rotation and scale equal their baselines", () => {
  const { sim, eids } = world(4);
  const tracker = new DeltaTracker();
  sim.beginTick(1);
  tracker.diff(sim, spawnedSlotsOf(sim));
  tracker.commit(sim);
  sim.endTick();
  sim.beginTick(2);
  Transform.px[eids[0]] += 1; // position only
  Transform.pz[eids[1]] += 1; Transform.qy[eids[1]] = 0.2; // position and rotation
  Transform.sx[eids[2]] = 2; // scale only
  const d = tracker.diff(sim, spawnedSlotsOf(sim));
  assert.deepEqual([...d.transforms].sort(), [eids[0], eids[1], eids[2]].sort());
  assert.deepEqual([...d.positionOnly], [eids[0]]);
  sim.endTick();
});

it("a newly spawned entity is a full row, and MMO_POSITION_ROWS=0 turns the classification off", () => {
  const { sim, eids } = world(2);
  const t1 = new DeltaTracker();
  sim.beginTick(1);
  const d1 = t1.diff(sim, spawnedSlotsOf(sim));
  assert.equal(d1.positionOnly.size, 0, "spawned this tick: full rows");
  t1.commit(sim);
  sim.endTick();
  process.env.MMO_POSITION_ROWS = "0";
  const t2 = new DeltaTracker();
  sim.beginTick(2);
  t2.diff(sim, spawnedSlotsOf(sim));
  t2.commit(sim);
  sim.endTick();
  sim.beginTick(3);
  Transform.px[eids[0]] += 1;
  assert.equal(t2.diff(sim, spawnedSlotsOf(sim)).positionOnly.size, 0, "flag off");
  sim.endTick();
});

it("sector deltas carry position-only rows, full and rate deltas stay correct, and the chain reproduces the server", () => {
  const { sim, eids } = world(25);
  const tracker = new DeltaTracker();
  const index = new SectorIndex();
  const mirror: WorldState = new Map();
  let positionRows = 0, fullRows = 0;
  const frames = [];
  for (let tick = 1; tick <= 12; tick++) {
    sim.beginTick(tick);
    eids.forEach((e, i) => {
      Transform.px[e] += 0.25 * ((i % 3) - 1); // everyone drifts a little
      if (tick === 5 && i === 3) Transform.qy[e] = 0.5; // one rotates
      if (tick === 7 && i === 4) Transform.sx[e] = 1.5; // one scales
      if (tick === 9 && i === 6) Transform.px[e] += 500; // one crosses into another sector
    });
    sim.emitTick(tick);
    const frame = index.frame(sim, tick, tracker, null);
    frames.push(frame);
    tracker.commit(sim);
    sim.endTick();
    // The receiver: full state of every sector on tick 1, then each sector's delta.
    for (const sector of frame.occupied()) {
      const bytes = tick === 1 ? frame.full(sector) : frame.delta(sector);
      if (!bytes) continue;
      const d = decodeDelta(bytes);
      positionRows += d.positions?.length ?? 0;
      fullRows += d.transforms.length;
      if (tick === 1) assert.equal(d.positions?.length ?? 0, 0, "a full state never uses position-only rows");
      applyDelta(mirror, d);
    }
  }
  assert.ok(positionRows > 100, `${positionRows} position-only rows`);
  assert.ok(fullRows > 25, `${fullRows} full transform rows (initial state, the rotated, the scaled, the mover)`);
  for (const e of eids) {
    const t = mirror.get(sim.wireId(e))?.transform;
    assert.ok(t, `entity ${e} present`);
    assert.deepEqual(
      [t.px, t.py, t.pz, t.qx, t.qy, t.qz, t.qw, t.sx, t.sy, t.sz].map((x) => Math.fround(x)),
      [Transform.px[e], Transform.py[e], Transform.pz[e], Transform.qx[e], Transform.qy[e], Transform.qz[e], Transform.qw[e], Transform.sx[e], Transform.sy[e], Transform.sz[e]].map((x) => Math.fround(x)),
      `entity ${e} transform equals the server's`,
    );
  }
});

it("position-only rows make a transform-heavy delta much smaller than full rows", () => {
  const { sim, eids } = world(300);
  const run = (): number => {
    const tracker = new DeltaTracker();
    const index = new SectorIndex();
    let bytes = 0;
    for (let tick = 1; tick <= 3; tick++) {
      sim.beginTick(tick);
      for (const e of eids) Transform.px[e] += 0.2;
      sim.emitTick(tick);
      const frame = index.frame(sim, tick, tracker, null);
      tracker.commit(sim);
      sim.endTick();
      if (tick === 3) for (const s of frame.occupied()) bytes += frame.delta(s)?.length ?? 0;
    }
    return bytes;
  };
  const withRows = run();
  process.env.MMO_POSITION_ROWS = "0";
  const without = run();
  assert.ok(withRows < without * 0.6, `${withRows} B with position rows vs ${without} B without`);
});
