/**
 * The rules' shape: one Zod schema per rules file. Every field has the
 * engine's neutral default, so a game's file only needs what it changes,
 * and an empty (or missing) file is the engine default. Objects are
 * strict: a misspelt field is an error, not silently ignored.
 *
 * See docs/MASTERY-AND-COMBAT.md for what each rule means.
 */

import { z } from "zod";

const id = z.string().regex(/^[a-z][a-zA-Z0-9-]*$/, "ids are lower camel or kebab case, starting with a letter");
const share = z.number().min(0).max(1);
const positive = z.number().positive();

// ---------------------------------------------------------------- skills

export const SkillSchema = z.strictObject({
  id,
  name: z.string().min(1),
  family: id,
  /** Skill id -> share of this skill's gains it also gets (0..1). */
  related: z.record(id, share).default({}),
});

export const SkillsSchema = z.strictObject({
  /** Skill values run 0..max (stored in tenths). */
  max: positive.default(100),
  families: z.array(id).default([]),
  skills: z.array(SkillSchema).default([]),
  gain: z
    .strictObject({
      /** Points a use at full challenge gives a novice. */
      base: positive.default(0.5),
      /** difficulty - m below this teaches nothing. */
      trivialBelow: z.number().max(0).default(-0.3),
      /** difficulty - m at or above this teaches the most. */
      fullAt: z.number().default(0),
      /** Gains scale by (1 - m)^topSlowdown. */
      topSlowdown: z.number().min(0).default(2),
      /** Each recent use on the same target keeps this share of the gain. */
      repeatFalloff: share.default(0.8),
      /** How long until repeated use on a target teaches fully again. */
      repeatRecoverMinutes: z.number().min(0).default(60),
    })
    .prefault({}),
  familiarity: z
    .strictObject({
      /** Best item-fit bonus from using one family of items (0..1). */
      maxFitBonus: share.default(0.1),
      /** Familiarity gained per use (0..1 of the maximum). */
      perUse: share.default(0.002),
    })
    .prefault({}),
  decay: z
    .strictObject({
      /** Days a skill can go unused before it starts to deteriorate. */
      graceDays: z.number().min(0).default(14),
      /** Share of the current value lost per week after the grace (0 = no decay). */
      ratePerWeek: share.default(0),
      /** Never below this share of the skill's peak. */
      floorOfPeak: share.default(0.6),
      /** Gains below the old peak are this many times faster. */
      relearnMultiplier: z.number().min(1).default(3),
    })
    .prefault({}),
});

// ----------------------------------------------------------- disciplines

export const DisciplineSchema = z.strictObject({
  id,
  name: z.string().min(1),
  /** Skill id -> the level it needs. */
  requires: z.record(id, z.number().min(0)),
  /** Technique ids it unlocks. */
  unlocks: z.array(id).default([]),
});

export const DisciplinesSchema = z.strictObject({
  disciplines: z.array(DisciplineSchema).default([]),
});

// ---------------------------------------------------------------- combat

export const DamageKind = z.enum(["cut", "blunt", "thrust"]);
export const ItemProperty = z.enum(["edge", "point", "hardness"]);

export const CombatSchema = z.strictObject({
  /** Technique id -> the item property it reads as fit, the kind of damage it does, and its skill. */
  techniques: z
    .record(id, z.strictObject({ property: ItemProperty, damageKind: DamageKind, skill: id.optional() }))
    .default({
      cut: { property: "edge", damageKind: "cut" },
      thrust: { property: "point", damageKind: "thrust" },
      bludgeon: { property: "hardness", damageKind: "blunt" },
    }),
  /** fit_eff = fit + (1 - fit) × closes × m^masteryPower. */
  fit: z.strictObject({ closes: share.default(0.8), masteryPower: positive.default(2) }).prefault({}),
  /** power = novice + masterBonus × m^curve. */
  power: z
    .strictObject({ novice: z.number().min(0).default(0.4), masterBonus: z.number().min(0).default(1.6), curve: positive.default(1.5) })
    .prefault({}),
  /** damage = base × mass^massPower × fit_eff × power × part multiplier × armour factor. */
  damage: z.strictObject({ base: positive.default(10), massPower: z.number().min(0).default(0.5) }).prefault({}),
  /** Chance a blow lands on the aimed part: novice + masterBonus × m. */
  precision: z.strictObject({ novice: share.default(0.3), masterBonus: share.default(0.65) }).prefault({}),
});

// ------------------------------------------------------------------ body

/** What happens to the character when a part reaches 0 health. */
export const AtZero = z.enum(["death", "useless", "drop", "cannotStand", "none"]);

export const BodyPartSchema = z.strictObject({
  id,
  name: z.string().min(1),
  /** The part it hangs from (null: the root). Losing a part loses everything below it. */
  parent: id.nullable(),
  /** Share of the character's total health (all parts sum to 1). */
  share: z.number().positive().max(1),
  /** Damage multiplier for blows that land here. */
  hitMultiplier: positive.default(1),
  atZero: AtZero.default("useless"),
  /** The appearance slot that draws it (hidden when dismembered). */
  slot: id.optional(),
});

