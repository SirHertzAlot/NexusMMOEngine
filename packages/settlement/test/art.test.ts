/**
 * Mapping structure kinds to the art catalog: name patterns per kind pick the
 * catalog's models, so a map can be built locally from the licensed catalog
 * without the model names ever living in the repo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildArtMap, DEFAULT_DRESSING_PATTERNS, type CatalogModel } from "../src/index.js";

const models: CatalogModel[] = [
  { id: "pack/SM_Bld_Preset_House_02_Optimized", name: "SM_Bld_Preset_House_02_Optimized", skinned: false },
  { id: "pack/SM_Bld_Preset_House_03_Optimized", name: "SM_Bld_Preset_House_03_Optimized", skinned: false },
  { id: "pack/SM_Bld_Preset_House_03_Glass_Optimized", name: "SM_Bld_Preset_House_03_Glass_Optimized", skinned: false },
  { id: "pack/SM_Bld_Preset_Tavern_01_Optimized", name: "SM_Bld_Preset_Tavern_01_Optimized", skinned: false },
  { id: "pack/SK_Chr_Tavern_Keeper_01", name: "SK_Chr_Tavern_Keeper_01", skinned: true },
  { id: "pack/SM_Prop_Barrel_01", name: "SM_Prop_Barrel_01", skinned: false },
];

describe("buildArtMap", () => {
  it("lists the models whose names match a kind's patterns, never skinned characters or glass panes", () => {
    const map = buildArtMap(models, { house: ["Preset_House_\[0-9]+_Optimized$"], tavern: ["Preset_Tavern"], chapel: ["Preset_Church"] });
    assert.deepEqual(map.house, ["pack/SM_Bld_Preset_House_02_Optimized", "pack/SM_Bld_Preset_House_03_Optimized"]);
    assert.deepEqual(map.tavern, ["pack/SM_Bld_Preset_Tavern_01_Optimized"]);
    assert.equal("chapel" in map, false, "a kind with no match is left out, so it stays a box");
  });

  it("maps farm dressing from whole names, case-insensitively, on synthetic entries", () => {
    const farm: CatalogModel[] = ["Pumpkin", "Wheelbarrow", "Watering_can", "Field_of_wheat", "Picket_fence", "Barn", "Pumpkin_seed"].map((n) => ({ id: `farm/${n}`, name: n, skinned: false }));
    const map = buildArtMap(farm, DEFAULT_DRESSING_PATTERNS, "i");
    assert.deepEqual(map.farm_produce, ["farm/Pumpkin"], "seed is not produce on the table");
    assert.deepEqual(map.farm_tools, ["farm/Watering_can", "farm/Wheelbarrow"]);
    assert.deepEqual(map.farm_crops, ["farm/Field_of_wheat"]);
    assert.deepEqual(map.farm_yard, ["farm/Barn", "farm/Picket_fence"]);
    assert.equal("camp_props" in map, false);
  });

  it("is sorted and so the same every time", () => {
    const a = buildArtMap([...models].reverse(), { house: ["Preset_House"] });
    assert.deepEqual(a, buildArtMap(models, { house: ["Preset_House"] }));
  });
});
