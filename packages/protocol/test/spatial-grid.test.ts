/**
 * Spatial containers (CF6): footprints, turning, placement checks, first fit, storage packing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canRotate, checkPlace, firstFit, gridFor, packPlacement, sizeOf, stamp, unpackPlacement } from "../src/spatial-grid.js";

const G = { columns: 4, rows: 3 };
const empty = () => new Array<number>(G.columns * G.rows).fill(0);

describe("footprints", () => {
  it("swap when turned, and only a non-square item can turn", () => {
    assert.deepEqual(sizeOf([1, 3], true), [3, 1]);
    assert.deepEqual(sizeOf([2, 2], true), [2, 2]);
    assert.equal(canRotate([1, 3]), true);
    assert.equal(canRotate([2, 2]), false);
  });
});

describe("checkPlace", () => {
  it("allows a free fit and names why not: outside, cannot turn, occupied", () => {
    const o = empty();
    assert.equal(checkPlace(G, o, [2, 2], { x: 0, y: 0, rot: false }), null);
    assert.equal(checkPlace(G, o, [2, 2], { x: 3, y: 0, rot: false }), "outside");
    assert.equal(checkPlace(G, o, [1, 4], { x: 0, y: 0, rot: false }), "outside", "too tall for 3 rows");
    assert.equal(checkPlace(G, o, [4, 1], { x: 0, y: 2, rot: false }), null);
    assert.equal(checkPlace(G, o, [2, 2], { x: 0, y: 0, rot: true }), "cannot-turn");
    stamp(G, o, [2, 2], { x: 1, y: 1, rot: false }, 7);
    assert.equal(checkPlace(G, o, [1, 1], { x: 2, y: 2, rot: false }), "occupied");
    assert.equal(checkPlace(G, o, [1, 1], { x: 3, y: 2, rot: false }), null);
    assert.equal(checkPlace(G, o, [2, 2], { x: 1, y: 1, rot: false }, 7), null, "an item does not block itself");
    assert.equal(checkPlace(G, o, [1, 1], { x: 1.5, y: 0, rot: false }), "outside", "whole cells only");
    assert.equal(checkPlace(G, o, [1, 1], { x: -1, y: 0, rot: false }), "outside");
  });

  it("turns a long item to fit where it cannot stand upright", () => {
    const o = empty();
    assert.equal(checkPlace(G, o, [1, 4], { x: 0, y: 0, rot: false }), "outside");
    assert.equal(checkPlace(G, o, [1, 4], { x: 0, y: 0, rot: true }), null, "4 wide, 1 tall: lies across the grid");
  });
});

describe("firstFit", () => {
  it("scans from the top left, turns only when upright does not fit, and says null when nothing does", () => {
    const o = empty();
    assert.deepEqual(firstFit(G, o, [2, 1]), { x: 0, y: 0, rot: false });
    stamp(G, o, [2, 1], { x: 0, y: 0, rot: false }, 1);
    assert.deepEqual(firstFit(G, o, [2, 1]), { x: 2, y: 0, rot: false });
    assert.deepEqual(firstFit(G, o, [1, 4]), { x: 0, y: 1, rot: true }, "no upright fit in 3 rows: turned, first free row");
    for (let i = 0; i < o.length; i++) o[i] = 9;
    assert.equal(firstFit(G, o, [1, 1]), null);
  });

  it("finds the gap a move leaves, ignoring the item itself", () => {
    const o = empty();
    stamp(G, o, [4, 3], { x: 0, y: 0, rot: false }, 5);
    assert.deepEqual(firstFit(G, o, [4, 3], 5), { x: 0, y: 0, rot: false });
    assert.equal(firstFit(G, o, [1, 1]), null);
  });
});

describe("storage", () => {
  it("makes a grid from a slot count and packs a placement into one integer", () => {
    assert.deepEqual(gridFor(24, 6), { columns: 6, rows: 4 });
    assert.deepEqual(gridFor(10, 4), { columns: 4, rows: 3 });
    assert.deepEqual(gridFor(3, 8), { columns: 3, rows: 1 });
    for (const p of [{ x: 0, y: 0, rot: false }, { x: 5, y: 3, rot: true }, { x: 2, y: 1, rot: false }]) {
      assert.deepEqual(unpackPlacement({ columns: 6, rows: 4 }, packPlacement({ columns: 6, rows: 4 }, p)), p);
    }
  });
});
