/**
 * VfxEmitter snapshot/delta/persistence coverage (ComponentId 19).
 *
 * Proves the vfxEmitters block round-trips bit-identically through the
 * FlatBuffers codec, rides the spawnedSlots fast path into deltas, is
 * diffed when intensity changes (admin verbs can retune it), survives
 * save/restore via SimWorld.restoreFromState (the world persistence
 * path), and — the chunk-fade fix — survives the ChunkEntityStore path
 * (collectEntitiesState -> encode -> decode -> spawnFromState) that an
 * unloading chunk's contents take.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import {
  SimWorld,
  Transform,
  VfxEmitter,
  collectDeltaState,
  collectEntitiesState,
  collectFullState,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  encodeSnapshotFromSim,
} from "../src/index.js";

/** fnv1a32("shrine-fire"), the fire shrine's template hash (golden). */
const FIRE_TEMPLATE = 4098966889;

function spawnEmitter(sim: SimWorld, template: number, intensity: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, VfxEmitter, eid);
  Transform.px[eid] = 216; Transform.py[eid] = 49; Transform.pz[eid] = -256;
  Transform.qw[eid] = 1;
  VfxEmitter.template[eid] = template;
  VfxEmitter.intensity[eid] = intensity;
  return eid;
}

test("snapshot: vfxEmitters block round-trips bit-identically", () => {
  const sim = new SimWorld();
  spawnEmitter(sim, FIRE_TEMPLATE, 1.5);
  spawnEmitter(sim, 2453196608, 0.25);
  const back = decodeSnapshot(encodeSnapshot(collectFullState(sim, 3)));
  assert.equal(back.vfxEmitters.length, 2);
  const live = collectFullState(sim, 3);
  const byId = new Map(back.vfxEmitters.map((r) => [r.wireId, r]));
  for (const row of live.vfxEmitters) {
    const got = byId.get(row.wireId);
    assert.ok(got, "row survives round-trip");
    assert.equal(got.template, row.template);
    assert.equal(got.intensity, row.intensity);
  }
});

test("snapshot: SoA encode is byte-identical to the row path", () => {
  const sim = new SimWorld();
  spawnEmitter(sim, FIRE_TEMPLATE, 1.5);
  const fromSim = encodeSnapshotFromSim(sim, 4);
  const fromRows = encodeSnapshot(collectFullState(sim, 4));
  assert.deepEqual(fromSim, fromRows);
  assert.equal(decodeSnapshot(fromSim).vfxEmitters.length, 1);
});

test("delta: freshly spawned emitters ride the spawnedSlots fast path, then no churn", () => {
  const sim = new SimWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  const e = spawnEmitter(sim, FIRE_TEMPLATE, 1.5);
  const delta = collectDeltaState(sim, 1, 0, tracker);
  assert.equal(delta.vfxEmitters.length, 1);
  assert.equal(delta.vfxEmitters[0].wireId, sim.wireId(e));
  assert.equal(delta.vfxEmitters[0].template, FIRE_TEMPLATE);
  tracker.commit(sim);
  sim.endTick();
  const delta2 = collectDeltaState(sim, 2, 1, tracker);
  assert.equal(delta2.vfxEmitters.length, 0);
});

test("delta: an intensity change is diffed and carried", () => {
  const sim = new SimWorld();
  const e = spawnEmitter(sim, FIRE_TEMPLATE, 1);
  const tracker = new DeltaTracker();
  // Baseline commit (the welcome snapshot's), then steady state.
  tracker.commit(sim);
  sim.endTick();
  assert.equal(collectDeltaState(sim, 1, 0, tracker).vfxEmitters.length, 0);
  tracker.commit(sim);
  // Admin retune: intensity changes, the next delta must carry the row.
  VfxEmitter.intensity[e] = 2.5;
  sim.endTick();
  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 2, 1, tracker)));
  assert.equal(delta.vfxEmitters.length, 1);
  assert.equal(delta.vfxEmitters[0].wireId, sim.wireId(e));
  assert.equal(delta.vfxEmitters[0].intensity, 2.5);
});

test("persistence: VfxEmitter survives save/restore (restoreFromState)", () => {
  const sim = new SimWorld();
  const e = spawnEmitter(sim, FIRE_TEMPLATE, 1.5);
  const wid = sim.wireId(e);
  const state = decodeSnapshot(encodeSnapshot(collectFullState(sim, 5)));
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  restored.restoreFromState(state, new Map());
  const again = collectFullState(restored, 5);
  const row = again.vfxEmitters.find((r) => r.wireId === wid);
  assert.ok(row, "VfxEmitter row restored");
  assert.equal(row.template, FIRE_TEMPLATE);
  assert.equal(row.intensity, 1.5);
});

test("chunk persistence: emitter survives collectEntitiesState -> spawnFromState (the fade fix)", () => {
  const sim = new SimWorld();
  const e = spawnEmitter(sim, FIRE_TEMPLATE, 1.5);
  // The chunk unload path: store just this entity's rows as bytes.
  const stored = decodeSnapshot(encodeSnapshot(collectEntitiesState(sim, [e], 7)));
  assert.equal(stored.vfxEmitters.length, 1);
  // The chunk reload path: fresh entities spawned from the stored rows.
  SimWorld.resetEntityCursorForTesting();
  const back = new SimWorld();
  const eids = back.spawnFromState(stored);
  assert.equal(eids.length, 1);
  assert.ok(hasComponent(back.ecs, VfxEmitter, eids[0]), "component re-attached on reload");
  const again = collectFullState(back, 7);
  assert.equal(again.vfxEmitters.length, 1);
  assert.equal(again.vfxEmitters[0].template, FIRE_TEMPLATE);
  assert.equal(again.vfxEmitters[0].intensity, 1.5);
});
