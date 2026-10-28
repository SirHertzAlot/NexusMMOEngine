import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  decodeFastDelta as tsDecodeFastDelta,
  encodeFastDelta as tsEncodeFastDelta,
  encodeFastDeltaFromSoA as tsEncodeFastDeltaFromSoA,
  tryDecodeFastDelta as tsTryDecodeFastDelta,
  FAST_PATH_HEADER_BYTES,
  FAST_PATH_MAGIC,
  FAST_PATH_RECORD_BYTES,
  FAST_PATH_VERSION,
  FastPathError,
  type FastPathEntry,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const nativeCodec = require("../../../addons/codec/index.js");

const f32 = (v: number): number => Math.fround(v);

const ENTRIES_CORPUS: FastPathEntry[] = [
  { wireId: 1n, px: 1.5, py: -2.25, pz: 0, lx: 4, ly: 5, lz: 6 },
  { wireId: 0x123456789abcdef0n, px: 100.25, py: 0.5, pz: -300.75, lx: -1, ly: 0, lz: 2.5 },
  { wireId: 18446744073709551615n, px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 },
  { wireId: 42n, px: -12.345, py: 67.89, pz: 101.112, lx: -0.05, ly: 0.1, lz: -0.2 },
];

test("fast-path parity: byte-identical encode output on test corpus", () => {
  const tsBytes = tsEncodeFastDelta(101, ENTRIES_CORPUS);
  const nativeBytes = nativeCodec.encodeFastDelta(101, ENTRIES_CORPUS);

  assert.equal(nativeBytes.length, tsBytes.length);
  assert.deepEqual([...nativeBytes], [...tsBytes]);
});

test("fast-path parity: byte-identical encode output on empty entries", () => {
  const tsBytes = tsEncodeFastDelta(42, []);
  const nativeBytes = nativeCodec.encodeFastDelta(42, []);

  assert.equal(nativeBytes.length, FAST_PATH_HEADER_BYTES);
  assert.deepEqual([...nativeBytes], [...tsBytes]);
});

test("fast-path parity: byte-identical large scale encode (10,000 entities)", () => {
  const largeEntries: FastPathEntry[] = [];
  for (let i = 0; i < 10000; i++) {
    largeEntries.push({
      wireId: BigInt(i * 137 + 1),
      px: (i % 500) - 250,
      py: (i % 100) * 0.5,
      pz: (i % 300) - 150,
      lx: 0.25,
      ly: 0.0,
      lz: -0.25,
    });
  }

  const tsBytes = tsEncodeFastDelta(999, largeEntries);
  const nativeBytes = nativeCodec.encodeFastDelta(999, largeEntries);

  assert.equal(nativeBytes.length, tsBytes.length);
  assert.deepEqual(nativeBytes, tsBytes);
});

test("fast-path parity: cross decode parity (TS encodes -> Native decodes, Native encodes -> TS decodes)", () => {
  const tsBytes = tsEncodeFastDelta(777, ENTRIES_CORPUS);
  const nativeDecoded = nativeCodec.decodeFastDelta(tsBytes);

  assert.equal(nativeDecoded.tick, 777);
  assert.equal(nativeDecoded.entries.length, ENTRIES_CORPUS.length);
  for (let i = 0; i < ENTRIES_CORPUS.length; i++) {
    assert.equal(nativeDecoded.entries[i].wireId, ENTRIES_CORPUS[i].wireId);
    assert.equal(nativeDecoded.entries[i].px, f32(ENTRIES_CORPUS[i].px));
    assert.equal(nativeDecoded.entries[i].py, f32(ENTRIES_CORPUS[i].py));
    assert.equal(nativeDecoded.entries[i].pz, f32(ENTRIES_CORPUS[i].pz));
    assert.equal(nativeDecoded.entries[i].lx, f32(ENTRIES_CORPUS[i].lx));
    assert.equal(nativeDecoded.entries[i].ly, f32(ENTRIES_CORPUS[i].ly));
    assert.equal(nativeDecoded.entries[i].lz, f32(ENTRIES_CORPUS[i].lz));
  }

  const nativeBytes = nativeCodec.encodeFastDelta(888, ENTRIES_CORPUS);
  const tsDecoded = tsDecodeFastDelta(nativeBytes);

  assert.equal(tsDecoded.tick, 888);
  assert.equal(tsDecoded.entries.length, ENTRIES_CORPUS.length);
  for (let i = 0; i < ENTRIES_CORPUS.length; i++) {
    assert.equal(tsDecoded.entries[i].wireId, ENTRIES_CORPUS[i].wireId);
    assert.equal(tsDecoded.entries[i].px, f32(ENTRIES_CORPUS[i].px));
  }
});

