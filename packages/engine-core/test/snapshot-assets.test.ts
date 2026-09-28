/**
 * AssetRef snapshot/delta/persistence coverage (PCG slice 4).
 *
 * Proves the new assets block round-trips bit-identically through the
 * FlatBuffers codec, rides the spawnedSlots fast path into deltas with
 * zero per-tick churn (spawn-time config, never mutated), is compared
 * exactly by compareStates, and survives save/restore via
 * SimWorld.restoreFromState (the persistence path).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  AssetRef,
  SimWorld,
  Transform,
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
import type { AssetRefRow } from "../src/index.js";

function spawnAsset(sim: SimWorld, hash: number, variant: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, AssetRef, eid);
  Transform.px[eid] = 2.5; Transform.qw[eid] = 1;
  AssetRef.assetHash[eid] = hash;
  AssetRef.variant[eid] = variant;
  return eid;
}

test("snapshot: assets block round-trips bit-identically", () => {
  const sim = new SimWorld();
  spawnAsset(sim, 0xdeadbeef, 7);
  spawnAsset(sim, 0x12345678, 0);
  const bytes = encodeSnapshot(collectFullState(sim, 3));
  const back = decodeSnapshot(bytes);
  assert.equal(back.tick, 3);
  assert.equal(back.assets.length, 2);
  const live = collectFullState(sim, 3);
  const byId = new Map(back.assets.map((r) => [r.wireId, r]));
  for (const row of live.assets) {
    const got = byId.get(row.wireId);
    assert.ok(got, "row survives round-trip");
    assert.equal(got.assetHash, row.assetHash);
    assert.equal(got.variant, row.variant);
  }
});

test("delta: freshly spawned assets ride the spawnedSlots fast path", () => {
  const sim = new SimWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  const e = spawnAsset(sim, 0xabcdef, 3);
  const delta = collectDeltaState(sim, 1, 0, tracker);
  assert.equal(delta.assets.length, 1);
  assert.equal(delta.assets[0].wireId, sim.wireId(e));
  assert.equal(delta.assets[0].assetHash, 0xabcdef);
  tracker.commit(sim);
  // Spawn-time config never mutates: no churn on later ticks.
  sim.endTick();
  const delta2 = collectDeltaState(sim, 2, 1, tracker);
  assert.equal(delta2.assets.length, 0);
});

test("delta: assets block survives encode/decode and applies cleanly", () => {
  const sim = new SimWorld();
  spawnAsset(sim, 0x1111, 1);
  spawnAsset(sim, 0x2222, 2);
  const tracker = new DeltaTracker();
  const snap0 = stateFromCollected(decodeSnapshot(encodeSnapshot(collectFullState(sim, 0))));
  tracker.commit(sim);
  sim.endTick();
  spawnAsset(sim, 0x3333, 3);
  const dState = collectDeltaState(sim, 1, 0, tracker);
  const applied = applyDelta(snap0, decodeDelta(encodeDelta(dState)));
  const live = stateFromCollected(collectFullState(sim, 1));
  assert.ok(compareStates(applied, live).equal);
});

test("persistence: AssetRef survives save/restore", () => {
  const sim = new SimWorld();
  const e = spawnAsset(sim, 0x9e3779b9, 12);
  const wid = sim.wireId(e);
  const state = decodeSnapshot(encodeSnapshot(collectFullState(sim, 5)));
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  restored.restoreFromState(state, new Map());
  const again = collectFullState(restored, 5);
  const row: AssetRefRow | undefined = again.assets.find((r) => r.wireId === wid);
  assert.ok(row, "AssetRef row restored");
  assert.equal(row.assetHash, 0x9e3779b9);
  assert.equal(row.variant, 12);
  const cmp = compareStates(stateFromCollected(state), stateFromCollected(again));
  assert.ok(cmp.equal, cmp.diffs.join("; "));
});
