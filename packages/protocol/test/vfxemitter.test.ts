/**
 * VfxEmitter rows (ComponentId 19) ride snapshots and deltas exactly
 * like every other block: field-for-field through the same bytes on
 * both sides, and the SoA encoder emits byte-identical output to the
 * row encoder for the same state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeDeltaSoA,
  encodeSnapshot,
  encodeSnapshotSoA,
  type CollectedState,
  type CollectedStateSoA,
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
  animations: [],
  vfxEmitters: [],
});

test("vfx emitter rows round-trip in snapshots and deltas", () => {
  const state = empty(11);
  state.vfxEmitters = [
    { wireId: 3n, template: 4098966889, intensity: 1.5 },
    { wireId: (1n << 32n) | 9n, template: 0, intensity: 0.25 },
    { wireId: 12n, template: 4294967295, intensity: 2 },
  ];
  assert.deepEqual(decodeSnapshot(encodeSnapshot(state)).vfxEmitters, state.vfxEmitters);
  assert.deepEqual(decodeDelta(encodeDelta(state)).vfxEmitters, state.vfxEmitters);
});

test("a state without emitters round-trips with an empty vfx block", () => {
  const state = empty(3);
  assert.deepEqual(decodeSnapshot(encodeSnapshot(state)).vfxEmitters, []);
  assert.deepEqual(decodeDelta(encodeDelta(state)).vfxEmitters, []);
});

function emptySoA(): CollectedStateSoA {
  const wireIdOf = (eid: number): bigint => BigInt(eid + 1);
  const no = { eids: [] as number[], wireIdOf };
  return {
    tick: 0,
    baseTick: 0,
    transforms: { ...no, px: [], py: [], pz: [], qx: [], qy: [], qz: [], qw: [], sx: [], sy: [], sz: [] },
    velocities: { ...no, lx: [], ly: [], lz: [], ax: [], ay: [], az: [] },
    intents: { ...no, mx: [], my: [], mz: [], lookYaw: [], lookPitch: [], jump: [], buttons: [] },
    chunks: { ...no, chunkIdHi: [], chunkIdLo: [], seedHi: [], seedLo: [], lod: [] },
    healths: { ...no, current: [], max: [] },
    staminas: { ...no, current: [], max: [] },
    characterRefs: { ...no, idHi: [], idLo: [] },
    bodies: { ...no, shapeKind: [], halfX: [], halfY: [], halfZ: [], radius: [], mass: [], motionType: [], layer: [], friction: [], restitution: [] },
    assets: { ...no, assetHash: [], variant: [] },
    locomotions: { ...no, mode: [], abilities: [], breath: [] },
    appearances: { ...no, lookOf: () => "" },
    actions: { ...no, move: [], started: [], seq: [], yaw: [] },
    animations: { ...no, clipId: [], startTick: [], rate: [], layerMask: [] },
    vfxEmitters: { ...no, template: [], intensity: [] },
    spawned: [],
    despawned: [],
  };
}

test("SoA encoding of vfx emitters is byte-identical to row encoding", () => {
  const wireIdOf = (eid: number): bigint => (BigInt(eid * 3 + 1) << 32n) | BigInt(eid);
  const rows = empty(7);
  rows.vfxEmitters = [
    { wireId: wireIdOf(2), template: 123456789, intensity: 1.5 },
    { wireId: wireIdOf(9), template: 4098966889, intensity: 0.5 },
  ];
  const template = new Float64Array(16);
  template[2] = 123456789;
  template[9] = 4098966889;
  const intensity = new Float64Array(16);
  intensity[2] = 1.5;
  intensity[9] = 0.5;
  const soa = emptySoA();
  soa.tick = 7;
  soa.vfxEmitters = { eids: [2, 9], wireIdOf, template, intensity };
  assert.deepEqual(encodeSnapshotSoA(soa), encodeSnapshot(rows));
  assert.deepEqual(encodeDeltaSoA(soa), encodeDelta(rows));
  assert.deepEqual(decodeSnapshot(encodeSnapshotSoA(soa)).vfxEmitters, rows.vfxEmitters);
});
