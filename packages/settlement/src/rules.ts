/**
 * Settlement rules as data: how a population splits, what each structure
 * kind is for, how many a settlement needs, and how the town is laid out.
 * The engine ships our game's set; a game replaces it with a JSON file of the
 * same shape (`loadRules`). Shares are integers in permille so every split is
 * exact and platform-independent.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The districts a town is made of. The first four take a share of the town's blocks (`districtShares`); the
 * civic, entertainment and education quarters are sized by the buildings that must stand in them (their
 * required counts), so a village gets one school and one tavern and a city a quarter of each.
 */
export const DISTRICT_KINDS = ["housing", "agriculture", "shopping", "manufacturing", "civic", "entertainment", "education"] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];
/** The districts sized by a share of the blocks. */
export const SHARED_DISTRICT_KINDS = ["housing", "agriculture", "shopping", "manufacturing"] as const;

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
  /** Storeys it has; its height is `buildingHeightM` (the rules' architecture), not a flat number. */
  floors: z.number().int().min(1),
  /** Floor-to-floor height of every storey, metres, for halls taller than a dwelling (ground floor included); defaults to the architecture's. */
  storeyM: z.number().positive().optional(),
  /** What its workers are called ("blacksmith"). */
  role: z.string(),
  /** Whether it trades: a shop is kept here, owned by one of its workers. */
  shop: z.boolean(),
});

/** Real-world building proportions: a storey is 1.5x the human, the ground ceiling is 8 ft. */
export const ArchitectureSchema = z.strictObject({
  /** Floor to floor of a normal storey, metres. */
  storeyM: z.number().positive(),
  /** Ground-floor ceiling height, metres (8 ft). */
  groundCeilingM: z.number().positive(),
  /** Roof above the top storey, metres. */
  roofM: z.number().min(0),
  /** The human every proportion is measured against, metres. */
  characterM: z.number().positive(),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const RequiredSchema = z.strictObject({
  /** One per this many people (rounded up). */
  perPopulation: z.number().int().positive().optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
  /** At most one per this many people (rounded up): a ceiling that grows with the town, so a tavern is not on every street. */
  maxPerPopulation: z.number().int().positive().optional(),
  /** A settlement smaller than this has none (a village has no barracks or theatre). */
  minPopulation: z.number().int().positive().optional(),
});

/**
 * The town wall (spec §16): a ring around the streets with a gate where each main road leaves and a tower at
 * the corners and every `towerSpacingMm`. Farms stand outside it, along the roads out of the gates. Lengths are
 * millimetres at scale 1 (they follow the building factor like parcels); heights are metres.
 */
export const FortificationSchema = z.strictObject({
  /** Towns of at least this many households are walled; smaller ones are open villages (no wall, same farms). */
  minHouseholds: z.number().int().min(0),
  /** Clear ground between the outermost street and the wall's inner face. */
  setbackMm: z.number().int().min(0),
  thicknessMm: z.number().int().positive(),
  heightM: z.number().positive(),
  /** The longest wall piece: one wall model's run (a wall is pieces, so each can be one model). */
  pieceMm: z.number().int().positive(),
  /** A tower's side (towers are square). */
  towerMm: z.number().int().positive(),
  towerHeightM: z.number().positive(),
  /** The most wall between two towers. */
  towerSpacingMm: z.number().int().positive(),
  gateHeightM: z.number().positive(),
});
export type Fortification = z.infer<typeof FortificationSchema>;

export const DEFAULT_FORTIFICATION: Fortification = { minHouseholds: 45, setbackMm: 4000, thicknessMm: 2000, heightM: 6, pieceMm: 6000, towerMm: 5000, towerHeightM: 9, towerSpacingMm: 40000, gateHeightM: 8 };

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
  districtShares: sharesOf(SHARED_DISTRICT_KINDS),
  layout: z.strictObject({
    /** Parcels along and across a block. */
    block: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    parcelSizeMm: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    streetWidthMm: z.number().int().positive(),
    /** Parcels the town has per household (permille, rounded up), for housing and everything else. */
    parcelsPerHouseholdPermille: z.number().int().min(1000),
    /** Farm plots outside the town: enough to feed everyone, times this (permille), so granaries and mills fit too. */
    farmSurplusPermille: z.number().int().min(1000).default(1250),
  }),
  architecture: ArchitectureSchema,
  /** The town wall; a rules file without one gets DEFAULT_FORTIFICATION. */
  fortification: FortificationSchema.default(DEFAULT_FORTIFICATION),
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
    /** Never build with any of the town's footprint above this absolute height, metres. */
    maxElevationM: z.number().positive().default(60),
    /** Nor above this height over the sea (the world's sea level), metres: the lowland band. */
    lowlandBandM: z.number().positive().default(40),
    /** The lowest ground of the town's whole footprint stands at least this far above the sea (a livable tread, not a tidal flat), metres. Also at least this far above any lake or river nearby. The survey caller may raise it (`TerrainFields.safeFloorM`) so the stored tiles clear the spawner's margin. */
    minElevationM: z.number().positive().default(4),
    /** The most the ground may rise and fall across the town's whole footprint (max minus min height, from the height field, not the slope), metres. */
    maxReliefM: z.number().positive().default(3),
    /** Ground above this height is a mountain, metres. */
    ridgeHeightM: z.number().positive().default(120),
    /** No site lies within this many metres of a mountain (0 turns it off). */
    mountainClearanceM: z.number().min(0).default(300),
    /** The steepest step a person walks, degrees: a site must be walkable from the world's spawn (or the largest connected land) over steps no steeper than this. Water blocks. */
    walkSlopeDeg: z.number().positive().max(89).default(25),
    /** Turn the walk rule off (false) to allow stranded flats (a plateau ringed by cliffs). */
    requireReachable: z.boolean().default(true),
  }),
});

