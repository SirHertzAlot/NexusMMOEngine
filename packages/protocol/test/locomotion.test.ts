import test from "node:test";
import assert from "node:assert/strict";
import * as flatbuffers from "flatbuffers";
import { Snapshot } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import {
  Ability,
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
  LocomotionMode,
  type CollectedState,
} from "../src/index.js";

const empty = (tick: number): CollectedState => ({
  tick,
  baseTick: 0,
  transforms: [],
  velocities: [],
  intents: [],
  chunks: [],
  healths: [],
  bodies: [],
  assets: [],
  spawned: [],
  despawned: [],
  locomotions: [],
});

test("locomotion rows round-trip in snapshots and deltas", () => {
  const state = empty(7);
  state.locomotions = [
    { wireId: 3n, mode: LocomotionMode.Swim, abilities: Ability.Swim, breath: 0.5 },
    { wireId: (1n << 32n) | 9n, mode: LocomotionMode.Fly, abilities: Ability.Swim | Ability.Fly, breath: 1 },
  ];
  assert.deepEqual(decodeSnapshot(encodeSnapshot(state)).locomotions, state.locomotions);
  assert.deepEqual(decodeDelta(encodeDelta(state)).locomotions, state.locomotions);
});

test("a snapshot saved before locomotion existed decodes with no rows", () => {
  // The old layout: no locomotions field at all.
  const b = new flatbuffers.Builder(64);
  Snapshot.startSnapshot(b);
  Snapshot.addTick(b, 42n);
  Snapshot.finishSnapshotBuffer(b, Snapshot.endSnapshot(b));
  const old = decodeSnapshot(b.asUint8Array());
  assert.equal(old.tick, 42);
  assert.deepEqual(old.locomotions, []);
});
