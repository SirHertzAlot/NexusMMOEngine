/**
 * Motion Grammar (CF1): primitives, recipe timing, pooling, budget, hitstop.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MotionSystem, compileRecipe, lerpFollow, makeOut, springStep, type Recipe } from "../src/motion/index.js";

const POP: Recipe = { steps: [{ p: "pop", ms: 100, overshoot: 1.5, from: 0 }] };

describe("recipes", () => {
  it("rejects an unknown primitive and times steps in sequence or parallel", () => {
    assert.throws(() => compileRecipe({ steps: [{ p: "nope" }] }), /unknown primitive/);
    const c = compileRecipe({ steps: [{ p: "pop", ms: 100 }, { p: "flash", ms: 50, parallel: true }, { p: "shake", ms: 200 }, { p: "wipe", ms: 10, at: 500 }] });
    assert.deepEqual(c.start, [0, 0, 100, 500]);
    assert.equal(c.total, 510);
    assert.equal(compileRecipe({ steps: [{ p: "sineIdle" }] }).total, Infinity);
  });
});

describe("MotionSystem", () => {
  it("pops from 0, overshoots, settles at 1, then retires", () => {
    const m = new MotionSystem(4);
    const o = makeOut();
    const h = m.start(POP);
    m.sample(h, o);
    assert.equal(o.scale, 0);
    m.tick(0.06);
    m.sample(h, o);
    assert.ok(Math.abs(o.scale - 1.5) < 1e-9, `peak ${o.scale}`);
    m.tick(0.05);
    assert.equal(m.sample(h, o), false);
    assert.equal(o.scale, 1);
    assert.equal(m.activeCount, 0);
  });

  it("staggers by index and holds the pop's first frame until it starts", () => {
    const m = new MotionSystem(4);
    const o = makeOut();
    const h = m.start({ ...POP, staggerMs: 100 }, { index: 2 });
    m.tick(0.15);
    assert.ok(m.sample(h, o));
    assert.equal(o.scale, 0);
    m.tick(0.15);
    m.sample(h, o);
    assert.ok(o.scale > 0.9);
  });

  it("sheds beyond the budget and below the quality tier, and stale handles are dead", () => {
    const m = new MotionSystem(2);
    const idle: Recipe = { steps: [{ p: "sineIdle" }] };
    const a = m.start(idle);
    m.start(idle);
    assert.equal(m.start(idle), -1);
    m.stop(a);
    assert.equal(m.sample(a, makeOut()), false);
    m.minPriority = 2;
    assert.equal(m.start(idle, { priority: 1 }), -1);
    assert.ok(m.start(idle, { priority: 2 }) >= 0);
    assert.equal(m.shed, 2);
  });

  it("loops idle forever until stopped", () => {
    const m = new MotionSystem(2);
    const o = makeOut();
    const h = m.start({ steps: [{ p: "sineIdle", amp: 2, freq: 1 }] });
    m.tick(10.25);
    assert.ok(m.sample(h, o));
    assert.ok(Math.abs(o.dy - 2) < 1e-6, `quarter cycle ${o.dy}`);
  });

  it("hitstop freezes the clocks for its duration, once", () => {
    const m = new MotionSystem(2);
    const h = m.start({ steps: [{ p: "hitstop", ms: 70 }, { p: "flash", ms: 100 }] });
    m.tick(0.001);
    assert.equal(m.timeScale, 0);
    m.tick(0.05);
    assert.equal(m.timeScale, 0);
    m.tick(0.03);
    assert.equal(m.timeScale, 1);
    m.tick(0.001);
    assert.equal(m.timeScale, 1, "does not re-fire");
    assert.ok(m.sample(h, makeOut()));
  });

  it("combines steps: scales multiply, offsets add, flash takes the max", () => {
    const m = new MotionSystem(2);
    const o = makeOut();
    const h = m.start({ steps: [{ p: "punch", ms: 100, amp: 1 }, { p: "flash", ms: 100, parallel: true }, { p: "anticipation", ms: 100, parallel: true, amount: 10 }] });
    m.sample(h, o);
    assert.equal(o.scale, 2);
    assert.equal(o.flash, 1);
    m.tick(0.05);
    m.sample(h, o);
    assert.ok(Math.abs(o.dy - 10) < 1e-9);
  });
});

describe("followers", () => {
  it("lerpFollow is frame-rate independent", () => {
    let a = 0, b = 0;
    for (let i = 0; i < 60; i++) a = lerpFollow(a, 1, 5, 1 / 60);
    for (let i = 0; i < 30; i++) b = lerpFollow(b, 1, 5, 1 / 30);
    assert.ok(Math.abs(a - b) < 1e-9);
  });

  it("a damped spring settles on its target and stays finite at a long step", () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 300; i++) springStep(s, 1, 120, 14, 1 / 60);
    assert.ok(Math.abs(s.x - 1) < 1e-3);
    springStep(s, 5, 120, 14, 0.5);
    assert.ok(Number.isFinite(s.x));
  });
});
