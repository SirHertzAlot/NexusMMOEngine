/**
 * Recipes, derived from composed items (@mmo-engine/compose): whatever the
 * composer put in an item, its recipe asks for.
 *
 *  - the item's material (a composer component: steel, mithril, ruby, …),
 *    refined from raw materials, in the quantity its base needs (a dagger
 *    less, a greatsword more)
 *  - fittings by base: leather straps (beast hide) on armour and shields, a
 *    gold setting on jewellery
 *  - every affix, ability and unique ability: reagents of its element (fire
 *    crystal for flaming, grave dust for shadow, …), or arcane dust when it
 *    has none, scaled by its cost; abilities of an element some creatures
 *    bleed (demon ichor for fire) take that too
 *  - signals: rune stone for carved runes, crystals for an aura
 *  - a craft skill (Smithing, Woodworking, Jewelcrafting, Armoursmithing)
 *    and the mastery it needs, from the item's place on the rank ladder
 *
 * So a legendary's recipe is the sum of a legendary's parts, and the
 * materials' tiers follow the ranks: balancing backwards from top gear.
 */

import { BUILTIN_CATALOG, DEFAULT_LADDER, type Catalog, type EntityBundle, type Ladder } from "@mmo-engine/compose/browser";
import { BUILTIN_MATERIALS, type Material } from "./materials.js";

export interface Recipe {
  /** The item it makes (its composed id). */
  item: string;
  skill: string;
  /** Mastery the craft needs, 0..1 (MASTERY-AND-COMBAT.md). */
  mastery: number;
  /** Raw material id → quantity. */
  inputs: Record<string, number>;
  /** Highest tier among the inputs. */
  tier: number;
}

/** Each composer material component, refined from raw materials (per unit). */
export const REFINING: Record<string, Record<string, number>> = {
  iron: { "iron-ore": 2, coal: 1 },
  steel: { "iron-ore": 2, coal: 2 },
  silver: { "silver-ore": 2, coal: 1 },
  mithril: { "enchanted-ore": 2, "silver-ore": 1 },
  obsidian: { "exotic-ore": 1, "fire-crystal": 1 },
  frostglass: { "frost-crystal": 2, "rough-quartz": 1 },
  stormsteel: { "iron-ore": 2, "storm-crystal": 1 },
  voidsteel: { "exotic-ore": 2, "void-essence": 1 },
  dragonbone: { "dragon-bone": 2 },
  ash: { "ash-log": 2 },
  yew: { "yew-log": 2 },
  ironwood: { "ironwood-log": 2 },
  heartwood: { heartwood: 2 },
  "bone-wood": { "old-bone": 2 },
  quartz: { "rough-quartz": 1 },
  ruby: { "rough-gem": 1, "fire-crystal": 1 },
  sapphire: { "rough-gem": 1, "frost-crystal": 1 },
  topaz: { "rough-gem": 1, "storm-crystal": 1 },
  emerald: { "rough-gem": 1, "wild-essence": 1 },
  onyx: { "rough-gem": 1, "grave-dust": 1 },
  diamond: { "rough-diamond": 1 },
  voidstone: { "rough-diamond": 1, "void-essence": 1 },
};

/** The reagent an element's enchantments take. */
export const ELEMENT_REAGENT: Record<string, string> = {
  fire: "fire-crystal",
  frost: "frost-crystal",
  storm: "storm-crystal",
  nature: "wild-essence",
  holy: "silver-ore",
  shadow: "grave-dust",
  void: "void-essence",
};

/** What an ability of an element also takes, beyond the element's reagent. */
export const ABILITY_EXTRA: Record<string, string> = { fire: "demon-ichor" };

/** How much material an item base takes (units of its material). */
function unitsFor(tags: readonly string[]): number {
  if (tags.includes("jewel")) return 1;
  if (tags.includes("two-handed")) return 6;
  if (tags.includes("offhand") || tags.includes("armour")) return 4;
  return 3;
}

function skillFor(tags: readonly string[]): string {
  if (tags.includes("jewel")) return "Jewelcrafting";
  if (tags.includes("wood")) return "Woodworking";
  if (tags.includes("armour")) return "Armoursmithing";
  return "Smithing";
}

const add = (to: Record<string, number>, id: string, n: number): void => {
  if (n > 0) to[id] = (to[id] ?? 0) + n;
};

/** The recipe for a composed item. Throws for a creature, or a component with no recipe mapping. */
export function recipeFor(
  bundle: EntityBundle,
  o: { catalog?: Catalog; ladder?: Ladder; materials?: Record<string, Material> } = {},
): Recipe {
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const materials = o.materials ?? BUILTIN_MATERIALS;
  if (bundle.Identity.kind !== "item") throw new Error(`${bundle.Identity.name}: creatures aren't crafted`);
  const base = catalog.items[bundle.Identity.base];
  if (!base) throw new Error(`no item base "${bundle.Identity.base}"`);
  const inputs: Record<string, number> = {};
  if (bundle.Material) {
    const refine = REFINING[bundle.Material];
    if (!refine) throw new Error(`material "${bundle.Material}" has no refining recipe`);
    for (const [raw, n] of Object.entries(refine)) add(inputs, raw, n * unitsFor(base.tags));
  }
  if (base.tags.includes("armour") || base.tags.includes("offhand")) add(inputs, "beast-hide", 2);
  if (base.tags.includes("jewel")) add(inputs, "gold-ore", 1);
  const elementOf = (compId: string): string | undefined => catalog.components[compId]?.tags.find((t) => t in ELEMENT_REAGENT);
  for (const a of bundle.Affixes) {
    const e = elementOf(a);
    add(inputs, e ? ELEMENT_REAGENT[e] : "arcane-dust", Math.max(1, catalog.components[a]?.cost ?? 1));
  }
  for (const a of bundle.Abilities) {
    const comp = catalog.components[a];
    const e = elementOf(a);
    const n = 2 * Math.max(1, comp?.cost ?? 1);
    add(inputs, e ? ELEMENT_REAGENT[e] : "arcane-dust", n);
    if (e && ABILITY_EXTRA[e]) add(inputs, ABILITY_EXTRA[e], 1);
    if (comp?.slot === "unique") add(inputs, "rune-stone", 3);
  }
  for (const [kind, sig] of Object.entries(bundle.Signals)) {
    if (!sig) continue;
    if (kind === "runes") add(inputs, "rune-stone", 1);
    if (kind === "aura") {
      const e = elementOf(sig);
      add(inputs, e ? ELEMENT_REAGENT[e] : "arcane-dust", 2);
    }
  }
  for (const raw of Object.keys(inputs)) if (!materials[raw]) throw new Error(`recipe input "${raw}" is not a known material`);
  const n = ladder.ranks.length;
  const t = n > 1 ? bundle.Rank.index / (n - 1) : 0;
  return {
    item: bundle.Identity.id,
    skill: skillFor(base.tags),
    mastery: Math.round(t * 0.9 * 100) / 100,
    inputs,
    tier: Math.max(1, ...Object.keys(inputs).map((raw) => materials[raw].tier)),
  };
}
