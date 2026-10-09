/**
 * TDD: Tick timing tracker for the world server.
 * Records per-tick durations and per-system costs; reports p50/p99
 * and the slowest systems. The debug API serves this to the editor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TickTimings } from "../src/tick-timings.js";

describe("TickTimings", () => {
  it("starts empty", () => {
    const t = new TickTimings();
    assert.deepEqual(t.snapshot(), { ticks: 0, p50: 0, p99: 0, systems: [] });
  });

  it("records tick durations", () => {
    const t = new TickTimings();
    t.recordTick(5, {});
    t.recordTick(10, {});
    t.recordTick(15, {});
    const s = t.snapshot();
    assert.equal(s.ticks, 3);
    assert.ok(s.p50 > 0);
    assert.ok(s.p99 >= s.p50);
  });

  it("tracks per-system costs", () => {
    const t = new TickTimings();
    t.recordTick(10, { physics: 6, ai: 3, net: 1 });
    t.recordTick(12, { physics: 7, ai: 4, net: 1 });
    const s = t.snapshot();
    assert.equal(s.systems[0].name, "physics");
    assert.ok(s.systems[0].avg > s.systems[1].avg);
  });

  it("caps history at 1000 ticks", () => {
    const t = new TickTimings(10);
    for (let i = 0; i < 20; i++) t.recordTick(i, {});
    assert.equal(t.snapshot().ticks, 10);
  });

  it("computes p50/p99 from history", () => {
    const t = new TickTimings();
    for (let i = 1; i <= 100; i++) t.recordTick(i, {});
    const s = t.snapshot();
    // p50 ~50, p99 ~99 (allow some slack for the exact percentile method)
    assert.ok(s.p50 >= 45 && s.p50 <= 55, `p50=${s.p50}`);
    assert.ok(s.p99 >= 95, `p99=${s.p99}`);
  });
});
