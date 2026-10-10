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
  damage: z.strictObject({ base: positive.default(10), massPower: z.number().min(0).default(0.5), armourHalf: positive.default(10) }).prefault({}),
  /** Chance a blow lands on the aimed part: novice + masterBonus × m. */
  precision: z.strictObject({ novice: share.default(0.3), masterBonus: share.default(0.65) }).prefault({}),
  /**
   * A guard facing the blow is a contest (docs/MASTERY-AND-COMBAT.md §3.3):
   * the defender stops it with chance `base + perSkill × (m_defence − m_attack)`,
   * held within [min, max]; a guard that loses lets `failedLetsThrough` of the blow through.
   * A parry that stops a blow disarms the attacker when the defender knows
   * the `disarm` technique (a discipline's) and out-skills the attacker by
   * at least `disarmMargin` (as a share of skills.max).
   */
  defence: z
    .strictObject({
      base: share.default(0.5),
      perSkill: z.number().min(0).default(1),
      min: share.default(0.05),
      max: share.default(0.95),
      failedLetsThrough: share.default(0.5),
      disarmMargin: share.default(0.3),
    })
    .prefault({}),
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
  /** A hand: which hand's item it holds. Its arm (it and the parts above it, below the root) swings that hand's blows. */
  holds: z.enum(["main", "off"]).optional(),
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

/** One kind of treatment: how long it takes a novice, and how hard it is (0..1). */
const Treatment = z.strictObject({ seconds: positive, difficulty: share });

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
      /** Seconds before an open wound stops bleeding on its own (null: only treatment stops it). A stump never does. */
      clotSeconds: z
        .strictObject({ cut: positive.nullable().default(null), thrust: positive.nullable().default(null) })
        .prefault({}),
      /** Blood made back per second while nothing bleeds. */
      regenPerSecond: z.number().min(0).default(0),
    })
    .prefault({}),
  /** Harmed parts that no longer bleed heal this share of their health per second (maimed parts wait for treatment). */
  healPerSecond: share.default(0),
  /**
   * What injuries cost (docs/MASTERY-AND-COMBAT.md §4.2). A part is
   * weakened while harmed below `harmedBelow`, and useless while maimed,
   * dismembered or at 0 health.
   */
  penalties: z
    .strictObject({
      /** Power and precision with a weakened arm. */
      weakArm: share.default(0.75),
      /** Speed with a weakened leg (a `cannotStand` part). */
      weakLeg: share.default(0.75),
      /** Speed with a useless leg (and no jumping). */
      uselessLeg: share.default(0.4),
      /** Speed with two useless legs, or useless hips: a crawl. */
      crawl: share.default(0.15),
      /** Stamina recovery with a weakened torso (the root part). */
      weakTorsoStamina: share.default(0.5),
    })
    .prefault({}),
  /** Landing hard: blunt damage per m/s of impact above `safeSpeed`, shared out over `parts` (absent: by share over the whole body). */
  fall: z
    .strictObject({
      safeSpeed: positive.default(13),
      damagePerSpeed: z.number().min(0).default(0),
      parts: z.record(id, share).default({}),
    })
    .prefault({}),
  /**
   * Medicine (M4, §4.5): treating a part takes time and may fail. `bandage`
   * stops an open wound bleeding, `stump` a lost part's stump, `set` turns
   * a maimed part back to harmed (at least `minHp`) so it heals. A healer at
   * Medicine m takes `seconds × (1 − fasterPerSkill × m)` and succeeds with
   * chance `chance.base + chance.perSkill × m − difficulty`, within
   * [chance.min, 1]; a failure costs the time and teaches more.
   */
  treatment: z
    .strictObject({
      /** Metres from healer to patient (treating yourself is always in reach). */
      reach: positive.default(2.5),
      fasterPerSkill: share.default(0.6),
      chance: z.strictObject({ base: share.default(0.6), perSkill: share.default(0.8), min: share.default(0.05) }).prefault({}),
      bandage: Treatment.prefault({ seconds: 4, difficulty: 0.2 }),
      stump: Treatment.prefault({ seconds: 6, difficulty: 0.4 }),
      set: Treatment.extend({ minHp: share.default(0.1) }).prefault({ seconds: 10, difficulty: 0.5 }),
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
 * - `maxMana`: the Mana pool's maximum (current keeps its share).
 */
export const StatDrive = z.enum(["moveSpeed", "maxHealth", "maxStamina", "maxMana"]);

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

/** Where worn armour sits: none for held items, a body slot for armour. */
export const ArmourSlot = z.enum(["none", "head", "chest", "hands", "legs", "ring", "amulet"]);

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
  /** Armour slot it is worn in (U10); "none" for held items. */
  slot: ArmourSlot.default("none"),
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

/** One line of a loot table: a named item base, how likely, how many. */
export const LootEntrySchema = z.strictObject({
  /** The item base dropped (an id in items.json). */
  base: id,
  /** Only this rank of the base (a rank id of the loot pool); absent: the lowest rank. */
  rank: id.optional(),
  /** Chance this line drops at all, 0..1. */
  chance: share.default(1),
  /** How many drop when it does (inclusive range). */
  count: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 1]),
});

