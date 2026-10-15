/**
 * Settlement rules as data: how a population splits, what each structure
 * kind is for, how many a settlement needs, and how the town is laid out.
 * The engine ships our game's set; a game replaces it with a JSON file of the
 * same shape (`loadRules`). Shares are integers in permille so every split is
 * exact and platform-independent.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const DISTRICT_KINDS = ["housing", "agriculture", "shopping", "manufacturing"] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];

const sharesOf = (keys: readonly string[]) =>
  z
    .record(z.string(), z.number().int().min(0))
    .refine((o) => keys.every((k) => k in o) && Object.keys(o).length === keys.length, { message: `must give exactly ${keys.join(", ")}` })
    .refine((o) => Object.values(o).reduce((a, b) => a + b, 0) === 1000, { message: "shares must add up to 1000 (permille)" });

const AGES = ["child", "adolescent", "adult", "elder"] as const;
const CLASSES = ["peasant", "artisan", "merchant", "clergy", "guard", "noble"] as const;

export const ArchetypeSchema = z.strictObject({
  /** Districts it may stand in. */
  kinds: z.array(z.enum(DISTRICT_KINDS)).min(1),
  /** Base likelihood in the structure solve. */
  weight: z.number().positive(),
  /** Households it houses. */
  households: z.number().int().min(0),
  /** Workers it employs. */
  workers: z.number().int().min(0),
  /** People it feeds. */
  feeds: z.number().int().min(0),
  /** How tall it stands, metres (its scene footprint's height). */
  heightM: z.number().positive(),
  /** What its workers are called ("blacksmith"). */
  role: z.string(),
  /** Whether it trades: a shop is kept here, owned by one of its workers. */
  shop: z.boolean(),
});

export const RequiredSchema = z.strictObject({
  /** One per this many people (rounded up). */
  perPopulation: z.number().int().positive().optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
});

export const SettlementRulesSchema = z.strictObject({
  version: z.string().min(1),
  demographics: z.strictObject({
    /** Mean household size x10 (44 = 4.4). */
    householdSizeX10: z.number().int().positive(),
    ageShares: sharesOf(AGES),
    /** Share of adults and adolescents who work. */
    laborParticipationPermille: z.number().int().min(0).max(1000),
    classShares: sharesOf(CLASSES),
  }),
  /** How the blocks are split between the district kinds. */
  districtShares: sharesOf(DISTRICT_KINDS),
  layout: z.strictObject({
    /** Parcels along and across a block. */
    block: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    parcelSizeMm: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    streetWidthMm: z.number().int().positive(),
    /** Parcels the town has per household (permille, rounded up), for housing and everything else. */
    parcelsPerHouseholdPermille: z.number().int().min(1000),
  }),
  archetypes: z.record(z.string(), ArchetypeSchema),
  required: z.record(z.string(), RequiredSchema),
  /** Pairs that may never stand on neighbouring parcels. */
  forbiddenAdjacent: z.array(z.tuple([z.string(), z.string()])),
  /** Where a settlement may stand (site selection). */
  sites: z.strictObject({
    /** The steepest ground it will build on, rise over run in permille. */
    maxSlopePermille: z.number().int().positive(),
    /** How good a biome's land is for living off, 0 to 1000 (a biome not listed is 0). */
    fertilityPermille: z.record(z.string(), z.number().int().min(0).max(1000)),
    /** The nearest and farthest water it wants, metres: nearer floods, farther is a walk. */
    waterRangeM: z.tuple([z.number().positive(), z.number().positive()]),
    /** Sites are at least this far apart, metres. */
    minSpacingM: z.number().positive(),
    /** Below this pressure (0 to 1000) a place is not a site. */
    minPressurePermille: z.number().int().min(0).max(1000),
  }),
});

export type SettlementRules = z.infer<typeof SettlementRulesSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;

export const BUILTIN_RULES: SettlementRules = {
  version: "settlement-rules/1",
  demographics: {
    householdSizeX10: 44,
    ageShares: { child: 280, adolescent: 170, adult: 410, elder: 140 },
    laborParticipationPermille: 850,
    classShares: { peasant: 610, artisan: 230, merchant: 100, clergy: 25, guard: 25, noble: 10 },
  },
  districtShares: { housing: 560, agriculture: 165, shopping: 110, manufacturing: 165 },
  layout: { block: [4, 2], parcelSizeMm: [12000, 20000], streetWidthMm: 6000, parcelsPerHouseholdPermille: 1550 },
  archetypes: {
    house: { kinds: ["housing"], weight: 10, households: 1, workers: 0, feeds: 0, heightM: 5, role: "", shop: false },
    artisan_house: { kinds: ["housing", "manufacturing"], weight: 3, households: 1, workers: 1, feeds: 0, heightM: 5, role: "artisan", shop: false },
    farmstead: { kinds: ["agriculture"], weight: 10, households: 1, workers: 2, feeds: 30, heightM: 5, role: "farmer", shop: false },
    granary: { kinds: ["agriculture", "shopping"], weight: 2, households: 0, workers: 1, feeds: 0, heightM: 6, role: "granary keeper", shop: false },
    mill: { kinds: ["agriculture", "manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, heightM: 8, role: "miller", shop: false },
    bakery: { kinds: ["shopping", "housing"], weight: 2, households: 0, workers: 1, feeds: 0, heightM: 5, role: "baker", shop: true },
    smithy: { kinds: ["manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, heightM: 5, role: "blacksmith", shop: true },
    workshop: { kinds: ["manufacturing"], weight: 4, households: 0, workers: 2, feeds: 0, heightM: 5, role: "craftsman", shop: true },
    market: { kinds: ["shopping"], weight: 6, households: 0, workers: 1, feeds: 0, heightM: 3, role: "trader", shop: true },
    tavern: { kinds: ["shopping", "housing"], weight: 2, households: 0, workers: 2, feeds: 0, heightM: 7, role: "innkeeper", shop: true },
    chapel: { kinds: ["housing", "shopping"], weight: 1, households: 0, workers: 1, feeds: 0, heightM: 10, role: "priest", shop: false },
    warehouse: { kinds: ["manufacturing", "shopping"], weight: 2, households: 0, workers: 1, feeds: 0, heightM: 6, role: "porter", shop: false },
  },
  required: {
    market: { min: 1, perPopulation: 400 },
    chapel: { min: 1, max: 3, perPopulation: 600 },
    granary: { min: 1, perPopulation: 500 },
    mill: { min: 1, perPopulation: 600 },
    bakery: { min: 1, perPopulation: 250 },
    smithy: { min: 1, perPopulation: 400 },
    tavern: { min: 1, perPopulation: 300 },
    warehouse: { min: 1, perPopulation: 500 },
    workshop: { perPopulation: 150 },
  },
  forbiddenAdjacent: [
    ["smithy", "granary"],
    ["smithy", "chapel"],
    ["smithy", "bakery"],
  ],
  sites: {
    maxSlopePermille: 150,
    fertilityPermille: { plains: 1000, forest: 450, rainforest: 350, swamp: 150, beach: 100, desert: 60, tundra: 80 },
    waterRangeM: [200, 800],
    minSpacingM: 1500,
    minPressurePermille: 150,
  },
};

export function loadRules(file: string): SettlementRules {
  return SettlementRulesSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
