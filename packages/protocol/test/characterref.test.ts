/**
 * CharacterRef rows (C3) ride snapshots and deltas exactly like every
 * other block: field-for-field through the same bytes on both sides.
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
  bodies: [],
  assets: [],
  spawned: [],
  despawned: [],
  locomotions: [],
  appearances: [],
  actions: [],
  characterRefs: [],
});

test("characterref rows round-trip in snapshots and deltas", () => {
  const state = empty(7);
  state.characterRefs = [
    { wireId: 3n, characterId: 42 },
    { wireId: (1n << 32n) | 9n, characterId: 4294967296 + 7 },
  ];
  assert.deepEqual(decodeSnapshot(encodeSnapshot(state)).characterRefs, state.characterRefs);
  assert.deepEqual(decodeDelta(encodeDelta(state)).characterRefs, state.characterRefs);
});
