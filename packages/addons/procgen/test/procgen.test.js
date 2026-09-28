"use strict";
// Unit tests for @mmo-engine/addon-procgen (node:test, no framework).
// Covers: determinism (same inputs -> bit-identical output), seed/coords
// sensitivity, cross-process determinism, input validation, output sanity,
// seamless chunk borders, and the optional frequency argument.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const addon = require("../index.js");

const SEED = 0x123456789abcdef0n;

function genChunk(seed = SEED, cx = 3, cz = -7, lod = 0) {
  const out = new Float32Array(addon.CHUNK_SAMPLES);
  addon.generateChunk(seed, cx, cz, lod, out);
  return out;
}

// FNV-1a over the raw float bits — a compact exact-equality fingerprint.
function fingerprint(arr) {
  const u32 = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u32.length; i++) {
    h ^= u32[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

test("exports constants", () => {
  assert.equal(addon.CHUNK_SIZE, 16);
  assert.equal(addon.CHUNK_SAMPLES, 256);
  assert.equal(addon.MAX_LOD, 8);
  assert.match(addon.libraryInfo(), /FastNoise2/);
});

test("determinism: same inputs -> bit-identical output", () => {
  const a = genChunk();
  const b = genChunk();
  assert.deepStrictEqual(a, b);
  assert.equal(fingerprint(a), fingerprint(b));
});

test("determinism across process restarts", () => {
  const parent = fingerprint(genChunk());
  const child = execFileSync(
    process.execPath,
    [
      "-e",
      `
      const addon = require(${JSON.stringify(require.resolve("../index.js"))});
      const out = new Float32Array(addon.CHUNK_SAMPLES);
      addon.generateChunk(${SEED}n, 3, -7, 0, out);
      const u32 = new Uint32Array(out.buffer);
      let h = 0x811c9dc5;
      for (let i = 0; i < u32.length; i++) { h ^= u32[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      console.log(h.toString(16).padStart(8, "0"));
      `,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(child, parent);
});

test("different seeds -> different output", () => {
  const a = genChunk(SEED);
  const b = genChunk(SEED + 1n);
  assert.notDeepStrictEqual(a, b);
});

test("different coords -> different output", () => {
  const a = genChunk(SEED, 3, -7);
  const b = genChunk(SEED, 4, -7);
  const c = genChunk(SEED, 3, -6);
  assert.notDeepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
});

test("lod changes the sampling footprint", () => {
  const a = genChunk(SEED, 0, 0, 0);
  const b = genChunk(SEED, 0, 0, 1);
  assert.notDeepStrictEqual(a, b);
});

test("output sanity: bounded, non-constant", () => {
  const out = genChunk();
  let min = Infinity;
  let max = -Infinity;
  const seen = new Set();
  for (const v of out) {
    assert.ok(v >= -1 && v <= 1, `value out of Simplex range: ${v}`);
    if (v < min) min = v;
    if (v > max) max = v;
    seen.add(v);
  }
  assert.ok(seen.size > 200, `expected varied terrain, got ${seen.size} distinct values`);
  assert.ok(max - min > 0.5, `expected relief, got range ${max - min}`);
});

test("generateChunk rejects bad input", () => {
  const ok = new Float32Array(addon.CHUNK_SAMPLES);
  assert.throws(() => addon.generateChunk(123, 0, 0, 0, ok), TypeError); // seed not bigint
  assert.throws(() => addon.generateChunk(SEED, 0.5, 0, 0, ok), RangeError); // cx not int32
  assert.throws(() => addon.generateChunk(SEED, 0, 0, 9, ok), RangeError); // lod > MAX_LOD
  assert.throws(() => addon.generateChunk(SEED, 0, 0, -1, ok), RangeError); // lod negative
  assert.throws(
    () => addon.generateChunk(SEED, 0, 0, 0, new Float64Array(256)),
    TypeError,
  );
  assert.throws(
    () => addon.generateChunk(SEED, 0, 0, 0, new Float32Array(255)),
    RangeError,
  );
  assert.throws(() => addon.generateChunk(SEED, 0, 0, 0), TypeError);
});

test("adjacent chunks share border samples bit-for-bit (seamless tiling)", () => {
  // Sample 15 of chunk cx and sample 0 of chunk cx+1 are the same
  // integer noise coordinate, so heights must be identical — including
  // negative coordinates, both axes, and a non-default frequency.
  for (const freq of [undefined, 0.07]) {
    for (let cx = -3; cx <= 2; cx++) {
      for (let cz = -3; cz <= 2; cz++) {
        const gen = (x, z) => {
          const out = new Float32Array(addon.CHUNK_SAMPLES);
          addon.generateChunk(SEED, x, z, 0, out, freq);
          return out;
        };
        const c = gen(cx, cz);
        const east = gen(cx + 1, cz);
        const south = gen(cx, cz + 1);
        for (let k = 0; k < 16; k++) {
          assert.equal(c[k * 16 + 15], east[k * 16]);
          assert.equal(c[15 * 16 + k], south[k]);
        }
      }
    }
  }
});

test("frequency: optional, validated, and shapes the terrain", () => {
  assert.equal(typeof addon.DEFAULT_FREQUENCY, "number");
  const omitted = genChunk();
  const explicit = new Float32Array(addon.CHUNK_SAMPLES);
  addon.generateChunk(SEED, 3, -7, 0, explicit, addon.DEFAULT_FREQUENCY);
  assert.deepStrictEqual(omitted, explicit);

  const broad = new Float32Array(addon.CHUNK_SAMPLES);
  addon.generateChunk(SEED, 3, -7, 0, broad, 0.002);
  assert.notDeepStrictEqual(omitted, broad);

  const ok = new Float32Array(addon.CHUNK_SAMPLES);
  for (const bad of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => addon.generateChunk(SEED, 0, 0, 0, ok, bad), RangeError);
  }
  assert.throws(() => addon.generateChunk(SEED, 0, 0, 0, ok, "0.1"), TypeError);
});

test("output stays strictly inside (-1, 1) across a wide area", () => {
  // The raw fractal exceeds [-1, 1]; the soft-clip must keep every sample
  // inside without flattening peaks into clamped plateaus.
  const out = new Float32Array(addon.CHUNK_SAMPLES);
  let atBound = 0;
  for (let cx = -12; cx < 12; cx++) {
    for (let cz = -12; cz < 12; cz++) {
      addon.generateChunk(SEED, cx, cz, 0, out);
      for (const v of out) {
        assert.ok(v > -1 && v < 1, `sample ${v} outside (-1, 1)`);
        if (Math.abs(v) > 0.999) atBound++;
      }
    }
  }
  assert.equal(atBound, 0, "no clamped plateaus");
});
