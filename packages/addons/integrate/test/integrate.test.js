"use strict";
// Unit tests for @mmo-engine/addon-integrate (node:test, no framework).
// Covers: integrate correctness, noop callability, the C++ world
// round-trip, and kernel equivalence between harness A and harness B
// (same kernel, same inputs -> bit-identical outputs).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const addon = require("../index.js");

test("integrate() advances positions by velocity * dt", () => {
  const px = new Float32Array([0, 10]);
  const py = new Float32Array([0, 20]);
  const pz = new Float32Array([0, 30]);
  const vx = new Float32Array([1, -2]);
  const vy = new Float32Array([0.5, 0]);
  const vz = new Float32Array([-1, 4]);
  addon.integrate(px, py, pz, vx, vy, vz, 2, 0.5);
  // f32 arithmetic: compare against f32-rounded expectations.
  const f32 = (x) => new Float32Array([x])[0];
  assert.equal(px[0], f32(0 + 1 * 0.5));
  assert.equal(py[0], f32(0 + 0.5 * 0.5));
  assert.equal(pz[0], f32(0 + -1 * 0.5));
  assert.equal(px[1], f32(10 + -2 * 0.5));
  assert.equal(py[1], f32(20 + 0 * 0.5));
  assert.equal(pz[1], f32(30 + 4 * 0.5));
});

test("integrate() respects count < array length", () => {
  const px = new Float32Array([0, 0, 0]);
  const zeros = new Float32Array(3);
  const ones = new Float32Array([1, 1, 1]);
  addon.integrate(px, zeros, zeros, ones, zeros, zeros, 2, 1);
  assert.equal(px[0], 1);
  assert.equal(px[1], 1);
  assert.equal(px[2], 0); // untouched: beyond count
});

test("integrate() rejects bad input", () => {
  const ok = new Float32Array(4);
  assert.throws(() => addon.integrate(ok, ok, ok, ok, ok, ok, 4), TypeError);
  assert.throws(
    () => addon.integrate(ok, ok, ok, ok, ok, new Float64Array(4), 4, 1),
    TypeError,
  );
  assert.throws(() => addon.integrate(ok, ok, ok, ok, ok, ok, 99, 1), RangeError);
});

test("noop() is callable and returns undefined", () => {
  assert.equal(addon.noop(), undefined);
});

test("C++ world: createWorld/stepWorld/copyPositions round-trip", () => {
  const n = 16;
  const px = new Float32Array(n).fill(1);
  const py = new Float32Array(n).fill(2);
  const pz = new Float32Array(n).fill(3);
  const vx = new Float32Array(n).fill(0.5);
  const vy = new Float32Array(n).fill(-0.5);
  const vz = new Float32Array(n).fill(2);
  const h = addon.createWorld(px, py, pz, vx, vy, vz);
  assert.equal(addon.worldSize(h), n);
  const dt = 1 / 30;
  for (let t = 0; t < 10; t++) addon.stepWorld(h, dt);
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  const oz = new Float32Array(n);
  addon.copyPositions(h, ox, oy, oz);
  const f32 = (x) => new Float32Array([x])[0];
  // Reference computed in f64 then rounded to f32 per step is NOT
  // bit-identical to iterated f32 math; compare with a small epsilon.
  let expected = 1;
  for (let t = 0; t < 10; t++) expected = f32(expected + f32(0.5 * dt));
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(ox[i] - expected) < 1e-6, `ox[${i}] drifted`);
  }
});

test("harness A and B kernels agree bit-identically", () => {
  const n = 64;
  const mk = (fn) => Float32Array.from({ length: n }, (_, i) => fn(i));
  const px = mk((i) => i * 0.25 - 8);
  const py = mk((i) => i * -0.1);
  const pz = mk((i) => (i % 7) * 1.5);
  const vx = mk((i) => Math.sin(i) * 3);
  const vy = mk((i) => Math.cos(i * 0.7) * 3);
  const vz = mk((i) => (i % 3) - 1);
  // Harness B world takes a copy at creation; harness A mutates in place.
  const h = addon.createWorld(px, py, pz, vx, vy, vz);
  const dt = 1 / 30;
  for (let t = 0; t < 25; t++) {
    addon.integrate(px, py, pz, vx, vy, vz, n, dt); // A
    addon.stepWorld(h, dt); // B
  }
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  const oz = new Float32Array(n);
  addon.copyPositions(h, ox, oy, oz);
  assert.deepEqual(Array.from(ox), Array.from(px));
  assert.deepEqual(Array.from(oy), Array.from(py));
  assert.deepEqual(Array.from(oz), Array.from(pz));
});
