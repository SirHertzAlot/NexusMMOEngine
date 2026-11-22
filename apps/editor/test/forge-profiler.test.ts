/**
 * Forge profiler (docs/EDITOR-UI-2026.md §3 item 12, slice EU7).
 *
 * The panel measures nothing: engine-core's `TickTimings` has recorded
 * per-system cost since the gateway was written and the debug API has
 * served it all along. What the panel adds is the budget — 33.33 ms at
 * 30 Hz — so these tests pin the arithmetic that turns milliseconds into
 * a share of a tick, and pin the honest label about the two windows the
 * server's snapshot mixes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForgeProfilerView,
  TICK_BUDGET_MS,
  budgetRows,
  budgetTone,
  headroomMs,
  type Timings,
} from "../src/ui/forge-profiler.js";

const TIMINGS: Timings = {
  ticks: 1000,
  p50: 8.4,
  p99: 21.7,
  systems: [
    { name: "movement", avg: 2.5, max: 9.1 },
    { name: "combat", avg: 0.8, max: 3.4 },
    { name: "interest", avg: 4.1, max: 18.2 },
  ],
};

function render(state: Parameters<typeof ForgeProfilerView>[0]["state"]): string {
  return renderToStaticMarkup(React.createElement(ForgeProfilerView, { state }));
}

describe("tick budget arithmetic", () => {
  it("uses the gateway's own 30 Hz step as the budget", () => {
    assert.equal(TICK_BUDGET_MS, 1000 / 30);
  });

  it("turns milliseconds into a share of the tick", () => {
    const rows = budgetRows([{ name: "a", avg: TICK_BUDGET_MS / 4, max: TICK_BUDGET_MS / 2 }]);
    assert.equal(rows[0]?.share, 0.25);
    assert.equal(rows[0]?.peakShare, 0.5);
  });

  it("orders systems by what they cost, dearest first", () => {
    assert.deepEqual(
      budgetRows(TIMINGS.systems).map((r) => r.name),
      ["interest", "movement", "combat"],
    );
  });

  it("warns at half the budget and fails at the whole of it", () => {
    assert.equal(budgetTone(0.2), "ok");
    assert.equal(budgetTone(0.49), "ok");
    assert.equal(budgetTone(0.5), "warn");
    assert.equal(budgetTone(0.99), "warn");
    assert.equal(budgetTone(1), "bad");
    // Over budget is still bad, not wrapped around to fine.
    assert.equal(budgetTone(2.4), "bad");
  });

  it("never reports negative headroom when the tick is over budget", () => {
    assert.equal(headroomMs(10), TICK_BUDGET_MS - 10);
    assert.equal(headroomMs(40), 0);
  });
});

describe("profiler panel", () => {
  it("shows every system, not the first five", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `sys${i}`, avg: i * 0.1, max: i }));
    const html = render({ kind: "timings", timings: { ...TIMINGS, systems: many } });
    assert.match(html, /Systems \(9\)/);
    assert.match(html, /sys8/);
  });

  it("states the budget and the headroom left at p99", () => {
    const html = render({ kind: "timings", timings: TIMINGS });
    assert.match(html, /33\.3 ms budget at 30 Hz/);
    // 33.333 - 21.7
    assert.match(html, /11\.63 ms of headroom/);
  });

  it("says the two windows are not the same, because they are not", () => {
    const html = render({ kind: "timings", timings: TIMINGS });
    assert.match(html, /running\s+totals since the server started/);
    assert.match(html, /not the same window/);
  });

  it("asks for play mode rather than drawing an empty chart", () => {
    assert.match(render({ kind: "idle" }), /Start play mode/);
  });

  it("passes the server's own reason through when the query cannot be answered", () => {
    const html = render({ kind: "unavailable", reason: "Simulate runs without one." });
    assert.match(html, /Simulate runs without one/);
  });

  it("measures nothing of its own: no control, no input", () => {
    const html = render({ kind: "timings", timings: TIMINGS });
    assert.doesNotMatch(html, /<input/i);
    assert.doesNotMatch(html, /<button/i);
  });
});
