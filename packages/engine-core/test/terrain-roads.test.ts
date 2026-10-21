import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaths,
  catmullRom,
  splineRoads,
  canonicalRoads,
  roadNetworkHash,
  type RoadEdge,
  type RoadNode,
} from "../src/terrain/roads.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const pk = (p: [number, number]): string => `${p[0]},${p[1]}`;
const sortedPair = (a: [number, number], b: [number, number]): string => [pk(a), pk(b)].sort().join("|");
const near = (a: number[], b: number[], eps = 1e-6): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

/** 4x4 junction grid in mm — mirrors 0003's topology (degree-2 corners, degree-3
 * boundary edges, degree-4 interior). Row + column edges, single class/width. */
const NODES: RoadNode[] = [];
for (let r = 0; r < 4; r++)
  for (let c = 0; c < 4; c++)
    NODES.push({ id: `g${r}${c}`, x: c * 1000, z: r * 1000 });

const EDGES: RoadEdge[] = [];
let eid = 0;
const mk = (from: string, to: string): void => {
  EDGES.push({ id: `e${eid++}`, from, to, roadClass: "street", widthMm: 6000, surface: "paved" });
};
for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) mk(`g${r}${c}`, `g${r}${c + 1}`); // rows
for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) mk(`g${r}${c}`, `g${r + 1}${c}`); // cols

const degree = (id: string): number => EDGES.filter((e) => e.from === id || e.to === id).length;

// An S-curving path of 5 junctions joined by 4 edges (a real "alignment" with turns).
const CURVE_NODES: RoadNode[] = [
  { id: "a", x: 0, z: 0 },
  { id: "b", x: 1000, z: 0 },
  { id: "c", x: 1500, z: 1000 },
  { id: "d", x: 1000, z: 2000 },
  { id: "e", x: 0, z: 2000 },
];
const CURVE_EDGES: RoadEdge[] = CURVE_NODES.slice(0, -1).map(
  (n, i) => ({ id: `s${i}`, from: n.id, to: CURVE_NODES[i + 1].id, roadClass: "road", widthMm: 8000, surface: "paved" }),
);

test("buildPaths covers every edge exactly once as chains between degree-2 junctions", () => {
  const paths = buildPaths(NODES, EDGES);
  assert.ok(paths.length > 0);

  const inputPairs: string[] = [];
  const pathPairs: string[] = [];
  for (const e of EDGES) {
    const a = NODES.find((n) => n.id === e.from)!;
    const b = NODES.find((n) => n.id === e.to)!;
    inputPairs.push(sortedPair([a.x, a.z], [b.x, b.z]));
  }
  for (const p of paths) {
    assert.ok(p.nodes.length >= 2);
    for (let i = 0; i < p.nodes.length - 1; i++) pathPairs.push(sortedPair(p.nodes[i], p.nodes[i + 1]));
    if (p.nodes.length > 2) {
      const firstId = NODES.find((n) => pk([n.x, n.z]) === pk(p.nodes[0]))!.id;
      const lastId = NODES.find((n) => pk([n.x, n.z]) === pk(p.nodes.at(-1)!))!.id;
      assert.notStrictEqual(degree(firstId), 2);
      assert.notStrictEqual(degree(lastId), 2);
    }
  }
  inputPairs.sort();
  pathPairs.sort();
  assert.deepEqual(pathPairs, inputPairs);
});

test("buildPaths preserves class/width boundaries (splits the curving path)", () => {
  const edges: RoadEdge[] = CURVE_EDGES.map((e, i) =>
    i === CURVE_EDGES.length - 1 ? { ...e, roadClass: "alley" } : e,
  );
  const paths = buildPaths(CURVE_NODES, edges);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].roadClass, "road");
  assert.equal(paths[1].roadClass, "alley");
  assert.equal(paths[0].nodes.length, 4); // A-B-C-D keeps its spine
});

test("buildPaths collapses degree-2 spines into one chain", () => {
  const paths = buildPaths(CURVE_NODES, CURVE_EDGES);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].nodes.length, 5);
  assert.deepEqual(paths[0].nodes[0], [0, 0]);
  assert.deepEqual(paths[0].nodes.at(-1), [0, 2000]);
  assert.equal(paths[0].widthMm, 8000);
});