export type SettlementRules = z.infer<typeof SettlementRulesSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;

export const BUILTIN_RULES: SettlementRules = {
  version: "settlement-rules/4",
  demographics: {
    householdSizeX10: 44,
    ageShares: { child: 280, adolescent: 170, adult: 410, elder: 140 },
    laborParticipationPermille: 850,
    classShares: { peasant: 610, artisan: 230, merchant: 100, clergy: 25, guard: 25, noble: 10 },
  },
  districtShares: { housing: 560, agriculture: 165, shopping: 110, manufacturing: 165 },
  layout: { block: [4, 2], parcelSizeMm: [12000, 20000], streetWidthMm: 6000, parcelsPerHouseholdPermille: 1550, farmSurplusPermille: 1250 },
  architecture: { storeyM: 2.7, groundCeilingM: 2.44, roofM: 2, characterM: 1.8 },
  fortification: DEFAULT_FORTIFICATION,
  archetypes: {
    house: { kinds: ["housing"], weight: 10, households: 1, workers: 0, feeds: 0, floors: 2, role: "", shop: false },
    // A tall house on a busy street: the homes between the halls of the civic, entertainment and education quarters.
    townhouse: { kinds: ["civic", "entertainment", "education"], weight: 3, households: 1, workers: 0, feeds: 0, floors: 3, role: "", shop: false },
    artisan_house: { kinds: ["housing", "manufacturing"], weight: 3, households: 1, workers: 1, feeds: 0, floors: 2, role: "artisan", shop: false },
    farmstead: { kinds: ["agriculture"], weight: 10, households: 1, workers: 2, feeds: 30, floors: 2, role: "farmer", shop: false },
    granary: { kinds: ["agriculture", "shopping"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 6, role: "granary keeper", shop: false },
    mill: { kinds: ["agriculture", "manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 3, storeyM: 3.5, role: "miller", shop: false },
    bakery: { kinds: ["shopping"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 2, role: "baker", shop: true },
    smithy: { kinds: ["manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 4, role: "blacksmith", shop: true },
    workshop: { kinds: ["manufacturing"], weight: 4, households: 0, workers: 2, feeds: 0, floors: 2, role: "craftsman", shop: true },
    market: { kinds: ["shopping"], weight: 6, households: 0, workers: 1, feeds: 0, floors: 1, role: "trader", shop: true },
    tavern: { kinds: ["entertainment"], weight: 2, households: 0, workers: 2, feeds: 0, floors: 3, role: "innkeeper", shop: true },
    inn: { kinds: ["entertainment"], weight: 2, households: 0, workers: 3, feeds: 0, floors: 3, role: "innkeeper", shop: true },
    theatre: { kinds: ["entertainment"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 1, storeyM: 9, role: "player", shop: true },
    bathhouse: { kinds: ["entertainment"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 1, storeyM: 5, role: "bath keeper", shop: true },
    chapel: { kinds: ["housing", "civic"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 8, role: "priest", shop: false },
    // Church life: the parish church on the square with its churchyard and the priest's house beside it; the
    // church's almshouse-hospital for the sick, old and poor; a cathedral for a city; a monastery out on its own lands.
    parish_church: { kinds: ["civic"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 1, storeyM: 11, role: "priest", shop: false },
    churchyard: { kinds: ["civic", "housing"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 1, role: "sexton", shop: false },
    rectory: { kinds: ["civic"], weight: 1, households: 1, workers: 1, feeds: 0, floors: 2, role: "clerk", shop: false },
    hospital: { kinds: ["civic"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, storeyM: 3.5, role: "infirmarian", shop: false },
    cathedral: { kinds: ["civic"], weight: 1, households: 0, workers: 6, feeds: 0, floors: 1, storeyM: 18, role: "canon", shop: false },
    monastery: { kinds: ["agriculture"], weight: 1, households: 0, workers: 8, feeds: 20, floors: 2, storeyM: 4, role: "monk", shop: false },
    apothecary: { kinds: ["shopping"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 2, role: "apothecary", shop: true },
    town_hall: { kinds: ["civic"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, storeyM: 4, role: "clerk", shop: false },
    guardhouse: { kinds: ["civic"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 2, role: "town guard", shop: false },
    barracks: { kinds: ["civic"], weight: 1, households: 0, workers: 8, feeds: 0, floors: 2, storeyM: 3.5, role: "soldier", shop: false },
    school: { kinds: ["education"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 2, role: "teacher", shop: false },
    library: { kinds: ["education"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 2, storeyM: 4, role: "scribe", shop: false },
    warehouse: { kinds: ["manufacturing", "shopping"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 5, role: "porter", shop: false },
  },
  required: {
    market: { min: 1, perPopulation: 400 },
    chapel: { min: 1, max: 3, perPopulation: 600, maxPerPopulation: 250 },
    granary: { min: 1, perPopulation: 500, maxPerPopulation: 200 },
    mill: { min: 1, perPopulation: 600, maxPerPopulation: 300 },
    bakery: { min: 1, perPopulation: 250, maxPerPopulation: 120 },
    smithy: { min: 1, perPopulation: 400, maxPerPopulation: 150 },
    tavern: { min: 1, perPopulation: 300, maxPerPopulation: 150 },
    inn: { minPopulation: 250, perPopulation: 500, maxPerPopulation: 300 },
    theatre: { minPopulation: 600, perPopulation: 2000, max: 2 },
    bathhouse: { minPopulation: 400, perPopulation: 1000, max: 3 },
    town_hall: { minPopulation: 200, min: 1, max: 1 },
    parish_church: { minPopulation: 200, min: 1, perPopulation: 1500, max: 4 },
    churchyard: { min: 1, perPopulation: 1500, max: 4 },
    rectory: { minPopulation: 200, min: 1, perPopulation: 1500, max: 4 },
    hospital: { minPopulation: 400, perPopulation: 1500, max: 3 },
    cathedral: { minPopulation: 2000, min: 1, max: 1 },
    monastery: { minPopulation: 1000, min: 1, max: 1 },
    apothecary: { minPopulation: 250, perPopulation: 600, maxPerPopulation: 400 },
    guardhouse: { min: 1, perPopulation: 300, maxPerPopulation: 200 },
    barracks: { minPopulation: 1200, perPopulation: 2500, max: 2 },
    school: { min: 1, perPopulation: 500, maxPerPopulation: 350 },
    library: { minPopulation: 800, perPopulation: 2000, max: 2 },
    warehouse: { min: 1, perPopulation: 500, maxPerPopulation: 150 },
    workshop: { perPopulation: 150 },
  },
  forbiddenAdjacent: [
    ["smithy", "granary"],
    ["smithy", "chapel"],
    ["smithy", "bakery"],
    ["tavern", "school"],
    ["tavern", "chapel"],
    ["tavern", "parish_church"],
    ["smithy", "churchyard"],
    ["tavern", "churchyard"],
  ],
  sites: {
    maxSlopePermille: 150,
    fertilityPermille: { plains: 1000, forest: 450, rainforest: 350, swamp: 150, beach: 100, desert: 60, tundra: 80 },
    waterRangeM: [200, 800],
    minSpacingM: 1500,
    minPressurePermille: 150,
    maxElevationM: 60,
    lowlandBandM: 40,
    minElevationM: 4,
    maxReliefM: 3,
    ridgeHeightM: 120,
    mountainClearanceM: 300,
    walkSlopeDeg: 25,
    requireReachable: true,
  },
};

/** How tall a building stands, metres: ground storey, one more per further floor, then the roof. */
export function buildingHeightM(a: Pick<Archetype, "floors" | "storeyM">, arch: Architecture): number {
  const ground = a.storeyM ?? arch.groundCeilingM;
  return ground + (a.floors - 1) * (a.storeyM ?? arch.storeyM) + arch.roofM;
}

export function loadRules(file: string): SettlementRules {
  return SettlementRulesSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
