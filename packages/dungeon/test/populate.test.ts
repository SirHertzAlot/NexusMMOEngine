/**
 * Population: WFC picks who holds each room. Species belong to the theme
 * and the rank, bosses lead the boss room (and only it), kinds that can't
 * coexist never share a doorway, and every spawn point has a species.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindsCoexist, loadSpecies, type Roster } from "@mmo-engine/species";

const SAMPLE_PACK = loadSpecies();
import {
  bakeDungeons, BUILTIN_DRESSING, BUILTIN_THEMES, dressDungeon, generateDungeon, populateDungeon, readIndex,
  type Dungeon, type DungeonFile,
} from "../src/index.js";

const make = (seed: number, theme: string, rooms = 34): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);

const cases: [number, string, number][] = [];
for (const theme of Object.keys(BUILTIN_THEMES)) for (const rank of [1, 3, 5]) cases.push([rank * 71 + theme.length, theme, rank]);

describe("populateDungeon", () => {
  it("is deterministic", () => {
    const d = make(5, "grim");
    assert.deepEqual(populateDungeon(d, SAMPLE_PACK, 3, null), populateDungeon(d, SAMPLE_PACK, 3, null));
  });

  it("fills rooms with the theme's dwellers at the rank, a boss in the boss room, kinds apart", () => {
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme);
      const archetypes = dressDungeon(d, BUILTIN_DRESSING, rank).archetypes;
      const p = populateDungeon(d, SAMPLE_PACK, rank, archetypes);
      const at = `${theme} rank ${rank}`;
      assert.deepEqual(p.relaxed, [], `${at}: no rule loosened`);
      const withSpawns = new Set(d.spawns.map((s) => s.room));
      p.rooms.forEach((id, r) => {
        if (!withSpawns.has(r)) return assert.equal(id, "", `${at}: room ${r} has no spawns, so no one`);
        assert.ok(id, `${at}: room ${r} is held`);
        const sp = SAMPLE_PACK[id];
        assert.ok((sp.habitat.dungeon?.themes[theme] ?? 0) > 0, `${at}: ${id} haunts ${theme}`);
        assert.ok(rank >= sp.minRank, `${at}: ${id} from rank ${sp.minRank}`);
      });
      assert.ok(SAMPLE_PACK[p.rooms[d.boss]].boss, `${at}: a boss leads the boss room (${p.rooms[d.boss]})`);
      for (const e of d.corridors) {
        const [a, b] = [p.rooms[e.a], p.rooms[e.b]];
        if (a && b) assert.ok(kindsCoexist(SAMPLE_PACK[a].kind, SAMPLE_PACK[b].kind), `${at}: ${a} beside ${b}`);
      }
      assert.equal(p.spawns.length, d.spawns.length, `${at}: every spawn point has a species`);
      for (const s of p.spawns) assert.equal(s.species, p.rooms[s.room]);
    }
  });

  it("steps down, room by room, for a roster too thin, rather than fail", () => {
    const d = make(8, "molten");
    const thin: Roster = { goblin: { ...SAMPLE_PACK.goblin, habitat: { world: {}, dungeon: { themes: { molten: 1 }, depth: [0, 0.2] } }, tier: [1, 1] } };
    const p = populateDungeon(d, thin, 1, null);
    assert.ok(p.spawns.length > 0 && p.spawns.every((s) => s.species === "goblin"));
    assert.deepEqual(populateDungeon(d, {}, 1, null).spawns, [], "no roster, no one home");
  });

  it("is stored by the bake, with the boss and dwellers in the index", () => {
    const out = mkdtempSync(join(tmpdir(), "populated-"));
    const common = { count: 3, seed: 4, theme: "auto", rooms: [14, 24] as [number, number], loopChance: 0.15, decorDensity: 0.5, themes: BUILTIN_THEMES, out };
    bakeDungeons({ ...common, dress: { dressing: BUILTIN_DRESSING, rank: [2, 4] }, populate: { roster: SAMPLE_PACK } });
    for (const e of readIndex(out).dungeons) {
      const f = JSON.parse(readFileSync(join(out, e.file), "utf8")) as DungeonFile;
      assert.equal(f.population?.rooms[f.boss], e.boss);
      assert.equal(f.population?.spawns.length, e.dwellers);
      assert.ok(SAMPLE_PACK[e.boss!].boss);
    }
    const alone = mkdtempSync(join(tmpdir(), "populated-bare-"));
    bakeDungeons({ ...common, out: alone, populate: { roster: SAMPLE_PACK, rank: [5, 5] } });
    const e = readIndex(alone).dungeons[0];
    assert.equal(e.rank, 5);
    assert.equal(e.veins, undefined);
    assert.ok(e.boss);
  });
});
