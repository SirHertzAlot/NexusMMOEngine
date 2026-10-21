import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeSnapshot,
  encodeDelta,
  encodeDeltaSoA,
  encodeSnapshot,
  encodeSnapshotSoA,
  type CollectedState,
  type CollectedStateSoA,
} from "../src/index.js";

/**
 * SoA-vs-row byte equality (Phase 3): the columnar encoders must emit
 * exactly the bytes the row encoders emit for the same logical state.
 * Stores here are plain JS arrays indexed by entity slot — the same
 * indexing contract the SAB-backed bitECS stores satisfy.
 */


/** Dense numeric column indexed by entity slot. */
function col(size: number, entries: Record<number, number>): Float64Array {
  const a = new Float64Array(size);
  for (const [k, v] of Object.entries(entries)) a[Number(k)] = v;
  return a;
}

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
    spawned: [],
    despawned: [],
  };
}

function emptyRows(): CollectedState {
  return {
    tick: 0, baseTick: 0,
    transforms: [], velocities: [], intents: [], chunks: [],
    healths: [], staminas: [], characterRefs: [], bodies: [],
    assets: [], locomotions: [], appearances: [], actions: [],
    animations: [], spawned: [], despawned: [],
  };
}

/**
 * One populated state, expressed both ways. Slots are sparse
 * (eids 2, 5, 9) so the test proves SoA indexing is by slot, not by
 * row position. Wire ids are (generation << 32) | slot with nonzero
 * generations, matching SimWorld.makeWireEntityId.
 */
function populated(): { rows: CollectedState; soa: CollectedStateSoA } {
  const rows = emptyRows();
  const soa = emptySoA();
  rows.tick = soa.tick = 7;
  rows.baseTick = soa.baseTick = 6;

  const wireIdOf = (eid: number): bigint => (BigInt(eid * 3 + 1) << 32n) | BigInt(eid);
  const wid = (eid: number): bigint => wireIdOf(eid);

  // --- transforms: slots 2 and 5 ---
  rows.transforms = [
    { wireId: wid(2), px: 1.5, py: -2.25, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 2, sz: 3 },
    { wireId: wid(5), px: 42, py: 0, pz: -7.5, qx: 0.1, qy: 0.2, qz: 0.3, qw: 0.9, sx: 2, sy: 2, sz: 2 },
  ];
  soa.transforms = {
    eids: [2, 5], wireIdOf,
    px: col(10, { 2: 1.5, 5: 42 }), py: col(10, { 2: -2.25, 5: 0 }), pz: col(10, { 2: 0, 5: -7.5 }),
    qx: col(10, { 2: 0, 5: 0.1 }), qy: col(10, { 2: 0, 5: 0.2 }), qz: col(10, { 2: 0, 5: 0.3 }), qw: col(10, { 2: 1, 5: 0.9 }),
    sx: col(10, { 2: 1, 5: 2 }), sy: col(10, { 2: 2, 5: 2 }), sz: col(10, { 2: 3, 5: 2 }),
  };

  // --- velocities: slot 2 only ---
  rows.velocities = [
    { wireId: wid(2), lx: 4, ly: 5, lz: 6, ax: 0.1, ay: 0.2, az: 0.3 },
  ];
  soa.velocities = {
    eids: [2], wireIdOf,
    lx: col(10, { 2: 4 }), ly: col(10, { 2: 5 }), lz: col(10, { 2: 6 }), ax: col(10, { 2: 0.1 }), ay: col(10, { 2: 0.2 }), az: col(10, { 2: 0.3 }),
  };

  // --- intents: slot 5 only ---
  rows.intents = [
    { wireId: wid(5), mx: 1, my: 0, mz: -1, lookYaw: 1.2, lookPitch: -0.4, jump: true, buttons: 7 },
  ];
  soa.intents = {
    eids: [5], wireIdOf,
    mx: col(10, { 5: 1 }), my: col(10, { 5: 0 }), mz: col(10, { 5: -1 }),
    lookYaw: col(10, { 5: 1.2 }), lookPitch: col(10, { 5: -0.4 }),
    jump: col(10, { 5: 1 }), buttons: col(10, { 5: 7 }),
  };

  // --- chunks: slot 9, large u64 ids + heights ---
  const heights = new Float32Array(256);
  for (let i = 0; i < 256; i++) heights[i] = i * 0.5 - 10;
  rows.chunks = [
    { wireId: wid(9), chunkId: 0x123456789abcdef0n, seed: 0xfedcba9876543210n, lod: 3, heights },
  ];
  soa.chunks = {
    eids: [9], wireIdOf,
    chunkIdHi: col(10, { 9: 0x12345678 }), chunkIdLo: col(10, { 9: 0x9abcdef0 }),
    seedHi: col(10, { 9: 0xfedcba98 }), seedLo: col(10, { 9: 0x76543210 }),
    lod: col(10, { 9: 3 }),
    heightsOf: (eid) => (eid === 9 ? heights : null),
  };

  // --- healths: slots 2 and 9 ---
  rows.healths = [
    { wireId: wid(2), current: 83.5, max: 100 },
    { wireId: wid(9), current: 10, max: 50 },
  ];
  soa.healths = {
    eids: [2, 9], wireIdOf,
    current: col(10, { 2: 83.5, 9: 10 }), max: col(10, { 2: 100, 9: 50 }),
  };

  // --- staminas: slot 2 ---
  rows.staminas = [{ wireId: wid(2), current: 42, max: 60 }];
  soa.staminas = { eids: [2], wireIdOf, current: col(10, { 2: 42 }), max: col(10, { 2: 60 }) };

  // --- character refs: slot 5 (small id, as in production) ---
  rows.characterRefs = [{ wireId: wid(5), characterId: 12345 }];
  soa.characterRefs = { eids: [5], wireIdOf, idHi: col(10, { 5: 0 }), idLo: col(10, { 5: 12345 }) };

  // --- bodies: slot 2 ---
  rows.bodies = [{
    wireId: wid(2), shapeKind: 1, halfX: 0.5, halfY: 1, halfZ: 0.5,
    radius: 0.25, mass: 80, motionType: 2, layer: 3, friction: 0.8, restitution: 0.1,
  }];
  soa.bodies = {
    eids: [2], wireIdOf,
    shapeKind: col(10, { 2: 1 }), halfX: col(10, { 2: 0.5 }), halfY: col(10, { 2: 1 }), halfZ: col(10, { 2: 0.5 }),
    radius: col(10, { 2: 0.25 }), mass: col(10, { 2: 80 }), motionType: col(10, { 2: 2 }), layer: col(10, { 2: 3 }),
    friction: col(10, { 2: 0.8 }), restitution: col(10, { 2: 0.1 }),
  };

  // --- assets: slot 5 ---
  rows.assets = [{ wireId: wid(5), assetHash: 0xdeadbeef, variant: 3 }];
  soa.assets = { eids: [5], wireIdOf, assetHash: col(10, { 5: 0xdeadbeef }), variant: col(10, { 5: 3 }) };

  // --- locomotions: slot 2 ---
  rows.locomotions = [{ wireId: wid(2), mode: 1, abilities: 3, breath: 0.75 }];
  soa.locomotions = { eids: [2], wireIdOf, mode: col(10, { 2: 1 }), abilities: col(10, { 2: 3 }), breath: col(10, { 2: 0.75 }) };

  // --- appearances: slot 5 ---
  rows.appearances = [{ wireId: wid(5), look: '{"hair":"red"}' }];
  soa.appearances = { eids: [5], wireIdOf, lookOf: (eid) => (eid === 5 ? '{"hair":"red"}' : "") };

  // --- actions: slot 2 ---
  rows.actions = [{ wireId: wid(2), move: 4, started: 99, seq: 2, yaw: 1.57 }];
  soa.actions = { eids: [2], wireIdOf, move: col(10, { 2: 4 }), started: col(10, { 2: 99 }), seq: col(10, { 2: 2 }), yaw: col(10, { 2: 1.57 }) };

  // --- animations: slot 2 ---
  rows.animations = [{ wireId: wid(2), clipId: 7, startTick: 5, rate: 1.25, layerMask: 3 }];
  soa.animations = { eids: [2], wireIdOf, clipId: col(10, { 2: 7 }), startTick: col(10, { 2: 5 }), rate: col(10, { 2: 1.25 }), layerMask: col(10, { 2: 3 }) };

  rows.spawned = [wid(2), wid(5), wid(9)];
  rows.despawned = [wid(11)];
  soa.spawned = [wid(2), wid(5), wid(9)];
  soa.despawned = [wid(11)];

  return { rows, soa };
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array): void {
  assert.equal(a.length, b.length, `byte length differs: ${a.length} vs ${b.length}`);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), "wire bytes differ");
}

