/**
 * graph-view: the view maths and edge routes every node graph shares
 * (PCG graphs, the game flow, quests and dialogs).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampScale,
  fitView,
  leftRightRoute,
  MAX_SCALE,
  MIN_SCALE,
  panFrom,
  toWorld,
  topDownRoute,
  verticalCurve,
  zoomAt,
  type Box,
} from "../src/graph-view.js";
import { edgePath } from "../src/inspectors/graph-editor.js";

const box = (x: number, y: number, w = 100, h = 40): Box => ({ x, y, w, h });

test("toWorld maps a client point through the view", () => {
  const p = toWorld({ x: 10, y: 20, scale: 2 }, { left: 100, top: 50 }, 140, 90);
  assert.deepEqual(p, { x: 30, y: 40 });
});

test("panFrom moves the view opposite the drag, scaled", () => {
  assert.deepEqual(panFrom({ x: 0, y: 0, scale: 2 }, 20, -10), { x: -10, y: 5, scale: 2 });
});

test("zoomAt keeps the world point under the cursor still", () => {
  const v = { x: 5, y: 7, scale: 1 };
  const wx = 105;
  const wy = 57;
  const z = zoomAt(v, wx, wy, 1.5);
  assert.equal(z.scale, 1.5);
  // The screen position of (wx, wy) is (w - view) * scale before and after.
  assert.ok(Math.abs((wx - v.x) * v.scale - (wx - z.x) * z.scale) < 1e-9);
  assert.ok(Math.abs((wy - v.y) * v.scale - (wy - z.y) * z.scale) < 1e-9);
});

test("zoom is clamped at both ends", () => {
  assert.equal(zoomAt({ x: 0, y: 0, scale: MAX_SCALE }, 0, 0, 2).scale, MAX_SCALE);
  assert.equal(zoomAt({ x: 0, y: 0, scale: MIN_SCALE }, 0, 0, 0.1).scale, MIN_SCALE);
  assert.equal(clampScale(99), MAX_SCALE);
});

test("fitView centres a small graph at 1:1", () => {
  const v = fitView([box(0, 0, 100, 40)], { w: 500, h: 300 });
  assert.equal(v.scale, 1);
  // The box's centre is the canvas's centre: (x + 250, y + 150) = (50, 20).
  assert.deepEqual({ x: v.x, y: v.y }, { x: -200, y: -130 });
});

test("fitView zooms out to show a graph bigger than the canvas", () => {
  const v = fitView([box(0, 0, 100, 40), box(1900, 960, 100, 40)], { w: 1000, h: 500 }, 40);
  assert.ok(v.scale < 0.5 && v.scale >= 0.3, String(v.scale));
  // Both corners land inside the canvas.
  assert.ok((0 - v.x) * v.scale >= 0 && (2000 - v.x) * v.scale <= 1000);
  assert.ok((0 - v.y) * v.scale >= 0 && (1000 - v.y) * v.scale <= 500);
});

test("fitView of no nodes is a plain origin view", () => {
  assert.deepEqual(fitView([], { w: 500, h: 300 }, 60), { x: -60, y: -60, scale: 1 });
});

test("topDownRoute runs from the bottom of one box to the top of the next", () => {
  const g = topDownRoute(box(0, 0), box(0, 200));
  assert.match(g.d, /^M 50 40 C /);
  assert.match(g.d, / 50 200$/);
  assert.equal(g.mid.y, 120);
});

test("topDownRoute honours pin positions", () => {
  const g = topDownRoute(box(0, 0), box(300, 200), { fromX: 25, toX: 330 });
  assert.match(g.d, /^M 25 40 /);
  assert.match(g.d, / 330 200$/);
});

test("topDownRoute loops a node's edge to itself under it", () => {
  const a = box(10, 10);
  const g = topDownRoute(a, a);
  assert.match(g.d, /q 40 40 80 0$/);
});

test("leftRightRoute goes forward as a curve and loops back under both boxes", () => {
  const fwd = leftRightRoute(box(0, 0), box(300, 0));
  assert.match(fwd.d, /^M100,20 C150,20 250,20 300,20$/);
  const back = leftRightRoute(box(300, 0), box(0, 0));
  assert.match(back.d, /^M350,40 C350,100 50,100 50,40$/);
  assert.ok(back.mid.y > 40, "the label sits under the loop");
});

test("the PCG editor's edgePath is the shared vertical curve", () => {
  assert.equal(edgePath(1, 2, 30, 90), verticalCurve(1, 2, 30, 90));
});
