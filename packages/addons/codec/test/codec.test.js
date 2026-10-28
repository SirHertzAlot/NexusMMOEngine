const test = require("node:test");
const assert = require("node:assert/strict");
const addon = require("../index.js");

const f32 = (v) => Math.fround(v);

const ENTRIES = [
  { wireId: 1n, px: 1.5, py: -2.25, pz: 0, lx: 4, ly: 5, lz: 6 },
  { wireId: 0x123456789abcdef0n, px: 100.25, py: 0.5, pz: -300.75, lx: -1, ly: 0, lz: 2.5 },
  { wireId: 18446744073709551615n, px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 },
];

test("addon-codec: export constants match spec", () => {
  assert.equal(addon.FAST_PATH_MAGIC, 0x46);
  assert.equal(addon.FAST_PATH_VERSION, 1);
  assert.equal(addon.FAST_PATH_HEADER_BYTES, 12);
  assert.equal(addon.FAST_PATH_RECORD_BYTES, 32);
});

test("addon-codec: encodeFastDelta / decodeFastDelta round-trips exactly", () => {
  const bytes = addon.encodeFastDelta(42, ENTRIES);
  assert.equal(bytes.length, 12 + ENTRIES.length * 32);

  const { tick, entries } = addon.decodeFastDelta(bytes);
  assert.equal(tick, 42);
  assert.equal(entries.length, ENTRIES.length);

  for (let i = 0; i < ENTRIES.length; i++) {
    assert.equal(entries[i].wireId, ENTRIES[i].wireId);
    for (const k of ["px", "py", "pz", "lx", "ly", "lz"]) {
      assert.equal(entries[i][k], f32(ENTRIES[i][k]));
    }
  }
});

test("addon-codec: empty entries payload", () => {
  const bytes = addon.encodeFastDelta(9, []);
  assert.equal(bytes.length, 12);
  const { tick, entries } = addon.decodeFastDelta(bytes);
  assert.equal(tick, 9);
  assert.deepEqual(entries, []);
});

test("addon-codec: reject unknown version", () => {
  const bytes = addon.encodeFastDelta(1, ENTRIES);
  const v2 = new Uint8Array(bytes);
  v2[1] = 2;

  assert.throws(() => addon.decodeFastDelta(v2), /unsupported version 2/);
  const tried = addon.tryDecodeFastDelta(v2);
  assert.equal(tried.ok, false);
  assert.match(tried.reason, /unsupported version 2/);
});

test("addon-codec: reject bad magic, short buffer, trailing bytes", () => {
  const bytes = addon.encodeFastDelta(1, ENTRIES);

  const badMagic = new Uint8Array(bytes);
  badMagic[0] = 0x00;
  assert.throws(() => addon.decodeFastDelta(badMagic), /bad magic/);

  assert.throws(() => addon.decodeFastDelta(bytes.slice(0, 5)), /short buffer/);

  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  assert.throws(() => addon.decodeFastDelta(trailing), /length mismatch/);
});

test("addon-codec: encodeFastDeltaFromSoA intersection encoding", () => {
  const transforms = {
    eids: [0, 1, 2],
    wireIdOf: (eid) => BigInt(eid + 100),
    px: new Float64Array([10, 20, 30]),
    py: new Float64Array([11, 21, 31]),
    pz: new Float64Array([12, 22, 32]),
  };
  const velocities = {
    eids: [1, 2, 3],
    wireIdOf: (eid) => BigInt(eid + 100),
    lx: new Float64Array([1, 2, 3]),
    ly: new Float64Array([4, 5, 6]),
    lz: new Float64Array([7, 8, 9]),
  };

  const bytes = addon.encodeFastDeltaFromSoA(77, transforms, velocities);
  assert.ok(bytes !== null);
  const decoded = addon.decodeFastDelta(bytes);
  assert.equal(decoded.tick, 77);
  // Intersection is eids [1, 2] -> 2 entries
  assert.equal(decoded.entries.length, 2);
  assert.equal(decoded.entries[0].wireId, 101n);
  assert.equal(decoded.entries[0].px, 20);
  assert.equal(decoded.entries[0].lx, 2);
  assert.equal(decoded.entries[1].wireId, 102n);
  assert.equal(decoded.entries[1].px, 30);
  assert.equal(decoded.entries[1].lx, 3);
});
