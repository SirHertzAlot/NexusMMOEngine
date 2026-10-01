/**
 * Stamina rows (U2) ride snapshots and deltas exactly like Health rows:
 * field-for-field through the same bytes on both sides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
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
  staminas: [],
  bodies: [],
  assets: [],
  spawned: [],
  despawned: [],
  locomotions: [],
  appearances: [],
  actions: [],
  characterRefs: [],
});

test("stamina rows round-trip in snapshots and deltas", () => {
  const state = empty(7);
  state.staminas = [
    { wireId: 3n, current: 80, max: 100 },
    { wireId: (1n << 32n) | 9n, current: 0, max: 120 },
  ];
  assert.deepEqual(decodeSnapshot(encodeSnapshot(state)).staminas, state.staminas);
  assert.deepEqual(decodeDelta(encodeDelta(state)).staminas, state.staminas);
});