/** Items on the ground and in bags (docs/ALPHA-PLAN.md, decisions D2 and D3). */
export const LootSchema = z.strictObject({
  /** Named loot tables: a creature's `drops.table` rolls every line of one. */
  tables: z.record(id, z.strictObject({ entries: z.array(LootEntrySchema).min(1) })).optional(),
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

// ---------------------------------------------------------------- ingress

/**
 * Ingress hardening (roadmap T1, exit criterion X5): what one session may
 * send before the gateway stops listening.
 *
 * Intents: the client sends at most one per server tick (30/s at 30 Hz;
 * same-tick changes collapse in MirrorClient), so 40/s with a burst of 60
 * never constrains legitimate play — not even a reconnect burst
 * (MirrorClient holds at most 4) — while a flood of hundreds per second
 * exhausts the burst in milliseconds. Pickups are key presses: 5/s with
 * a burst of 10 is far above human mashing. Past its budget a message is
 * dropped and counted; past maxViolations excess messages inside
 * abuseWindowSeconds the session is disconnected (close 4000).
 *
 * maxClientPayloadBytes is the largest inbound WebSocket frame (see
 * GatewayOptions): 64 KiB is ~16x the largest legitimate message (a
 * character look, capped at 4 KiB). Keep it above ~8 KiB, or character
 * creation breaks.
 */
export const IngressSchema = z.strictObject({
  /** Largest inbound WebSocket frame accepted, bytes. */
  maxClientPayloadBytes: z.number().int().positive().default(65536),
  /** Intent tokens refilled per second, per session. */
  intentsPerSecond: z.number().min(1).default(40),
  /** Most intents a session may burst at once. */
  intentBurst: z.number().int().min(1).default(60),
  /** Pickup tokens refilled per second, per session. */
  pickupsPerSecond: z.number().min(1).default(5),
  /** Most pickups a session may burst at once. */
  pickupBurst: z.number().int().min(1).default(10),
  /** Seconds an abuse window spans. */
  abuseWindowSeconds: z.number().min(1).default(10),
  /** Excess messages inside one window before the session is disconnected. */
  maxViolations: z.number().int().min(1).default(100),
});

// -------------------------------------------------------------- creatures

/** One kind of creature (docs/ALPHA-PLAN.md, decision D6). */
export const CreatureSchema = z.strictObject({
  name: z.string().min(1),
  /** Whole-body health (D1). */
  health: positive,
  /** Metres within which it notices a player and gives chase. */
  aggroRadius: positive,
  /** Metres from home past which it gives up the chase and walks back. */
  leashRadius: positive,
  /** Seconds a killed creature stays down before it rises at home. */
  respawnSeconds: z.number().min(0),
  /** How many spawn together (inclusive range). */
  pack: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 1]),
  /** Item bases a spawned creature may carry; one is chosen at random. */
  weapons: z.array(id).min(1),
  /** Share of full walking speed it chases at. */
  chaseSpeed: share.default(0.9),
  /** Seconds between its blows while in reach. */
  attackEverySeconds: positive.default(1.5),
  /** What it drops when killed: it rolls `rolls` times (inclusive range), each roll yields one mob-pool item with `chance`. */
  drops: z
    .strictObject({
      rolls: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([1, 2]),
      chance: share.default(0.8),
      /** A loot table (loot.json `tables`) whose lines also drop, each by its own chance. */
      table: id.optional(),
    })
    .default({ rolls: [1, 2], chance: 0.8 }),
});

