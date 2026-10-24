import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFastDelta,
  encodeFastDelta,
  encodeFastDeltaFromSoA,
  tryDecodeFastDelta,
  FAST_PATH_HEADER_BYTES,
  FAST_PATH_MAGIC,
  FAST_PATH_RECORD_BYTES,
  FAST_PATH_VERSION,
  FastPathError,
  type FastPathEntry,
} from "../src/index.js";

/**
 * Phase 5, Part B: the frozen-layout fast path for position/velocity
 * deltas must round-trip exactly (in f32, the wire's precision), and
 * any malformed payload — unknown version above all — must fail
 * closed, never parse as v1.
 */

const f32 = (v: number): number => Math.fround(v);

const ENTRIES: FastPathEntry[] = [
  { wireId: 1n, px: 1.5, py: -2.25, pz: 0, lx: 4, ly: 5, lz: 6 },
  { wireId: 0x123456789abcdef0n, px: 100.25, py: 0.5, pz: -300.75, lx: -1, ly: 0, lz: 2.5 },
  { wireId: 18446744073709551615n, px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 },
];

test("fast-path: encode/decode round-trips exactly (f32 precision)", () => {
  const bytes = encodeFastDelta(42, ENTRIES);
  assert.equal(bytes.length, FAST_PATH_HEADER_BYTES + ENTRIES.length * FAST_PATH_RECORD_BYTES);
  const { tick, entries } = decodeFastDelta(bytes);
  assert.equal(tick, 42);
  assert.equal(entries.length, ENTRIES.length);
  for (let i = 0; i < ENTRIES.length; i++) {
    assert.equal(entries[i].wireId, ENTRIES[i].wireId);
    for (const k of ["px", "py", "pz", "lx", "ly", "lz"] as const) {
      assert.equal(entries[i][k], f32(ENTRIES[i][k]), `${k} of record ${i}`);
    }
  }
});

test("fast-path: header fields are the frozen v1 layout", () => {
  const bytes = encodeFastDelta(7, ENTRIES.slice(0, 1));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint8(0), FAST_PATH_MAGIC);
  assert.equal(view.getUint8(1), FAST_PATH_VERSION);
  assert.equal(view.getUint16(2, true), 0);
  assert.equal(view.getUint32(4, true), 7);
  assert.equal(view.getUint32(8, true), 1);
});

test("fast-path: empty entries encode to a header-only payload that decodes to []", () => {
  const bytes = encodeFastDelta(9, []);
  assert.equal(bytes.length, FAST_PATH_HEADER_BYTES);
  assert.deepEqual(decodeFastDelta(bytes), { tick: 9, entries: [] });
});

test("fast-path: unknown version is rejected, never misread as v1", () => {
  const bytes = encodeFastDelta(1, ENTRIES);
  // A v2 payload with v1-shaped bytes: bump the version, keep the rest.
  const v2 = new Uint8Array(bytes);
  v2[1] = 2;
  assert.throws(() => decodeFastDelta(v2), (e: unknown) => e instanceof FastPathError && /unsupported version 2/.test(e.message));
  const tried = tryDecodeFastDelta(v2);
  assert.equal(tried.ok, false);
  if (!tried.ok) assert.match(tried.reason, /unsupported version 2/);
  // A far-future version, and a version-0 payload, get the same treatment.
  const v99 = new Uint8Array(bytes);
  v99[1] = 99;
  assert.equal(tryDecodeFastDelta(v99).ok, false);
  const v0 = new Uint8Array(bytes);
  v0[1] = 0;
  assert.equal(tryDecodeFastDelta(v0).ok, false);
});

test("fast-path: bad magic, truncation, trailing bytes, nonzero reserved all fail closed", () => {
  const bytes = encodeFastDelta(1, ENTRIES);
  const badMagic = new Uint8Array(bytes);
  badMagic[0] = 0x00;
  assert.throws(() => decodeFastDelta(badMagic), FastPathError);
  assert.equal(tryDecodeFastDelta(badMagic).ok, false);

  assert.throws(() => decodeFastDelta(bytes.slice(0, bytes.length - 1)), FastPathError);
  assert.throws(() => decodeFastDelta(bytes.slice(0, 5)), FastPathError);
  assert.throws(() => decodeFastDelta(new Uint8Array(0)), FastPathError);

  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  assert.throws(() => decodeFastDelta(trailing), FastPathError);

  const reserved = new Uint8Array(bytes);
  reserved[2] = 1;
  assert.throws(() => decodeFastDelta(reserved), FastPathError);
});

