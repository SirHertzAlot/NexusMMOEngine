import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemView } from "@mmo-engine/protocol";
import { dropVerdict, occupancyOf } from "../src/ui/bag-grid.js";

const G = { columns: 4, rows: 3, slots: 10 };
const item = (id: number, x: number, y: number, w: number, h: number, rot = false): ItemView => ({ id, def: "d", name: "n", base: "b", rank: "common", color: "#fff", hand: "none", stats: {}, durability: 1, model: "", at: { x, y, rot, w, h } });

describe("bag grid", () => {
  it("marks every covered cell, and closes the cells past the last slot", () => {
    const c = occupancyOf([item(1, 0, 0, 2, 2), item(2, 2, 0, 1, 2, false)], G);
    assert.deepEqual([c[0], c[1], c[4], c[5]], [1, 1, 1, 1]);
    assert.deepEqual([c[2], c[6]], [2, 2], "a 1x2 item at (2,0) covers cells 2 and 6");
    assert.ok(c[10] !== 0 && c[11] !== 0, "cells 10 and 11 do not exist");
  });
  it("predicts the server: free fits, over another or out of the grid does not, itself does not block", () => {
    const c = occupancyOf([item(1, 0, 0, 2, 2)], G);
    assert.equal(dropVerdict(G, c, [2, 2], { x: 2, y: 0, rot: false }, 1), null);
    assert.equal(dropVerdict(G, c, [2, 2], { x: 1, y: 0, rot: false }, 2), "occupied");
    assert.equal(dropVerdict(G, c, [2, 2], { x: 1, y: 0, rot: false }, 1), null, "its own cells do not block it");
  });
});