export const CreaturesSchema = z.strictObject({
  /** Creature kind id -> its numbers. */
  creatures: z.record(id, CreatureSchema).default({}),
});

// ------------------------------------------------------------------ needs

/** One survival meter: full at spawn, drained over time, harmful at zero. */
export const NeedSchema = z.strictObject({
  /** Meter size. */
  max: positive.default(100),
  /** Points lost per minute of play. */
  drainPerMinute: z.number().min(0),
  /** Health lost per second while the meter is empty. */
  damagePerSecond: z.number().min(0),
});

export const NeedsSchema = z.strictObject({
  hunger: NeedSchema.default({ max: 100, drainPerMinute: 2, damagePerSecond: 1 }),
  thirst: NeedSchema.default({ max: 100, drainPerMinute: 3, damagePerSecond: 1 }),
  /** Share of the drain that applies while running or swimming (1 = no change). */
  exertionFactor: z.number().min(1).default(1.5),
});

// ---------------------------------------------------------------- spells

/** What a spell does when its cast completes. */
export const SpellEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** Restore `amount` health × the caster's `spellPower` stat (spread over the parts; it neither sets bones nor stops bleeding). */
    kind: z.literal("heal"),
    amount: positive,
  }),
]);

export const SpellSchema = z.strictObject({
  id,
  name: z.string().min(1),
  /** Mana spent when the cast completes. */
  mana: z.number().min(0),
  /** Seconds the caster must stand still and out of a fight (0: instant). */
  castSeconds: z.number().min(0).default(1.5),
  /** Seconds after a completed cast before it can be cast again. */
  cooldownSeconds: z.number().min(0).default(0),
  /** Who it can be cast on: the caster only, or anyone within `reach` metres. */
  target: z.enum(["self", "any"]).default("any"),
  reach: positive.default(3),
  effect: SpellEffectSchema,
});

export const SpellsSchema = z.strictObject({
  spells: z.array(SpellSchema).default([]),
  /** Mana pool when the rules bind no stat to `maxMana`, and regeneration per second without a `manaRegen` stat. */
  defaultMax: positive.default(50),
  defaultRegen: z.number().min(0).default(1),
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
  creatures: CreaturesSchema,
  needs: NeedsSchema,
  ingress: IngressSchema,
  spells: SpellsSchema,
} as const;

export type RuleFile = keyof typeof RULE_FILES;

export type SkillsRules = z.infer<typeof SkillsSchema>;
export type DisciplinesRules = z.infer<typeof DisciplinesSchema>;
export type Discipline = z.infer<typeof DisciplineSchema>;
export type CombatRules = z.infer<typeof CombatSchema>;
export type SpellsRules = z.infer<typeof SpellsSchema>;
export type Spell = z.infer<typeof SpellSchema>;
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
export type NeedsRules = z.infer<typeof NeedsSchema>;
export type NeedRules = z.infer<typeof NeedSchema>;
export type IngressRules = z.infer<typeof IngressSchema>;
export type CreaturesRules = z.infer<typeof CreaturesSchema>;
export type CreatureRules = z.infer<typeof CreatureSchema>;
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
  ingress: IngressRules;
  creatures: CreaturesRules;
  needs: NeedsRules;
  spells: SpellsRules;
}
