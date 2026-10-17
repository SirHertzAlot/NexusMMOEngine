/**
 * Mapping structure kinds to the art catalog: name patterns per kind pick the
 * catalog's models, so a map can be built locally from the licensed catalog
 * without the model names ever living in the repo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildArtMap, DEFAULT_ART_PATTERNS, DEFAULT_DRESSING_PATTERNS, DEFAULT_PROP_PATTERNS, PROP_KINDS, FORTIFICATION_KINDS, FORTIFICATION_NAME, type CatalogModel } from "../src/index.js";

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

  it("maps street furniture case-insensitively, on synthetic entries, a pattern for every prop kind", () => {
    for (const k of PROP_KINDS) assert.ok(DEFAULT_PROP_PATTERNS[k], k);
    const props: CatalogModel[] = ["SM_Prop_Street_Lamp_01", "SM_Prop_Bench_02", "SM_Prop_Fountain_01", "SM_Prop_Statue_03", "SM_Prop_Barrel_01", "SM_Prop_Crate_02", "SM_Prop_FlowerBox_01", "SM_Prop_Stairs_01", "SM_Prop_Barrel_Lid_01", "SM_Prop_LogPile_01", "SM_Prop_MineCart_01", "SM_Prop_Fish_Rack_01", "SM_Prop_Sack_Grain_02", "SM_Prop_Banner_01"].map((n) => ({ id: `pack/${n}`, name: n, skinned: false }));
    const map = buildArtMap(props, DEFAULT_PROP_PATTERNS, "i");
    assert.deepEqual(map.street_lamp, ["pack/SM_Prop_Street_Lamp_01"]);
    assert.deepEqual(map.barrel, ["pack/SM_Prop_Barrel_01"], "a barrel's lid is not a barrel");
    assert.deepEqual(map.planter, ["pack/SM_Prop_FlowerBox_01"]);
    assert.deepEqual(map.stair_step, ["pack/SM_Prop_Stairs_01"]);
    for (const k of ["bench", "fountain", "statue", "crate", "log_pile", "ore_cart", "fish_rack", "grain_sacks", "guild_banner"]) assert.equal(map[k]!.length, 1, k);
  });

  it("never gives a building a wall, gate, tower or archway model, and gives those to the wall's kinds", () => {
    const named = (n: string): CatalogModel => ({ id: `pack/${n}`, name: n, skinned: false });
    const pack = ["SM_Bld_Preset_House_02_Optimized", "SM_Bld_Preset_House_Archway_01_Optimized", "SM_Bld_Preset_House_Wall_02_Optimized", "SM_Bld_Castle_Wall_01", "SM_Bld_Castle_Tower_01", "SM_Bld_Castle_Gate_01", "SM_Prop_Market_Stall_01"].map(named);
    const map = buildArtMap(pack, { ...DEFAULT_ART_PATTERNS, house: ["Preset_House_"], market: ["Stall"] });
    assert.deepEqual(map.house, ["pack/SM_Bld_Preset_House_02_Optimized"], "the archway and the wall piece are not homes, though their names match");
    assert.deepEqual(map.market, ["pack/SM_Prop_Market_Stall_01"], "a stall is not a wall");
    assert.deepEqual(map.town_wall, ["pack/SM_Bld_Castle_Wall_01"]);
    assert.deepEqual(map.wall_tower, ["pack/SM_Bld_Castle_Tower_01"]);
    assert.deepEqual(map.town_gate, ["pack/SM_Bld_Castle_Gate_01"]);
    for (const kind of FORTIFICATION_KINDS) assert.ok(kind in DEFAULT_ART_PATTERNS, `${kind} has default patterns`);
    for (const [kind, ids] of Object.entries(buildArtMap(pack, DEFAULT_ART_PATTERNS))) {
      if (!(FORTIFICATION_KINDS as readonly string[]).includes(kind)) for (const id of ids) assert.ok(!FORTIFICATION_NAME.test(id), `${kind} took ${id}`);
    }
  });

  it("is sorted and so the same every time", () => {
    const a = buildArtMap([...models].reverse(), { house: ["Preset_House"] });
    assert.deepEqual(a, buildArtMap(models, { house: ["Preset_House"] }));
  });
});
