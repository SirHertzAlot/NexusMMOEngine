/**
 * The generator: deterministic, every dungeon fully connected with one
 * entrance and one boss, difficulty rising from entrance to boss, and
 * everything placed on the right kind of cell.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_THEMES, CELL, generateDungeon, layoutHash, type Dungeon } from "../src/index.js";

const make = (seed: number, theme = "ancient", rooms = 30): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.15, decorDensity: 0.6, theme }, BUILTIN_THEMES[theme]);

describe("generateDungeon", () => {
  it("makes Dungeon Forge's dungeon for its default seed (golden vector)", () => {
    const d = make(1337, "ancient", 42);
    assert.equal(d.name, "The Sunken Undercroft of Ker’oth");
    assert.deepEqual([d.width, d.height], [101, 115]);
    assert.deepEqual(d.stats, { rooms: 42, corridors: 51, loops: 10, criticalPath: 11, floorTiles: 4618 });
    assert.equal(layoutHash(d), "7e1660dcd95c911e1513da1abaa1ed84ffca53713ba6c38298ea133aec1a2530");
  });

  it("refuses parameters it can't build from (fewer than 3 rooms would never finish)", () => {
    const t = BUILTIN_THEMES.ancient;
    for (const rooms of [0, 1, 2, 2.5]) assert.throws(() => generateDungeon({ seed: 1, rooms, loopChance: 0.1, decorDensity: 0.5, theme: "ancient" }, t), /rooms must be a whole number >= 3/);
    assert.throws(() => generateDungeon({ seed: 1, rooms: 10, loopChance: 2, decorDensity: 0.5, theme: "ancient" }, t), /loopChance/);
    assert.throws(() => generateDungeon({ seed: 1, rooms: 10, loopChance: 0.1, decorDensity: -1, theme: "ancient" }, t), /decorDensity/);
    assert.ok(generateDungeon({ seed: 1, rooms: 3, loopChance: 0.1, decorDensity: 0.5, theme: "ancient" }, t).valid, "3 rooms works");
  });

  it("gives the same layout for the same seed and a different one for another", () => {
    assert.equal(layoutHash(make(7)), layoutHash(make(7)));
    assert.notEqual(layoutHash(make(7)), layoutHash(make(8)));
  });

  it("connects every floor cell, with one entrance, one boss, and difficulty rising between them", () => {
    for (const theme of Object.keys(BUILTIN_THEMES)) {
      for (let seed = 1; seed <= 12; seed++) {
        const d = make(seed * 7919, theme, 12 + seed * 5);
        const at = `${theme} seed ${seed * 7919}`;
        assert.ok(d.valid, `${at}: connected`);
        let floor = 0;
        for (let c = 0; c < d.grid.length; c++) {
          if (d.grid[c] === CELL.floor) {
            floor++;
            assert.ok(d.distance[c] >= 0, `${at}: floor cell ${c} reachable`);
          } else assert.equal(d.distance[c], -1);
        }
        assert.equal(floor, d.stats.floorTiles);
        assert.equal(d.rooms.filter((r) => r.type === "entrance").length, 1, `${at}: one entrance`);
        assert.equal(d.rooms.filter((r) => r.type === "boss").length, 1, `${at}: one boss`);
        assert.equal(d.rooms[d.entrance].difficulty, 0);
        assert.equal(d.rooms[d.boss].difficulty, 1);
        for (const r of d.rooms) assert.ok(r.difficulty >= 0 && r.difficulty <= 1);
        assert.equal(d.corridors.filter((e) => !e.loop).length, d.rooms.length - 1, `${at}: a spanning tree plus loops`);
        assert.ok(d.corridors.some((e) => e.critical), `${at}: a critical path`);
        // The walls close the dungeon: no floor cell touches the void.
        for (let y = 0; y < d.height; y++)
          for (let x = 0; x < d.width; x++) {
            if (d.grid[y * d.width + x] !== CELL.floor) continue;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(d.grid[(y + dy) * d.width + x + dx], CELL.void);
          }
        for (const s of d.spawns) {
          const c = s.y * d.width + s.x;
          assert.equal(d.grid[c], CELL.floor, `${at}: spawn on floor`);
          assert.equal(d.roomId[c], s.room);
          assert.ok(["combat", "elite", "boss"].includes(d.rooms[s.room].type), `${at}: spawns in fighting rooms`);
          assert.ok(s.tier >= 1 && s.tier <= 3);
        }
        for (const t of d.torches) {
          assert.equal(d.grid[t.y * d.width + t.x], CELL.wall, `${at}: torch on a wall`);
          assert.equal(d.grid[(t.y + t.dy) * d.width + t.x + t.dx], CELL.floor, `${at}: facing floor`);
        }
      }
    }
  });

  it("dresses by theme: liquids in molten, lakes and icicles in frost, graves in grim, roots in verdant", () => {
    const kinds = (d: Dungeon): Set<string> => new Set(d.props.map((p) => p.kind));
    assert.ok(make(11, "molten", 40).pools.length > 0);
    assert.equal(make(11, "ancient", 40).pools.length, 0);
    const frost = make(11, "frost", 40);
    assert.ok(frost.lake.some((v) => v === 1) && kinds(frost).has("icicle"));
    assert.ok(kinds(make(11, "grim", 40)).has("grave"));
    assert.ok(kinds(make(11, "verdant", 40)).has("roots"));
  });
});
