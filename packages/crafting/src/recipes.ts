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
 *
 * The costs are data (rules.ts, content/crafting/recipes.json): this file is
 * only the derivation.
 */

import { BUILTIN_CATALOG, DEFAULT_LADDER, type Catalog, type EntityBundle, type Ladder } from "@mmo-engine/compose/browser";
import { BUILTIN_MATERIALS, type Material } from "./materials.js";
import { EMPTY_CRAFTING_RULES, loadCraftingRules, type CraftingRules } from "./rules.js";

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

let shipped: CraftingRules | undefined;
/** The game's rules (content/crafting/recipes.json), read once; empty when the game has no crafting. */
export function craftingRules(): CraftingRules {
  return (shipped ??= loadCraftingRules() ?? EMPTY_CRAFTING_RULES);
}

const add = (to: Record<string, number>, id: string, n: number): void => {
  if (n > 0) to[id] = (to[id] ?? 0) + n;
};

const hasAny = (have: readonly string[], want: readonly string[]): boolean => want.some((t) => have.includes(t));

/** The recipe for a composed item. Throws for a creature, or a component with no recipe mapping. */
export function recipeFor(
  bundle: EntityBundle,
  o: { catalog?: Catalog; ladder?: Ladder; materials?: Record<string, Material>; rules?: CraftingRules } = {},
): Recipe {
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const materials = o.materials ?? BUILTIN_MATERIALS;
  const rules = o.rules ?? craftingRules();
  if (bundle.Identity.kind !== "item") throw new Error(`${bundle.Identity.name}: creatures aren't crafted`);
  const base = catalog.items[bundle.Identity.base];
  if (!base) throw new Error(`no item base "${bundle.Identity.base}"`);
  const inputs: Record<string, number> = {};
  if (bundle.Material) {
    const refine = rules.refining[bundle.Material];
    if (!refine) throw new Error(`material "${bundle.Material}" has no refining recipe`);
    const units = rules.units.find((u) => hasAny(base.tags, u.tags))?.units ?? rules.defaultUnits;
    for (const [raw, n] of Object.entries(refine.inputs)) add(inputs, raw, n * units);
  }
  for (const f of rules.fittings) if (hasAny(base.tags, f.tags)) for (const [raw, n] of Object.entries(f.add)) add(inputs, raw, n);
  const elementOf = (compId: string): string | undefined => catalog.components[compId]?.tags.find((t) => t in rules.reagents);
  const reagent = (e: string | undefined): string => (e ? rules.reagents[e].reagent : rules.fallbackReagent);
  for (const a of bundle.Affixes) add(inputs, reagent(elementOf(a)), Math.max(1, catalog.components[a]?.cost ?? 1));
  for (const a of bundle.Abilities) {
    const comp = catalog.components[a];
    const e = elementOf(a);
    add(inputs, reagent(e), 2 * Math.max(1, comp?.cost ?? 1));
    const extra = e ? rules.reagents[e].extra : undefined;
    if (extra) add(inputs, extra, 1);
    if (comp?.slot === "unique") add(inputs, rules.runeStone, 3);
  }
  for (const [kind, sig] of Object.entries(bundle.Signals)) {
    if (!sig) continue;
    if (kind === "runes") add(inputs, rules.runeStone, 1);
    if (kind === "aura") add(inputs, reagent(elementOf(sig)), 2);
  }
  for (const raw of Object.keys(inputs)) if (!materials[raw]) throw new Error(`recipe input "${raw}" is not a known material`);
  const n = ladder.ranks.length;
  const t = n > 1 ? bundle.Rank.index / (n - 1) : 0;
  return {
    item: bundle.Identity.id,
    skill: rules.skills.find((s) => hasAny(base.tags, s.tags))?.skill ?? rules.defaultSkill,
    mastery: Math.round(t * 0.9 * 100) / 100,
    inputs,
    tier: Math.max(1, ...Object.keys(inputs).map((raw) => materials[raw].tier)),
  };
}
