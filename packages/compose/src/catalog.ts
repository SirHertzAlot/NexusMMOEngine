/**
 * What entities are composed from: item bases (creature bases come from
 * the species roster, or any list of ids and tags) and the components
 * that fill their slots. Each component has:
 *
 *  - a slot kind
 *  - a cost against the rank's budget
 *  - a weight and a lowest rank
 *  - tags, and tags it `excludes` (it never shares an entity with them)
 *  - base tags it `fits` (a wood only on a staff or bow)
 *  - `stats` (summed into the entity's)
 *  - `params` (for the client prefab: a colour, a scale)
 *
 * Elemental components carry their element, and exclude the opposing
 * ones (fire and frost; holy with shadow or void; nature and void). Holy
 * never goes on demons or the undead, nor nature on the undead. An
 * elemental aura, set of runes, particles or tint needs an element the
 * entity already has, so the signals always match the entity (a fire
 * demon glows with fire, never frost).
 *
 * `BUILTIN_CATALOG` is our game's. A game adds or replaces entries by id
 * with a file (`loadCatalog`).
 */

import { z } from "zod";

export const SLOT_KINDS = ["material", "affix", "ability", "unique", "aura", "runes", "particles", "tint", "transform"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];
/** Slots that are signals (visuals for the prefab; no cost). */
export const SIGNAL_SLOTS: readonly SlotKind[] = ["aura", "runes", "particles", "tint", "transform"];

export const ELEMENTS = ["fire", "frost", "storm", "nature", "holy", "shadow", "void"] as const;
export type Element = (typeof ELEMENTS)[number];

