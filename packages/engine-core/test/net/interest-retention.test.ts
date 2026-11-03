/**
 * SectorIndex must not keep old frames alive. Each frame holds `prior`, the frames kept for IM7's
 * rate windows; if an older frame kept its own `prior`, every frame since boot stayed reachable
 * (about 26 MB/s retained at 200 players, ending in 200 to 400 ms major-GC ticks).
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { DeltaTracker, SimWorld, Transform, Velocity } from "../../src/index.js";
import { RATE_HISTORY, SectorIndex, type SectorFrame } from "../../src/net/interest.js";

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
