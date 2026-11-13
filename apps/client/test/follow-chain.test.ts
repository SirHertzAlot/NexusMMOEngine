/**
 * Follow-chains (CF4): the sim, the LOD, the ribbon and the budget.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_RECIPES, Chain, ChainBudget, buildRibbon, lodPoints, ribbonIndices, stepChain } from "../src/render/follow-chain.js";

const R = CHAIN_RECIPES.hair!;
const DOWN = [0, -1, 0];
const seg = (c: Chain, i: number) => Math.hypot(c.pos[i * 3]! - c.pos[i * 3 - 3]!, c.pos[i * 3 + 1]! - c.pos[i * 3 - 2]!, c.pos[i * 3 + 2]! - c.pos[i * 3 - 1]!);

describe("chain sim", () => {
  it("hangs at rest along its direction, one leash per segment", () => {
    const c = new Chain(R.points);
    c.reset(R, [0, 2, 0], DOWN);
    for (let i = 0; i < 240; i++) stepChain(c, R, R.points, [0, 2, 0], DOWN, 1 / 60);
    for (let i = 1; i < R.points; i++) assert.ok(seg(c, i) <= R.leash + 1e-9, `segment ${i}`);
    assert.ok(c.pos[(R.points - 1) * 3 + 1]! < 2 - R.leash * 2, "tip hangs below the anchor");
    assert.ok(Math.abs(c.pos[(R.points - 1) * 3]!) < 0.02, "and stays under it");
  });

  it("lags behind a moving anchor, never stretches past the leash, then catches up", () => {
    const c = new Chain(R.points);
    c.reset(R, [0, 2, 0], DOWN);
    let x = 0;
    for (let i = 0; i < 60; i++) {
      x += 0.08; // 4.8 m/s
      stepChain(c, R, R.points, [x, 2, 0], DOWN, 1 / 60);
      for (let k = 1; k < R.points; k++) assert.ok(seg(c, k) <= R.leash + 1e-9);
    }
    const tip = (R.points - 1) * 3;
    assert.ok(x - c.pos[tip]! > R.leash, `tip trails the anchor by ${x - c.pos[tip]!}`);
    for (let i = 0; i < 240; i++) stepChain(c, R, R.points, [x, 2, 0], DOWN, 1 / 60);
    assert.ok(Math.abs(c.pos[tip]! - x) < 0.02, "catches up when the anchor stops");
  });

  it("stays finite at a long frame", () => {
    const c = new Chain(R.points);
    c.reset(R, [0, 2, 0], DOWN);
    stepChain(c, R, R.points, [5, 2, 0], DOWN, 2);
    assert.ok(c.pos.every(Number.isFinite));
  });
});

describe("lod and budget", () => {
  it("full near, shortened mid, hidden far", () => {
    assert.equal(lodPoints(R, 5), R.points);
    assert.equal(lodPoints(R, (R.lod.full + R.lod.mid) / 2), R.lod.midPoints);
    assert.equal(lodPoints(R, R.lod.mid + 1), 0);
  });

  it("admits the nearest chains up to the budget and counts what it shed", () => {
    const b = new ChainBudget();
    const got: number[] = [];
    b.begin();
    [[1, 30], [2, 5], [3, 12], [4, 2], [5, 40]].forEach(([id, d]) => b.offer(id!, d!));
    b.admit(3, (id) => got.push(id));
    assert.deepEqual(got.sort(), [2, 3, 4]);
    assert.equal(b.shed, 2);
    got.length = 0;
    b.begin();
    b.offer(9, 1);
    b.admit(3, (id) => got.push(id));
    assert.deepEqual(got, [9]);
    assert.equal(b.shed, 0);
  });
});

describe("budget at scale", () => {
  it("matches a full sort on random offers, including ties", () => {
    const b = new ChainBudget();
    for (let round = 0; round < 50; round++) {
      const n = 1 + Math.floor(Math.random() * 300);
      const ds = Array.from({ length: n }, () => Math.floor(Math.random() * 20));
      const max = Math.floor(Math.random() * (n + 5));
      b.begin();
      ds.forEach((d, i) => b.offer(i, d));
      const got: number[] = [];
      b.admit(max, (id) => got.push(id));
      const want = Math.min(max, n);
      assert.equal(got.length, want);
      assert.equal(new Set(got).size, want, "no id twice");
      const worstTaken = Math.max(-1, ...got.map((i) => ds[i]!));
      const best = [...ds].sort((x, y) => x - y)[want - 1] ?? -1;
      assert.equal(worstTaken, want === 0 ? -1 : best, "the nearest were taken");
    }
  });
});

describe("ribbon", () => {
  it("two vertices per point, tapering, facing the camera", () => {
    const c = new Chain(4);
    c.reset(R, [0, 2, 0], DOWN);
    const out = new Float32Array(4 * 6);
    assert.equal(buildRibbon(out, c, 4, [0.4, 0.1], [0, 1, 5]), 8);
    const wRoot = Math.hypot(out[3]! - out[0]!, out[4]! - out[1]!, out[5]! - out[2]!);
    const wTip = Math.hypot(out[21]! - out[18]!, out[22]! - out[19]!, out[23]! - out[20]!);
    assert.ok(Math.abs(wRoot - 0.4) < 1e-5 && Math.abs(wTip - 0.1) < 1e-5);
    assert.ok(out.every(Number.isFinite));
    assert.equal(ribbonIndices(4).length, 18);
  });
});