const Severity = z.strictObject({
  /** One blow of at least this share of the part's health maims it (it also maims at 0 health). */
  maim: share.nullable().default(null),
  /** One blow of at least this share dismembers it (null: this kind never dismembers). */
  dismember: share.nullable().default(null),
  /** On an already maimed part, this share is enough to dismember. */
  dismemberMaimed: share.nullable().default(null),
});

/**
 * Most parts a body can have: the Injury component packs 2 bits of state
 * per part into 32 bits, keeping one for bleeding (docs/MASTERY-AND-COMBAT.md §6).
 */
export const MAX_BODY_PARTS = 15;

export const BodySchema = z.strictObject({
  parts: z
    .array(BodyPartSchema)
    .min(1)
    .max(MAX_BODY_PARTS, `at most ${MAX_BODY_PARTS} parts (the Injury component holds 2 bits of state per part in 32 bits, one kept for bleeding)`)
    .default([{ id: "body", name: "Body", parent: null, share: 1, hitMultiplier: 1, atZero: "death" }]),
  /** Harmed-part penalties apply below this share of the part's health. */
  harmedBelow: share.default(0.4),
  severity: z
    .strictObject({ cut: Severity.prefault({}), blunt: Severity.prefault({}), thrust: Severity.prefault({}) })
    .prefault({}),
  blood: z
    .strictObject({
      max: positive.default(100),
      /** Blood lost per second per open wound, by kind. */
      bleedPerSecond: z
        .strictObject({ cut: z.number().min(0).default(0), thrust: z.number().min(0).default(0), dismember: z.number().min(0).default(0) })
        .prefault({}),
    })
    .prefault({}),
});

// ----------------------------------------------------------------- death

export const DeathSchema = z.strictObject({
  respawn: z
    .strictObject({
      /** Seconds between death and respawning. */
      delaySeconds: z.number().min(0).default(10),
      /** Where: the world's spawn point, or the nearest respawn anchor the character has visited. */
      at: z.enum(["spawn", "nearestVisited"]).default("spawn"),
    })
    .prefault({}),
  keep: z
    .strictObject({
      skills: z.boolean().default(true),
      /** Items: kept, dropped where the character fell, or a share lost. */
      items: z.enum(["keep", "drop", "partial"]).default("keep"),
      /** Share of items lost with "partial". */
      partialLoss: share.default(0.25),
      /** Keep injuries (including lost parts) through death. */
      injuries: z.boolean().default(false),
    })
    .prefault({}),
  /** Record every death on the character (count, place, cause, killer). */
  recordDeaths: z.boolean().default(true),
});

// ------------------------------------------------------------ appearance

export const AppearanceSlotSchema = z.strictObject({
  id,
  /** The body part this slot draws (hidden when the part is dismembered). */
  part: id.optional(),
  required: z.boolean().default(false),
});

export const AppearanceSchema = z.strictObject({
  slots: z.array(AppearanceSlotSchema).default([]),
  /** Colour channel -> allowed colours (#rrggbb). */
  palettes: z.record(id, z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/))).default({}),
});

// ----------------------------------------------------------------- stats

/**
 * What the engine itself reads a stat for. A game binds at most one stat
 * to each; an unbound drive keeps the engine's built-in behaviour.
 *
 * - `moveSpeed`: a multiplier on every locomotion speed (1 = normal).
 * - `maxHealth`: the Health component's maximum (current keeps its share).
 * - `maxStamina`: the Stamina component's maximum (current keeps its share).
 */
export const StatDrive = z.enum(["moveSpeed", "maxHealth", "maxStamina"]);

/**
 * How a modifier changes a stat. A stat's value is
 * `(base + Σ add) × (1 + Σ percent) × Π multiply`, then clamped:
 * `add` is flat (+5 strength), `percent` sums before it applies
 * (+10 % and +20 % make +30 %), and `multiply` compounds (×0.5 halves).
 */
export const ModifierOp = z.enum(["add", "percent", "multiply"]);

/** Optional bound; JSON has no infinity, so an absent bound is null. */
const bound = z.number().nullable().default(null);

/**
 * A primary attribute: a broad umbrella (strength, agility, …) that
 * derived stats read from. A game may have none.
 */
export const AttributeSchema = z.strictObject({
  id,
  name: z.string().min(1),
  /** A new character's value. */
  base: z.number().default(10),
  min: bound,
  max: bound,
  drives: StatDrive.optional(),
});

/**
 * A derived stat: what systems actually use (move speed, max health, …),
 * its own base plus a share of each attribute it reads.
 */
export const DerivedStatSchema = z.strictObject({
  id,
  name: z.string().min(1),
  base: z.number().default(0),
  /** Attribute id -> amount added per point of that attribute. */
  from: z.record(id, z.number()).default({}),
  min: bound,
  max: bound,
  drives: StatDrive.optional(),
});

