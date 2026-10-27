/**
 * C++ Main Tick — Phase 1 Pilot Benchmark
 *
 * Compares pure TypeScript fast-path implementation against native C++ addon
 * (@mmo-engine/addon-codec) across encode, decode, and SoA column serialization.
 *
 * Execution: node packages/protocol/test/bench/fast-path-pilot.bench.mjs
 */

import { createRequire } from "node:module";
import {
  decodeFastDelta as tsDecodeFastDelta,
  encodeFastDelta as tsEncodeFastDelta,
  encodeFastDeltaFromSoA as tsEncodeFastDeltaFromSoA,
} from "../../dist/src/index.js";

const require = createRequire(import.meta.url);
const nativeCodec = require("../../../addons/codec/index.js");

const ITERS = 150;
const WARMUP = 20;

function timeIt(fn, iters = ITERS) {
  for (let i = 0; i < WARMUP; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

function makeRows(n) {
  const entries = new Array(n);
  for (let i = 0; i < n; i++) {
    entries[i] = {
      wireId: BigInt(i + 1),
      px: i * 0.5,
      py: (i % 97) - 48,
      pz: i * 0.25,
      lx: 0.1,
      ly: 0.0,
      lz: -0.1,
    };
  }
  return entries;
}

function makeSoA(n) {
  const wireIdOf = (eid) => BigInt(eid + 1);
  const eids = Array.from({ length: n }, (_, i) => i);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lz = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    px[i] = i * 0.5;
    py[i] = (i % 97) - 48;
    pz[i] = i * 0.25;
    lx[i] = 0.1;
    ly[i] = 0.0;
    lz[i] = -0.1;
  }

  return {
    transforms: { eids, wireIdOf, px, py, pz },
    velocities: { eids, wireIdOf, lx, ly, lz },
  };
}

function makeSoABulk(n) {
  const tEids = new Uint32Array(n);
  const vEids = new Uint32Array(n);
  const tWireIds = new BigUint64Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lz = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    tEids[i] = i;
    vEids[i] = i;
    tWireIds[i] = BigInt(i + 1);
    px[i] = i * 0.5;
    py[i] = (i % 97) - 48;
    pz[i] = i * 0.25;
    lx[i] = 0.1;
    ly[i] = 0.0;
    lz[i] = -0.1;
  }

  return { tEids, tWireIds, px, py, pz, vEids, lx, ly, lz };
}

console.log("================================================================================");
console.log("C++ Main Tick — Phase 1 Pilot Benchmark (TypeScript vs Native C++ Addon)");
console.log("================================================================================\n");

const results = [];

for (const n of [100, 1000, 5000, 10000, 50000]) {
  const entries = makeRows(n);
  const soa = makeSoA(n);
  const bulk = makeSoABulk(n);

  const iters = n >= 10000 ? 50 : ITERS;

  // 1. Encode Row Entries
  const tsEncRow = timeIt(() => tsEncodeFastDelta(1, entries), iters);
  const nativeEncRow = timeIt(() => nativeCodec.encodeFastDelta(1, entries), iters);
  const encSpeedup = tsEncRow / nativeEncRow;

  // 2. Decode Binary Payload
  const payload = nativeCodec.encodeFastDelta(1, entries);
  const tsDec = timeIt(() => tsDecodeFastDelta(payload), iters);
  const nativeDec = timeIt(() => nativeCodec.decodeFastDelta(payload), iters);
  const decSpeedup = tsDec / nativeDec;

  // 3. SoA Column Encode (JS Object + V8 bridge)
  const tsEncSoA = timeIt(() => tsEncodeFastDeltaFromSoA(1, soa.transforms, soa.velocities), iters);
  const nativeEncSoA = timeIt(() => nativeCodec.encodeFastDeltaFromSoA(1, soa.transforms, soa.velocities), iters);
  const soaSpeedup = tsEncSoA / nativeEncSoA;

  // 4. Native Zero-Copy Bulk SoA (Direct TypedArray pointers, zero V8 object wrapping)
  const nativeBulk = timeIt(
    () => nativeCodec.encodeFastDeltaSoABulk(1, bulk.tEids, bulk.tWireIds, bulk.px, bulk.py, bulk.pz, bulk.vEids, bulk.lx, bulk.ly, bulk.lz),
    iters
  );
  const bulkSpeedup = tsEncSoA / nativeBulk;

  results.push({
    n,
    tsEncRow,
    nativeEncRow,
    encSpeedup,
    tsDec,
    nativeDec,
    decSpeedup,
    tsEncSoA,
    nativeEncSoA,
    soaSpeedup,
    nativeBulk,
    bulkSpeedup,
  });

  console.log(`[N = ${n.toString().padStart(5)}] Payload: ${(payload.length / 1024).toFixed(1)} KB`);
  console.log(`  - Encode (Row):     TS = ${tsEncRow.toFixed(4)} ms | Native = ${nativeEncRow.toFixed(4)} ms | Speedup = ${encSpeedup.toFixed(2)}x`);
  console.log(`  - Decode (Binary):  TS = ${tsDec.toFixed(4)} ms | Native = ${nativeDec.toFixed(4)} ms | Speedup = ${decSpeedup.toFixed(2)}x`);
  console.log(`  - SoA Intersect:    TS = ${tsEncSoA.toFixed(4)} ms | Native = ${nativeEncSoA.toFixed(4)} ms | Speedup = ${soaSpeedup.toFixed(2)}x`);
  console.log(`  - Native Bulk SoA:  Native = ${nativeBulk.toFixed(4)} ms | Speedup vs TS SoA = ${bulkSpeedup.toFixed(2)}x`);
  console.log("");
}

console.log("Benchmark run completed successfully.");
