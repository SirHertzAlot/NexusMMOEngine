/**
 * Shell levels: a cell on level L has its floor at L × levelStep. Pits (−1)
 * and daises (+1) built against the real geometry addon: each floor sits on
 * its level, a step between levels leaves a wall of the step's height, and a
 * shell with every cell on ground is the same shell as before levels.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BUILTIN_THEMES, CELL, dungeonShell, generateDungeon, SHELL_PARTS, type Dungeon, type GeometryOps } from "../src/index.js";
import { heightsAt, yRanges } from "./shell-support.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;

const STEP = 2;
const FLOOR = SHELL_PARTS.indexOf("floor");
const WALL = SHELL_PARTS.indexOf("wall");

const make = (seed: number): Dungeon => generateDungeon({ seed, rooms: 12, loopChance: 0.15, decorDensity: 0.6, theme: "ancient" }, BUILTIN_THEMES.ancient);

/** Rooms by id: every third room is a dais (+1), the next a pit (−1), the rest ground (0). Corridors stay ground. */
function levelsFor(d: Dungeon): Int8Array {
  const of = new Int8Array(d.width * d.height);
  for (let i = 0; i < of.length; i++) {
    const r = d.roomId[i];
    if (r < 0) continue;
    of[i] = r % 3 === 1 ? 1 : r % 3 === 2 ? -1 : 0;
  }
  return of;
}

describe("shell levels", () => {
  it("every floor cell's floor sits at its level", () => {
    const d = make(7);
    const levels = levelsFor(d);
    const s = dungeonShell(d, geo, { levels, levelStep: STEP });
    let checked = 0;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const i = y * d.width + x;
        if (d.grid[i] !== CELL.floor) continue;
        const h = heightsAt(s, FLOOR, (x + 0.5) * 2, (y + 0.5) * 2);
        assert.ok(h.includes(levels[i] * STEP), `cell ${x},${y} on level ${levels[i]}: floor heights ${h}`);
        checked++;
      }
    }
    assert.ok(checked > 0);
  });

  it("a step between levels leaves a wall the height of the step, up for a dais and down for a pit", () => {
    const d = make(7);
    const s = dungeonShell(d, geo, { levels: levelsFor(d), levelStep: STEP });
    const walls = yRanges(s, WALL);
    assert.ok(walls.some(([lo, hi]) => Math.abs(lo) < 1e-4 && Math.abs(hi - STEP) < 1e-4), "a dais wall from ground to the dais");
    assert.ok(walls.some(([lo, hi]) => Math.abs(lo + STEP) < 1e-4 && Math.abs(hi) < 1e-4), "a pit wall from the pit up to ground");
  });

  it("the inside surface's lowest point is the pit floor", () => {
    const d = make(7);
    const s = dungeonShell(d, geo, { levels: levelsFor(d), levelStep: STEP });
    assert.ok(Math.abs(s.bounds.min[1] + STEP) < 1e-4, `lowest point ${s.bounds.min[1]} is the pit floor at ${-STEP}`);
  });

  it("all cells on ground give the same shell as no levels", () => {
    const d = make(7);
    const plain = dungeonShell(d, geo);
    const ground = dungeonShell(d, geo, { levels: new Int8Array(d.width * d.height) });
    assert.equal(ground.stats.triangles, plain.stats.triangles);
    assert.deepEqual(ground.bounds, plain.bounds);
  });

  it("refuses a level map that does not match the layout", () => {
    const d = make(7);
    assert.throws(() => dungeonShell(d, geo, { levels: new Int8Array(3) }), /levels has 3 cells/);
  });
});