test("catmullRom hits endpoints exactly and samples densely", () => {
  const c = catmullRom(CURVE_NODES.map((n) => [n.x, n.z]), 1 / 500, 0);
  assert.ok(near(c[0], [0, 0]));
  assert.ok(near(c.at(-1)!, [0, 2000]));
  assert.ok(c.length > 10);
});

test("catmullRom tension=1 is linear; tension=0 rounds the corners", () => {
  const pts = CURVE_NODES.map((n) => [n.x, n.z]);
  const curved = catmullRom(pts, 1 / 500, 0);
  const linear = catmullRom(pts, 1 / 500, 1);

  const onPoly = (p: number[]): boolean =>
    CURVE_NODES.slice(1).some((n, i) => {
      const a = CURVE_NODES[i];
      const seg = [n.x - a.x, n.z - a.z];
      const L = seg[0] * seg[0] + seg[1] * seg[1];
      const t = ((p[0] - a.x) * seg[0] + (p[1] - a.z) * seg[1]) / L;
      if (t < -1e-9 || t > 1 + 1e-9) return false;
      const proj = [a.x + seg[0] * t, a.z + seg[1] * t];
      return near(p, proj, 1e-6);
    });
  for (const p of linear) assert.ok(onPoly(p), "linear sample off the polyline");
  assert.ok(curved.some((p) => !onPoly(p)), "tension=0 should round corners");
});

test("splineRoads drapes to height and builds constant-width ribbons", () => {
  const flat = (_x: number, _z: number) => 0;
  const ribbon = splineRoads(CURVE_NODES, CURVE_EDGES, flat, { samplesPerMm: 1 / 500 });
  assert.equal(ribbon.length, 1);
  const r = ribbon[0];
  assert.equal(r.roadClass, "road");
  assert.equal(r.widthMm, 8000);

  for (let i = 0; i < r.center.length; i += 3) assert.equal(r.center[i + 1], 0); // flat
  assert.equal(r.left.length, r.right.length);
  assert.equal(r.left.length, r.center.length);
  for (let i = 0; i < r.left.length; i += 3) {
    const dx = r.left[i] - r.right[i];
    const dz = r.left[i + 2] - r.right[i + 2];
    assert.ok(Math.abs(Math.hypot(dx, dz) - 8000) < 1); // rails at half-width (mm tolerance)
  }

  const ramp = (x: number, _z: number) => x / 10; // 1:10 fall
  const draped = splineRoads(CURVE_NODES, CURVE_EDGES, ramp, { samplesPerMm: 1 / 500 });
  for (let i = 0; i < draped[0].center.length; i += 3) {
    assert.equal(draped[0].center[i + 1], draped[0].center[i] / 10); // draped onto the slope
  }
});

test("canonicalRoads is stable and changes with the data", () => {
  const a = canonicalRoads(NODES, EDGES);
  const b = canonicalRoads(NODES.slice().reverse(), EDGES.slice().reverse());
  assert.equal(a, b); // order-independent

  const moved = NODES.map((n, i) => (i === 0 ? { ...n, x: n.x + 7 } : n));
  assert.notEqual(canonicalRoads(moved, EDGES), a);

  const sameT = canonicalRoads(NODES, EDGES, { terrainVersion: "t1" });
  assert.equal(sameT, canonicalRoads(NODES, EDGES, { terrainVersion: "t1" })); // pinned → stable
  assert.notEqual(canonicalRoads(NODES, EDGES, { terrainVersion: "t2" }), sameT); // terrain change → new key
});

test("roadNetworkHash is deterministic and content-addressed", () => {
  const o = { samplesPerMm: 1 / 500, tension: 0, terrainVersion: "survey-0003" };
  const h1 = roadNetworkHash(NODES, EDGES, o, sha256);
  const h2 = roadNetworkHash(NODES, EDGES, o, sha256);
  assert.equal(h1, h2);

  const h3 = roadNetworkHash(NODES, EDGES, { ...o, samplesPerMm: 1 / 250 }, sha256);
  assert.notEqual(h3, h1); // density change → new key

  const moved = [{ ...NODES[0], x: NODES[0].x + 1 }].concat(NODES.slice(1));
  const h4 = roadNetworkHash(moved, EDGES, o, sha256);
  assert.notEqual(h4, h1); // geometry change → new key

  const h5 = roadNetworkHash(NODES, EDGES, { ...o, terrainVersion: "survey-9999" }, sha256);
  assert.notEqual(h5, h1); // terrain change → new draped key
});
