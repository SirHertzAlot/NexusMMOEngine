/** PositionBlock (v29): position-only rows round-trip through encodeDeltaSoA / decodeDelta, field for field. */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, encodeDeltaSoA, PROTOCOL_VERSION, type CollectedStateSoA } from "../src/index.js";

const none = { eids: [] as number[], wireIdOf: (e: number) => BigInt(e) };

test("position rows round-trip and cost 20 B per row against 57 B for a full transform row", () => {
  const n = 100;
  const px = new Float32Array(n + 1), py = new Float32Array(n + 1), pz = new Float32Array(n + 1);
  for (let i = 1; i <= n; i++) { px[i] = i * 1.5; py[i] = -i; pz[i] = i / 3; }
  const eids = Array.from({ length: n }, (_, i) => i + 1);
  const state = {
    tick: 9, baseTick: 8,
    transforms: { ...none, px, py, pz, qx: px, qy: px, qz: px, qw: px, sx: px, sy: px, sz: px },
    positions: { eids, wireIdOf: (e: number) => BigInt(0x100 + e), px, py, pz },
    velocities: { ...none, lx: px, ly: px, lz: px, ax: px, ay: px, az: px },
    intents: { ...none, mx: px, my: px, mz: px, lookYaw: px, lookPitch: px, jump: px, buttons: px },
    chunks: { ...none, chunkIdHi: px, chunkIdLo: px, seedHi: px, seedLo: px, lod: px },
    healths: { ...none, current: px, max: px },
    staminas: { ...none, current: px, max: px },
    characterRefs: { ...none, idHi: px, idLo: px },
    bodies: { ...none }, assets: { ...none, assetHash: px, variant: px },
    locomotions: { ...none, mode: px, abilities: px, breath: px },
    appearances: { ...none }, actions: { ...none, move: px, started: px, seq: px, yaw: px },
    animations: { ...none, clipId: px, startTick: px, rate: px, layerMask: px },
    spawned: [], despawned: [],
  } as unknown as CollectedStateSoA;
  const bytes = encodeDeltaSoA(state, undefined, true);
  const d = decodeDelta(bytes);
  assert.equal(d.transforms.length, 0);
  assert.equal(d.positions!.length, n);
  d.positions!.forEach((r, i) => {
    const e = i + 1;
    assert.equal(r.wireId, BigInt(0x100 + e));
    assert.deepEqual([r.px, r.py, r.pz], [px[e], py[e], pz[e]]);
  });
  assert.ok(bytes.length < n * 24 + 80, `${bytes.length} B for ${n} rows`);
  assert.ok(PROTOCOL_VERSION >= 29);
});

test("a Delta without positions decodes to an empty list", () => {
  const empty = { ...none, px: [], py: [], pz: [] };
  const state = {
    tick: 1, baseTick: 0, transforms: { ...empty, qx: [], qy: [], qz: [], qw: [], sx: [], sy: [], sz: [] },
    velocities: { ...none, lx: [], ly: [], lz: [], ax: [], ay: [], az: [] },
    intents: { ...none, mx: [], my: [], mz: [], lookYaw: [], lookPitch: [], jump: [], buttons: [] },
    chunks: { ...none, chunkIdHi: [], chunkIdLo: [], seedHi: [], seedLo: [], lod: [] },
    healths: { ...none, current: [], max: [] }, staminas: { ...none, current: [], max: [] },
    characterRefs: { ...none, idHi: [], idLo: [] }, bodies: { ...none }, assets: { ...none, assetHash: [], variant: [] },
    locomotions: { ...none, mode: [], abilities: [], breath: [] }, appearances: { ...none },
    actions: { ...none, move: [], started: [], seq: [], yaw: [] }, animations: { ...none, clipId: [], startTick: [], rate: [], layerMask: [] },
    spawned: [], despawned: [],
  } as unknown as CollectedStateSoA;
  assert.deepEqual(decodeDelta(encodeDeltaSoA(state, undefined, true)).positions, []);
});