test("SoA snapshot encoding is byte-identical to row encoding", () => {
  const { rows, soa } = populated();
  assertBytesEqual(encodeSnapshotSoA(soa), encodeSnapshot(rows));
  // Decoding the SoA bytes yields the same logical state.
  const decoded = decodeSnapshot(encodeSnapshotSoA(soa));
  assert.equal(decoded.tick, 7);
  assert.equal(decoded.chunks[0]?.chunkId, 0x123456789abcdef0n);
  assert.equal(decoded.chunks[0]?.seed, 0xfedcba9876543210n);
  assert.equal(decoded.chunks[0]?.heights?.[10], 10 * 0.5 - 10);
  assert.equal(decoded.appearances[0]?.look, '{"hair":"red"}');
});

test("SoA delta encoding is byte-identical to row encoding", () => {
  const { rows, soa } = populated();
  assertBytesEqual(encodeDeltaSoA(soa), encodeDelta(rows));
});

test("SoA encoding of an empty state is byte-identical to row encoding", () => {
  assertBytesEqual(encodeSnapshotSoA(emptySoA()), encodeSnapshot(emptyRows()));
  assertBytesEqual(encodeDeltaSoA(emptySoA()), encodeDelta(emptyRows()));
});

test("SoA chunk without a heights source encodes like a heights:null row", () => {
  const { rows, soa } = populated();
  rows.chunks[0]!.heights = null;
  soa.chunks = { ...soa.chunks, heightsOf: undefined };
  assertBytesEqual(encodeSnapshotSoA(soa), encodeSnapshot(rows));
});
