/**
 * Mapping structure kinds to art models. The licensed catalog stays in the
 * ignored assets/ folder: a map is built from it at bake time (`--catalog`)
 * and goes into the baked scene, so the model names live in an ignored
 * file or a local bake, never in source. A kind with no match keeps its stand-in
 * box, which is also what a client without the art draws.
 */

export interface CatalogModel {
  id: string;
  name: string;
  skinned: boolean;
  /** Width, height, depth in metres (the catalog's `size`). */
  size?: [number, number, number];
}

/**
 * The kinds that make up a town wall (layout's WallPieceKind). Only these may take a model whose name says it is
 * fortification: a wall, gate, tower or archway is never a home or a shop.
 */
export const FORTIFICATION_KINDS = ["town_wall", "wall_tower", "town_gate"] as const;

/** A model name that is part of a wall or a gate, whatever pattern it also matches. */
export const FORTIFICATION_NAME = /(Wall|Gate|Gatehouse|Arch(way)?|Tower|Portcullis|Palisade|Rampart|Battlement)(_|$)/i;

/** Name patterns per structure kind, for the packs' whole-building presets. A game replaces them with `--art-patterns`. */
export const DEFAULT_ART_PATTERNS: Record<string, string[]> = {
  house: ["Preset_House_0[2-9](_[A-C])?_Optimized$", "Preset_Hut_\[0-9]+_Optimized$"],
  artisan_house: ["Preset_House_(01_A|10)_Optimized$", "Preset_House_0[4-6]_Optimized$"],
  farmstead: ["Preset_(Hut|Shelter|Stables)_\[0-9]+_Optimized$", "Preset_Farm(house)?_\[0-9]+_Optimized$"],
  granary: ["Preset_Shelter_\[0-9]+_Optimized$"],
  mill: ["Preset_House_Windmill_\[0-9]+_Optimized$"],
  bakery: ["Preset_Bakery_\[0-9]+_Optimized$", "Preset_House_0[4-6]_Optimized$"],
  smithy: ["Preset_Blacksmith_\[0-9]+_Optimized$"],
  workshop: ["Preset_Workshop_\[0-9]+_Optimized$", "Preset_House_01_A_Optimized$"],
  market: ["Prop_Market_Stall_\[0-9]+$"],
  tavern: ["Preset_Tavern_\[0-9]+_Optimized$"],
  chapel: ["Preset_Church_\[0-9]+_[AB]_Optimized$"],
  warehouse: ["Preset_Stables_\[0-9]+_Optimized$", "Preset_House_04_Optimized$"],
  townhouse: ["Preset_House_1[1-9](_[A-C])?_Optimized$", "Preset_Townhouse_\[0-9]+_Optimized$"],
  inn: ["Preset_Inn_\[0-9]+_Optimized$", "Preset_Tavern_\[0-9]+_Optimized$"],
  theatre: ["Preset_Theat(re|er)_\[0-9]+_Optimized$", "Preset_Amphitheat(re|er)_\[0-9]+_Optimized$"],
  bathhouse: ["Preset_Bath(house|s)?_\[0-9]+_Optimized$"],
  town_hall: ["Preset_(Town_?Hall|Guild_?Hall|Manor)_\[0-9]+_Optimized$"],
  guardhouse: ["Preset_(Guard_?House|Watch_?House|Guard_?Post)_\[0-9]+_Optimized$"],
  barracks: ["Preset_Barracks_\[0-9]+_Optimized$"],
  school: ["Preset_(School|Schoolhouse)_\[0-9]+_Optimized$"],
  library: ["Preset_(Library|Archive)_\[0-9]+_Optimized$"],
  parish_church: ["Preset_Church_\[0-9]+_[C-Z]_Optimized$", "Preset_Church_\[0-9]+_Optimized$"],
  cathedral: ["Preset_Cathedral_\[0-9]+_Optimized$", "Preset_Basilica_\[0-9]+_Optimized$"],
  churchyard: ["(Prop|Preset)_(Graveyard|Cemetery)(_\[0-9]+)?(_Optimized)?$"],
  rectory: ["Preset_(Rectory|Vicarage|Parsonage)_\[0-9]+_Optimized$", "Preset_House_0[4-6]_Optimized$"],
  hospital: ["Preset_(Hospital|Infirmary|Almshouse)_\[0-9]+_Optimized$"],
  monastery: ["Preset_(Monastery|Abbey|Priory)_\[0-9]+_Optimized$"],
  apothecary: ["Preset_(Apothecary|Herbalist|Alchemist)_\[0-9]+_Optimized$"],
  tenement: ["Preset_(Tenement|House_1[1-9])(_[A-C])?_Optimized$", "Preset_House_0[2-3](_[A-C])?_Optimized$"],
  shop: ["Preset_(Shop|Store|Merchant)_\[0-9]+_Optimized$", "Preset_House_0[4-6]_Optimized$"],
  watch_hq: ["Preset_(Watch_?House|Guard_?House|Barracks)_\[0-9]+_Optimized$"],
  gaol: ["Preset_(Gaol|Jail|Prison|Dungeon)_\[0-9]+_Optimized$"],
  garden: ["(Prop|Preset)_(Garden|Orchard|Vegetable_?Patch)(_\[0-9]+)?(_Optimized)?$"],
  // The town square's well or fountain.
  town_well: ["(Prop|Preset)_(Well|Fountain)(_\[0-9]+)?(_Optimized)?$"],
  // The town wall: straight wall runs, towers, and the gate the road passes through.
  town_wall: ["(Castle|Town|City|Stone|Wood(en)?)_Wall(_Straight|_Long|_Mid)?_\[0-9]+$", "_Wall_(Straight|Long|Mid)_\[0-9]+$", "Palisade(_Wall|_Straight)?_\[0-9]+$"],
  wall_tower: ["(Castle|Wall|Town|Guard|Watch)_Tower(_Round|_Square)?_\[0-9]+$", "Palisade_Tower_\[0-9]+$"],
  town_gate: ["(Castle|Town|City|Wall|Palisade)_Gate(house)?(_Large|_Small)?_\[0-9]+$", "_Gatehouse_\[0-9]+$"],
};