test("fast-path parity: fail-closed parity on invalid magic", () => {
  const bytes = tsEncodeFastDelta(1, ENTRIES_CORPUS);
  const bad = new Uint8Array(bytes);
  bad[0] = 0x00;

  assert.throws(() => tsDecodeFastDelta(bad), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(bad), /fast-path/);

  const tsTry = tsTryDecodeFastDelta(bad);
  const nativeTry = nativeCodec.tryDecodeFastDelta(bad);
  assert.equal(tsTry.ok, false);
  assert.equal(nativeTry.ok, false);
});

test("fast-path parity: fail-closed parity on unsupported version", () => {
  const bytes = tsEncodeFastDelta(1, ENTRIES_CORPUS);
  const v2 = new Uint8Array(bytes);
  v2[1] = 2;

  assert.throws(() => tsDecodeFastDelta(v2), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(v2), /fast-path/);

  const tsTry = tsTryDecodeFastDelta(v2);
  const nativeTry = nativeCodec.tryDecodeFastDelta(v2);
  assert.equal(tsTry.ok, false);
  assert.equal(nativeTry.ok, false);
});

test("fast-path parity: fail-closed parity on truncated or trailing buffer", () => {
  const bytes = tsEncodeFastDelta(1, ENTRIES_CORPUS);

  const truncated = bytes.slice(0, bytes.length - 1);
  assert.throws(() => tsDecodeFastDelta(truncated), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(truncated), /fast-path/);

  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  assert.throws(() => tsDecodeFastDelta(trailing), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(trailing), /fast-path/);
});

test("fast-path parity: fail-closed parity on non-finite values", () => {
  const nanBytes = tsEncodeFastDelta(1, [{ wireId: 1n, px: NaN, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 }]);
  assert.throws(() => tsDecodeFastDelta(nanBytes), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(nanBytes), /fast-path/);

  const infBytes = tsEncodeFastDelta(1, [{ wireId: 1n, px: Infinity, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 }]);
  assert.throws(() => tsDecodeFastDelta(infBytes), FastPathError);
  assert.throws(() => nativeCodec.decodeFastDelta(infBytes), /fast-path/);
});

test("fast-path parity: SoA intersection byte parity across sparse slots", () => {
  const wireIdOf = (eid: number): bigint => BigInt(eid + 100);
  const col = (size: number, entries: Record<number, number>): Float64Array => {
    const a = new Float64Array(size);
    for (const [k, v] of Object.entries(entries)) a[Number(k)] = v;
    return a;
  };

  const transforms = {
    eids: [1, 2, 3],
    wireIdOf,
    px: col(5, { 1: 1.5, 2: 2.5, 3: 3.5 }),
    py: col(5, { 1: 10, 2: 20, 3: 30 }),
    pz: col(5, { 1: -1, 2: -2, 3: -3 }),
  };
  const velocities = {
    eids: [2, 3, 4],
    wireIdOf,
    lx: col(5, { 2: 0.1, 3: 0.2, 4: 0.3 }),
    ly: col(5, { 2: 0.4, 3: 0.5, 4: 0.6 }),
    lz: col(5, { 2: 0.7, 3: 0.8, 4: 0.9 }),
  };

  const tsSoa = tsEncodeFastDeltaFromSoA(15, transforms, velocities);
  const nativeSoa = nativeCodec.encodeFastDeltaFromSoA(15, transforms, velocities);

  assert.ok(tsSoa);
  assert.ok(nativeSoa);
  assert.equal(nativeSoa!.length, tsSoa!.length);
  assert.deepEqual([...nativeSoa!], [...tsSoa!]);
});

test("fast-path parity: SoA empty intersection returns null on both", () => {
  const wireIdOf = (eid: number): bigint => BigInt(eid);
  const zero = new Float64Array(4);

  const tsNull = tsEncodeFastDeltaFromSoA(
    1,
    { eids: [1], wireIdOf, px: zero, py: zero, pz: zero },
    { eids: [2], wireIdOf, lx: zero, ly: zero, lz: zero },
  );
  const nativeNull = nativeCodec.encodeFastDeltaFromSoA(
    1,
    { eids: [1], wireIdOf, px: zero, py: zero, pz: zero },
    { eids: [2], wireIdOf, lx: zero, ly: zero, lz: zero },
  );

  assert.equal(tsNull, null);
  assert.equal(nativeNull, null);
});
