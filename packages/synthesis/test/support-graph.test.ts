/**
 * Structural support (DE3): what holds up what, and what falls when parts go.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SynthesizedPlacement } from "../src/types.js";
import { buildSupportGraph, collapseFrom } from "../src/support-graph.js";

const part = (category: string, pos: [number, number, number], size: [number, number, number]): SynthesizedPlacement => ({
  partId: category,
  assetRef: `p/${category}`,
  category,
  transform: { pos, rot: [0, 0, 0, 1], scale: [1, 1, 1] },
  size,
});

// A 6 m square house: a 0.3 m floor, four walls 3 m tall on it, a roof on the walls, a door in the south wall and
// a window in the north wall. Indices: 0 floor, 1 north, 2 south, 3 east, 4 west, 5 roof, 6 door, 7 window.
const FLOOR = 0;
const N = 1;
const S = 2;
const E = 3;
const W = 4;
const ROOF = 5;
const DOOR = 6;
const WINDOW = 7;
const house = (): SynthesizedPlacement[] => [
  part("floor", [0, 0.15, 0], [6, 0.3, 6]),
  part("wall", [0, 1.8, -2.9], [6, 3, 0.2]),
  part("wall", [0, 1.8, 2.9], [6, 3, 0.2]),
  part("wall", [2.9, 1.8, 0], [0.2, 3, 6]),
  part("wall", [-2.9, 1.8, 0], [0.2, 3, 6]),
  part("roof", [0, 3.45, 0], [6.4, 0.3, 6.4]),
  part("door", [0, 1.6, 2.9], [1, 2.2, 0.3]),
  part("window", [1.5, 2, -2.9], [1, 1, 0.3]),
];

const indices = (f: Array<{ index: number }>): number[] => f.map((x) => x.index).sort((a, b) => a - b);

describe("buildSupportGraph", () => {
  const g = buildSupportGraph(house());
  it("grounds the floor and nothing else", () => {
    assert.deepEqual(g.grounded, [true, false, false, false, false, false, false, false]);
  });
  it("rests each wall on the floor and the roof on the four walls", () => {
    for (const w of [N, S, E, W]) assert.deepEqual(g.supporters[w]!.map((s) => [s.to, s.kind]), [[FLOOR, "rests"]]);
    assert.deepEqual(g.supporters[ROOF]!.map((s) => s.to).sort(), [N, S, E, W]);
  });
  it("hangs the door and the window from their walls", () => {
    assert.ok(g.supporters[DOOR]!.every((s) => s.kind === "attached") && g.supporters[DOOR]!.some((s) => s.to === S));
    assert.ok(g.supporters[WINDOW]!.some((s) => s.to === N && s.kind === "attached"));
  });
  it("is the reverse of itself: a part's dependents are the parts it supports", () => {
    assert.deepEqual([...g.dependents[N]!].sort(), [ROOF, WINDOW]);
    assert.deepEqual([...g.dependents[FLOOR]!].sort((a, b) => a - b), [N, S, E, W]);
  });
});

describe("collapseFrom", () => {
  const g = buildSupportGraph(house());
  it("drops nothing when nothing is removed", () => {
    assert.deepEqual(collapseFrom(g, []), []);
  });
  it("brings it all down in waves when the floor goes: walls first, then the roof and fixtures", () => {
    const f = collapseFrom(g, [FLOOR]);
    assert.deepEqual(indices(f), [N, S, E, W, ROOF, DOOR, WINDOW]);
    for (const w of [N, S, E, W]) assert.equal(f.find((x) => x.index === w)!.wave, 1);
    for (const x of [ROOF, DOOR, WINDOW]) assert.equal(f.find((q) => q.index === x)!.wave, 2);
  });
  it("keeps the roof up on three walls, and drops only what hung from the broken one", () => {
    const f = collapseFrom(g, [S]);
    assert.deepEqual(indices(f), [DOOR]);
  });
  it("keeps the roof up on two opposite walls: it spans them", () => {
    assert.deepEqual(indices(collapseFrom(g, [N, S])).includes(ROOF), false);
  });
  it("drops the roof when one wall is left: its centre is no longer over its supports", () => {
    const f = collapseFrom(g, [N, S, E]);
    assert.ok(indices(f).includes(ROOF));
    assert.equal(f.find((x) => x.index === ROOF)!.wave, 1);
  });
  it("never reports a removed part, and never drops a grounded one", () => {
    const f = collapseFrom(g, [N]);
    assert.ok(!indices(f).includes(N) && !indices(f).includes(FLOOR));
  });
  it("is the same however the removal is ordered", () => {
    assert.deepEqual(collapseFrom(g, [N, S, E]), collapseFrom(g, [E, S, N]));
  });
});

describe("two storeys", () => {
  // An upper floor on the walls, four more walls on it, the roof on those. 0 floor, 1-4 walls, 5 upper floor, 6-9 walls, 10 roof.
  const two = [
    ...house().slice(0, 5),
    part("floor", [0, 3.45, 0], [6.4, 0.3, 6.4]),
    part("wall", [0, 5.25, -2.9], [6, 3, 0.2]),
    part("wall", [0, 5.25, 2.9], [6, 3, 0.2]),
    part("wall", [2.9, 5.25, 0], [0.2, 3, 6]),
    part("wall", [-2.9, 5.25, 0], [0.2, 3, 6]),
    part("roof", [0, 7.05, 0], [6.4, 0.3, 6.4]),
  ];
  const g = buildSupportGraph(two);
  it("passes the loss up: a lost ground floor takes every storey with it, in order", () => {
    const f = collapseFrom(g, [0]);
    assert.deepEqual(indices(f), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const wave = (i: number): number => f.find((x) => x.index === i)!.wave;
    assert.ok(wave(1) < wave(5) && wave(5) < wave(6) && wave(6) < wave(10));
  });
  it("keeps the upper storey up when one lower wall goes", () => {
    assert.deepEqual(indices(collapseFrom(g, [1])), []);
  });
});

describe("parts the data leaves hanging", () => {
  it("bonds a part that rests on nothing to what it touches, and holds it only while a neighbour stands on the ground", () => {
    // A floor, a wall beside it with a gap beneath (rests on nothing), and a wall on top of that one.
    const ps = [part("floor", [0, 0.15, 0], [4, 0.3, 4]), part("wall", [2.1, 1.8, 0], [0.2, 3, 4]), part("wall", [2.1, 4.8, 0], [0.2, 3, 4])];
    const g = buildSupportGraph(ps);
    assert.deepEqual(g.stands, [true, true, true], "bonded to the floor it touches, and the upper wall rests on it");
    assert.ok(g.supporters[1]!.every((s) => s.kind === "bonded"));
    assert.deepEqual(indices(collapseFrom(g, [0])), [1, 2]);
  });
  it("does not let a ring of parts that only hold each other stand", () => {
    const ps = [part("wall", [0, 5, 0], [2, 1, 2]), part("wall", [2, 5, 0], [2, 1, 2]), part("wall", [4, 5, 0], [2, 1, 2])];
    assert.deepEqual(buildSupportGraph(ps).stands.some(Boolean), true, "the lowest part is the ground here");
    const g = buildSupportGraph([...ps, part("floor", [20, 0.15, 0], [4, 0.3, 4])], { groundY: 0 });
    assert.deepEqual(g.stands, [false, false, false, true], "nothing grounds the ring, so it floats in the data");
    assert.deepEqual(collapseFrom(g, [3]), [], "and does not fall: it was never up");
  });
});
