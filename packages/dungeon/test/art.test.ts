/**
 * The art overlay generator: matches prop kinds to a catalog's models by conservative name patterns. The catalogs here are
 * made up (nothing from the licensed art), so each test says exactly which names should and should not match.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUNGEON_ART_PATTERNS, matchProps, nameWords, writeArtOverlay, type CatalogModel } from "../src/index.js";

const m = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id: `id-${name}`, name, ...extra });

describe("nameWords", () => {
  it("splits at separators and camelCase joins, lower-cases, and drops numbers", () => {
    assert.deepEqual(nameWords("SM_Prop_WeaponRack_01"), ["sm", "prop", "weapon", "rack"]);
    assert.deepEqual(nameWords("Weapon_Rack"), ["weapon", "rack"]);
    assert.deepEqual(nameWords("Caterpillar"), ["caterpillar"]);
  });
});

describe("matchProps", () => {
  const kinds = ["weapon-rack", "barrel", "chest", "cage", "urn", "desk", "table", "candles", "sarcophagus"];

  it("matches by the kind's own words, and picks the first by name (the same for any input order)", () => {
    const models = [m("SM_Prop_WeaponRack_02"), m("SM_Prop_WeaponRack_01"), m("SM_Prop_Barrel_01")];
    const got = matchProps(models, kinds);
    assert.equal(got.assets["weapon-rack"], "id-SM_Prop_WeaponRack_01");
    assert.equal(got.assets.barrel, "id-SM_Prop_Barrel_01");
    assert.deepEqual(matchProps([...models].reverse(), kinds).assets, got.assets);
    assert.equal(got.contact.find((c) => c.kind === "weapon-rack")!.candidates, 2);
  });

  it("does not take a near miss: lids, plate armour, bones, speakers, particles", () => {
    const got = matchProps(
      [m("SM_Prop_Chest_01_Lid"), m("SM_Item_ChestPlate_01"), m("SM_Env_Bone_Ribcage_01"), m("SM_Env_Minetrack_Turn_01"), m("Wall_desk_speakers"), m("SM_Prop_Skeleton_Table_01"), m("SM_Prop_Candles_01_Particle")],
      kinds,
    );
    for (const k of ["chest", "cage", "urn", "desk", "table", "candles"]) assert.equal(got.assets[k], undefined, `${k} stays procedural`);
    assert.ok(got.unmatched.includes("chest") && got.unmatched.includes("candles"));
  });

  it("matches whole words: a Caterpillar is no pillar, a Crater no crate, the Stables no table, a candlestick no candles, a fountain's statue no statue", () => {
    const got = matchProps(
      [m("Caterpillar"), m("SM_Env_Ground_Crater_01"), m("SM_Bld_Preset_Stables_01"), m("FX_Item_Candlestick_01"), m("SM_Env_Fountain_Statue_01"), m("SM_Bld_Castle_Rubble_01")],
      ["pillar", "crate", "table", "candles", "statue", "rubble"],
    );
    assert.deepEqual(got.assets, {}, "nothing matches: all six stay procedural");
    const ok = matchProps([m("SM_Env_Pillar_01"), m("SM_Prop_Crate_Metal_01"), m("SM_Prop_Table_Long_01"), m("SM_Prop_Candles_01"), m("SM_Env_Statue_01"), m("SM_Env_Rubble_01")], ["pillar", "crate", "table", "candles", "statue", "rubble"]);
    assert.equal(Object.keys(ok.assets).length, 6, "the real ones match");
  });

  it("then takes the plain model beside the near misses", () => {
    const got = matchProps([m("SM_Prop_Chest_01_Lid"), m("SM_Prop_Chest_01"), m("SM_Prop_Table_01"), m("SM_Prop_Skeleton_Table_01")], kinds);
    assert.equal(got.assets.chest, "id-SM_Prop_Chest_01");
    assert.equal(got.assets.table, "id-SM_Prop_Table_01");
  });

  it("skips skinned models and leaves kinds with no pattern procedural", () => {
    const got = matchProps([m("SM_Prop_Barrel_01", { skinned: true }), m("SM_Sarcophagus_01")], kinds);
    assert.equal(got.assets.barrel, undefined);
    assert.equal(got.assets.sarcophagus, undefined, "no pattern: always procedural");
    assert.ok(!("sarcophagus" in DUNGEON_ART_PATTERNS));
    assert.ok(got.unmatched.includes("sarcophagus") && got.unmatched.includes("barrel"));
  });
});

describe("size factors", () => {
  it("scales a model to a real one's size by its longest side, and leaves a right-sized or unknown one alone", () => {
    const got = matchProps(
      [m("SM_Prop_Coffin_01", { size: [1.0, 0.19, 0.45] }), m("SM_Prop_Barrel_01", { size: [0.98, 1.0, 0.98] }), m("SM_Env_Statue_01", { size: [3.06, 4.48, 3.06] }), m("SM_Prop_Anvil_01")],
      ["coffin", "barrel", "statue", "anvil", "torch"],
    );
    assert.equal(got.scales.coffin, 2, "a 1 m coffin is drawn twice as big");
    assert.equal(got.scales.barrel, undefined, "within 5% of a barrel: no factor");
    assert.equal(got.scales.statue, 0.62, "a 4.5 m statue is brought down to 2.8 m");
    assert.equal(got.scales.anvil, undefined, "no size in the catalog: its own");
    assert.equal(got.scales.torch, undefined);
  });
});

describe("writeArtOverlay", () => {
  it("writes the overlay the server reads: version 1 and kind to model id, only the matched kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "art-"));
    const out = join(dir, "props.local.json");
    const { assets } = writeArtOverlay([m("SM_Prop_Barrel_01"), m("SM_Prop_Anvil_01")], ["barrel", "anvil", "urn"], out);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { version: 1, assets: { anvil: "id-SM_Prop_Anvil_01", barrel: "id-SM_Prop_Barrel_01" }, scales: {} });
    assert.deepEqual(Object.keys(assets).sort(), ["anvil", "barrel"]);
    writeFileSync(join(dir, "again.json"), "{}");
  });
});
