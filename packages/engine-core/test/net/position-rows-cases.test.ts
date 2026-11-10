/**
 * Position-only rows (protocol v29): an omitted rotation or scale must mean "keep what the receiver has", never a
 * default. Each case drives a real tracker and SectorIndex, applies every sector delta to a receiver in order, and
 * checks (a) the receiver ends equal to the server, (b) a position-only row is only ever sent for an entity the
 * receiver already holds with the same rotation and scale the tracker used as its baseline.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { applyDelta, decodeDelta, DeltaTracker, SimWorld, Transform, Velocity } from "../../src/index.js";
import type { WorldState } from "../../src/index.js";
import { SectorIndex } from "../../src/net/interest.js";

afterEach(() => {
  delete process.env.MMO_POSITION_ROWS;
});

type Rig = { sim: SimWorld; tracker: DeltaTracker; index: SectorIndex; receiver: WorldState; positionRows: number; fullRows: number; baselineMisses: number };

function rig(): Rig {
  return { sim: new SimWorld(), tracker: new DeltaTracker(), index: new SectorIndex(), receiver: new Map(), positionRows: 0, fullRows: 0, baselineMisses: 0 };
}

function add(r: Rig, x: number, z: number, q = { y: 0, w: 1 }, s = 1): number {
  const e = r.sim.spawn();
  addComponent(r.sim.ecs, Transform, e);
  addComponent(r.sim.ecs, Velocity, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qy[e] = q.y;
  Transform.qw[e] = q.w;
  Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = s;
  return e;
}

/** One server tick: `mutate` changes the world, then the frame is built and every sector's delta goes to the receiver. */
function tick(r: Rig, n: number, mutate: () => void, receiver: WorldState = r.receiver, full = false): void {
  r.sim.beginTick(n);
  mutate();
  r.sim.emitTick(n);
  const frame = r.index.frame(r.sim, n, r.tracker, null);
  r.tracker.commit(r.sim);
  r.sim.endTick();
  for (const sector of frame.occupied()) {
    const bytes = full ? frame.full(sector) : frame.delta(sector);
    if (!bytes) continue;
    const d = decodeDelta(bytes);
    for (const p of d.positions ?? []) {
      r.positionRows++;
      if (!receiver.get(p.wireId)?.transform) r.baselineMisses++;
    }
    r.fullRows += d.transforms.length;
    applyDelta(receiver, d);
  }
}

function same(r: Rig, e: number, receiver: WorldState = r.receiver): void {
  const t = receiver.get(r.sim.wireId(e))?.transform;
  assert.ok(t, `entity ${e} present at the receiver`);
  const got = [t.px, t.py, t.pz, t.qx, t.qy, t.qz, t.qw, t.sx, t.sy, t.sz].map(Math.fround);
  const want = [Transform.px[e], Transform.py[e], Transform.pz[e], Transform.qx[e], Transform.qy[e], Transform.qz[e], Transform.qw[e], Transform.sx[e], Transform.sy[e], Transform.sz[e]].map(Math.fround);
  assert.deepEqual(got, want, `entity ${e} equals the server's transform`);
}

it("position-only: moves the entity and keeps a non-default rotation and scale", () => {
  const r = rig();
  const e = add(r, 5, 5, { y: 0.6, w: 0.8 }, 2);
  tick(r, 1, () => {});
  tick(r, 2, () => { Transform.px[e] += 3; });
  tick(r, 3, () => { Transform.pz[e] -= 1; });
  assert.ok(r.positionRows >= 2, `${r.positionRows} position rows`);
  assert.equal(r.baselineMisses, 0);
  same(r, e);
  assert.equal(r.receiver.get(r.sim.wireId(e))!.transform!.qy.toFixed(1), "0.6");
});

it("rotation-only change (position untouched) is a full row and keeps the position", () => {
  const r = rig();
  const e = add(r, 7, 9);
  tick(r, 1, () => {});
  const before = r.positionRows;
  tick(r, 2, () => { Transform.qy[e] = 0.5; Transform.qw[e] = 0.866; });
  assert.equal(r.positionRows, before, "no position-only row for a rotation change");
  same(r, e);
});

it("scale-only change (position untouched) is a full row and keeps the position", () => {
  const r = rig();
  const e = add(r, 7, 9, { y: 0.3, w: 0.95 });
  tick(r, 1, () => {});
  const before = r.positionRows;
  tick(r, 2, () => { Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 3; });
  assert.equal(r.positionRows, before, "no position-only row for a scale change");
  same(r, e);
});

it("position, rotation and scale changing together is one full row", () => {
  const r = rig();
  const e = add(r, 1, 1);
  tick(r, 1, () => {});
  const before = r.positionRows;
  tick(r, 2, () => { Transform.px[e] += 2; Transform.qy[e] = 0.7; Transform.qw[e] = 0.714; Transform.sx[e] = 1.5; });
  assert.equal(r.positionRows, before);
  same(r, e);
});

it("a position-only row after a rotation change keeps the NEW rotation (the baseline follows the change)", () => {
  const r = rig();
  const e = add(r, 1, 1);
  tick(r, 1, () => {});
  tick(r, 2, () => { Transform.qy[e] = 0.5; Transform.qw[e] = 0.866; });
  tick(r, 3, () => { Transform.px[e] += 1; });
  tick(r, 4, () => { Transform.px[e] += 1; });
  assert.ok(r.positionRows >= 2);
  assert.equal(r.baselineMisses, 0);
  same(r, e);
});