export const StatsSchema = z.strictObject({
  /** Primary attributes (optional: a game can use derived stats only). */
  attributes: z.array(AttributeSchema).default([]),
  /** Derived stats (optional: a game can drive the engine from attributes only). */
  stats: z.array(DerivedStatSchema).default([]),
});

// ----------------------------------------------------------------- items

/** Which hand an item is held in: one hand, the off hand, both, or not held (armour, jewels). */
export const Hand = z.enum(["main", "off", "both", "none"]);

/**
 * An item base's physical properties (docs/MASTERY-AND-COMBAT.md §3.1):
 * what a blow with it does, not a damage number. A composed item (the loot
 * pool's) is its base plus components; the base sets the physics, the
 * components the stats.
 */
export const ItemBaseRulesSchema = z.strictObject({
  /** kg: heavier hits harder and swings slower. */
  mass: positive.default(1),
  /** Metres of reach. */
  length: z.number().min(0).default(0.5),
  /** How well it cuts, pierces, and transfers a blunt blow (0..1). */
  edge: share.default(0.1),
  point: share.default(0.1),
  hardness: share.default(0.5),
  /** How quickly it recovers between blows (0..1). */
  balance: share.default(0.5),
  /** Uses before it breaks. */
  durability: z.number().int().positive().default(100),
  hand: Hand.default("none"),
  /** The technique a plain attack with it uses (a combat.json technique). */
  technique: id.default("bludgeon"),
  /**
   * Model ids the item can show as (art catalog ids, e.g.
   * "fantasy-kingdom/SM_Wep_Sword_01"); an item picks one by its seed.
   * Empty: the client's placeholder.
   */
  models: z.array(z.string().min(1).max(160)).default([]),
});

export const ItemsSchema = z.strictObject({
  /** Item base id (the loot catalog's: sword, axe, …) -> its physics. */
  bases: z.record(id, ItemBaseRulesSchema).default({}),
  /** For a composed item whose base isn't listed: a stick's worth of physics. */
  fallback: ItemBaseRulesSchema.prefault({}),
  /** A composed item's `power` stat scales its blows: × (1 + power × powerScale). */
  powerScale: z.number().min(0).default(0.02),
  /** Damage from a blow with no item in hand (fists), before power and parts. */
  unarmed: ItemBaseRulesSchema.prefault({ mass: 0.6, length: 0.3, edge: 0, point: 0, hardness: 0.3, technique: "bludgeon" }),
});

// ------------------------------------------------------------------ loot

/** Items on the ground and in bags (docs/ALPHA-PLAN.md, decisions D2 and D3). */
export const LootSchema = z.strictObject({
  /** Seconds a drop belongs to whoever earned it before anyone may take it. */
  ownershipSeconds: z.number().min(0).default(30),
  /** Seconds before an item left on the ground disappears. */
  despawnSeconds: positive.default(300),
  /** Metres from the character within which an item can be picked up. */
  pickupRange: positive.default(2.5),
  /** Bag slots per character. */
  bagSlots: z.number().int().min(1).max(256).default(24),
  /** Most items lying on the ground in a region at once: past it, the oldest go. */
  maxGroundItems: z.number().int().min(1).max(65536).default(4096),
});

// ------------------------------------------------------------------ all

/** Every rules file, by file name (content/rules/<name>.json). */
export const RULE_FILES = {
  skills: SkillsSchema,
  disciplines: DisciplinesSchema,
  combat: CombatSchema,
  body: BodySchema,
  death: DeathSchema,
  appearance: AppearanceSchema,
  stats: StatsSchema,
  items: ItemsSchema,
  loot: LootSchema,
} as const;

export type RuleFile = keyof typeof RULE_FILES;

export type SkillsRules = z.infer<typeof SkillsSchema>;
export type DisciplinesRules = z.infer<typeof DisciplinesSchema>;
export type CombatRules = z.infer<typeof CombatSchema>;
export type BodyRules = z.infer<typeof BodySchema>;
export type BodyPart = z.infer<typeof BodyPartSchema>;
export type DeathRules = z.infer<typeof DeathSchema>;
export type AppearanceRules = z.infer<typeof AppearanceSchema>;
export type DamageKind = z.infer<typeof DamageKind>;
export type ItemProperty = z.infer<typeof ItemProperty>;
export type StatsRules = z.infer<typeof StatsSchema>;
export type ItemsRules = z.infer<typeof ItemsSchema>;
export type ItemBaseRules = z.infer<typeof ItemBaseRulesSchema>;
export type HandKind = z.infer<typeof Hand>;
export type LootRules = z.infer<typeof LootSchema>;
export type AttributeDef = z.infer<typeof AttributeSchema>;
export type DerivedStatDef = z.infer<typeof DerivedStatSchema>;
export type StatDrive = z.infer<typeof StatDrive>;
export type ModifierOp = z.infer<typeof ModifierOp>;

export interface Rules {
  skills: SkillsRules;
  disciplines: DisciplinesRules;
  combat: CombatRules;
  body: BodyRules;
  death: DeathRules;
  appearance: AppearanceRules;
  stats: StatsRules;
  items: ItemsRules;
  loot: LootRules;
}
