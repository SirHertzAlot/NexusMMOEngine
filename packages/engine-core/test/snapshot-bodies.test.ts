/**
 * BodyConfig snapshot/delta/persistence coverage (Phase 2).
 *
 * Proves the new bodies block round-trips bit-identically through the
 * FlatBuffers codec, participates in changed-only deltas, is compared
 * exactly by compareStates, and survives a save/restore cycle via
 * SimWorld.restoreFromState (the persistence path).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  MotionType,
  ShapeKind,
  SimWorld,
  Transform,
  Velocity,
  applyDelta,
  collectDeltaState,
  collectFullState,
  compareStates,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  stateFromCollected,
} from "../src/index.js";
import type { BodyConfigRow } from "../src/index.js";

function spawnBody(sim: SimWorld, motion: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  Transform.px[eid] = 1.5; Transform.qw[eid] = 1;
  BodyConfig.shapeKind[eid] = ShapeKind.Sphere;
  BodyConfig.halfX[eid] = 0.25; BodyConfig.halfY[eid] = 0.25; BodyConfig.halfZ[eid] = 0.25;
  BodyConfig.radius[eid] = 0.75;
  BodyConfig.mass[eid] = 2.5;
  BodyConfig.motionType[eid] = motion;
  BodyConfig.layer[eid] = 1;
  BodyConfig.friction[eid] = 0.6;
  BodyConfig.restitution[eid] = 0.1;
  return eid;
}

function expectRowsEqual(a: BodyConfigRow, b: BodyConfigRow): void {
  assert.equal(a.wireId, b.wireId);
  for (const f of [
    "shapeKind", "halfX", "halfY", "halfZ", "radius", "mass",
    "motionType", "layer", "friction", "restitution",
  ] as const) {
    assert.equal(a[f], b[f], `field ${f}`);
  }
}

test("snapshot: bodies block round-trips bit-identically", () => {
  const sim = new SimWorld();
  spawnBody(sim, MotionType.Dynamic);
  spawnBody(sim, MotionType.Static);
  const bytes = encodeSnapshot(collectFullState(sim, 9));
  const back = decodeSnapshot(bytes);
  assert.equal(back.tick, 9);
  assert.equal(back.bodies.length, 2);
  const live = collectFullState(sim, 9);
  const byId = new Map(back.bodies.map((r) => [r.wireId, r]));
  for (const row of live.bodies) {
    const got = byId.get(row.wireId);
    assert.ok(got, "row survives round-trip");
    expectRowsEqual(row, got);
  }
});

test("delta: only changed BodyConfig rows are included", () => {
  const sim = new SimWorld();
  const e0 = spawnBody(sim, MotionType.Dynamic);
  const e1 = spawnBody(sim, MotionType.Dynamic);
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  // Change one field on one entity.
  BodyConfig.friction[e1] = 0.95;
  const delta = collectDeltaState(sim, 1, 0, tracker);
  assert.equal(delta.bodies.length, 1);
  assert.equal(delta.bodies[0].wireId, sim.wireId(e1));
  assert.ok(Math.abs(delta.bodies[0].friction - 0.95) < 1e-6); // f32 field
  tracker.commit(sim);
  // No further changes => empty bodies block.
  const delta2 = collectDeltaState(sim, 2, 1, tracker);
  assert.equal(delta2.bodies.length, 0);
  void e0;
});

test("delta: bodies block survives encode/decode and applies cleanly", () => {
  const sim = new SimWorld();
  spawnBody(sim, MotionType.Dynamic);
  const e1 = spawnBody(sim, MotionType.Kinematic);
  const tracker = new DeltaTracker();
  const snap0 = stateFromCollected(decodeSnapshot(encodeSnapshot(collectFullState(sim, 0))));
  tracker.commit(sim);
  sim.endTick();
  BodyConfig.mass[e1] = 9;
  const dState = collectDeltaState(sim, 1, 0, tracker);
  const applied = applyDelta(snap0, decodeDelta(encodeDelta(dState)));
  const live = stateFromCollected(collectFullState(sim, 1));
  assert.ok(compareStates(applied, live).equal);
});

test("compareStates: body config differences are reported", () => {
  const sim = new SimWorld();
  const e = spawnBody(sim, MotionType.Dynamic);
  const a = stateFromCollected(collectFullState(sim, 0));
  BodyConfig.radius[e] = 1.25;
  const b = stateFromCollected(collectFullState(sim, 0));
  const cmp = compareStates(a, b);
  assert.equal(cmp.equal, false);
  assert.ok(cmp.diffs.some((d) => d.includes(".body.radius")));
});

test("persistence: BodyConfig survives restoreFromState", () => {
  const sim = new SimWorld();
  spawnBody(sim, MotionType.Dynamic);
  spawnBody(sim, MotionType.Static);
  const state = decodeSnapshot(encodeSnapshot(collectFullState(sim, 3)));
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  restored.restoreFromState(state, new Map());
  const back = collectFullState(restored, 3);
  assert.equal(back.bodies.length, 2);
  const cmp = compareStates(stateFromCollected(state), stateFromCollected(back));
  assert.ok(cmp.equal, cmp.diffs.join("; "));
});
