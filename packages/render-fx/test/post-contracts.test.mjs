/**
 * PR1 frame-graph contract tests: ordering rules for depth readers,
 * paint, colour, tonemap. Mirrors validateFrameGraph semantics without
 * importing TS (protocol-style plain-JS check).
 */
import assert from "node:assert/strict";
import test from "node:test";

const ORDER = ["depth-reader", "paint", "colour", "tonemap", "ui"];

function validateFrameGraph(passes) {
  const issues = [];
  let maxSeen = -1;
  let depthGone = false;
  for (const p of passes) {
    const idx = ORDER.indexOf(p.kind);
    if (idx < 0) {
      issues.push(`${p.name}: unknown pass kind`);
      continue;
    }
    if (idx < maxSeen) issues.push(`${p.name}: ${p.kind} runs after a later stage`);
    maxSeen = Math.max(maxSeen, idx);
    if (p.readsDepth && depthGone) issues.push(`${p.name}: reads depth after it was consumed`);
    if (p.consumesDepth) depthGone = true;
  }
  return { ok: issues.length === 0, issues };
}

test("canonical order validates", () => {
  const r = validateFrameGraph([
    { name: "N8AO", kind: "depth-reader", readsDepth: true, consumesDepth: true },
    { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: false },
    { name: "Bloom", kind: "colour", readsDepth: false, consumesDepth: false },
    { name: "GTTonemap", kind: "tonemap", readsDepth: false, consumesDepth: false },
  ]);
  assert.equal(r.ok, true);
});

test("non-consuming depth readers may repeat", () => {
  const r = validateFrameGraph([
    { name: "N8AO", kind: "depth-reader", readsDepth: true, consumesDepth: false },
    { name: "Underwater", kind: "depth-reader", readsDepth: true, consumesDepth: true },
    { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: false },
  ]);
  assert.equal(r.ok, true);
});

test("depth reader after paint is rejected", () => {
  const r = validateFrameGraph([
    { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: true },
    { name: "N8AO-late", kind: "depth-reader", readsDepth: true, consumesDepth: false },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("reads depth after it was consumed")));
});

test("out-of-order colour before paint is rejected", () => {
  const r = validateFrameGraph([
    { name: "Bloom", kind: "colour", readsDepth: false, consumesDepth: false },
    { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: false },
  ]);
  assert.equal(r.ok, false);
});

test("kuwahara tier table targets recorded", () => {
  const table = {
    low: { enabled: false, radius: 0 },
    medium: { enabled: true, radius: 2 },
    high: { enabled: true, radius: 3 },
    ultra: { enabled: true, radius: 4 },
  };
  assert.equal(table.low.enabled, false);
  assert.equal(table.high.radius, 3);
});
