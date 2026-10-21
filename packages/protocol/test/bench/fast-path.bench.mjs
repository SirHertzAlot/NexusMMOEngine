/**
 * Phase 5 benchmark gate, Part B: fast-path v1 encode/decode vs the
 * FlatBuffers Delta for the same position + linear-velocity data.
 *
 * Run: node packages/protocol/test/bench/fast-path.bench.mjs
 * (from the repo root, after building @mmo-engine/protocol).
 *
 * The FlatBuffers Delta is built from row state with only the
 * transform + velocity blocks populated (the fast path's best case:
 * a position/velocity-only tick). The fast path encodes the same
 * fields as a frozen struct array. Both directions are timed, and
 * payload bytes are reported (the fast path's fixed 32 B/record vs
 * FlatBuffers table/vector overhead).
 */

import {
  decodeDelta,
  decodeFastDelta,
  encodeDelta,
  encodeFastDelta,
  encodeDeltaSoA,
  encodeFastDeltaFromSoA,
} from "../../dist/src/index.js";

const ITERS = 200;
const WARMUP = 20;

function timeIt(fn, iters) {
  for (let i = 0; i < WARMUP; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

function makeRows(n) {
  const transforms = [];
  const velocities = [];
  const entries = [];
  for (let i = 0; i < n; i++) {
    const wireId = BigInt(i + 1);
    transforms.push({
      wireId, px: i * 0.5, py: (i % 97) - 48, pz: i * 0.25,
      qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1,
    });
    velocities.push({ wireId, lx: 0.1, ly: 0, lz: -0.1, ax: 0, ay: 0.01, az: 0 });
    entries.push({ wireId, px: i * 0.5, py: (i % 97) - 48, pz: i * 0.25, lx: 0.1, ly: 0, lz: -0.1 });
  }
  return { transforms, velocities, entries };
}

function makeSoA(n) {
  const wireIdOf = (eid) => BigInt(eid + 1);
  const eids = Array.from({ length: n }, (_, i) => i);
  const col = (fn) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = fn(i); return a; };
  return {
    transforms: {
      eids, wireIdOf,
      px: col((i) => i * 0.5), py: col((i) => (i % 97) - 48), pz: col((i) => i * 0.25),
      qx: col(() => 0), qy: col(() => 0), qz: col(() => 0), qw: col(() => 1),
      sx: col(() => 1), sy: col(() => 1), sz: col(() => 1),
    },
    velocities: {
      eids, wireIdOf,
      lx: col(() => 0.1), ly: col(() => 0), lz: col(() => -0.1),
      ax: col(() => 0), ay: col(() => 0.01), az: col(() => 0),
    },
  };
}

function emptyState() {
  return {
    tick: 1, baseTick: 0,
    transforms: [], velocities: [], intents: [], chunks: [], healths: [],
    staminas: [], characterRefs: [], bodies: [], assets: [], locomotions: [],
    appearances: [], actions: [], animations: [], spawned: [], despawned: [],
  };
}

function emptySoA() {
  const wireIdOf = (eid) => BigInt(eid + 1);
  const no = { eids: [], wireIdOf };
  return {
    tick: 1, baseTick: 0,
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
    spawned: [], despawned: [],
  };
}

console.log("Phase 5 fast-path v1 vs FlatBuffers Delta (pos + linear velocity only)");
for (const n of [1000, 5000]) {
  const { transforms, velocities, entries } = makeRows(n);
  const rowState = { ...emptyState(), transforms, velocities };
  const soa = makeSoA(n);
  const soaState = { ...emptySoA(), transforms: soa.transforms, velocities: soa.velocities };

  const fbRow = encodeDelta(rowState);
  const fpRow = encodeFastDelta(1, entries);
  const fbSoA = encodeDeltaSoA(soaState);
  const fpSoA = encodeFastDeltaFromSoA(1, soa.transforms, soa.velocities);

  const encFbRow = timeIt(() => encodeDelta(rowState), ITERS);
  const encFp = timeIt(() => encodeFastDelta(1, entries), ITERS);
  const encFbSoA = timeIt(() => encodeDeltaSoA(soaState), ITERS);
  const encFpSoA = timeIt(() => encodeFastDeltaFromSoA(1, soa.transforms, soa.velocities), ITERS);
  const decFb = timeIt(() => decodeDelta(fbRow), ITERS);
  const decFp = timeIt(() => decodeFastDelta(fpRow), ITERS);

  console.log(
    `N=${n}: encode FlatBuffers(row) ${encFbRow.toFixed(3)} ms | ` +
    `FlatBuffers(SoA) ${encFbSoA.toFixed(3)} ms | ` +
    `fast-path ${encFp.toFixed(3)} ms (${(encFbSoA / encFp).toFixed(2)}x vs SoA) | ` +
    `fast-path(SoA) ${encFpSoA.toFixed(3)} ms`,
  );
  console.log(
    `N=${n}: decode FlatBuffers ${decFb.toFixed(3)} ms | fast-path ${decFp.toFixed(3)} ms (${(decFb / decFp).toFixed(2)}x) | ` +
    `bytes FlatBuffers ${fbRow.length} vs fast-path ${fpRow.length} (${(fbRow.length / fpRow.length).toFixed(2)}x smaller)`,
  );
  // Sanity: the SoA fast-path bytes equal the row fast-path bytes.
  if (Buffer.compare(Buffer.from(fpSoA), Buffer.from(fpRow)) !== 0) {
    console.error(`N=${n}: SoA fast-path bytes differ from row fast-path bytes`);
    process.exitCode = 1;
  }
}
