/**
 * Model coverage (SG13): every kind the generator can emit that the local art catalog can dress is dressed, and the
 * kinds left as boxes are named here, so a new kind (or a changed pattern) cannot silently leave a town of boxes.
 * The catalog is the licensed art (git-ignored, MMO_CATALOG or <repo>/assets/catalog.json): without it these skip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ART_PATTERNS, DEFAULT_PROP_PATTERNS, buildArtMap, buildPlaceArtMap, FORTIFICATION_KINDS, type CatalogModel } from "../src/art.js";
import { BUILTIN_RULES, PROP_KINDS } from "../src/rules.js";
import { PLACE_LOOKS } from "../src/places-scene.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const catalogPath = process.env.MMO_CATALOG ?? resolve(REPO, "assets/catalog.json");
const have = existsSync(catalogPath);
const models = have ? (JSON.parse(readFileSync(catalogPath, "utf8")) as { models: CatalogModel[] }).models : [];

/** Kinds the packs have no model for, as of the catalog this was written against: they stay boxes. */
const NO_MODEL = ["mine", "fish_rack", "fishing_spot"];

describe("place art map", () => {
  const named = (n: string): CatalogModel => ({ id: `p/${n}`, name: n, skinned: false });
  const cat = ["SM_Bld_Preset_House_07_Optimized", "SM_Bld_Preset_Outhouse_01_Optimized", "SM_Bld_Preset_Hut_01_Optimized", "SM_Bld_Preset_Tavern_01_Optimized", "Tent", "Field_of_wheat", "Pitchfork", "Barn", "Pumpkin", "SM_Bld_Preset_Hut_02_Optimized"].map(named);
  const map = buildPlaceArtMap(cat);
  it("dresses each place kind from its own patterns and the farm dressing", () => {
    assert.deepEqual(map.guard_outpost, ["p/SM_Bld_Preset_House_07_Optimized"]);
    assert.deepEqual(map.shack, ["p/SM_Bld_Preset_Outhouse_01_Optimized"], "a model no town kind uses, so it cannot shrink a home");
    assert.deepEqual(map.farmhouse, ["p/SM_Bld_Preset_Hut_01_Optimized"]);
    assert.deepEqual(map.roadside_inn, ["p/SM_Bld_Preset_Tavern_01_Optimized"]);
    assert.deepEqual(map.camp_site, ["p/Tent"]);
    assert.deepEqual(map.farm_field, ["p/Field_of_wheat"]);
    assert.deepEqual(map.farm_tools, ["p/Pitchfork"]);
    assert.deepEqual(map.farm_yard, ["p/Barn"]);
    assert.deepEqual(map.farm_produce, ["p/Pumpkin"]);
  });
  it("leaves a place with no model out, so it stays a box", () => {
    assert.equal("ranch_pen" in map, false);
  });
});

describe("model coverage against the local art catalog", { skip: !have && "no art catalog here (the licensed art is git-ignored)" }, () => {
  const map = { ...buildArtMap(models, DEFAULT_ART_PATTERNS), ...buildArtMap(models, DEFAULT_PROP_PATTERNS, "i") };
  const dressed = (k: string): boolean => (map[k]?.length ?? 0) > 0;

  it("dresses every structure, wall and prop kind except the named few", () => {
    const kinds = [...new Set([...Object.keys(BUILTIN_RULES.archetypes), ...FORTIFICATION_KINDS, ...PROP_KINDS, "town_well", "stair_step", "tree_stand", "ore_vein"])];
    const bare = kinds.filter((k) => !dressed(k));
    assert.deepEqual(bare.filter((k) => !NO_MODEL.includes(k)), [], "a kind lost its model (or is new): map it, or name it in NO_MODEL on purpose");
    assert.deepEqual(NO_MODEL.filter((k) => dressed(k)), [], "a kind in NO_MODEL has a model now: take it off the list");
  });

  it("dresses the places between the towns", () => {
    const places = buildPlaceArtMap(models);
    const kinds = Object.values(PLACE_LOOKS).map((l) => l.kind);
    const bare = kinds.filter((k) => !(places[k]?.length));
    // a ranch's pen has no model in the packs
    assert.deepEqual(bare.filter((k) => k !== "ranch_pen"), []);
  });
});
