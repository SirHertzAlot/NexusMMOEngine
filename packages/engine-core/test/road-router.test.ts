import test from "node:test";
import assert from "node:assert/strict";
import { routeEdge, routeRoads, type Grid, type RouteOptions } from "../src/terrain/road-router.js";

const cell = 10; // metres per cell

const grid = (heights: number[], width: number, depth: number, originX = 0, originZ = 0): Grid => ({
  heights: new Float32Array(heights),
  width,
  depth,
  cell,
  originX,
  originZ,
});

const dry: RouteOptions = { seaLevel: -1, maxGrade: 0.08 };

test("road-router water blocking: never steps into a cell at or below sea level", () => {
  // Finite lake wall: a 2-cell column of sea at u=5,v=1..2, dry ground (h=10)
  // everywhere else. The road must detour around the END of the wall, where the
  // ground is flat and dry, and never enter a water cell.
  const W = 9, D = 5;
  const h: number[] = new Array(W * D).fill(10);
  h[1 * W + 5] = 0; // (5,1) sea
  h[2 * W + 5] = 0; // (5,2) sea
  const g = grid(h, W, D);
  const pts = routeEdge(g, [25, 15], [85, 15], { ...dry, seaLevel: 0, stride: 1 });
  assert.ok(pts.length > 3, "road should have bent around the lake");
  assert.deepEqual(pts[0], [25, 15], "start pinned to junction");
  assert.deepEqual(pts[pts.length - 1], [85, 15], "end pinned to junction");
  for (const p of pts) {
    const u = Math.max(0, Math.min(W - 1, Math.floor(p[0] / cell)));
    const v = Math.max(0, Math.min(D - 1, Math.floor(p[1] / cell)));
    const gi = v * W + u;
    assert.ok(h[gi]! > 0, `road stepped into water at node (${u},${v}) h=${h[gi]}`);
  }
});

test("road-router water blocking: falls back to straight spine when start sits on sea with no land", () => {
  // Entire grid is sea: no walkable node exists -> nearestWalkable returns -1.
  const W = 5, D = 5;
  const h: number[] = new Array(W * D).fill(0);
  const g = grid(h, W, D);
  const pts = routeEdge(g, [15, 15], [35, 35], { ...dry, seaLevel: 0, stride: 1 });
  assert.equal(pts.length, 2, "should fall back to straight spine");
  assert.deepEqual(pts[0], [15, 15]);
  assert.deepEqual(pts[1], [35, 35]);
});

test("road-router grade avoidance: bends around a sheer cliff, not through it", () => {
  // Finite cliff wall: 2-cell column at u=5,v=1..2 of h=1300, flat h=1000
  // everywhere else. Direct spine (y=15) would cross the cliff; the route must
  // detour to the flat ground past the wall's end.
  const W = 9, D = 5;
  const h: number[] = new Array(W * D).fill(1000);
  h[1 * W + 5] = 1300; // (5,1) cliff
  h[2 * W + 5] = 1300; // (5,2) cliff
  const g = grid(h, W, D);
  const pts = routeEdge(g, [25, 15], [85, 15], { ...dry, stride: 1 });
  assert.ok(pts.length > 3, "road should have bent around the cliff");
  // The direct spine rides y=15 through x≈40..60; the detour crosses that x-range
  // only at y≈45 (past the wall's end).
  const crossesCliff = pts.some((p) => p[0] > 40 && p[0] < 60 && p[1] > 12 && p[1] < 18);
  assert.ok(!crossesCliff, "road cut straight through the cliff spine");
  assert.deepEqual(pts[0], [25, 15]);
  assert.deepEqual(pts[pts.length - 1], [85, 15]);
});

test("road-router grade avoidance: corridor bounds the detour, falls back when it is too short", () => {
  // Same cliff layout, but maxDetourM=25 excludes the flat end (y=45 is 30 m
  // off the y=15 spine) -> no gradeable route within budget -> straight spine.
  const W = 9, D = 5;
  const h: number[] = new Array(W * D).fill(1000);
  h[1 * W + 5] = 1300;
  h[2 * W + 5] = 1300;
  const g = grid(h, W, D);
  const pts = routeEdge(g, [25, 15], [85, 15], { ...dry, maxDetourM: 25, stride: 1 });
  assert.equal(pts.length, 2, "should fall back to straight spine when corridor is too tight");
  assert.deepEqual(pts[0], [25, 15]);
  assert.deepEqual(pts[1], [85, 15]);
});

test("road-router simplify: collapses a straight spine on flat dry ground", () => {
  const W = 13, D = 3;
  const h: number[] = new Array(W * D).fill(10);
  const g = grid(h, W, D);
  const pts = routeEdge(g, [15, 15], [115, 15], { ...dry, simplifyTolM: 5, stride: 1 });
  assert.ok(pts.length <= 6, `flat ground should simplify heavily, got ${pts.length} pts`);
  assert.deepEqual(pts[0], [15, 15]);
  assert.deepEqual(pts[pts.length - 1], [115, 15]);
});

test("road-router whole graph: pins both endpoints of every edge", () => {
  const W = 16, D = 16;
  const h: number[] = new Array(W * D).fill(200);
  const g = grid(h, W, D);
  const res = routeRoads(
    {
      nodes: [
        { id: "a", x: 25, z: 25 },
        { id: "b", x: 135, z: 25 },
        { id: "c", x: 75, z: 125 },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    },
    g,
    { ...dry, stride: 2 },
  );
  assert.equal(res.length, 2);
  assert.deepEqual(res[0].points[0], [25, 25]);
  assert.deepEqual(res[0].points[res[0].points.length - 1], [135, 25]);
  assert.deepEqual(res[1].points[0], [135, 25]);
  assert.deepEqual(res[1].points[res[1].points.length - 1], [75, 125]);
});
