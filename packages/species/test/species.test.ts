/**
 * Species: the sample pack (content/species) holds the ecology as data —
 * demons manifest only in dungeons, organics and beasts carry open-world
 * needs, the dead and the otherworldly carry dungeon-scoped essence needs.
 * No species rows live in engine source (proposal invariant 1). A game's
 * file merges over the sample pack and is checked; the world's spawn
 * tables draw only what lives in a biome (legacy path for world weights).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kindsCoexist,
  loadNeedCatalog,
  loadSpecies,
  loadSpeciesPack,
  pickWorldPack,
  suitability,
  worldSpawnTable,
} from "../src/index.js";

const mulberry = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("species", () => {
  it("the sample pack loads from content/species: 19 species, all with needs, all need ids resolve", () => {
    const { roster, catalog } = loadSpeciesPack();
    assert.equal(Object.keys(roster).length, 19);
    for (const [id, sp] of Object.entries(roster)) {
      assert.equal(sp.needs.speciesId, id, `${id}: needs.speciesId matches the roster key`);
      assert.ok(Object.keys(sp.needs.needs).length > 0, `${id}: declares at least one need`);
      for (const needId of Object.keys(sp.needs.needs)) {
        assert.ok(catalog.byId.has(needId), `${id}: unknown need id ${needId}`);
      }
    }
  });

  it("keep the ecology: demons only in dungeons, organics and beasts open-world, the dead and the otherworldly below", () => {
    const roster = loadSpecies();
    for (const [id, sp] of Object.entries(roster)) {
      const openWorld = Object.keys(sp.needs.needs).some((n) => !n.startsWith("need:essence."));
      const below = !!sp.habitat.dungeon && Object.values(sp.habitat.dungeon.themes).some((w) => w > 0);
      if (sp.kind === "demon") assert.ok(!openWorld && below, `${id}: demons only in dungeons`);
      if (sp.kind === "organic" || sp.kind === "beast") assert.ok(openWorld, `${id}: lives in the open world`);
      if (sp.kind === "undead" || sp.kind === "otherworldly") assert.ok(!openWorld && below, `${id}: dwells in dungeons`);
      if (sp.kind === "demon") assert.ok(sp.sustenance.includes("emotion") || sp.sustenance.includes("lifeforce"), `${id}: feeds on emotion or lifeforce`);
    }
  });

  it("dungeon dwellers score 0 in the open world and above 0 where their essence is supplied", () => {
    const { roster, catalog } = loadSpeciesPack();
    const openWorld = { "water.fresh": 0.5, "water.salinity": 0, temperature: 0.4, "dungeon.essence": 0 };
    const crypt = { "water.fresh": 0, "water.salinity": 0, temperature: 0.2, "dungeon.essence": 0.9 };
    const pos = { x: 0, z: 0 };
    for (const [id, sp] of Object.entries(roster)) {
      if (sp.kind !== "undead" && sp.kind !== "demon" && sp.kind !== "otherworldly") continue;
      assert.equal(suitability(catalog, sp.needs, pos, openWorld), 0, `${id}: never in the open world`);
      assert.ok(suitability(catalog, sp.needs, pos, crypt) > 0, `${id}: satisfiable where its essence is`);
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

  it("merge a game's file over the sample pack, and list every problem in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "species-"));
    const base = loadSpecies();
    assert.equal(Object.keys(base).length, 19);
    const needsOf = (id: string) => base[id].needs;
    const koboldNeeds = { ...needsOf("goblin"), speciesId: "kobold" };
    const good = join(dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({
        kobold: { name: "Kobold", kind: "organic", sustenance: ["food"], needs: koboldNeeds },
      }),
    );
    const g = loadSpecies(good);
    assert.ok(g.kobold && g.goblin);
    assert.equal(Object.keys(g).length, 20);
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        fiend: { name: "Fiend", kind: "demon", sustenance: ["emotion"], needs: needsOf("fiend"), habitat: { world: { forest: 1 } }, pack: [3, 1] },
      }),
    );
    assert.throws(() => loadSpecies(bad), (e: Error) => /demons manifest only in dungeons/.test(e.message) && /pack: min above max/.test(e.message));
    const typo = join(dir, "typo.json");
    writeFileSync(typo, JSON.stringify({ imp: { name: "Imp", kind: "devil" } }));
    assert.throws(() => loadSpecies(typo), /imp\.kind/);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    assert.throws(() => loadSpecies(broken), /broken\.json/);
    const mismatchNeeds = { ...needsOf("goblin"), speciesId: "goblin" };
    const mismatch = join(dir, "mismatch.json");
    writeFileSync(mismatch, JSON.stringify({ kobold: { name: "Kobold", kind: "organic", sustenance: ["food"], needs: mismatchNeeds } }));
    assert.throws(() => loadSpecies(mismatch), /kobold\.needs\.speciesId/);
    const unknownNeed = join(dir, "unknown-need.json");
    const tuned = structuredClone(needsOf("goblin"));
    tuned.needs["need:nope.missing"] = { weight: 1, tolerance: 0.5 };
    writeFileSync(unknownNeed, JSON.stringify({ kobold: { name: "Kobold", kind: "organic", sustenance: ["food"], needs: tuned } }));
    assert.throws(() => loadSpecies(unknownNeed, loadNeedCatalog()), /unknown need id need:nope\.missing/);
    const badVersion = join(dir, "bad-version.json");
    const v2 = { ...structuredClone(needsOf("goblin")), schemaVersion: 2 };
    writeFileSync(badVersion, JSON.stringify({ kobold: { name: "Kobold", kind: "organic", sustenance: ["food"], needs: v2 } }));
    assert.throws(() => loadSpecies(badVersion), /schemaVersion/);
  });

  it("draw world packs only from what lives in a biome, by weight, within pack sizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "species-w-"));
    const file = join(dir, "w.json");
    const wolfNeeds = loadSpecies().wolf.needs;
    writeFileSync(
      file,
      JSON.stringify({
        hillfox: { name: "Hillfox", kind: "beast", sustenance: ["food"], needs: { ...wolfNeeds, speciesId: "hillfox" }, habitat: { world: { hills: 2 } }, pack: [2, 3], tier: [1, 1] },
        dalefox: { name: "Dalefox", kind: "beast", sustenance: ["food"], needs: { ...wolfNeeds, speciesId: "dalefox" }, habitat: { world: { hills: 1 } }, pack: [1, 1], tier: [1, 1] },
      }),
    );
    const g = loadSpecies(file);
    const table = worldSpawnTable(g, "hills");
    assert.deepEqual(table.map((e) => e.id).sort(), ["dalefox", "hillfox"]);
    assert.ok(table.every((e) => g[e.id].kind !== "demon"), "hills: no demons");
    const r = mulberry(5);
    const seen = new Map<string, number>();
    for (let k = 0; k < 2000; k++) {
      const p = pickWorldPack(g, "hills", r)!;
      const sp = g[p.id];
      assert.ok((sp.habitat.world.hills ?? 0) > 0, `hills: ${p.id} lives there`);
      assert.ok(p.count >= sp.pack[0] && p.count <= sp.pack[1], `${p.id}: pack of ${p.count}`);
      seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
    }
    const total = table.reduce((t, e) => t + e.weight, 0);
    for (const e of table) assert.ok(Math.abs((seen.get(e.id) ?? 0) / 2000 - e.weight / total) < 0.05, `hills: ${e.id} drawn by weight`);
    assert.equal(pickWorldPack(g, "nowhere", Math.random), null);
  });
});
