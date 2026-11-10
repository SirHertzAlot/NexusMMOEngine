/**
 * SectorIndex must not keep old frames alive. Each frame holds `prior`, the frames kept for IM7's
 * rate windows; if an older frame kept its own `prior`, every frame since boot stayed reachable
 * (about 26 MB/s retained at 200 players, ending in 200 to 400 ms major-GC ticks).
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { DeltaTracker, SimWorld, Transform, Velocity } from "../../src/index.js";
import {
  interestSectors,
  interestSectorsCached,
  MAX_CANONICAL_INTEREST_SETS,
  RATE_HISTORY,
  SectorIndex,
  steadyEntryArrays,
  type InterestRadii,
  type SectorFrame,
} from "../../src/net/interest.js";
import { invalidateSessionInterest, type ClientSession } from "../../src/session.js";

const STEP = 1 / 30;

function world(n: number): SimWorld {
  const sim = new SimWorld();
  for (let i = 0; i < n; i++) {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Velocity, eid);
    Transform.px[eid] = (i % 40) * 20 - 400;
    Transform.pz[eid] = Math.floor(i / 40) * 20 - 200;
    Transform.qw[eid] = 1;
    Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  }
  return sim;
}

/** One gateway-shaped tick: everything moves, the frame is built, the tracker commits. */
function run(sim: SimWorld, index: SectorIndex, tracker: DeltaTracker, from: number, ticks: number): SectorFrame {
  let frame!: SectorFrame;
  for (let t = from; t < from + ticks; t++) {
    sim.beginTick(t);
    for (let e = 1; e < 600; e++) Transform.px[e] += 0.5 * STEP * ((e % 3) - 1);
    sim.emitTick(t);
    frame = index.frame(sim, t, tracker, null);
    tracker.commit(sim);
    sim.endTick();
  }
  return frame;
}

/** Frames reachable from `f` through `prior` links. */
function reachable(f: SectorFrame): number {
  const seen = new Set<SectorFrame>();
  const stack = [f];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of cur.prior) stack.push(p);
  }
  return seen.size;
}

it("the newest frame reaches at most RATE_HISTORY + 1 frames, however many ticks have run", () => {
  const sim = world(600);
  const index = new SectorIndex();
  const tracker = new DeltaTracker();
  const frame = run(sim, index, tracker, 1, 500);
  assert.ok(reachable(frame) <= RATE_HISTORY + 1, `${reachable(frame)} frames reachable, want at most ${RATE_HISTORY + 1} (the newest plus the ${RATE_HISTORY} kept)`);
});

