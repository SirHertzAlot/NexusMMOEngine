/** Break pieces (DE2): the pooled simulation. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEBRIS_LIFE_S, DebrisSim, piecesFor } from "../src/render/debris-sim.js";

const run = (s: DebrisSim, seconds: number, ground = (): number => 0): void => {
  for (let t = 0; t < seconds; t += 1 / 60) s.step(1 / 60, ground);
};

describe("DebrisSim", () => {
  it("throws pieces from inside the prop, upward, and they fall back to the ground", () => {
    const s = new DebrisSim(16, 3);
    s.burst(10, 0, 5, 0.5, 0.5, 0.5, 6, 0xaa8844);
    assert.equal(s.alive(), 6);
    for (let k = 0; k < 6; k++) assert.ok(Math.abs(s.px[k]! - 10) <= 0.5 && s.py[k]! >= 0 && s.py[k]! <= 1);
    run(s, 2);
    for (let k = 0; k < 6; k++) assert.ok(Math.abs(s.py[k]! - s.half[k]!) < 1e-3, "a piece lies on the ground by its own size");
  });
  it("rests on uneven ground, not at zero", () => {
    const s = new DebrisSim(8, 3);
    s.burst(0, 2, 0, 0.4, 0.4, 0.4, 4, 0xffffff);
    run(s, 3, () => 2);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(s.py[k]! - (2 + s.half[k]!)) < 1e-3);
  });
  it("is gone after its life and shrinks through the last second", () => {
    const s = new DebrisSim(4, 3);
    s.burst(0, 0, 0, 0.3, 0.3, 0.3, 1, 1);
    assert.equal(s.scaleOf(0), 1);
    run(s, DEBRIS_LIFE_S - 0.5);
    assert.ok(s.scaleOf(0) > 0 && s.scaleOf(0) < 1);
    run(s, 1);
    assert.equal(s.alive(), 0);
    assert.equal(s.scaleOf(0), 0);
  });
  it("overwrites the oldest when full, never growing", () => {
    const s = new DebrisSim(5, 3);
    s.burst(0, 0, 0, 0.3, 0.3, 0.3, 12, 1);
    assert.equal(s.alive(), 5);
  });
  it("is the same for the same seed", () => {
    const a = new DebrisSim(6, 9);
    const b = new DebrisSim(6, 9);
    a.burst(1, 0, 1, 0.5, 0.5, 0.5, 6, 1);
    b.burst(1, 0, 1, 0.5, 0.5, 0.5, 6, 1);
    run(a, 1);
    run(b, 1);
    assert.deepEqual([...a.px], [...b.px]);
  });
  it("sizes pieces from the prop: small for a crate, bigger for a hut, never a speck or a boulder", () => {
    const small = new DebrisSim(4, 3);
    small.burst(0, 0, 0, 0.3, 0.3, 0.3, 4, 1);
    const big = new DebrisSim(4, 3);
    big.burst(0, 0, 0, 3, 2, 3, 4, 1);
    assert.ok(big.half[0]! > small.half[0]!);
    for (const s of [small, big]) for (let k = 0; k < 4; k++) assert.ok(s.half[k]! >= 0.01 && s.half[k]! <= 0.3);
  });
});

describe("piecesFor", () => {
  it("gives a few for a crate and more for a hut, within bounds", () => {
    assert.ok(piecesFor(1.5, 1.5, 1.5) > piecesFor(0.3, 0.3, 0.3));
    assert.equal(piecesFor(0.01, 0.01, 0.01), 5);
    assert.equal(piecesFor(20, 20, 20), 14);
  });
});
