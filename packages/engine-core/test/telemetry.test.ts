/** Play telemetry buckets and tick histogram (roadmap T2). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUCKET_SECONDS, BUCKETS, PlayTelemetry } from "../src/stats/telemetry.js";

describe("PlayTelemetry", () => {
  it("counts into the current bucket and keeps running totals", () => {
    let now = 0;
    const t = new PlayTelemetry(() => now);
    t.kill();
    t.kill();
    t.damageDealt(12.5);
    const s = t.snapshot();
    assert.equal(s.series.kills[BUCKETS - 1], 2);
    assert.equal(s.totals.kills, 2);
    assert.equal(s.totals.damageDealt, 12.5);
  });

  it("rolls to a new bucket and drops buckets older than the ring", () => {
    let now = 0;
    const t = new PlayTelemetry(() => now);
    t.drop();
    now += BUCKET_SECONDS * 1000;
    t.drop();
    t.drop();
    let s = t.snapshot();
    assert.deepEqual(s.series.drops.slice(-2), [1, 2]);
    now += BUCKET_SECONDS * 1000 * (BUCKETS + 5);
    s = t.snapshot();
    assert.equal(s.series.drops.reduce((a, b) => a + b, 0), 0);
    assert.equal(s.totals.drops, 3, "totals outlive the ring");
  });

  it("reports tick percentiles from the histogram", () => {
    const t = new PlayTelemetry(() => 0);
    for (let i = 0; i < 99; i++) t.tickMs(2);
    t.tickMs(30);
    const s = t.snapshot().tick;
    assert.equal(s.count, 100);
    assert.ok(s.p50Ms <= 2.5);
    assert.ok(s.p99Ms <= 2.5, "one slow tick in 100 is above p99");
    assert.equal(s.maxMs, 30);
  });

  it("an empty histogram reads zero", () => {
    assert.deepEqual(new PlayTelemetry().snapshot().tick, { count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });
});
