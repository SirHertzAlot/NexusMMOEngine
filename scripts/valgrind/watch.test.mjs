#!/usr/bin/env node
/**
 * Unit tests for watch.mjs's pure helpers (diff + report rendering).
 * Run: node --test scripts/valgrind/watch.test.mjs
 * The watcher's git/npm/valgrind plumbing is exercised by --dry-run
 * and VALGRIND_WATCH_SKIP_PIPELINE=1 runs, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, renderReport } from "./watch.mjs";

const KEY = "InvalidRead|addon-physics|physics.cc:10";
const snap = (over = {}) => ({
  id: "2026-10-28T14:11:45.247Z",
  time: "2026-10-28T14:11:45.247Z",
  commit: "e5f98682",
  dirty: false,
  node: "v24.21.0",
  memcheck: {
    reports: 11, errors: 20, leakedBytes: 264, engineErrors: 0, viaErrors: 0,
    engineKeys: [], viaKeys: [], perReport: {},
  },
  callgrind: {
    "sim-tick-1000": { irPerOp: 16_000_000, unit: "tick" },
    "procgen-chunk": { irPerOp: 67_000, unit: "chunk" },
  },
  ...over,
});

test("identical snapshots: no new/gone errors, no regressions", () => {
  const d = diffSnapshots(snap(), snap(), 3);
  assert.deepEqual(d.memcheck.newEngine, []);
  assert.deepEqual(d.memcheck.goneEngine, []);
  assert.equal(d.nodeMismatch, false);
  assert.equal(d.callgrind.every((w) => !w.regression), true);
});

test("a new engine key and a +5% workload are flagged", () => {
  const next = snap();
  next.memcheck = { ...next.memcheck, errors: 21, engineErrors: 1, engineKeys: [KEY] };
  next.callgrind = {
    "sim-tick-1000": { irPerOp: 16_800_000, unit: "tick" }, // +5%
    "procgen-chunk": { irPerOp: 67_000, unit: "chunk" },
  };
  const d = diffSnapshots(snap(), next, 3);
  assert.deepEqual(d.memcheck.newEngine, [KEY]);
  const tick = d.callgrind.find((w) => w.name === "sim-tick-1000");
  assert.equal(tick.regression, true);
  assert.ok(Math.abs(tick.deltaPct - 5) < 0.001);
});

test("a resolved engine key is reported as gone", () => {
  const prev = snap();
  prev.memcheck = { ...prev.memcheck, engineErrors: 1, engineKeys: [KEY] };
  const d = diffSnapshots(prev, snap(), 3);
  assert.deepEqual(d.memcheck.goneEngine, [KEY]);
  assert.deepEqual(d.memcheck.newEngine, []);
});

test("node mismatch suppresses regression flags (counts not comparable)", () => {
  const next = snap({ node: "v24.22.1" });
  next.callgrind = { "sim-tick-1000": { irPerOp: 32_000_000, unit: "tick" } }; // +100%
  const d = diffSnapshots(snap(), next, 3);
  assert.equal(d.nodeMismatch, true);
  assert.equal(d.callgrind.find((w) => w.name === "sim-tick-1000").regression, false);
});

test("added and missing workloads are surfaced, not diffed", () => {
  const next = snap();
  next.callgrind = { "new-bench": { irPerOp: 123, unit: "op" } };
  const d = diffSnapshots(snap(), next, 3);
  assert.equal(d.callgrind.find((w) => w.name === "new-bench").added, true);
  assert.equal(d.callgrind.find((w) => w.name === "sim-tick-1000").missing, true);
});

test("null prev (first run) yields an empty diff", () => {
  const d = diffSnapshots(null, snap(), 3);
  assert.equal(d.memcheck, null);
  assert.deepEqual(d.callgrind, []);
});

test("report renders verdict, new errors and regressions", () => {
  const next = snap();
  next.memcheck = { ...next.memcheck, engineErrors: 1, engineKeys: [KEY] };
  next.callgrind = { "sim-tick-1000": { irPerOp: 16_800_000, unit: "tick" }, "procgen-chunk": { irPerOp: 67_000, unit: "chunk" } };
  const prev = snap();
  const md = renderReport({
    sha: "e5f98682abcdef", time: next.time, node: next.node, verdict: "FAIL — gate",
    checkLines: ["[check] memcheck: 1 error(s) in our code (gated)"], prev, next,
    diff: diffSnapshots(prev, next, 3), thresholdPct: 3, logName: "run-e5f98682.log",
  });
  assert.match(md, /# Valgrind watch — e5f98682/);
  assert.match(md, /gate: FAIL — gate/);
  assert.match(md, /NEW error in our code/);
  assert.match(md, /REGRESSION/);
  assert.match(md, /sim-tick-1000/);
});

test("report without a snapshot says the pipeline fell short", () => {
  const md = renderReport({
    sha: "e5f98682abcdef", time: "2026-10-28T00:00:00.000Z", node: "v24.21.0",
    verdict: "PIPELINE FAILED (valgrind:build-debug)", prev: null, next: null,
    diff: diffSnapshots(null, null), logName: "run-e5f98682.log",
  });
  assert.match(md, /No snapshot was produced/);
});
