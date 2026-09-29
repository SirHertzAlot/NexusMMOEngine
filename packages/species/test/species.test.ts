/**
 * Species: the built-in roster holds the ecology (demons only in dungeons,
 * organics in the open world, the undead and the otherworldly below), a
 * game's file merges over it and is checked, and the world's spawn tables
 * draw only what lives in a biome.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SPECIES, kindsCoexist, loadSpecies, pickWorldPack, worldSpawnTable } from "../src/index.js";

const mulberry = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("species", () => {
  it("keep the ecology: demons manifest only in dungeons, organics roam the world, the dead and the otherworldly dwell below", () => {
    for (const [id, sp] of Object.entries(BUILTIN_SPECIES)) {
      const world = Object.values(sp.habitat.world).some((w) => w > 0);
      const below = !!sp.habitat.dungeon && Object.values(sp.habitat.dungeon.themes).some((w) => w > 0);
      if (sp.kind === "demon") assert.ok(!world && below, `${id}: demons only in dungeons`);
      if (sp.kind === "organic") assert.ok(world, `${id}: organics live in the open world`);
      if (sp.kind === "undead" || sp.kind === "otherworldly") assert.ok(!world && below, `${id}: dwells in dungeons`);
      if (sp.kind === "demon") assert.ok(sp.sustenance.includes("emotion") || sp.sustenance.includes("lifeforce"), `${id}: feeds on emotion or lifeforce`);
    }
  });

  it("keep the living apart from demons and the dead", () => {
    assert.equal(kindsCoexist("organic", "demon"), false);
    assert.equal(kindsCoexist("demon", "organic"), false);
    assert.equal(kindsCoexist("organic", "undead"), false);
    assert.equal(kindsCoexist("beast", "demon"), false);
    assert.equal(kindsCoexist("undead", "demon"), true);
    assert.equal(kindsCoexist("organic", "beast"), true);
  });

  it("merge a game's file over ours, and list every problem in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "species-"));
    assert.equal(loadSpecies(), BUILTIN_SPECIES);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ kobold: { name: "Kobold", kind: "organic", sustenance: ["food"], habitat: { world: { hills: 2 } } } }));
    const g = loadSpecies(good);
    assert.ok(g.kobold && g.goblin);
    assert.deepEqual(worldSpawnTable(g, "hills").find((e) => e.id === "kobold"), { id: "kobold", weight: 2 });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ fiend: { name: "Fiend", kind: "demon", sustenance: ["emotion"], habitat: { world: { forest: 1 } }, pack: [3, 1] } }));
    assert.throws(() => loadSpecies(bad), (e: Error) => /demons manifest only in dungeons/.test(e.message) && /pack: min above max/.test(e.message));
    const typo = join(dir, "typo.json");
    writeFileSync(typo, JSON.stringify({ imp: { name: "Imp", kind: "devil" } }));
    assert.throws(() => loadSpecies(typo), /imp\.kind/);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    assert.throws(() => loadSpecies(broken), /broken\.json/);
  });

  it("draw world packs only from what lives in a biome, by weight, within pack sizes", () => {
    const biomes = new Set(Object.values(BUILTIN_SPECIES).flatMap((sp) => Object.keys(sp.habitat.world)));
    assert.ok(biomes.size > 0);
    for (const biome of biomes) {
      const table = worldSpawnTable(BUILTIN_SPECIES, biome);
      assert.ok(table.length > 0 && table.every((e) => BUILTIN_SPECIES[e.id].kind !== "demon"), `${biome}: no demons`);
      const r = mulberry(biome.length);
      const seen = new Map<string, number>();
      for (let k = 0; k < 2000; k++) {
        const p = pickWorldPack(BUILTIN_SPECIES, biome, r)!;
        const sp = BUILTIN_SPECIES[p.id];
        assert.ok((sp.habitat.world[biome] ?? 0) > 0, `${biome}: ${p.id} lives there`);
        assert.ok(p.count >= sp.pack[0] && p.count <= sp.pack[1], `${p.id}: pack of ${p.count}`);
        seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
      }
      const total = table.reduce((t, e) => t + e.weight, 0);
      for (const e of table) assert.ok(Math.abs((seen.get(e.id) ?? 0) / 2000 - e.weight / total) < 0.05, `${biome}: ${e.id} drawn by weight`);
    }
    assert.equal(pickWorldPack(BUILTIN_SPECIES, "nowhere", Math.random), null);
  });
});
