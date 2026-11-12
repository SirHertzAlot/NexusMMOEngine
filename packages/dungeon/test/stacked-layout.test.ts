/**
 * Stacked layouts: two floor levels joined by a stair. The merged Dungeon
 * walks up the stair, the level map feeds the shell, and the shell has the
 * stair's step as a wall. Bad stacks are refused with the reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dungeonShell, stackedDungeon, SHELL_PARTS, type GeometryOps } from "../src/index.js";
import { yRanges } from "./shell-support.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;

// Ground: a room, and one floor cell (4, 2) that is the stair's foot. Upper: a room whose west edge is (5, 2).
const GROUND = ["#########", "#...#####", "#....####", "#...#####", "#########"];
const UPPER = ["#########", "#########", "#####...#", "#####...#", "#########"];
const stack = (over: Record<string, unknown> = {}) => ({
  version: 1,
  levels: [
    { level: 0, rows: GROUND },
    { level: 1, rows: UPPER },
  ],
  entrance: { x: 1, y: 1 },
  stairs: [{ id: "s1", x: 4, y: 2, from: 0, to: 1 }],
  ...over,
});

describe("stacked layouts", () => {
  it("merges two levels, tags each cell with its level, and reports the stair", () => {
    const st = stackedDungeon(stack());
    const W = 9;
    assert.equal(st.levels[1 * W + 1], 0, "ground cell");
    assert.equal(st.levels[2 * W + 6], 1, "upper cell");
    assert.deepEqual(st.stairs[0].from, { x: 4, y: 2, level: 0 });
    assert.deepEqual(st.stairs[0].to, { x: 5, y: 2, level: 1 });
  });

  it("walks up the stair: upper cells are reachable from the entrance", () => {
    const st = stackedDungeon(stack());
    const W = 9;
    assert.ok(st.dungeon.distance[2 * W + 6] > 0, "upper cell has a walking distance");
  });

  it("the shell has the stair's step as a wall of the level's height", () => {
    const st = stackedDungeon(stack());
    const s = dungeonShell(st.dungeon, geo, { levels: st.levels });
    const WALL = SHELL_PARTS.indexOf("wall");
    assert.ok(yRanges(s, WALL).some(([lo, hi]) => Math.abs(lo) < 1e-4 && Math.abs(hi - 2) < 1e-4), "a wall from ground to the upper level");
  });

  it("refuses a column on two levels", () => {
    assert.throws(() => stackedDungeon(stack({ levels: [{ level: 0, rows: GROUND }, { level: 1, rows: GROUND }] })), /on levels 0 and 1/);
  });

  it("refuses levels that touch with no stair between them", () => {
    assert.throws(() => stackedDungeon(stack({ stairs: [] })), /touch with no stair/);
  });

  it("refuses a stair with no neighbour on its target level", () => {
    assert.throws(() => stackedDungeon(stack({ stairs: [{ id: "s1", x: 1, y: 2, from: 0, to: 1 }] })), /needs floor of level 1 beside it/);
  });

  it("refuses an entrance off level 0", () => {
    assert.throws(() => stackedDungeon(stack({ entrance: { x: 6, y: 2 } })), /entrance must be on level 0/);
  });
});
