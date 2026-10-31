/**
 * Room interiors: the interior grammar lays each dressed room's walls and floor
 * from its footprint. The walls stand on the edges the dungeon closes and the
 * openings stay bare, the walls face into the room, and the bake records what
 * it laid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PLAN_CELLS } from "@mmo-engine/synthesis";
import {
  BUILTIN_DRESSING, BUILTIN_THEMES, CELL, DUNGEON_CELL, SHELL_DEFAULTS, bakeDungeons, decodeDungeon, dressDungeon,
  encodeDungeon, generateDungeon, loadInteriorContent, roomInteriors, roomPlan,
  type Dressing, type Dungeon, type DungeonFile, type RoomInterior,
} from "../src/index.js";
import { readOptions } from "../src/cli.js";

const CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../content/synthesis");
const content = loadInteriorContent(CONTENT);
const TOL = 1e-3;
/** The four sides of a cell, as the step each takes in (x, y). */
const SIDES: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

const make = (seed: number, theme = "grim", rooms = 34): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);

/** The first grim dungeon whose dressing lays an interior in one of its rooms. */
function laid(): { d: Dungeon; seed: number; archetypes: string[]; interiors: RoomInterior[] } {
  for (let seed = 1; seed <= 40; seed++) {
    const d = make(seed);
    const archetypes = dressDungeon(d, BUILTIN_DRESSING, 3).archetypes;
    const interiors = roomInteriors(d, archetypes, BUILTIN_DRESSING, content.styles, content.ruleSet, seed);
    if (interiors.length > 0) return { d, seed, archetypes, interiors };
  }
  throw new Error("no grim dungeon in 40 seeds lays an interior");
}

describe("roomPlan", () => {
  it("refuses a room the dungeon does not have", () => {
    assert.throws(() => roomPlan(make(1), 9999), /room 9999 has no cells/);
  });

  it("keeps every room's plan within the grammar's cap", () => {
    for (const seed of [1, 2, 3, 4]) {
      const d = make(seed, "grim", 48);
      for (const r of d.rooms) {
        const { grammar } = roomPlan(d, r.id);
        assert.ok(grammar.plan.length <= MAX_PLAN_CELLS && grammar.plan[0].length <= MAX_PLAN_CELLS, `room ${r.id} of seed ${seed}`);
      }
    }
  });
});

