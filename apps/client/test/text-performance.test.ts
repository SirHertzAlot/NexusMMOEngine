/**
 * Text performance (CF5): markup, glossary, the punctuation clock, the glyph poses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PERFORM as R, LinePerformance, glossaryFrom, glyphPose, schedule, type GlyphPose } from "../src/ui/text-performance.js";

const text = (s: string) => schedule(s).glyphs.map((g) => g.ch).join("");

describe("tokenise", () => {
  it("reads [shake] [wave] [pause] and leaves other brackets as text", () => {
    const g = schedule("a[shake]b[/shake][wave]c[/wave]d [see] e").glyphs;
    assert.equal(g.map((x) => x.ch).join(""), "abcd [see] e");
    assert.deepEqual(g.slice(0, 4).map((x) => [x.shake, x.wave]), [[false, false], [true, false], [false, true], [false, false]]);
    assert.equal(text("[pause=300]hi"), "hi");
    assert.equal(text("[pause=99999999]x"), "[pause=99999999]x", "a runaway pause is not a tag");
  });

  it("colours glossary terms: whole words, any case, the longest first, never twice", () => {
    const terms = [{ term: "rusty sword", tone: "item" }, { term: "sword", tone: "omen" }, { term: "ash", tone: "place" }];
    const g = schedule("A Rusty Sword, a sword, a swordsman, ash and splash.", R, terms).glyphs;
    const toneOf = (from: number, len: number) => new Set(g.slice(from, from + len).map((x) => x.tone));
    const s = g.map((x) => x.ch).join("");
    assert.deepEqual([...toneOf(s.indexOf("Rusty"), 11)], ["item"], "the longer term wins");
    assert.deepEqual([...toneOf(s.indexOf("sword,"), 5)], ["omen"]);
    assert.deepEqual([...toneOf(s.indexOf("swordsman"), 9)], [undefined], "not inside another word");
    assert.deepEqual([...toneOf(s.indexOf("ash and"), 3)], ["place"]);
    assert.deepEqual([...toneOf(s.indexOf("splash"), 6)], [undefined]);
  });

  it("builds terms from quest, item, person and place names, skipping the very short", () => {
    const t = glossaryFrom({ quests: ["Wolves at the Gate"], items: ["Ox", "Iron ingot"], people: ["Warden Hale"] });
    assert.deepEqual(t.map((x) => `${x.tone}:${x.term}`), ["quest:Wolves at the Gate", "item:Iron ingot", "person:Warden Hale"]);
  });
});

describe("schedule", () => {
  const gap = (s: string, i: number) => { const { glyphs } = schedule(s); return glyphs[i + 1]!.at - glyphs[i]!.at; };
  const step = 1000 / R.cps;
  it("types at the rate, a space a little quicker", () => {
    assert.ok(Math.abs(gap("abc", 0) - step) < 1e-9);
    assert.ok(Math.abs(gap("a b", 0) - step) < 1e-9, "the glyph before a space takes a full step");
    assert.ok(Math.abs(gap("a b", 1) - step * 0.6) < 1e-9, "the space itself is quicker");
  });
  it("waits longer at a comma, longer at a sentence end, longest at an ellipsis", () => {
    assert.ok(Math.abs(gap("Hi, you", 2) - (step + R.dwell.minor)) < 1e-9);
    assert.ok(Math.abs(gap("Hi. You", 2) - (step + R.dwell.major)) < 1e-9);
    assert.ok(Math.abs(gap("Hi... you", 4) - (step + R.dwell.ellipsis)) < 1e-9, "after the third dot");
    assert.ok(Math.abs(gap("Hi... you", 2) - step) < 1e-9, "not between the dots");
    assert.ok(Math.abs(gap("Hi… you", 2) - (step + R.dwell.ellipsis)) < 1e-9);
  });
  it("does not stop inside a number or an abbreviation", () => {
    assert.ok(Math.abs(gap("3.5 gold", 1) - step) < 1e-9);
    assert.ok(Math.abs(gap("e.g. so", 1) - step) < 1e-9);
  });
  it("adds a [pause], and an instant line is all there at once with no effects", () => {
    assert.ok(schedule("a[pause=400]b").glyphs[1]!.at - schedule("a[pause=400]b").glyphs[0]!.at > 400);
    const i = schedule("a[shake]bc[/shake]", R, [], true);
    assert.equal(i.total, 0);
    assert.ok(i.glyphs.every((g) => g.at === 0 && !g.shake));
  });
});

describe("LinePerformance", () => {
  it("emits glyphs as the clock passes them and reports how many each step", () => {
    const { glyphs, total } = schedule("abcdef");
    const p = new LinePerformance(glyphs, total);
    assert.equal(p.shown, 1, "the first glyph is at 0");
    const n = p.advance(1000 / R.cps * 2.5);
    assert.equal(n, 2);
    assert.equal(p.done, false);
    p.complete();
    assert.equal(p.shown, glyphs.length);
    assert.equal(p.done, true);
  });
  it("speaks while a visible glyph was just emitted, not across a space, and not once done", () => {
    const { glyphs, total } = schedule("ab  cd");
    const p = new LinePerformance(glyphs, total);
    p.advance(10);
    assert.equal(p.speaking, true);
    p.advance(1000 / R.cps * 2.2); // on the spaces: the last visible glyph is older than flapMs
    p.advance(R.flapMs);
    assert.equal(p.speaking, false);
    p.complete();
    assert.equal(p.speaking, false);
  });
});

describe("glyphPose", () => {
  const into = (): GlyphPose => ({ opacity: 0, scale: 1, dx: 0, dy: 0 });
  const g = (o: Partial<{ shake: boolean; wave: boolean }> = {}) => ({ ch: "a", at: 100, shake: false, wave: false, ...o });
  it("is hidden before its turn, pops in, and settles at 1", () => {
    assert.equal(glyphPose(g(), 0, 50, R, into()).opacity, 0);
    const mid = glyphPose(g(), 0, 100 + R.pop.ms * 0.6, R, into());
    assert.ok(mid.opacity === 1 && Math.abs(mid.scale - R.pop.overshoot) < 1e-9, `peak ${mid.scale}`);
    assert.equal(glyphPose(g(), 0, 100 + R.pop.ms + 1, R, into()).scale, 1);
  });
  it("shakes within its amplitude and waves with its neighbours out of step", () => {
    for (let t = 200; t < 2000; t += 37) {
      const p = glyphPose(g({ shake: true }), 3, t, R, into());
      assert.ok(Math.abs(p.dx) <= R.shake.amp && Math.abs(p.dy) <= R.shake.amp);
    }
    const a = glyphPose(g({ wave: true }), 0, 500, R, into()).dy;
    const b = glyphPose(g({ wave: true }), 1, 500, R, into()).dy;
    assert.notEqual(a, b);
    assert.ok(Math.abs(a) <= R.wave.amp && Math.abs(b) <= R.wave.amp);
  });
});