it("a spawn is a full row first, then position-only rows (no position row for an entity the receiver lacks)", () => {
  const r = rig();
  const a = add(r, 0, 0);
  tick(r, 1, () => {});
  let b = -1;
  tick(r, 2, () => { b = add(r, 4, 4, { y: 0.4, w: 0.917 }, 1.5); Transform.px[a] += 1; });
  same(r, b);
  tick(r, 3, () => { Transform.px[b] += 1; Transform.px[a] += 1; });
  tick(r, 4, () => { Transform.px[b] += 1; Transform.px[a] += 1; });
  assert.ok(r.positionRows >= 4, `${r.positionRows} position rows`);
  assert.equal(r.baselineMisses, 0);
  same(r, a);
  same(r, b);
});

it("resync: a receiver that joins late gets the full state, then continues correctly on position-only deltas", () => {
  const r = rig();
  const e = add(r, 2, 2, { y: 0.5, w: 0.866 }, 2);
  tick(r, 1, () => {});
  for (let n = 2; n <= 5; n++) tick(r, n, () => { Transform.px[e] += 1; });
  const late: WorldState = new Map();
  // The late receiver is sent the sector's full state this tick (what a replace baseline or a new sector delivers).
  tick(r, 6, () => { Transform.px[e] += 1; }, late, true);
  for (let n = 7; n <= 9; n++) {
    r.sim.beginTick(n);
    Transform.px[e] += 1;
    r.sim.emitTick(n);
    const frame = r.index.frame(r.sim, n, r.tracker, null);
    r.tracker.commit(r.sim);
    r.sim.endTick();
    for (const sector of frame.occupied()) {
      const bytes = frame.delta(sector);
      if (!bytes) continue;
      const d = decodeDelta(bytes);
      for (const p of d.positions ?? []) if (!late.get(p.wireId)?.transform) r.baselineMisses++;
      applyDelta(late, d);
      applyDelta(r.receiver, d);
    }
  }
  assert.equal(r.baselineMisses, 0);
  same(r, e, late);
  assert.equal(late.get(r.sim.wireId(e))!.transform!.sx, 2, "scale carried through the full state");
});

it("entity reuse: a despawned slot respawned with another rotation never inherits the old baseline", () => {
  const r = rig();
  const old = add(r, 3, 3, { y: 0.6, w: 0.8 }, 2);
  tick(r, 1, () => {});
  tick(r, 2, () => { Transform.px[old] += 1; });
  let fresh = -1;
  // Despawn and respawn in the same tick: the freed slot is recycled with a new generation.
  tick(r, 3, () => { r.sim.despawn(old); fresh = add(r, 3, 3, { y: 0, w: 1 }, 1); });
  assert.notEqual(r.sim.wireId(fresh), undefined);
  same(r, fresh);
  assert.equal(r.receiver.has(r.sim.wireId(old)), r.sim.wireId(old) === r.sim.wireId(fresh), "the old wire id is gone unless the id was reused");
  tick(r, 4, () => { Transform.px[fresh] += 1; });
  tick(r, 5, () => { Transform.px[fresh] += 1; });
  assert.ok(r.positionRows >= 2, "the reused slot goes on to send position-only rows");
  assert.equal(r.baselineMisses, 0);
  same(r, fresh);
  const t = r.receiver.get(r.sim.wireId(fresh))!.transform!;
  assert.equal(t.qy, 0, "the new entity's rotation, not the old one's");
  assert.equal(t.sx, 1, "the new entity's scale, not the old one's");
});

it("entity reuse across ticks: despawn on one tick, respawn into the freed slot on the next", () => {
  const r = rig();
  const old = add(r, 3, 3, { y: 0.6, w: 0.8 }, 2);
  tick(r, 1, () => {});
  tick(r, 2, () => { r.sim.despawn(old); });
  let fresh = -1;
  tick(r, 3, () => { fresh = add(r, 3, 3, { y: 0, w: 1 }, 1); });
  tick(r, 4, () => { Transform.px[fresh] += 1; });
  tick(r, 5, () => { Transform.px[fresh] += 1; });
  assert.ok(r.positionRows >= 2, "the reused slot goes on to send position-only rows");
  assert.equal(r.baselineMisses, 0);
  same(r, fresh);
  assert.equal(r.receiver.get(r.sim.wireId(fresh))!.transform!.sx, 1);
});

it("crossing into another sector is a full row there, then position-only rows", () => {
  const r = rig();
  const e = add(r, 10, 10, { y: 0.5, w: 0.866 }, 1.5);
  tick(r, 1, () => {});
  tick(r, 2, () => { Transform.px[e] += 1000; });
  tick(r, 3, () => { Transform.px[e] += 1; });
  tick(r, 4, () => { Transform.px[e] += 1; });
  assert.equal(r.baselineMisses, 0);
  same(r, e);
});

it("an orphan position-only row (receiver missed baseline) is discarded rather than fabricating identity rotation/scale", () => {
  const r = rig();
  const e = add(r, 10, 10, { y: 0.6, w: 0.8 }, 2.5);
  tick(r, 1, () => {});
  const unseeded: WorldState = new Map();
  // Tick 2 emits a position-only delta; applying it to an unseeded receiver must not fabricate an identity transform.
  r.sim.beginTick(2);
  Transform.px[e] += 1;
  r.sim.emitTick(2);
  const frame = r.index.frame(r.sim, 2, r.tracker, null);
  r.tracker.commit(r.sim);
  r.sim.endTick();
  for (const sector of frame.occupied()) {
    const bytes = frame.delta(sector);
    if (!bytes) continue;
    applyDelta(unseeded, decodeDelta(bytes));
  }
  assert.equal(unseeded.has(r.sim.wireId(e)), false, "orphan position-only row was discarded");
});
