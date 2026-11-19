/**
 * Interface choreography (CF3): focus, motifs, treatment chase, rarity, and
 * the two primitives it added to the Motion Grammar (fade, seeded idle).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THEME as T, itemOffset, moveFocus, newTreat, rarityStyle, stepTreat } from "../src/ui/choreo.js";
import { MotionSystem, makeOut } from "../src/motion/index.js";

describe("focus", () => {
  it("moves and wraps (or stops at the ends)", () => {
    assert.equal(moveFocus(0, 1, 3), 1);
    assert.equal(moveFocus(2, 1, 3), 0);
    assert.equal(moveFocus(0, -1, 3), 2);
    assert.equal(moveFocus(2, 1, 3, false), 2);
    assert.equal(moveFocus(-1, 1, 3), 0, "nothing focused: down picks the first");
    assert.equal(moveFocus(-1, -1, 3), 2, "nothing focused: up picks the last");
    assert.equal(moveFocus(0, 1, 0), -1);
  });
});

describe("motifs", () => {
  it("cascade steps along the diagonal, chevron peaks in the middle, stack is flat", () => {
    const step = { x: 10, y: 4 };
    assert.deepEqual(itemOffset("cascade", 2, 5, step), { x: 20, y: 8 });
    assert.deepEqual(itemOffset("stack", 2, 5, step), { x: 0, y: 0 });
    const xs = [0, 1, 2, 3, 4].map((i) => itemOffset("chevron", i, 5, step).x);
    assert.deepEqual(xs, [0, 10, 20, 10, 0]);
  });
});

describe("treatment", () => {
  it("chases focus, settles exactly, and reports when it stops moving", () => {
    const t = newTreat(false);
    assert.equal(stepTreat(t, true, T.focus.rate, 1 / 60), true);
    assert.ok(t.focus > 0 && t.focus < 1);
    for (let i = 0; i < 120; i++) stepTreat(t, true, T.focus.rate, 1 / 60);
    assert.equal(t.focus, 1);
    assert.equal(stepTreat(t, true, T.focus.rate, 1 / 60), false);
  });

  it("rarity picks a colour and sheen, unknown tiers fall back", () => {
    assert.equal(rarityStyle(T, "epic").color, T.rarity.epic!.color);
    assert.ok(rarityStyle(T, "epic").sheen > rarityStyle(T, "uncommon").sheen);
    assert.equal(rarityStyle(T, "mythic"), rarityStyle(T, undefined));
  });
});

describe("motion additions", () => {
  it("fade holds invisible until its turn, then reaches full opacity", () => {
    const m = new MotionSystem(2);
    const o = makeOut();
    const h = m.start({ staggerMs: 100, steps: [{ p: "fade", ms: 100 }, { p: "sineIdle", amp: 0 }] }, { index: 1 });
    m.sample(h, o);
    assert.equal(o.alpha, 0);
    m.tick(0.2);
    m.sample(h, o);
    assert.equal(o.alpha, 1);
  });

  it("seedPhase keeps two idling items out of step", () => {
    const m = new MotionSystem(4);
    const a = makeOut(), b = makeOut();
    const rec = { steps: [{ p: "sineIdle", amp: 2, freq: 1, seedPhase: 1.3 }] };
    const h1 = m.start(rec, { seed: 1 });
    const h2 = m.start(rec, { seed: 2 });
    m.tick(0.1);
    m.sample(h1, a);
    m.sample(h2, b);
    assert.notEqual(a.dy, b.dy);
  });
});
