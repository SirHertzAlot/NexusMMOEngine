/**
 * Correctness tests for the slice-1.5 benchmark harnesses (node:test).
 *
 * Fast checks (small N, few ticks) that harness A (bitECS + C++ integrate
 * addon) and harness B (pure C++ world) agree bit-exactly and that the
 * integration actually moves entities. The full benchmark (`npm run bench`)
 * repeats the exactness check at 1k/10k/100k.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addon,
  DT,
  maxPositionDiff,
  setupHarnessA,
  setupHarnessB,
} from "../src/harness.js";

describe("benchmark harness correctness", () => {
  it("A and B agree bit-exactly after 20 ticks (n=200)", () => {
    const a = setupHarnessA(200, 1337);
    const b = setupHarnessB(a.arrays);
    for (let t = 0; t < 20; t++) {
      a.tick();
      b.tick();
    }
    assert.equal(maxPositionDiff(a.arrays, b.readPositions()), 0);
  });

  it("integration actually moves entities", () => {
    const a = setupHarnessA(50, 42);
    const before = a.arrays.px.slice();
    a.tick();
    let moved = 0;
    for (let i = 0; i < before.length; i++) {
      if (a.arrays.px[i] !== before[i]) moved++;
    }
    // Velocities are drawn from [-20, 20]; P(all ~0) is nil.
    assert.ok(moved > 40, `only ${moved}/50 entities moved`);
  });

  it("one tick advances px by vx*dt exactly (spot check)", () => {
    const a = setupHarnessA(10, 7);
    const i = 3;
    const px0 = a.arrays.px[i];
    const vx = a.arrays.vx[i];
    a.tick();
    const expected = new Float32Array([px0 + vx * DT])[0];
    assert.equal(a.arrays.px[i], expected);
  });

  it("empty N-API call overhead is sane (< 10 us/call)", () => {
    const CALLS = 10_000;
    for (let i = 0; i < 100; i++) addon.noop();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < CALLS; i++) addon.noop();
    const nsPerCall = Number(process.hrtime.bigint() - t0) / CALLS;
    assert.ok(nsPerCall < 10_000, `${nsPerCall} ns/call exceeds 10 us`);
  });
});
