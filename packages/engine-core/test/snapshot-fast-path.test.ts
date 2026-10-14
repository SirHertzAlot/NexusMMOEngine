import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  decodeFastDelta,
  DeltaTracker,
  encodeFastDeltaFromSim,
  SimWorld,
  Transform,
  Velocity,
} from "../src/index.js";
import { Health } from "../src/components.js";

/**
 * Phase 5, Part B: encodeFastDeltaFromSim builds the fast-path v1
 * payload from the sim's SAB-backed stores (tracker diff, no row
 * copy), returns null when the fast path doesn't apply, and stays
 * read-only w.r.t. the tracker (the caller still owns commit()).
 */

function makeWorld(): { sim: SimWorld; mover: number; spinner: number; rock: number } {
  const sim = new SimWorld();
  // Mover: position + velocity (fast-path eligible).
  const mover = sim.spawn();
  addComponent(sim.ecs, Transform, mover);
  addComponent(sim.ecs, Velocity, mover);
  Transform.px[mover] = 1; Transform.py[mover] = 2; Transform.pz[mover] = 3;
  Velocity.lx[mover] = 4; Velocity.ly[mover] = 5; Velocity.lz[mover] = 6;
  // Spinner: velocity only (angular), no transform change tracked here —
  // it carries Velocity but no Transform component at all.
  const spinner = sim.spawn();
  addComponent(sim.ecs, Velocity, spinner);
  Velocity.ax[spinner] = 0.5;
  // Rock: transform only, never moves.
  const rock = sim.spawn();
  addComponent(sim.ecs, Transform, rock);
  Transform.px[rock] = 10; Transform.py[rock] = 0; Transform.pz[rock] = 10;
  return { sim, mover, spinner, rock };
}

test("fast-path from sim: moved entities encode; tracker stays uncommitted", () => {
  const { sim, mover } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  // Move the mover: both its transform and velocity change.
  Transform.px[mover] = 11; Transform.pz[mover] = 13;
  Velocity.lx[mover] = 7;
  const bytes = encodeFastDeltaFromSim(sim, 9, tracker);
  assert.ok(bytes);
  const { tick, entries } = decodeFastDelta(bytes!);
  assert.equal(tick, 9);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].wireId, sim.wireId(mover));
  assert.equal(entries[0].px, 11);
  assert.equal(entries[0].pz, 13);
  assert.equal(entries[0].lx, 7);
  assert.equal(entries[0].ly, 5);
  // Read-only w.r.t. the tracker: the same diff is still pending, so
  // a second encode sees the same change (the gateway commits once,
  // after its FlatBuffers delta is built).
  const again = encodeFastDeltaFromSim(sim, 9, tracker);
  assert.ok(again);
  assert.deepEqual([...again!], [...bytes!]);
  tracker.commit(sim);
  sim.endTick();
  assert.equal(encodeFastDeltaFromSim(sim, 10, tracker), null);
});

test("fast-path from sim: null when only non-position columns change", () => {
  const { sim, mover } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  // A health change only: no transform/velocity diff, so the fast
  // path doesn't apply — the caller sends the FlatBuffers Delta.
  addComponent(sim.ecs, Health, mover);
  Health.current[mover] = 50;
  assert.equal(encodeFastDeltaFromSim(sim, 3, tracker), null);
});

test("fast-path from sim: transform-only and velocity-only changes don't apply", () => {
  const { sim, rock } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  // The rock's transform changes but it has no velocity: no
  // intersection, so null even though a transform changed.
  Transform.px[rock] = 11;
  assert.equal(encodeFastDeltaFromSim(sim, 4, tracker), null);
});
