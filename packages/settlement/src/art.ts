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

/** Name patterns per structure kind, for the packs' whole-building presets. A game replaces them with `--art-patterns`. */
export const DEFAULT_ART_PATTERNS: Record<string, string[]> = {
  house: ["Preset_House_0[2-9](_[A-C])?_Optimized$", "Preset_Hut_\[0-9]+_Optimized$"],
  artisan_house: ["Preset_House_(01_A|10)_Optimized$", "Preset_House_0[4-6]_Optimized$"],
  farmstead: ["Preset_(Hut|Shelter|Stables)_\[0-9]+_Optimized$"],
  granary: ["Preset_Shelter_\[0-9]+_Optimized$"],
  mill: ["Preset_House_Windmill_\[0-9]+_Optimized$"],
  bakery: ["Preset_House_Archway_0[12]_Optimized$"],
  smithy: ["Preset_Blacksmith_\[0-9]+_Optimized$"],
  workshop: ["Preset_House_01_A_Optimized$", "Preset_House_Archway_02_Optimized$"],
  market: ["Prop_Market_Stall_\[0-9]+$"],
  tavern: ["Preset_Tavern_\[0-9]+_Optimized$"],
  chapel: ["Preset_Church_\[0-9]+_[AB]_Optimized$"],
  warehouse: ["Preset_Stables_\[0-9]+_Optimized$", "Preset_House_04_Optimized$"],
};

/** Model ids per kind whose names match any of the kind's patterns, sorted; never skinned models or glass panes. A kind with no match is left out. */
export function buildArtMap(models: readonly CatalogModel[], patterns: Record<string, string[]>): Record<string, string[]> {
  const usable = models.filter((m) => !m.skinned && !m.name.includes("Glass"));
  const map: Record<string, string[]> = {};
  for (const [kind, ps] of Object.entries(patterns)) {
    const res = ps.map((p) => new RegExp(p));
    const ids = usable.filter((m) => res.some((r) => r.test(m.name))).map((m) => m.id).sort();
    if (ids.length > 0) map[kind] = ids;
  }
  return map;
}