it("retained heap stays flat across thousands of ticks", { skip: typeof globalThis.gc !== "function" }, () => {
  const sim = world(600);
  const index = new SectorIndex();
  const tracker = new DeltaTracker();
  run(sim, index, tracker, 1, 300);
  globalThis.gc!();
  const before = process.memoryUsage().heapUsed;
  run(sim, index, tracker, 301, 3000);
  globalThis.gc!();
  const grownMb = (process.memoryUsage().heapUsed - before) / 2 ** 20;
  assert.ok(grownMb < 1, `retained heap grew ${grownMb.toFixed(1)} MB over 3000 ticks`);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it("safe-movement cache matches uncached interestSectors across 15,000 randomized hysteresis, threshold, teleport, resync, and radii-change steps", () => {
  const rng = mulberry32(20261104);
  const canon = new Map<string, ReadonlySet<string>>();
  const radiiOptions: InterestRadii[] = [
    { enterM: 96, leaveM: 128 },
    { enterM: 32, leaveM: 48 },
    { enterM: 64, leaveM: 64 },
    { enterM: 128, leaveM: 96 }, // inverted radii edge case
  ];
  let hits = 0;
  let total = 0;

  for (let traj = 0; traj < 300; traj++) {
    let x = (rng() - 0.5) * 1000;
    let z = (rng() - 0.5) * 1000;
    let r = radiiOptions[traj % radiiOptions.length];
    let prevUncached: Set<string> | null = null;
    const s = { interestSet: null } as unknown as ClientSession;

    for (let step = 0; step < 50; step++) {
      total++;
      // Exercise micro-steps near thresholds, normal movement, teleports, resyncs, and radii changes.
      const mode = rng();
      if (mode < 0.35) {
        // Sub-meter micro-step (tests hysteresis & boundary slack)
        x += (rng() - 0.5) * 0.8;
        z += (rng() - 0.5) * 0.8;
      } else if (mode < 0.80) {
        // Normal walking step (0..5 m)
        x += (rng() - 0.5) * 10;
        z += (rng() - 0.5) * 10;
      } else if (mode < 0.90) {
        // Exact boundary probe (land near a 64m sector line or +96m/+128m offset)
        const base = Math.round(x / 64) * 64;
        const offsets = [0, 1e-5, -1e-5, 32, -32, 64, -64];
        x = base + offsets[Math.floor(rng() * offsets.length)];
        z += (rng() - 0.5) * 2;
      } else if (mode < 0.95) {
        // Teleport
        x = (rng() - 0.5) * 2000;
        z = (rng() - 0.5) * 2000;
      } else if (mode < 0.98) {
        // Resync invalidation
        prevUncached = null;
        invalidateSessionInterest(s);
      } else {
        // Dynamic radii change
        r = radiiOptions[Math.floor(rng() * radiiOptions.length)];
      }

      const want = interestSectors(x, z, r, prevUncached);
      prevUncached = want;

      const prevCached = s.interestSet ?? null;
      const dx = x - (s.interestRefX ?? NaN);
      const dz = z - (s.interestRefZ ?? NaN);
      let got: ReadonlySet<string>;
      if (
        prevCached !== null &&
        s.interestEnterM === r.enterM &&
        s.interestLeaveM === r.leaveM &&
        dx * dx + dz * dz < (s.interestSafeMoveSq ?? 0)
      ) {
        got = prevCached;
        hits++;
      } else {
        const res = interestSectorsCached(x, z, r, prevCached, canon);
        got = res.set;
        s.interestRefX = x;
        s.interestRefZ = z;
        s.interestSafeMoveSq = res.safeMoveSq;
        s.interestEnterM = r.enterM;
        s.interestLeaveM = r.leaveM;
      }
      s.interestSet = got;

      assert.deepEqual([...got], [...want], `traj ${traj} step ${step} at (${x}, ${z}) r=${JSON.stringify(r)}`);
    }
  }
  assert.ok(hits > 3000, `expected substantial safe-move cache hits, got ${hits}/${total}`);
});

it("canonical sets enforce runtime immutability and resync invalidation never mutates shared sets", () => {
  const canon = new Map<string, ReadonlySet<string>>();
  const r: InterestRadii = { enterM: 96, leaveM: 128 };
  const a = interestSectorsCached(10, 20, r, null, canon);
  const b = interestSectorsCached(12, 22, r, null, canon);
  assert.equal(a.set, b.set, "co-located sessions share the exact same canonical Set reference");

  const mutableView = a.set as unknown as Set<string>;
  assert.throws(() => mutableView.add("99,99"), TypeError, ".add() on canonical Set must throw");
  assert.throws(() => mutableView.delete("g"), TypeError, ".delete() on canonical Set must throw");
  assert.throws(() => mutableView.clear(), TypeError, ".clear() on canonical Set must throw");

  const s1 = { interestSet: a.set, interestRefX: 10, interestRefZ: 20, interestSafeMoveSq: a.safeMoveSq } as unknown as ClientSession;
  const s2 = { interestSet: b.set, interestRefX: 12, interestRefZ: 22, interestSafeMoveSq: b.safeMoveSq } as unknown as ClientSession;
  const snapshotBefore = [...s2.interestSet!];
  invalidateSessionInterest(s1);
  assert.equal(s1.interestSet, null);
  assert.equal(s1.interestSafeMoveSq, 0);
  assert.deepEqual([...s2.interestSet!], snapshotBefore, "invalidating s1 must not alter s2's shared canonical Set");
});

it("canon map bounds retention to MAX_CANONICAL_INTEREST_SETS and steadyDeltaEntries returns frozen arrays", () => {
  const canon = new Map<string, ReadonlySet<string>>();
  const r: InterestRadii = { enterM: 96, leaveM: 128 };
  for (let i = 0; i < MAX_CANONICAL_INTEREST_SETS + 250; i++) {
    interestSectorsCached(i * 128, i * 128, r, null, canon);
  }
  assert.ok(canon.size <= MAX_CANONICAL_INTEREST_SETS, `canon.size ${canon.size} exceeded ${MAX_CANONICAL_INTEREST_SETS}`);

  const sim = world(20);
  const index = new SectorIndex();
  const tracker = new DeltaTracker();
  const frame = run(sim, index, tracker, 1, 2);
  const steady = frame.steadyDeltaEntries(aSet(canon));
  assert.equal(steadyEntryArrays.has(steady), true, "steadyDeltaEntries array must be registered in steadyEntryArrays");

  // Verify canonical sets enforce deterministic iteration order (GLOBAL_SECTOR then ascending (sx, sz))
  // and replace any pre-existing map entry whose iteration order differs from the canonical sequence.
  const orderedCanon = new Map<string, ReadonlySet<string>>();
  const r96: InterestRadii = { enterM: 96, leaveM: 128 };
  const { set: canonical } = interestSectorsCached(10, 10, r96, null, orderedCanon);
  const canonicalOrder = [...canonical];
  assert.equal(canonicalOrder[0], "g");
  for (let i = 2; i < canonicalOrder.length; i++) {
    const [sxPrev, szPrev] = canonicalOrder[i - 1].split(",").map(Number);
    const [sxCur, szCur] = canonicalOrder[i].split(",").map(Number);
    assert.ok(
      sxPrev < sxCur || (sxPrev === sxCur && szPrev < szCur),
      `sectors must iterate in strictly ascending (sx, sz) order: ${canonicalOrder[i - 1]} before ${canonicalOrder[i]}`,
    );
  }
  const sigKey = canonicalOrder.join("|");
  const reversed = new Set<string>([canonicalOrder[0], ...canonicalOrder.slice(1).reverse()]);
  orderedCanon.set(sigKey, reversed);
  const { set: repaired } = interestSectorsCached(10, 10, r96, null, orderedCanon);
  assert.notEqual(repaired, reversed, "mismatched iteration order in canon map must be rejected and replaced");
  assert.deepEqual([...repaired], canonicalOrder, "repaired canonical set must preserve exact canonical iteration order");
});

function aSet(canon: Map<string, ReadonlySet<string>>): ReadonlySet<string> {
  return canon.values().next().value!;
}

it("SectorIndex and DeltaTracker handle 32-bit sequence wraparound (0xFFFFFFFF -> 1) without stale tags", () => {
  const sim = new SimWorld();
  const eids: number[] = [];
  for (let i = 0; i < 10; i++) {
    const eid = sim.spawn();
    eids.push(eid);
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Velocity, eid);
    Transform.px[eid] = i * 10;
    Transform.pz[eid] = i * 10;
    Transform.qw[eid] = 1;
    Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  }
  const ePos = eids[0];
  const eRot = eids[1];
  const index = new SectorIndex();
  const tracker = new DeltaTracker();
  // Seed initial frame
  sim.beginTick(1);
  sim.emitTick(1);
  index.frame(sim, 1, tracker, null);
  tracker.commit(sim);
  sim.endTick();

  // Force internal sequence counters to 0xFFFFFFFE and step across 0xFFFFFFFF -> 0 -> 1
  (index as unknown as { frameSeq: number }).frameSeq = 0xfffffffe;
  (tracker as unknown as { posOnlySeq: number }).posOnlySeq = 0xfffffffe;

  for (let t = 2; t <= 6; t++) {
    sim.beginTick(t);
    Transform.px[ePos] += 1; // position-only move on ePos
    Transform.qy[eRot] = Math.sin(t * 0.1); // rotation change on eRot (not position-only)
    Transform.qw[eRot] = Math.cos(t * 0.1);
    sim.emitTick(t);
    const f = index.frame(sim, t, tracker, null);
    assert.equal(tracker.isPositionOnly(ePos), true, `tick ${t}: ePos is position-only`);
    assert.equal(tracker.isPositionOnly(eRot), false, `tick ${t}: eRot is full transform`);
    assert.ok(f.pending.size > 0);
    tracker.commit(sim);
    sim.endTick();
  }
  assert.equal((index as unknown as { frameSeq: number }).frameSeq, 4);
  assert.equal((tracker as unknown as { posOnlySeq: number }).posOnlySeq, 4);
});