/**
 * Yard and field dressing for farmsteads (produce, tools, crops, fences), for the imported farm packs: whole names, so
 * match them with `buildArtMap(models, DEFAULT_DRESSING_PATTERNS, "i")`. These are small props, not structures, so they
 * stay out of DEFAULT_ART_PATTERNS (scale-fit sizes every kind there to a building).
 */
export const DEFAULT_DRESSING_PATTERNS: Record<string, string[]> = {
  farm_produce: ["^(pumpkin|corn|ear_of_corn|tomato|turnip|potato|carrot|onion|garlic|beet|radish|eggplant|cucumber|pea_pod|egg|fruit_bowl|apple|orange|pear)$"],
  farm_crops: ["^field_of_", "^(wheat|sunflower|vine|scarecrow)$"],
  farm_tools: ["^(pitchfork|shovel|bucket|watering_can|wheelbarrow|barrel|horseshoe|saddle|wagon)$"],
  farm_yard: ["^(well|fence|picket_fence|silo|windmill|barn|barn_scene|tractor)$"],
  camp_props: ["^(anvil|campfire|lantern|candelabra|tent|ladder|flag|gravestone|fountain)$"],
};

/**
 * Model ids per kind whose names match any of the kind's patterns (`flags` "i" for case-insensitive), sorted; never
 * skinned models or glass panes, and only a wall kind (FORTIFICATION_KINDS) takes a wall, gate or tower model
 * (FORTIFICATION_NAME). A kind with no match is left out.
 */
export function buildArtMap(models: readonly CatalogModel[], patterns: Record<string, string[]>, flags = ""): Record<string, string[]> {
  const usable = models.filter((m) => !m.skinned && !m.name.includes("Glass"));
  const walls = new Set<string>(FORTIFICATION_KINDS);
  const map: Record<string, string[]> = {};
  for (const [kind, ps] of Object.entries(patterns)) {
    const res = ps.map((p) => new RegExp(p, flags));
    const ids = usable.filter((m) => res.some((r) => r.test(m.name)) && (walls.has(kind) || !FORTIFICATION_NAME.test(m.name))).map((m) => m.id).sort();
    if (ids.length > 0) map[kind] = ids;
  }
  return map;
}