describe("room interiors", () => {
  it("walls stand on the room's closed edges and nowhere else, and face into the room", () => {
    const { d, interiors } = laid();
    let openings = 0;
    for (const ri of interiors) {
      const style = content.styles[ri.style];
      const cat = (feature: "floor" | "wall" | "door"): string => style.categories[feature] ?? feature;
      const size = d.rooms.find((r) => r.id === ri.room)!.size;
      const [ox, oz] = ri.origin;
      const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < d.width && y < d.height;
      const walkable = (x: number, y: number): boolean => {
        const v = d.grid[y * d.width + x];
        return v === CELL.floor || v === CELL.pool;
      };
      const inRoom = (x: number, y: number): boolean => d.roomId[y * d.width + x] === ri.room;
      const open = (x: number, y: number): boolean => inBounds(x, y) && walkable(x, y);

      // Cell x spans x to x + 1 cells: the origin is the footprint's centre, and the room spans minX to maxX + 1.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) {
          if (!inRoom(x, y)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      assert.ok(Math.abs(ox - ((minX + maxX + 1) / 2) * DUNGEON_CELL) < TOL, `room ${ri.room}: the origin is the footprint's centre (x)`);
      assert.ok(Math.abs(oz - ((minY + maxY + 1) / 2) * DUNGEON_CELL) < TOL, `room ${ri.room}: the origin is the footprint's centre (z)`);

      // Each floor cell's edges: into the room (no wall), onto another walkable cell (an opening), or closed.
      const floors: Array<[number, number]> = [];
      const closed: Array<{ at: [number, number]; into: [number, number] }> = [];
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) {
          if (!inRoom(x, y) || !walkable(x, y)) continue;
          floors.push([(x + 0.5) * DUNGEON_CELL - ox, (y + 0.5) * DUNGEON_CELL - oz]);
          for (const [dx, dy] of SIDES) {
            const nx = x + dx, ny = y + dy;
            if (open(nx, ny) && inRoom(nx, ny)) continue;
            if (open(nx, ny)) { openings++; continue; }
            closed.push({ at: [(x + 0.5 + dx / 2) * DUNGEON_CELL - ox, (y + 0.5 + dy / 2) * DUNGEON_CELL - oz], into: [-dx, -dy] });
          }
        }
      }

      const walls = ri.placements.filter((p) => p.category === cat("wall"));
      const floorParts = ri.placements.filter((p) => p.category === cat("floor"));
      assert.equal(floorParts.length, floors.length, `room ${ri.room}: one floor per walkable cell`);
      assert.equal(walls.length, closed.length, `room ${ri.room}: one wall per closed edge`);
      if (style.categories.door === "") {
        assert.ok(ri.placements.every((p) => p.category === cat("floor") || p.category === cat("wall")), `room ${ri.room}: an open archway lays no door`);
      }
      for (const [x, z] of floors) {
        assert.ok(floorParts.some((p) => Math.abs(p.transform.pos[0] - x) < TOL && Math.abs(p.transform.pos[2] - z) < TOL), `room ${ri.room}: a floor at ${x}, ${z}`);
      }
      for (const e of closed) {
        const wall = walls.find((p) => Math.abs(p.transform.pos[0] - e.at[0]) < TOL && Math.abs(p.transform.pos[2] - e.at[1]) < TOL);
        assert.ok(wall, `room ${ri.room}: a wall on the closed edge at ${e.at}`);
        const yaw = 2 * Math.atan2(wall.transform.rot[1], wall.transform.rot[3]);
        assert.ok(Math.abs(Math.sin(yaw) - e.into[0]) < TOL && Math.abs(Math.cos(yaw) - e.into[1]) < TOL, `room ${ri.room}: the wall at ${e.at} faces into the room`);
        assert.ok(Math.abs(wall.size[0] - DUNGEON_CELL) < TOL, `room ${ri.room}: a wall one cell long`);
        assert.ok(Math.abs(wall.size[1] - SHELL_DEFAULTS.roomHeight[size]) < TOL, `room ${ri.room}: as tall as the room's shell`);
        assert.ok(Math.abs(wall.transform.pos[1] - wall.size[1] / 2) < TOL, `room ${ri.room}: stands on the floor`);
      }
    }
    assert.ok(openings > 0, "some room opens onto its neighbours, so the openings are tested");
  });

  it("is deterministic: the same dungeon, archetypes and seed lay the same interiors", () => {
    const { d, seed, archetypes, interiors } = laid();
    assert.deepEqual(roomInteriors(d, archetypes, BUILTIN_DRESSING, content.styles, content.ruleSet, seed), interiors);
  });

  it("lays nothing where no archetype fits", () => {
    const { d, seed } = laid();
    assert.deepEqual(roomInteriors(d, d.rooms.map(() => ""), BUILTIN_DRESSING, content.styles, content.ruleSet, seed), []);
  });

  it("refuses an archetype whose style is not in the content", () => {
    const { d, seed, archetypes } = laid();
    const broken: Dressing = structuredClone(BUILTIN_DRESSING);
    for (const a of Object.values(broken.archetypes)) if (a.style) a.style = "missing";
    assert.throws(
      () => roomInteriors(d, archetypes, broken, content.styles, content.ruleSet, seed),
      /style "missing", which is not in content\/synthesis\/styles/,
    );
  });
});

describe("the dungeon file", () => {
  it("carries the interiors and gives them back as they went in", () => {
    const { d, interiors } = laid();
    const f = JSON.parse(JSON.stringify(encodeDungeon(d, dressDungeon(d, BUILTIN_DRESSING, 3), undefined, interiors))) as DungeonFile;
    assert.deepEqual(f.interiors, JSON.parse(JSON.stringify(interiors)));
    assert.equal("interiors" in decodeDungeon(f), false, "the layout does not carry the interiors");
  });

  it("has no interiors field when none were laid", () => {
    assert.equal("interiors" in encodeDungeon(make(1)), false);
  });
});

describe("bakeDungeons with interiors", () => {
  it("lays each dressed room's interior and counts them in the index", () => {
    const out = mkdtempSync(join(tmpdir(), "interiors-"));
    const r = bakeDungeons({
      count: 3, seed: 1, theme: "grim", rooms: [24, 34], loopChance: 0.15, decorDensity: 0.6, themes: BUILTIN_THEMES, out,
      dress: { dressing: BUILTIN_DRESSING, rank: [3, 3] }, interiors: content,
    });
    let laidRooms = 0;
    for (const entry of r.added) {
      const f = JSON.parse(readFileSync(join(out, entry.file), "utf8")) as DungeonFile;
      assert.equal(f.interiors?.length ?? 0, entry.interiors ?? 0, `${entry.id}: the index counts its interiors`);
      laidRooms += entry.interiors ?? 0;
    }
    assert.ok(laidRooms > 0, "some room is laid");
  });

  it("a bake without interiors lays none", () => {
    const r = bakeDungeons({
      count: 1, seed: 1, theme: "grim", rooms: [24, 34], loopChance: 0.15, decorDensity: 0.6, themes: BUILTIN_THEMES,
      out: mkdtempSync(join(tmpdir(), "interiors-")), dress: { dressing: BUILTIN_DRESSING, rank: [3, 3] },
    });
    assert.equal(r.added[0].interiors, undefined);
  });
});

describe("the CLI", () => {
  it("--no-interiors is a flag", () => {
    assert.equal(readOptions(["--no-interiors"], {})["no-interiors"], "true");
  });
});
