/**
 * PerfSampler: frame counters folded into one sample a second (mean and
 * worst frame time, draw calls and triangles a frame), network rates from
 * the byte counters, and a minute of history.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bytes, compact, PERF_HISTORY, PerfSampler, type PerfGauges } from "../src/render/perf-stats.js";

const GAUGES: PerfGauges = {
  geometries: 10, textures: 4, programs: 3, props: 20, propDrawCalls: 2, propTriangles: 500,
  propFullTriangles: 1000, propsPerLevel: [5, 15], entities: 30, chunks: 9, heapBytes: null,
};

describe("PerfSampler", () => {
  it("samples a second of frames: rate, mean and worst frame time, cost a frame", () => {
    const p = new PerfSampler(0);
    p.frame(10, 100, 1000);
    p.frame(30, 200, 3000);
    assert.equal(p.due(999), false);
    assert.equal(p.due(1000), true);
    const s = p.sample(1000, GAUGES, { bytesIn: 0, bytesOut: 0 });
    assert.equal(s.fps, 2);
    assert.equal(s.frameMs, 20);
    assert.equal(s.frameMaxMs, 30);
    assert.equal(s.drawCalls, 150);
    assert.equal(s.triangles, 2000);
    assert.deepEqual(s.propsPerLevel, [5, 15]);
    assert.notEqual(s.propsPerLevel, GAUGES.propsPerLevel, "a copy");
    assert.equal(p.due(1500), false, "the next second starts at the sample");
  });

  it("measures network rates between samples, starting from zero", () => {
    const p = new PerfSampler(0);
    assert.equal(p.sample(1000, GAUGES, { bytesIn: 5000, bytesOut: 100 }).inBytesPerSec, 0, "no rate before a baseline");
    const s = p.sample(3000, GAUGES, { bytesIn: 9000, bytesOut: 300 });
    assert.equal(s.inBytesPerSec, 2000);
    assert.equal(s.outBytesPerSec, 100);
  });

  it("keeps a minute of samples, oldest first", () => {
    const p = new PerfSampler(0);
    for (let i = 1; i <= PERF_HISTORY + 5; i++) p.sample(i * 1000, GAUGES, { bytesIn: 0, bytesOut: 0 });
    const h = p.history();
    assert.equal(h.length, PERF_HISTORY);
    assert.equal(h[0].at, 6000);
    assert.equal(h.at(-1)!.at, (PERF_HISTORY + 5) * 1000);
  });

  it("formats counts and sizes compactly", () => {
    assert.equal(compact(950), "950");
    assert.equal(compact(1234), "1.2k");
    assert.equal(compact(3_400_000), "3.4M");
    assert.equal(bytes(512), "512 B");
    assert.equal(bytes(12.5 * 1024), "12.5 kB");
    assert.equal(bytes(84 * 1024 * 1024), "84.0 MB");
  });
});