test("fast-path: a header lying about the count is rejected", () => {
  const bytes = encodeFastDelta(1, ENTRIES);
  const lied = new Uint8Array(bytes);
  new DataView(lied.buffer).setUint32(8, ENTRIES.length + 1, true);
  assert.throws(() => decodeFastDelta(lied), FastPathError);
  const liedDown = new Uint8Array(bytes);
  new DataView(liedDown.buffer).setUint32(8, 1, true);
  assert.throws(() => decodeFastDelta(liedDown), FastPathError);
});

test("fast-path: non-finite coordinates are rejected", () => {
  const bytes = encodeFastDelta(1, [{ wireId: 1n, px: NaN, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 }]);
  assert.throws(() => decodeFastDelta(bytes), FastPathError);
  const inf = encodeFastDelta(1, [{ wireId: 1n, px: Infinity, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 }]);
  assert.throws(() => decodeFastDelta(inf), FastPathError);
});

test("fast-path: tick must be a u32", () => {
  assert.throws(() => encodeFastDelta(-1, []), RangeError);
  assert.throws(() => encodeFastDelta(2 ** 32, []), RangeError);
  assert.throws(() => encodeFastDelta(1.5, []), RangeError);
  // Max u32 tick is fine.
  assert.equal(decodeFastDelta(encodeFastDelta(2 ** 32 - 1, [])).tick, 2 ** 32 - 1);
});

test("fast-path SoA: encodes the transform/velocity intersection, in transform-block order", () => {
  const wireIdOf = (eid: number): bigint => BigInt(eid + 100);
  const col = (size: number, entries: Record<number, number>): Float64Array => {
    const a = new Float64Array(size);
    for (const [k, v] of Object.entries(entries)) a[Number(k)] = v;
    return a;
  };
  // Transforms changed for slots 1, 2, 3; velocities for 2, 3, 4.
  const bytes = encodeFastDeltaFromSoA(
    5,
    {
      eids: [1, 2, 3], wireIdOf,
      px: col(5, { 1: 1, 2: 2, 3: 3 }), py: col(5, {}), pz: col(5, {}),
    },
    {
      eids: [2, 3, 4], wireIdOf,
      lx: col(5, { 2: 20, 3: 30, 4: 40 }), ly: col(5, {}), lz: col(5, {}),
    },
  );
  assert.ok(bytes);
  const { tick, entries } = decodeFastDelta(bytes!);
  assert.equal(tick, 5);
  // Intersection only, in transforms order: slots 2, 3 (slot 1 has no
  // velocity, slot 4 has no transform).
  assert.deepEqual(entries.map((e) => e.wireId), [102n, 103n]);
  assert.deepEqual(entries.map((e) => e.px), [2, 3]);
  assert.deepEqual(entries.map((e) => e.lx), [20, 30]);
});

test("fast-path SoA: empty intersection returns null (FlatBuffers fallback applies)", () => {
  const wireIdOf = (eid: number): bigint => BigInt(eid);
  const zero = new Float64Array(4);
  assert.equal(
    encodeFastDeltaFromSoA(
      1,
      { eids: [1], wireIdOf, px: zero, py: zero, pz: zero },
      { eids: [2], wireIdOf, lx: zero, ly: zero, lz: zero },
    ),
    null,
  );
  assert.equal(
    encodeFastDeltaFromSoA(
      1,
      { eids: [], wireIdOf, px: zero, py: zero, pz: zero },
      { eids: [], wireIdOf, lx: zero, ly: zero, lz: zero },
    ),
    null,
  );
});

test("fast-path SoA: output equals the row encoder for the same entries", () => {
  const wireIdOf = (eid: number): bigint => BigInt(eid * 7 + 1);
  const col = (v: number): Float64Array => {
    const a = new Float64Array(3);
    a.fill(v);
    return a;
  };
  const soa = encodeFastDeltaFromSoA(
    11,
    { eids: [0, 1, 2], wireIdOf, px: col(1), py: col(2), pz: col(3) },
    { eids: [2, 1, 0], wireIdOf, lx: col(4), ly: col(5), lz: col(6) },
  );
  const row = encodeFastDelta(11, [0, 1, 2].map((eid) => ({
    wireId: wireIdOf(eid), px: 1, py: 2, pz: 3, lx: 4, ly: 5, lz: 6,
  })));
  assert.ok(soa);
  assert.deepEqual([...soa!], [...row]);
});
