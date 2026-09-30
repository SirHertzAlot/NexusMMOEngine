/**
 * Raw materials: what players gather, where, and at what tier.
 *
 * A material has a tier (1 common … 5 legendary), a kind, the skill that
 * gathers it, and its sources:
 *
 *  - world: nodes in open-world biomes (ecology scatter places them)
 *  - vein: a dungeon resource vein kind (@mmo-engine/dungeon dressing:
 *    iron seam, gold vein, elemental crystal, enchanted ore, exotic ore,
 *    rune stone); dungeons are where the high tiers are
 *  - drop: from creatures of a kind (demons, the undead, beasts, …)
 *
 * Tradability is data too (see TRADABILITY): commodities trade freely,
 * bound materials stay with who gathered them.
 */

import { z } from "zod";

export const MATERIAL_KINDS = ["ore", "fuel", "wood", "gem", "crystal", "essence", "rune"] as const;

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const SourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("world"), biomes: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("vein"), vein: id }),
  z.strictObject({ kind: z.literal("drop"), from: z.array(z.string()).min(1) }),
]);
export type Source = z.infer<typeof SourceSchema>;

export const MaterialSchema = z.strictObject({
  name: z.string().min(1),
  tier: z.number().int().min(1).max(5),
  kind: z.enum(MATERIAL_KINDS),
  /** The skill that gathers it (MASTERY-AND-COMBAT.md: Mining, Woodcutting, …; drops need none). */
  skill: z.string().nullable().default(null),
  sources: z.array(SourceSchema).min(1),
  /** Overrides the tier rule in TRADABILITY. */
  tradable: z.boolean().optional(),
});
export type Material = z.infer<typeof MaterialSchema>;

type In = z.input<typeof MaterialSchema>;
const m = (x: In): Material => MaterialSchema.parse(x);
const world = (...biomes: string[]): Source => ({ kind: "world", biomes });
const vein = (v: string): Source => ({ kind: "vein", vein: v });
const drop = (...from: string[]): Source => ({ kind: "drop", from });

/** Our game's raw materials (biome ids match the world spec; vein ids the dungeon dressing). */
export const BUILTIN_MATERIALS: Record<string, Material> = {
  "iron-ore": m({ name: "Iron ore", tier: 1, kind: "ore", skill: "Mining", sources: [world("mountains", "tundra", "desert"), vein("iron-seam")] }),
  coal: m({ name: "Coal", tier: 1, kind: "fuel", skill: "Mining", sources: [world("mountains", "swamp"), vein("iron-seam")] }),
  "silver-ore": m({ name: "Silver ore", tier: 2, kind: "ore", skill: "Mining", sources: [world("mountains"), vein("gold-vein")] }),
  "gold-ore": m({ name: "Gold ore", tier: 2, kind: "ore", skill: "Mining", sources: [vein("gold-vein")] }),
  "fire-crystal": m({ name: "Fire crystal", tier: 3, kind: "crystal", skill: "Mining", sources: [world("volcanic"), vein("elemental-crystal")] }),
  "frost-crystal": m({ name: "Frost crystal", tier: 3, kind: "crystal", skill: "Mining", sources: [world("glacier"), vein("elemental-crystal")] }),
  "storm-crystal": m({ name: "Storm crystal", tier: 3, kind: "crystal", skill: "Mining", sources: [vein("elemental-crystal")] }),
  "enchanted-ore": m({ name: "Enchanted ore", tier: 3, kind: "ore", skill: "Mining", sources: [vein("enchanted-ore")] }),
  "exotic-ore": m({ name: "Exotic ore", tier: 4, kind: "ore", skill: "Mining", sources: [vein("exotic-ore")] }),
  "rune-stone": m({ name: "Rune stone", tier: 5, kind: "rune", skill: "Mining", sources: [vein("rune-stone")] }),
  "ash-log": m({ name: "Ash log", tier: 1, kind: "wood", skill: "Woodcutting", sources: [world("forest", "plains")] }),
  "yew-log": m({ name: "Yew log", tier: 2, kind: "wood", skill: "Woodcutting", sources: [world("forest", "swamp")] }),
  "ironwood-log": m({ name: "Ironwood log", tier: 3, kind: "wood", skill: "Woodcutting", sources: [world("rainforest")] }),
  heartwood: m({ name: "Heartwood", tier: 4, kind: "wood", skill: "Woodcutting", sources: [world("rainforest"), vein("enchanted-ore")] }),
  "rough-quartz": m({ name: "Rough quartz", tier: 1, kind: "gem", skill: "Mining", sources: [world("mountains", "desert"), vein("iron-seam")] }),
  "rough-gem": m({ name: "Rough gemstone", tier: 2, kind: "gem", skill: "Mining", sources: [vein("gold-vein"), world("mountains")] }),
  "rough-diamond": m({ name: "Rough diamond", tier: 4, kind: "gem", skill: "Mining", sources: [vein("exotic-ore")] }),
  "beast-hide": m({ name: "Beast hide", tier: 1, kind: "essence", sources: [drop("beast")] }),
  "wild-essence": m({ name: "Wild essence", tier: 2, kind: "essence", sources: [drop("beast", "organic")] }),
  "arcane-dust": m({ name: "Arcane dust", tier: 2, kind: "essence", sources: [drop("otherworldly", "undead", "demon")] }),
  "grave-dust": m({ name: "Grave dust", tier: 2, kind: "essence", sources: [drop("undead")] }),
  "old-bone": m({ name: "Old bone", tier: 3, kind: "essence", sources: [drop("undead")] }),
  "demon-ichor": m({ name: "Demon ichor", tier: 3, kind: "essence", sources: [drop("demon")] }),
  "void-essence": m({ name: "Void essence", tier: 4, kind: "essence", sources: [drop("otherworldly")] }),
  "dragon-bone": m({ name: "Dragon bone", tier: 5, kind: "essence", sources: [drop("dragon"), vein("exotic-ore")] }),
};

/**
 * Proposed tradability (open question 4 in docs/DUNGEONS-AND-LOOT.md, for
 * you to confirm): materials up to tier 3 are commodities, tiers 4–5 bound
 * to whoever gathers them; items of the lower ranks trade, the top two ranks
 * bind (epic on equip, the top rank on pickup).
 */
export const TRADABILITY = {
  materialsTradableUpToTier: 3,
  /** By place on the rank ladder (0 lowest … 1 top). */
  itemBinding: (t: number): "none" | "equip" | "pickup" => (t >= 1 ? "pickup" : t >= 0.75 ? "equip" : "none"),
};

export function isTradable(mat: Material): boolean {
  return mat.tradable ?? mat.tier <= TRADABILITY.materialsTradableUpToTier;
}
