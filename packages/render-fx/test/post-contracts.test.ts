import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_GRAPH_ORDER,
  KUWAHARA_TIER_TABLE,
  passOrderIndex,
  validateFrameGraph,
} from "../src/post-contracts.js";
import type { PassContract } from "../src/post-contracts.js";

const CANONICAL: PassContract[] = [
  { name: "N8AO", kind: "depth-reader", readsDepth: true, consumesDepth: false },
  { name: "Underwater", kind: "depth-reader", readsDepth: true, consumesDepth: true },
  { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: false },
  { name: "Bloom", kind: "colour", readsDepth: false, consumesDepth: false },
  { name: "GTTonemap", kind: "tonemap", readsDepth: false, consumesDepth: false },
];

test("canonical order validates via the normative export", () => {
  const r = validateFrameGraph(CANONICAL);
  assert.equal(r.ok, true);
});

test("stage order matches FRAME_GRAPH_ORDER", () => {
  assert.deepEqual([...FRAME_GRAPH_ORDER], ["depth-reader", "paint", "colour", "tonemap", "ui"]);
  assert.ok(passOrderIndex("depth-reader") < passOrderIndex("paint"));
  assert.ok(passOrderIndex("paint") < passOrderIndex("tonemap"));
});

test("depth reader after depth consumption is rejected", () => {
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

test("kuwahara tier table targets recorded (spec [TARGET])", () => {
  assert.equal(KUWAHARA_TIER_TABLE.low.enabled, false);
  assert.equal(KUWAHARA_TIER_TABLE.medium.radius, 2);
  assert.equal(KUWAHARA_TIER_TABLE.high.radius, 3);
  assert.equal(KUWAHARA_TIER_TABLE.ultra.radius, 4);
});

test("non-consuming depth readers may repeat", () => {
  const r = validateFrameGraph([
    { name: "N8AO", kind: "depth-reader", readsDepth: true, consumesDepth: false },
    { name: "Underwater", kind: "depth-reader", readsDepth: true, consumesDepth: true },
    { name: "Kuwahara", kind: "paint", readsDepth: false, consumesDepth: false },
  ]);
  assert.equal(r.ok, true);
});
