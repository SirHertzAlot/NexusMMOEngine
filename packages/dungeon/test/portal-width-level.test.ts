/**
 * Portal width and target level. Width is how many wall cells the opening
 * takes, along the wall; every one of them is cut open and must be wall with
 * floor beside it. Target level is the floor level the portal leads to.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CELL, dungeonFromLayout, layoutPortals, parseLayoutMask, type LayoutMask } from "../src/index.js";

// Two rooms side by side with a wall column (x = 4) between them.
const ROWS = ["#########", "#...#...#", "#...#...#", "#...#...#", "#########"];
const raw = (portal: Record<string, unknown>) => ({ version: 1 as const, rows: ROWS, entrance: { x: 1, y: 1 }, portals: [{ id: "a", x: 4, y: 1, side: "x", ...portal }] });
const mask = (portal: Record<string, unknown>): LayoutMask => parseLayoutMask(raw(portal));

describe("portal width and target level", () => {
  it("width defaults to 1 and the portal reports its one cell", () => {
    const [p] = layoutPortals(mask({}));
    assert.equal(p.width, 1);
    assert.deepEqual(p.cells, [{ x: 4, y: 1 }]);
    assert.equal(p.targetLevel, undefined);
  });

  it("a width of 3 cuts three wall cells open, along the wall", () => {
    const m = mask({ width: 3 });
    const d = dungeonFromLayout(m);
    for (const y of [1, 2, 3]) assert.equal(d.grid[y * d.width + 4], CELL.floor, `cell 4,${y} is open`);
    assert.deepEqual(layoutPortals(m)[0].cells, [{ x: 4, y: 1 }, { x: 4, y: 2 }, { x: 4, y: 3 }]);
    assert.equal(d.stats.floorTiles, 9 + 9 + 3);
  });

  it("a wide portal on a north-south passage runs east-west", () => {
    const rows = ["#####", "#...#", "#####", "#...#", "#####"];
    const m = parseLayoutMask({ version: 1, rows, entrance: { x: 1, y: 1 }, portals: [{ id: "a", x: 1, y: 2, side: "y", width: 2 }] });
    assert.deepEqual(layoutPortals(m)[0].cells, [{ x: 1, y: 2 }, { x: 2, y: 2 }]);
  });

  it("refuses a width that runs off the wall or onto a cell with no floor beside it", () => {
    assert.throws(() => parseLayoutMask(raw({ width: 4 })), /portal a.*4,4/); // the fourth cell is the outer wall's corner
    assert.throws(() => parseLayoutMask(raw({ width: 0 })));
    assert.throws(() => parseLayoutMask(raw({ width: 1.5 })));
  });

  it("refuses two portals that share a cell", () => {
    const m = { version: 1 as const, rows: ROWS, entrance: { x: 1, y: 1 }, portals: [{ id: "a", x: 4, y: 1, side: "x", width: 2 }, { id: "b", x: 4, y: 2, side: "x" }] };
    assert.throws(() => parseLayoutMask(m), /portal b.*shares cell 4,2 with portal a/);
  });

  it("carries a target level, and refuses one that is not a whole level", () => {
    assert.equal(layoutPortals(mask({ kind: "stair", targetLevel: -1 }))[0].targetLevel, -1);
    assert.equal(layoutPortals(mask({ targetLevel: 2 }))[0].targetLevel, 2);
    assert.throws(() => parseLayoutMask(raw({ targetLevel: 0.5 })));
    assert.throws(() => parseLayoutMask(raw({ targetLevel: 99 })));
  });
});