const ENTITY_KINDS = ["creature", "item"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const Param = z.union([z.number(), z.string(), z.boolean()]);

export const ComponentSchema = z.strictObject({
  slot: z.enum(SLOT_KINDS),
  name: z.string().optional(),
  /** For affixes: the word before the base ("Flaming"), or the phrase after it ("of the Bear"). */
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  cost: z.number().int().min(0).default(1),
  weight: z.number().min(0).default(1),
  tags: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
  /** Base tags it can go on (any one); empty: any base. */
  fits: z.array(z.string()).default([]),
  for: z.array(z.enum(ENTITY_KINDS)).min(1).default(["creature", "item"]),
  /** Lowest rank index it appears at (0 the lowest rank). */
  minRank: z.number().int().min(0).default(0),
  stats: z.record(z.string(), z.number()).default({}),
  params: z.record(z.string(), Param).default({}),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ItemBaseSchema = z.strictObject({
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  stats: z.record(z.string(), z.number()).default({}),
  /** The mesh or asset id the client builds it from. */
  prefab: z.string().min(1),
});
export type ItemBase = z.infer<typeof ItemBaseSchema>;

export const CatalogSchema = z.strictObject({
  items: z.record(id, ItemBaseSchema).default({}),
  components: z.record(id, ComponentSchema).default({}),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/** A creature base: a species (or any creature) as the composer sees it. */
export interface CreatureBase {
  id: string;
  name: string;
  /** Kind and traits: "demon", "undead", "fire", … */
  tags: readonly string[];
  stats?: Record<string, number>;
  /** Defaults to the id. */
  prefab?: string;
}

const OPPOSED: Record<Element, readonly string[]> = {
  fire: ["frost"],
  frost: ["fire"],
  storm: [],
  nature: ["void", "undead"],
  holy: ["shadow", "void", "demon", "undead"],
  shadow: ["holy"],
  void: ["holy", "nature"],
};

const COLOR: Record<Element, string> = {
  fire: "#ff6a1a", frost: "#8fd8ff", storm: "#b9a8ff", nature: "#6fd36a", holy: "#ffe9a3", shadow: "#6b3fa0", void: "#3a1f6e",
};

type In = z.input<typeof ComponentSchema>;
const c = (x: In): Component => ComponentSchema.parse(x);
const el = (e: Element, x: In): Component => c({ ...x, tags: [e, ...(x.tags ?? [])], excludes: [...OPPOSED[e], ...(x.excludes ?? [])] });

const items: Record<string, z.input<typeof ItemBaseSchema>> = {
  sword: { name: "Sword", tags: ["weapon", "melee", "blade", "metal"], stats: { power: 10, speed: 1 }, prefab: "sword" },
  greatsword: { name: "Greatsword", tags: ["weapon", "melee", "blade", "metal", "two-handed"], stats: { power: 16 }, prefab: "greatsword" },
  axe: { name: "Axe", tags: ["weapon", "melee", "metal"], stats: { power: 12 }, prefab: "axe" },
  mace: { name: "Mace", tags: ["weapon", "melee", "blunt", "metal"], stats: { power: 11, stagger: 2 }, prefab: "mace" },
  dagger: { name: "Dagger", tags: ["weapon", "melee", "blade", "metal"], stats: { power: 7, speed: 3, crit: 3 }, prefab: "dagger" },
  spear: { name: "Spear", tags: ["weapon", "melee", "metal", "two-handed"], stats: { power: 12, reach: 1 }, prefab: "spear" },
  staff: { name: "Staff", tags: ["weapon", "caster", "wood", "two-handed"], stats: { spell: 12 }, prefab: "staff" },
  wand: { name: "Wand", tags: ["weapon", "caster", "wood"], stats: { spell: 8, speed: 2 }, prefab: "wand" },
  bow: { name: "Bow", tags: ["weapon", "ranged", "wood", "two-handed"], stats: { power: 10, reach: 4 }, prefab: "bow" },
  shield: { name: "Shield", tags: ["armour", "offhand", "metal"], stats: { armour: 8, block: 5 }, prefab: "shield" },
  helm: { name: "Helm", tags: ["armour", "metal"], stats: { armour: 4 }, prefab: "helm" },
  cuirass: { name: "Cuirass", tags: ["armour", "metal"], stats: { armour: 9 }, prefab: "cuirass" },
  gauntlets: { name: "Gauntlets", tags: ["armour", "metal"], stats: { armour: 3 }, prefab: "gauntlets" },
  greaves: { name: "Greaves", tags: ["armour", "metal"], stats: { armour: 4 }, prefab: "greaves" },
  ring: { name: "Ring", tags: ["jewel"], stats: {}, prefab: "ring" },
  amulet: { name: "Amulet", tags: ["jewel"], stats: { spell: 2 }, prefab: "amulet" },
  // Provisions: eaten or drunk from the bag (hotkey + E); `nourish`/`quench` are the hunger/thirst points restored. No components.
  bread: { name: "Bread", tags: ["food"], stats: { nourish: 25 }, prefab: "bread" },
  "dried-meat": { name: "Dried Meat", tags: ["food"], stats: { nourish: 40 }, prefab: "dried-meat" },
  waterskin: { name: "Waterskin", tags: ["food"], stats: { quench: 40 }, prefab: "waterskin" },
  // A key opens a locked chest or door (a Chest or Door with `requires: "key"`); like provisions it takes no components.
  key: { name: "Key", tags: ["key"], stats: {}, prefab: "key" },
};

const components: Record<string, Component> = {
  // Materials (items only): metals, woods, gems.
  iron: c({ slot: "material", cost: 0, fits: ["metal"], for: ["item"], stats: { power: 1, armour: 1 }, params: { color: "#8a8d91" } }),
  steel: c({ slot: "material", cost: 1, fits: ["metal"], for: ["item"], stats: { power: 3, armour: 3 }, params: { color: "#b4bac1" } }),
  silver: c({ slot: "material", cost: 2, fits: ["metal"], for: ["item"], tags: ["silver"], stats: { power: 3, armour: 3, spell: 3 }, params: { color: "#dfe4ea" } }),
  mithril: c({ slot: "material", cost: 3, minRank: 2, fits: ["metal"], for: ["item"], stats: { power: 6, armour: 6, speed: 2 }, params: { color: "#cfe8ff" } }),
  obsidian: el("fire", { slot: "material", cost: 3, minRank: 2, fits: ["metal"], for: ["item"], stats: { power: 7, fire: 3 }, params: { color: "#1c1414" } }),
  frostglass: el("frost", { slot: "material", cost: 3, minRank: 2, fits: ["metal"], for: ["item"], stats: { power: 6, frost: 3 }, params: { color: "#bfefff" } }),
  stormsteel: el("storm", { slot: "material", cost: 3, minRank: 2, fits: ["metal"], for: ["item"], stats: { power: 6, storm: 3 }, params: { color: "#8c9ad8" } }),
  voidsteel: el("void", { slot: "material", cost: 4, minRank: 3, fits: ["metal"], for: ["item"], stats: { power: 9, void: 3 }, params: { color: "#2a1d44" } }),
  dragonbone: c({ slot: "material", cost: 4, minRank: 3, fits: ["metal"], for: ["item"], tags: ["draconic"], stats: { power: 9, armour: 7 }, params: { color: "#e8dcc0" } }),
  ash: c({ slot: "material", cost: 0, fits: ["wood"], for: ["item"], stats: { spell: 1, power: 1 }, params: { color: "#c8b28a" } }),
  yew: c({ slot: "material", cost: 1, fits: ["wood"], for: ["item"], stats: { spell: 3, power: 3 }, params: { color: "#a0703c" } }),
  ironwood: c({ slot: "material", cost: 2, fits: ["wood"], for: ["item"], stats: { spell: 4, power: 4, armour: 2 }, params: { color: "#5a4632" } }),
  heartwood: el("nature", { slot: "material", cost: 3, minRank: 2, fits: ["wood"], for: ["item"], stats: { spell: 7, nature: 3 }, params: { color: "#7c5a2c" } }),
  "bone-wood": el("shadow", { slot: "material", cost: 3, minRank: 2, fits: ["wood"], for: ["item"], stats: { spell: 7, shadow: 3 }, params: { color: "#d8d0c0" } }),
  quartz: c({ slot: "material", cost: 0, fits: ["jewel"], for: ["item"], stats: { spell: 1 }, params: { color: "#f2f2f2" } }),
  ruby: el("fire", { slot: "material", cost: 2, fits: ["jewel"], for: ["item"], stats: { spell: 3, fire: 2 }, params: { color: "#d0203a" } }),
  sapphire: el("frost", { slot: "material", cost: 2, fits: ["jewel"], for: ["item"], stats: { spell: 3, frost: 2 }, params: { color: "#2050d0" } }),
  topaz: el("storm", { slot: "material", cost: 2, fits: ["jewel"], for: ["item"], stats: { spell: 3, storm: 2 }, params: { color: "#f0c040" } }),
  emerald: el("nature", { slot: "material", cost: 2, fits: ["jewel"], for: ["item"], stats: { spell: 3, nature: 2 }, params: { color: "#20a050" } }),
  onyx: el("shadow", { slot: "material", cost: 2, fits: ["jewel"], for: ["item"], stats: { spell: 3, shadow: 2 }, params: { color: "#202020" } }),
  diamond: el("holy", { slot: "material", cost: 3, minRank: 2, fits: ["jewel"], for: ["item"], stats: { spell: 5, holy: 3 }, params: { color: "#f8fbff" } }),
  voidstone: el("void", { slot: "material", cost: 4, minRank: 3, fits: ["jewel"], for: ["item"], stats: { spell: 7, void: 3 }, params: { color: "#301050" } }),

  // Affixes.
  mighty: c({ slot: "affix", prefix: "Mighty", cost: 1, stats: { power: 3 } }),
  "of-the-bear": c({ slot: "affix", suffix: "of the Bear", cost: 1, stats: { health: 10 } }),
  keen: c({ slot: "affix", prefix: "Keen", cost: 1, fits: ["weapon", "creature"], stats: { crit: 5 } }),
  swift: c({ slot: "affix", prefix: "Swift", cost: 1, stats: { speed: 4 } }),
  warding: c({ slot: "affix", prefix: "Warding", cost: 1, fits: ["armour", "jewel", "creature"], stats: { armour: 5 } }),
  "of-the-sage": c({ slot: "affix", suffix: "of the Sage", cost: 1, fits: ["caster", "jewel", "creature"], stats: { spell: 4 } }),
  flaming: el("fire", { slot: "affix", prefix: "Flaming", cost: 2, stats: { fire: 5 } }),
  frozen: el("frost", { slot: "affix", prefix: "Frozen", cost: 2, stats: { frost: 5, slow: 2 } }),
  shocking: el("storm", { slot: "affix", prefix: "Shocking", cost: 2, stats: { storm: 5 } }),
  venomous: el("nature", { slot: "affix", prefix: "Venomous", cost: 2, stats: { nature: 4, poison: 2 } }),
  radiant: el("holy", { slot: "affix", prefix: "Radiant", cost: 2, stats: { holy: 5 } }),
  vampiric: el("shadow", { slot: "affix", prefix: "Vampiric", cost: 2, stats: { shadow: 3, lifesteal: 3 } }),
  abyssal: el("void", { slot: "affix", prefix: "Abyssal", cost: 3, minRank: 2, stats: { void: 7 } }),
  "of-the-titan": c({ slot: "affix", suffix: "of the Titan", cost: 3, minRank: 2, stats: { power: 6, health: 15 } }),
  "of-thorns": c({ slot: "affix", suffix: "of Thorns", cost: 2, fits: ["armour", "creature"], stats: { reflect: 4 } }),
  relentless: c({ slot: "affix", prefix: "Relentless", cost: 2, for: ["creature"], stats: { regen: 3 } }),

  // Abilities.
  cleave: c({ slot: "ability", cost: 1, fits: ["melee", "creature"], stats: { power: 1 } }),
  charge: c({ slot: "ability", cost: 1, fits: ["melee", "creature"] }),
  "war-cry": c({ slot: "ability", cost: 1, for: ["creature"] }),
  "shield-bash": c({ slot: "ability", cost: 1, fits: ["offhand"], for: ["item"] }),
  volley: c({ slot: "ability", cost: 1, fits: ["ranged"], for: ["item"] }),
  enrage: c({ slot: "ability", cost: 1, for: ["creature"], excludes: ["undead"] }),
  fireball: el("fire", { slot: "ability", cost: 2, fits: ["caster", "jewel", "creature"] }),
  "frost-nova": el("frost", { slot: "ability", cost: 2, fits: ["caster", "jewel", "creature"] }),
  "chain-lightning": el("storm", { slot: "ability", cost: 2, fits: ["caster", "jewel", "creature"] }),
  entangle: el("nature", { slot: "ability", cost: 2, fits: ["caster", "jewel", "creature"] }),
  smite: el("holy", { slot: "ability", cost: 2, fits: ["melee", "caster", "jewel", "creature"] }),
  "drain-life": el("shadow", { slot: "ability", cost: 2, fits: ["caster", "jewel", "creature"] }),
  blink: el("void", { slot: "ability", cost: 2, minRank: 2 }),
  "summon-minions": c({ slot: "ability", cost: 3, minRank: 2, for: ["creature"] }),

  // Unique abilities (the top rank only).
  cataclysm: el("fire", { slot: "unique", cost: 3 }),
  "glacial-tomb": el("frost", { slot: "unique", cost: 3 }),
  "storm-call": el("storm", { slot: "unique", cost: 3 }),
  "world-tree": el("nature", { slot: "unique", cost: 3 }),
  judgement: el("holy", { slot: "unique", cost: 3 }),
  "soul-harvest": el("shadow", { slot: "unique", cost: 3 }),
  rift: el("void", { slot: "unique", cost: 3 }),
  avatar: c({ slot: "unique", cost: 3, weight: 0.5, stats: { power: 5, health: 20 } }),

  // Signals (visuals; no cost). Elemental ones need the element on the entity.
  ...Object.fromEntries(
    ELEMENTS.flatMap((e) => [
      [`aura-${e}`, el(e, { slot: "aura", cost: 0, weight: 4, params: { color: COLOR[e], radius: 1.2 } })],
      [`runes-${e}`, el(e, { slot: "runes", cost: 0, weight: 4, params: { color: COLOR[e] } })],
      [`tint-${e}`, el(e, { slot: "tint", cost: 0, weight: 4, params: { color: COLOR[e], amount: 0.35 } })],
    ]),
  ),
  "aura-arcane": c({ slot: "aura", cost: 0, params: { color: "#c080ff", radius: 1.2 } }),
  "runes-ancient": c({ slot: "runes", cost: 0, params: { color: "#9fe0ff" } }),
  "tint-rank": c({ slot: "tint", cost: 0, params: { amount: 0.3 } }),
  embers: el("fire", { slot: "particles", cost: 0, weight: 4, params: { effect: "embers" } }),
  snow: el("frost", { slot: "particles", cost: 0, weight: 4, params: { effect: "snow" } }),
  sparks: el("storm", { slot: "particles", cost: 0, weight: 4, params: { effect: "sparks" } }),
  spores: el("nature", { slot: "particles", cost: 0, weight: 4, params: { effect: "spores" } }),
  motes: el("holy", { slot: "particles", cost: 0, weight: 4, params: { effect: "motes" } }),
  smoke: el("shadow", { slot: "particles", cost: 0, weight: 4, params: { effect: "smoke" } }),
  "void-wisps": el("void", { slot: "particles", cost: 0, weight: 4, params: { effect: "void-wisps" } }),
  glimmer: c({ slot: "particles", cost: 0, params: { effect: "glimmer" } }),
  giant: c({ slot: "transform", cost: 0, for: ["creature"], params: { scale: 1.3 } }),
  hulking: c({ slot: "transform", cost: 0, for: ["creature"], params: { scale: 1.15, girth: 1.25 } }),
  spectral: c({ slot: "transform", cost: 0, for: ["creature"], excludes: ["organic", "beast"], params: { opacity: 0.7, gait: "float" } }),
  ornate: c({ slot: "transform", cost: 0, for: ["item"], params: { filigree: true } }),
  ascendant: c({ slot: "transform", cost: 0, for: ["item"], params: { hover: 0.1, spin: 0.3 } }),
};

export const BUILTIN_CATALOG: Catalog = CatalogSchema.parse({ items, components });

/** Tags that make a signal elemental (it then needs the element on the entity). */
export const elementOf = (comp: Component): Element | undefined => ELEMENTS.find((e) => comp.tags.includes(e));

/** Our catalog with a game's (parsed JSON) merged over it, by id. Throws with every problem, prefixed with `file`. */
export function catalogFromJson(raw: unknown, file = "catalog"): Catalog {
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const merged: Catalog = {
    items: { ...BUILTIN_CATALOG.items, ...parsed.data.items },
    components: { ...BUILTIN_CATALOG.components, ...parsed.data.components },
  };
  const problems: string[] = [];
  for (const [cid, comp] of Object.entries(merged.components)) {
    if ((comp.prefix || comp.suffix) && comp.slot !== "affix") problems.push(`${cid}: only affixes have a prefix or suffix`);
    if (comp.prefix && comp.suffix) problems.push(`${cid}: a prefix or a suffix, not both`);
    if (SIGNAL_SLOTS.includes(comp.slot) && comp.cost !== 0) problems.push(`${cid}: signals cost nothing (cost ${comp.cost})`);
  }
  if (problems.length) throw new Error(`${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return merged;
}
