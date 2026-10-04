import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";

test("counters go up, by label", () => {
  const r = new Registry("mmo_");
  const c = r.counter("hits_total", "Hits.", ["kind"]);
  c.inc({ kind: "a" });
  c.inc({ kind: "a" }, 2);
  c.inc({ kind: "b" });
  assert.equal(c.get({ kind: "a" }), 3);
  assert.equal(c.get({ kind: "b" }), 1);
  assert.throws(() => c.inc({ kind: "a" }, -1), /only go up/);
  assert.throws(() => c.inc({ nope: "x" } as never), /unknown label "nope"/);
  assert.throws(() => c.inc(), /missing label "kind"/);
});

test("gauges set, inc and dec", () => {
  const g = new Registry().gauge("open", "Open things.");
  g.set(5); g.inc(); g.dec(undefined, 3);
  assert.equal(g.get(), 3);
});

test("histograms record and scrape as _bucket, _sum and _count", () => {
  const r = new Registry();
  const h = r.histogram("lat_ms", "Latency.", ["op"], [1, 10]);
  h.observe(0.5, { op: "x" });
  h.observe(5, { op: "x" });
  h.observe(50, { op: "x" });
  const text = r.scrape();
  assert.match(text, /^lat_ms_bucket\{op="x",le="1"\} 1$/m);
  assert.match(text, /^lat_ms_bucket\{op="x",le="10"\} 2$/m);
  assert.match(text, /^lat_ms_bucket\{op="x",le="\+Inf"\} 3$/m);
  assert.match(text, /^lat_ms_sum\{op="x"\} 55\.5$/m);
  assert.match(text, /^lat_ms_count\{op="x"\} 3$/m);
});

test("names are checked and registered once", () => {
  const r = new Registry();
  r.counter("a_total", "A.");
  assert.throws(() => r.counter("a_total", "A again."), /registered twice/);
  assert.throws(() => r.gauge("bad-name", "x"), /invalid metric name/);
  assert.throws(() => r.gauge("ok", "x", ["__reserved"]), /invalid label name/);
  assert.deepEqual(r.names(), ["a_total"]);
});
