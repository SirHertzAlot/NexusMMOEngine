/**
 * The art overlay generator: matches prop kinds to a catalog's models by conservative name patterns. The catalogs here are
 * made up (nothing from the licensed art), so each test says exactly which names should and should not match.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUNGEON_ART_PATTERNS, matchProps, writeArtOverlay, type CatalogModel } from "../src/index.js";

const m = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id: `id-${name}`, name, ...extra });

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

describe("writeArtOverlay", () => {
  it("writes the overlay the server reads: version 1 and kind to model id, only the matched kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "art-"));
    const out = join(dir, "props.local.json");
    const { assets } = writeArtOverlay([m("SM_Prop_Barrel_01"), m("SM_Prop_Anvil_01")], ["barrel", "anvil", "urn"], out);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { version: 1, assets: { anvil: "id-SM_Prop_Anvil_01", barrel: "id-SM_Prop_Barrel_01" } });
    assert.deepEqual(Object.keys(assets).sort(), ["anvil", "barrel"]);
    writeFileSync(join(dir, "again.json"), "{}");
  });
});
