/**
 * The layout mask adapter: a checked mask becomes the Dungeon the shell takes,
 * portals are cut open and listed, and rejects a malformed mask.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CELL } from "../src/generate.js";
import { dungeonFromLayout, layoutPortals, parseLayoutMask } from "../src/mask-layout.js";

const ROOM = [
  "#######",
  "#.....#",
  "#.....#",
  "#.....#",
  "#######",
];

describe("layout mask adapter", () => {
  it("maps floor, rock and pool cells, and finds the boss as the farthest floor cell", () => {
    const d = dungeonFromLayout(parseLayoutMask({ version: 1, rows: [...ROOM.slice(0, 1), "#.p...#", ...ROOM.slice(2)], entrance: { x: 1, y: 1 }, portals: [] }));
    assert.equal(d.grid[1 * 7 + 2], CELL.pool);
    assert.equal(d.grid[0], CELL.wall);
    assert.equal(d.distance[d.entrance], 0);
    assert.ok(d.maxDistance > 0);
    assert.equal(d.distance[d.boss], d.maxDistance);
  });

  it("cuts each portal open and lists it, on the same cell", () => {
    const rows = ["#####", "#...#", "#####", "#...#", "#####"];
    const layout = parseLayoutMask({ version: 1, rows, entrance: { x: 1, y: 1 }, portals: [{ id: "door-1", x: 2, y: 2, side: "y" }] });
    const d = dungeonFromLayout(layout);
    assert.equal(d.grid[2 * 5 + 2], CELL.floor, "the portal cell is open");
    assert.deepEqual(layoutPortals(layout), [{ id: "door-1", x: 2, y: 2, side: "y", kind: "door", width: 1, cells: [{ x: 2, y: 2 }] }]);
    // The shell's walkable cells are exactly the floor cells the grid now has, portal included.
    const walkable = [...d.grid].filter((g) => g === CELL.floor || g === CELL.pool).length;
    assert.equal(d.stats.floorTiles, walkable);
  });

  it("the portal is reachable from the entrance", () => {
    const rows = ["#####", "#...#", "#####", "#...#", "#####"];
    const d = dungeonFromLayout(parseLayoutMask({ version: 1, rows, entrance: { x: 1, y: 1 }, portals: [{ id: "d", x: 2, y: 2, side: "y" }] }));
    assert.ok(d.distance[2 * 5 + 2] >= 0, "reachable through the cut");
  });

  it("rejects a ragged mask, an entrance on rock, a portal on floor, and a repeated portal id", () => {
    assert.throws(() => parseLayoutMask({ version: 1, rows: ["###", "#.##", "###"], entrance: { x: 1, y: 1 } }), /same width/);
    assert.throws(() => parseLayoutMask({ version: 1, rows: ["###", "#.#", "###"], entrance: { x: 0, y: 0 } }), /entrance/);
    assert.throws(() => parseLayoutMask({ version: 1, rows: ["###", "#.#", "###"], entrance: { x: 1, y: 1 }, portals: [{ id: "p", x: 1, y: 1, side: "x" }] }), /solid wall/);
    assert.throws(
      () => parseLayoutMask({ version: 1, rows: ["#####", "#.#.#", "#####"], entrance: { x: 1, y: 1 }, portals: [{ id: "a", x: 2, y: 1, side: "x" }, { id: "a", x: 2, y: 1, side: "x" }] }),
      /repeats|solid wall/,
    );
  });
});
