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

test("stepSimulation() zero-copy SAB matrix integrates alive entities and skips dead entities (HP <= 0)", () => {
  const STRIDE = 8;
  const count = 4;
  const sab = new SharedArrayBuffer(count * STRIDE * 4);
  const floatMatrix = new Float32Array(sab);
  const intMatrix = new Int32Array(sab);

  // Entity 0: alive (HP = 100), pos=(1,2,3), vel=(10,20,30)
  floatMatrix[0] = 1; floatMatrix[1] = 2; floatMatrix[2] = 3;
  floatMatrix[3] = 10; floatMatrix[4] = 20; floatMatrix[5] = 30;
  intMatrix[6] = 100; intMatrix[7] = 0;

  // Entity 1: dead (HP = 0), pos=(5,6,7), vel=(50,60,70) -> must not move
  floatMatrix[8 + 0] = 5; floatMatrix[8 + 1] = 6; floatMatrix[8 + 2] = 7;
  floatMatrix[8 + 3] = 50; floatMatrix[8 + 4] = 60; floatMatrix[8 + 5] = 70;
  intMatrix[8 + 6] = 0; intMatrix[8 + 7] = 1;

  // Entity 2: dead (HP = -10), pos=(-1,-2,-3), vel=(10,10,10) -> must not move
  floatMatrix[16 + 0] = -1; floatMatrix[16 + 1] = -2; floatMatrix[16 + 2] = -3;
  floatMatrix[16 + 3] = 10; floatMatrix[16 + 4] = 10; floatMatrix[16 + 5] = 10;
  intMatrix[16 + 6] = -10; intMatrix[16 + 7] = 0;

  // Entity 3: alive (HP = 50), pos=(0,0,0), vel=(-4, 8, -12)
  floatMatrix[24 + 0] = 0; floatMatrix[24 + 1] = 0; floatMatrix[24 + 2] = 0;
  floatMatrix[24 + 3] = -4; floatMatrix[24 + 4] = 8; floatMatrix[24 + 5] = -12;
  intMatrix[24 + 6] = 50; intMatrix[24 + 7] = 3;

  const ok = addon.stepSimulation(floatMatrix, count, 0.5);
  assert.equal(ok, true);

  // Entity 0 moved: (1+5, 2+10, 3+15) = (6, 12, 18)
  assert.equal(floatMatrix[0], 6);
  assert.equal(floatMatrix[1], 12);
  assert.equal(floatMatrix[2], 18);

  // Entity 1 untouched
  assert.equal(floatMatrix[8 + 0], 5);
  assert.equal(floatMatrix[8 + 1], 6);
  assert.equal(floatMatrix[8 + 2], 7);

  // Entity 2 untouched
  assert.equal(floatMatrix[16 + 0], -1);
  assert.equal(floatMatrix[16 + 1], -2);
  assert.equal(floatMatrix[16 + 2], -3);

  // Entity 3 moved: (-2, 4, -6)
  assert.equal(floatMatrix[24 + 0], -2);
  assert.equal(floatMatrix[24 + 1], 4);
  assert.equal(floatMatrix[24 + 2], -6);
});

test("stepSimulationSoA() branchless SIMD matches stepSimulation() bit-identically across mixed alive/dead entities", () => {
  const n = 35; // non-multiple of 4 to test SIMD loop + scalar tail
  const STRIDE = 8;
  const sab = new SharedArrayBuffer(n * STRIDE * 4);
  const floatMatrix = new Float32Array(sab);
  const intMatrix = new Int32Array(sab);

  const px = new Float32Array(new SharedArrayBuffer(n * 4));
  const py = new Float32Array(new SharedArrayBuffer(n * 4));
  const pz = new Float32Array(new SharedArrayBuffer(n * 4));
  const vx = new Float32Array(new SharedArrayBuffer(n * 4));
  const vy = new Float32Array(new SharedArrayBuffer(n * 4));
  const vz = new Float32Array(new SharedArrayBuffer(n * 4));
  const hp = new Int32Array(new SharedArrayBuffer(n * 4));

  for (let i = 0; i < n; i++) {
    const base = i * STRIDE;
    const x = i * 1.25 - 10;
    const y = i * -0.5;
    const z = (i % 5) * 3.0;
    const lx = (i % 7) - 3;
    const ly = (i % 3) * 0.75;
    const lz = -(i * 0.25);
    const health = i % 3 === 0 ? 0 : i % 5 === 0 ? -5 : 100;

    floatMatrix[base + 0] = px[i] = x;
    floatMatrix[base + 1] = py[i] = y;
    floatMatrix[base + 2] = pz[i] = z;
    floatMatrix[base + 3] = vx[i] = lx;
    floatMatrix[base + 4] = vy[i] = ly;
    floatMatrix[base + 5] = vz[i] = lz;
    intMatrix[base + 6] = hp[i] = health;
  }

  const dt = 1 / 30;
  for (let t = 0; t < 15; t++) {
    assert.equal(addon.stepSimulation(floatMatrix, n, dt), true);
    assert.equal(addon.stepSimulationSoA(px, py, pz, vx, vy, vz, hp, n, dt), true);
  }

  for (let i = 0; i < n; i++) {
    const base = i * STRIDE;
    assert.equal(px[i], floatMatrix[base + 0], `px mismatch at ${i}`);
    assert.equal(py[i], floatMatrix[base + 1], `py mismatch at ${i}`);
    assert.equal(pz[i], floatMatrix[base + 2], `pz mismatch at ${i}`);
  }
});

test("applyIntentsAndStep() decodes INTENT_BIT flags into velocity and integrates in one pass", () => {
  const STRIDE = 8;
  const sab = new SharedArrayBuffer(2 * STRIDE * 4);
  const floatMatrix = new Float32Array(sab);
  const intMatrix = new Int32Array(sab);

  // Entity 0: alive, intent = Forward (1) | Right (8) | Sprint (64)
  intMatrix[6] = 100;
  intMatrix[7] = (1 << 0) | (1 << 3) | (1 << 6);

  // Entity 1: alive, intent = Left (4) |Backward (2)
  intMatrix[8 + 6] = 100;
  intMatrix[8 + 7] = (1 << 2) | (1 << 1);

  assert.equal(addon.applyIntentsAndStep(floatMatrix, 2, 0.5, 4.0), true);
  // Entity 0: sprint speed = 8.0 -> vx = +8, vz = +8 -> pos = (4, 0, 4)
  assert.equal(floatMatrix[3], 8);
  assert.equal(floatMatrix[5], 8);
  assert.equal(floatMatrix[0], 4);
  assert.equal(floatMatrix[2], 4);

  // Entity 1: base speed = 4.0 -> vx = -4, vz = -4 -> pos = (-2, 0, -2)
  assert.equal(floatMatrix[8 + 3], -4);
  assert.equal(floatMatrix[8 + 5], -4);
  assert.equal(floatMatrix[8 + 0], -2);
  assert.equal(floatMatrix[8 + 2], -2);
});

test("engine_kernel.node binary loads and exposes stepSimulation", () => {
  const kernel = require("../build/Release/engine_kernel.node");
  assert.equal(typeof kernel.stepSimulation, "function");
  const sab = new SharedArrayBuffer(8 * 4);
  const f32 = new Float32Array(sab);
  const i32 = new Int32Array(sab);
  f32[3] = 2;
  i32[6] = 10;
  assert.equal(kernel.stepSimulation(f32, 1, 0.5), true);
  assert.equal(f32[0], 1);
});

