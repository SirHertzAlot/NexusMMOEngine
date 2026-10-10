import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FRAME_DELTA_MS,
  MAX_STEPS_PER_FRAME,
  STEP_MS,
  TickLoop,
} from "../src/index.js";

test("first frame only arms the clock", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  assert.equal(loop.frame(1000), 0);
  assert.deepEqual(ticks, []);
  assert.equal(loop.stats().ticks, 0);
});

test("accumulator converts frame deltas into whole ticks", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(0);
  assert.equal(loop.frame(STEP_MS * 1.5), 1); // 1 tick, 0.5 step carried
  assert.equal(loop.frame(STEP_MS * 2.5), 1); // 0.5 carried + 1.0 = 1.5 -> 1
  assert.equal(loop.frame(STEP_MS * 3.0), 1); // 0.5 carried + 0.5 = 1.0 -> 1
  assert.deepEqual(ticks, [0, 1, 2]);
});

test("tick indices are sequential over many frames", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(0);
  for (let f = 1; f <= 10; f++) loop.frame(f * STEP_MS);
  assert.deepEqual(ticks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(loop.stats().ticks, 10);
});

test("catch-up is capped; backlog is dropped and counted, not spiraled", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(0);
  const ran = loop.frame(20 * STEP_MS); // 20 steps of backlog at once
  assert.equal(ran, MAX_STEPS_PER_FRAME);
  const s = loop.stats();
  assert.equal(s.ticks, MAX_STEPS_PER_FRAME);
  assert.equal(s.spiralEvents, 1);
  assert.ok(s.droppedMs > 0);
  // No leftover backlog: the next frame resumes with a single tick.
  assert.equal(loop.frame(21 * STEP_MS), 1);
  assert.equal(loop.stats().spiralEvents, 1);
});

test("pathological frame gaps are clamped before the spiral guard", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(0);
  const ran = loop.frame(60_000); // 60 s stall (debugger pause)
  // 60 s clamped to MAX_FRAME_DELTA_MS, then still capped per frame.
  assert.ok(ran <= MAX_STEPS_PER_FRAME);
  assert.equal(loop.stats().spiralEvents, 1);
  assert.ok(loop.stats().droppedMs <= MAX_FRAME_DELTA_MS);
});

test("backwards clock steps are ignored", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(1000);
  assert.equal(loop.frame(1000 + STEP_MS), 1);
  assert.equal(loop.frame(1000 + STEP_MS / 2), 0); // nowMs went backwards
  assert.deepEqual(ticks, [0]);
});

test("constructor rejects nonsense config", () => {
  assert.throws(() => new TickLoop(() => {}, 0), RangeError);
  assert.throws(() => new TickLoop(() => {}, STEP_MS, 0), RangeError);
});

test("step runs one tick outside the clock; rearm drops the backlog", () => {
  const ticks: number[] = [];
  const loop = new TickLoop((t) => ticks.push(t));
  loop.frame(0);
  loop.step();
  loop.rearm(10_000);
  assert.equal(loop.frame(10_000 + STEP_MS), 1);
  assert.deepEqual(ticks, [0, 1]);
});
