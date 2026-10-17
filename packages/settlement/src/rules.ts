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
  /** Doors and openings people use (1 when not given): a market is open on every side, a church or a gaol has one controlled door. */
  entrances: z.number().int().min(1).optional(),
  /** People it holds at once (0 when not given): a church's congregation, a school's pupils, a gaol's cells. */
  capacity: z.number().int().min(0).optional(),
  /** It stands only on a plot open to at least this many streets (a corner plot is open to 2): a market needs the traffic. */
  minAccess: z.number().int().min(1).optional(),
  /** It stands only on housing plots of these wealth bands (a tenement in the poor streets). */
  wealth: z.array(z.enum(["high", "middle", "low"])).optional(),
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
  /** It also serves the visitors the town's masters draw (taverns, inns): counted on residents plus visitors. */
  visitors: z.boolean().optional(),
  /** It makes the town's export (`withIndustry` sets it): its masters' work is on top of it, not instead of it. */
  export: z.boolean().optional(),
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

/**
 * The town watch (where crime is likeliest): a guard post at every gate (an open village at the ends of its main
 * road), in the market (one per `marketPlotsPerPost` market plots) and in the poor streets (one per
 * `poorHomesPerPost` low-income housing plots); a headquarters and a gaol beside it at the back of the civic
 * quarter. The archetypes named here stand only on the plots the layout reserves for them.
 */
export const WatchSchema = z.strictObject({
  post: z.string(),
  headquarters: z.string(),
  gaol: z.string(),
  /** Guard posts of an open village (no gates): at the ends of its main road. */
  villageEntrancePosts: z.number().int().min(0).max(4),
  marketPlotsPerPost: z.number().int().positive(),
  poorHomesPerPost: z.number().int().positive(),
  /** The share of housing plots that are the poor streets (farthest from the square, nearest the craft gate). */
  lowIncomePermille: z.number().int().min(0).max(1000),
  /** The share that are the well-off streets nearest the square. */
  highIncomePermille: z.number().int().min(0).max(1000),
});
export type Watch = z.infer<typeof WatchSchema>;
export const DEFAULT_WATCH: Watch = { post: "guardhouse", headquarters: "watch_hq", gaol: "gaol", villageEntrancePosts: 2, marketPlotsPerPost: 10, poorHomesPerPost: 20, lowIncomePermille: 300, highIncomePermille: 200 };

/**
 * Farmland by acreage: a holding is as many acres as its farmstead feeds people times `acresPerPersonX10`/10
 * (arable, fallow and pasture together), laid out as one field `fieldAspect` times deeper than its frontage on
 * the road. Holdings stand apart, each farmstead alone in its fields.
 */
export const FarmingSchema = z.strictObject({
  acresPerPersonX10: z.number().int().positive(),
  fieldAspect: z.number().int().positive(),
});
export type Farming = z.infer<typeof FarmingSchema>;
export const DEFAULT_FARMING: Farming = { acresPerPersonX10: 15, fieldAspect: 2 };

/**
 * Mastery: about one person in `oneInPeople` is a master of their profession, drawn per town (the "mastery"
 * stream). A master runs a master workplace (`professions[p].master`) that does the work of `yield` ordinary
 * ones, so the town needs fewer of them; a master farm needs a `landFactor`th of the land. Masters draw people:
 * `residentsPerMaster` more live in the town, `visitorsPerMaster` more come through it (taverns, inns). A town with
 * `communityMasters` masters of one profession is a master community in it.
 */
export const MasterySchema = z.strictObject({
  oneInPeople: z.number().int().positive(),
  yield: z.number().int().min(1),
  landFactor: z.number().int().min(1),
  residentsPerMaster: z.number().int().min(0),
  visitorsPerMaster: z.number().int().min(0),
  communityMasters: z.number().int().positive(),
  /**
   * Grand masters: each master is one with a chance of one in `oneInMasters`. Pupils pay a grand master to learn
   * the craft over years: each draws `pupils` more people to live in the town, and the town builds a workplace of
   * the discipline's ordinary kind for every `pupilsPerWorkplace` of them, so it grows bigger around the one
   * discipline that honours them.
   */
  grandMaster: z.strictObject({ oneInMasters: z.number().int().positive(), pupils: z.number().int().min(0), pupilsPerWorkplace: z.number().int().positive() }).optional(),
  /** Each profession: the ordinary archetype, the master's, and how likely a master is of it. */
  professions: z.record(z.string(), z.strictObject({ archetype: z.string(), master: z.string(), weight: z.number().positive() })),
});
export type Mastery = z.infer<typeof MasterySchema>;
export const DEFAULT_MASTERY: Mastery = {
  oneInPeople: 100,
  yield: 4,
  landFactor: 4,
  residentsPerMaster: 10,
  visitorsPerMaster: 50,
  communityMasters: 3,
  grandMaster: { oneInMasters: 20, pupils: 30, pupilsPerWorkplace: 5 },
  professions: {
    farming: { archetype: "farmstead", master: "master_farmstead", weight: 6 },
    smithing: { archetype: "smithy", master: "master_smithy", weight: 2 },
    crafting: { archetype: "workshop", master: "master_workshop", weight: 3 },
    baking: { archetype: "bakery", master: "master_bakery", weight: 2 },
  },
};

/**
 * The homeless: a few people in a town have no home of their own (beggars, vagrants, the widowed and orphaned,
 * day labourers between masters). A town of `minPopulation` or more has between `permille[0]` and `permille[1]`
 * of its people homeless, drawn per town (the "homeless" stream) and scaled by its density (a crowded town has
 * more); they sleep at the `shelters` (the hospital, the monasteries and churches) or rough where there are none.
 */
export const HomelessSchema = z.strictObject({
  permille: z.tuple([z.number().int().min(0).max(1000), z.number().int().min(0).max(1000)]),
  minPopulation: z.number().int().min(0),
  shelters: z.array(z.string()),
});
export type Homeless = z.infer<typeof HomelessSchema>;
export const DEFAULT_HOMELESS: Homeless = { permille: [10, 30], minPopulation: 150, shelters: ["hospital", "monastery", "chapel", "parish_church", "cathedral"] };

/**
 * Open ground inside the town: parks (one per `parkPerPeople`, on the middling streets) and empty lots, a share
 * `lotsPermille[trend]` of the homes. A growing town's lots are cleared ground at its edge waiting to be built on;
 * a shrinking town's are abandoned plots scattered through it; a stable town has a few. Both are walk-through.
 */
export const TRENDS = ["growing", "stable", "shrinking"] as const;
export type Trend = (typeof TRENDS)[number];
export const OpenGroundSchema = z.strictObject({
  park: z.string(),
  lot: z.string(),
  parkPerPeople: z.number().int().positive(),
  lotsPermille: z.strictObject({ growing: z.number().int().min(0).max(500), stable: z.number().int().min(0).max(500), shrinking: z.number().int().min(0).max(500) }),
});
export type OpenGround = z.infer<typeof OpenGroundSchema>;
export const DEFAULT_OPEN_GROUND: OpenGround = { park: "park", lot: "empty_lot", parkPerPeople: 600, lotsPermille: { growing: 50, stable: 15, shrinking: 80 } };

/** How a town is reached: by sea (a port), by river or lake, by road, or hardly at all (remote: far over land or on poor ground). */
export const ACCESS = ["port", "river", "road", "remote"] as const;
export type Access = (typeof ACCESS)[number];

/**
 * Settings: what a town's place allows. Its access caps how many people it can keep (trade and food come in by
 * water far more cheaply than by cart, so a port grows biggest and a remote town stays small), and sets how
 * densely they live: `densityPermille` is a range a town is drawn from (the "setting" stream), 1000 the rules'
 * own layout. A dense town shares homes more and keeps few gardens; a sparse one spreads out over more ground.
 * A town is growing, stable or shrinking: `trendPermille` is the chance of growing and of shrinking (the rest
 * stable), drawn per town; trade brings people to a port, a remote town loses them.
 * Masters go where their goods sell: a town's chance of each person being a master is `masteryPermille` of the
 * rules' (more in a port, few in a remote town, which lacks much else besides).
 * A site is a port when its footprint sits against the sea, a lake or a river (within the near water range of its
 * edge), a river town when a river or lake is within the far range;
 * it is remote when the walk to it from the spawn is longer than `remoteWalkM` or its land is poor (pressure
 * under `remotePressurePermille`).
 */
const AccessSettingSchema = z.strictObject({ maxPopulation: z.number().int().positive(), masteryPermille: z.number().int().min(0).max(5000), trendPermille: z.tuple([z.number().int().min(0).max(1000), z.number().int().min(0).max(1000)]), densityPermille: z.tuple([z.number().int().min(500).max(1500), z.number().int().min(500).max(1500)]) });
export const SettingsSchema = z.strictObject({
  access: z.strictObject({ port: AccessSettingSchema, river: AccessSettingSchema, road: AccessSettingSchema, remote: AccessSettingSchema }),
  remoteWalkM: z.number().positive(),
  remotePressurePermille: z.number().int().min(0).max(1000),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  access: {
    port: { maxPopulation: 3500, masteryPermille: 1500, trendPermille: [500, 100], densityPermille: [1050, 1200] },
    river: { maxPopulation: 3000, masteryPermille: 1200, trendPermille: [400, 150], densityPermille: [950, 1100] },
    road: { maxPopulation: 2500, masteryPermille: 1000, trendPermille: [300, 250], densityPermille: [850, 1000] },
    remote: { maxPopulation: 600, masteryPermille: 250, trendPermille: [150, 450], densityPermille: [600, 800] },
  },
  remoteWalkM: 1500,
  remotePressurePermille: 250,
};

/**
 * Street furniture and dressing (the props stage): what stands in a town's streets, its square and its parks. A
 * walled town's streets are paved (the road edges' `surface`), a village's are beaten earth.
 *   - Lamps line the streets at the plots' boundaries, one every `lampEveryPlots` plots on each side, the two sides
 *     staggered, `lampInsetMm` into the street from its edge; one at each corner of the square.
 *   - The square has benches round its edge (every `squareBenchSpacingMm`, `squareBenchInsetMm` in), a fountain
 *     from `fountainMinPopulation` people, a statue from `statueMinPopulation`, and a statue to each grand master.
 *   - A park has `parkBenches` benches facing a fountain or a statue (the "props" stream picks which).
 *   - The `stores` (taverns, inns, warehouses, bakeries) have a barrel and a crate by the door; homes on the
 *     `planters` wealth bands a planter either side of it; an industry's workplace its `dressing` either side
 *     (logs at a sawmill, ore carts at a mine, fish racks at a fishery, sacks at a mill).
 *   - The `terraces` archetypes stand on a raised terrace over their whole plot, `heightMm` up, reached from the
 *     street by stairs of `stepRiseMm` steps, each `stepTreadMm` deep and `stairsWidthMm` wide.
 * Sizes are millimetres [width, depth, height]: width along the street (or the bench's seat), depth away from it.
 */
export const PROP_KINDS = ["street_lamp", "bench", "fountain", "statue", "barrel", "crate", "planter", "log_pile", "ore_cart", "fish_rack", "grain_sacks", "guild_banner"] as const;
export type PropKind = (typeof PROP_KINDS)[number];
const SizeMm = z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]);
export const PropsSchema = z.strictObject({
  sizesMm: z.strictObject(Object.fromEntries(PROP_KINDS.map((k) => [k, SizeMm])) as Record<PropKind, typeof SizeMm>),
  lampEveryPlots: z.number().int().positive(),
  lampInsetMm: z.number().int().min(0),
  squareBenchSpacingMm: z.number().int().positive(),
  squareBenchInsetMm: z.number().int().min(0),
  fountainMinPopulation: z.number().int().min(0),
  statueMinPopulation: z.number().int().min(0),
  parkBenches: z.number().int().min(0).max(4),
  stores: z.array(z.string()),
  planters: z.array(z.enum(["high", "middle", "low"])),
  dressing: z.record(z.string(), z.enum(PROP_KINDS)).default({}),
  terraces: z.strictObject({ archetypes: z.array(z.string()), heightMm: z.number().int().positive(), stepRiseMm: z.number().int().positive(), stepTreadMm: z.number().int().positive(), stairsWidthMm: z.number().int().positive() }),
});
export type Props = z.infer<typeof PropsSchema>;
export const DEFAULT_PROPS: Props = {
  sizesMm: { street_lamp: [300, 300, 3500], bench: [1800, 600, 900], fountain: [4000, 4000, 2500], statue: [1500, 1500, 4000], barrel: [700, 700, 1000], crate: [900, 900, 900], planter: [1200, 500, 600], log_pile: [3000, 900, 1100], ore_cart: [1400, 900, 1100], fish_rack: [2400, 700, 1600], grain_sacks: [1600, 900, 800], guild_banner: [1000, 400, 4500] },
  lampEveryPlots: 2,
  lampInsetMm: 500,
  squareBenchSpacingMm: 8000,
  squareBenchInsetMm: 2500,
  fountainMinPopulation: 1000,
  statueMinPopulation: 2000,
  parkBenches: 2,
  stores: ["tavern", "inn", "warehouse", "bakery", "master_bakery"],
  planters: ["high"],
  dressing: { sawmill: "log_pile", mine: "ore_cart", fishery: "fish_rack", master_fishery: "fish_rack", mill: "grain_sacks", guild_hall: "guild_banner" },
  terraces: { archetypes: ["town_hall", "guild_hall", "parish_church", "cathedral", "library", "townhouse"], heightMm: 600, stepRiseMm: 200, stepTreadMm: 350, stairsWidthMm: 3000 },
};

/**
 * Industry: what a town lives off and is known for, read from the land around it (a site's `biomes` share within
 * reach, its water). Each industry's abundance (0 to 1000) is the weighted share of its biomes near the town, full
 * at `fullSharePermille` (fishing: the water the town sits on; farming: the land's fertility, `sites.fertilityPermille`).
 * The most abundant (at least `minAbundancePermille`; compared by `priorityPermille` of it, so farming, which any
 * fertile land has, gives way to rarer riches) is the town's industry:
 *   - Its size: the access's population cap is scaled from `capFloorPermille` (no resources) to the whole cap (rich land),
 *     so only towns on rich land grow big.
 *   - Its export: a `workplace` (sawmill, mine, fishery, mill) for every `exportPerPeople` people at full abundance, out
 *     in the craft quarter; its signature product is the highest-tier `product` whose land is near (rare wood, special ore).
 *   - Its masters: `specialtyPermille` of them practise the industry's `profession` (added to the professions, with
 *     `archetype` and `master`, when the rules have none).
 * Another industry's workplace (and a profession's master workplace the rules lack) stands in no town.
 */
export const INDUSTRIES = ["timber", "mining", "fishing", "farming"] as const;
export type IndustryId = (typeof INDUSTRIES)[number];
export const WATER_KINDS_FISHED = ["sea", "lake", "river"] as const;
const ProductSchema = z.strictObject({
  /** The raw material (a crafting material id where one exists). */
  material: z.string(),
  tier: z.number().int().min(1).max(5),
  /** Biomes it comes from: at least `minSharePermille` of the land within reach must be one of them. */
  biomes: z.array(z.string()).default([]),
  minSharePermille: z.number().int().min(1).max(1000).default(1),
  /** Or the water the town sits on. */
  water: z.array(z.enum(WATER_KINDS_FISHED)).default([]),
  /** What the town makes of it and is known for. */
  export: z.string(),
});
export const IndustrySchema = z.strictObject({
  biomes: z.record(z.string(), z.number().int().min(0).max(1000)).default({}),
  water: z.partialRecord(z.enum(WATER_KINDS_FISHED), z.number().int().min(0).max(1000)).default({}),
  fertility: z.boolean().default(false),
  /** How much it counts when choosing the town's industry, permille of its abundance: farming is what every town falls back on, so rarer riches win over it. */
  priorityPermille: z.number().int().min(1).max(1000).default(1000),
  profession: z.strictObject({ name: z.string(), archetype: z.string(), master: z.string() }),
  workplace: z.string(),
  products: z.array(ProductSchema).min(1),
  /** What it trades as (rules.industry.trade): the good's name and its price where it is made, in copper a load. */
  good: z.string(),
  basePrice: z.number().int().positive(),
  /**
   * Its stock over the years (rules.industry.history): a town working it at its full cap uses `depletePermillePerYear`
   * of it a year, and `regrowPermillePerYear` of what is used comes back each year (forests regrow, fish return; ore does not).
   */
  depletePermillePerYear: z.number().int().min(0).max(1000).default(0),
  regrowPermillePerYear: z.number().int().min(0).max(1000).default(0),
});
/**
 * Trade between towns (`tradeRegion`): each industry's workplace sends `loadsPerWorkplace` loads a year, and every town
 * needs a load of each good per `peoplePerLoad` people. A town sells its own goods first at home; what it lacks it buys from
 * the nearest towns with loads to spare. The price rises `pricePermillePerKm` a km on the road (by sea between two ports,
 * `seaPermille` of that), and goods the town cannot get at all cost `shortagePermille` of the dearest price.
 */
export const TradeRulesSchema = z.strictObject({
  loadsPerWorkplace: z.number().int().positive(),
  peoplePerLoad: z.number().int().positive(),
  pricePermillePerKm: z.number().int().min(0),
  seaPermille: z.number().int().min(0).max(1000),
  shortagePermille: z.number().int().min(1000),
});
/**
 * A region over the years (`evolveRegion`): a town grows toward the people its land keeps by `growthPermillePerYear` of
 * itself a year, or shrinks toward it by `shrinkPermillePerYear`; within `stablePermille` of it, it is stable. It turns
 * from the industry it works to another only when that one is richer by `switchPermille` (or its own is too poor).
 */
export const HistoryRulesSchema = z.strictObject({
  switchPermille: z.number().int().min(0).default(0),
  growthPermillePerYear: z.number().int().min(0).max(1000),
  shrinkPermillePerYear: z.number().int().min(0).max(1000),
  stablePermille: z.number().int().min(0).max(1000),
});
/**
 * A town's craft guild (`townGuild`): a town with an industry and at least `minPopulation` people has a guild hall
 * (`archetype`) of its profession, led by its best master. The guild's ranks are the reputation a player earns with it;
 * each rank lets them buy the guild's recipes up to its tier, and a rank with `pupil` needs a master of the guild to take
 * them on (the town's signature recipe is sold only from such a rank).
 */
export const GuildRulesSchema = z.strictObject({
  archetype: z.string(),
  minPopulation: z.number().int().positive(),
  ranks: z.array(z.strictObject({ title: z.string(), reputation: z.number().int().min(0), tier: z.number().int().min(1).max(5), pupil: z.boolean().default(false) })).min(1),
});
export const IndustryRulesSchema = z.strictObject({
  industries: z.record(z.enum(INDUSTRIES), IndustrySchema),
  fullSharePermille: z.number().int().min(1).max(1000),
  minAbundancePermille: z.number().int().min(0).max(1000),
  capFloorPermille: z.number().int().min(0).max(1000),
  specialtyPermille: z.number().int().min(0).max(999),
  exportPerPeople: z.number().int().positive(),
  trade: TradeRulesSchema.optional(),
  history: HistoryRulesSchema.optional(),
  guild: GuildRulesSchema.optional(),
});
export type IndustryRules = z.infer<typeof IndustryRulesSchema>;
export const DEFAULT_INDUSTRY: IndustryRules = IndustryRulesSchema.parse({
  industries: {
    timber: {
      biomes: { forest: 1000, rainforest: 1000, swamp: 500 },
      profession: { name: "crafting", archetype: "workshop", master: "master_workshop" },
      workplace: "sawmill",
      good: "timber",
      basePrice: 40,
      depletePermillePerYear: 12,
      regrowPermillePerYear: 30,
      products: [
        { material: "ash-log", tier: 1, biomes: ["forest", "plains"], export: "ash furniture" },
        { material: "yew-log", tier: 2, biomes: ["forest", "swamp"], minSharePermille: 200, export: "yew longbows and cabinets" },
        { material: "ironwood-log", tier: 3, biomes: ["rainforest"], export: "ironwood furniture" },
        { material: "heartwood", tier: 4, biomes: ["rainforest"], minSharePermille: 400, export: "heartwood furniture and staves" },
      ],
    },
    mining: {
      biomes: { mountains: 1000, volcanic: 1000, glacier: 600, desert: 500, tundra: 500 },
      profession: { name: "smithing", archetype: "smithy", master: "master_smithy" },
      workplace: "mine",
      good: "metal",
      basePrice: 90,
      depletePermillePerYear: 10,
      products: [
        { material: "iron-ore", tier: 1, biomes: ["mountains", "tundra", "desert"], export: "iron blades and tools" },
        { material: "silver-ore", tier: 2, biomes: ["mountains"], minSharePermille: 250, export: "silver-inlaid blades" },
        { material: "fire-crystal", tier: 3, biomes: ["volcanic"], export: "fire-forged blades" },
        { material: "frost-crystal", tier: 3, biomes: ["glacier"], export: "frost-tempered blades" },
      ],
    },
    fishing: {
      water: { sea: 1000, lake: 700, river: 500 },
      profession: { name: "fishing", archetype: "fishery", master: "master_fishery" },
      workplace: "fishery",
      good: "fish",
      basePrice: 30,
      depletePermillePerYear: 15,
      regrowPermillePerYear: 80,
      products: [
        { material: "sea-fish", tier: 1, water: ["sea"], export: "salted sea fish" },
        { material: "river-fish", tier: 1, water: ["lake", "river"], export: "smoked river fish" },
      ],
    },
    farming: {
      fertility: true,
      priorityPermille: 600,
      profession: { name: "farming", archetype: "farmstead", master: "master_farmstead" },
      workplace: "mill",
      good: "grain",
      basePrice: 20,
      products: [{ material: "grain", tier: 1, biomes: ["plains"], export: "flour and ale" }],
    },
  },
  fullSharePermille: 500,
  minAbundancePermille: 150,
  capFloorPermille: 400,
  specialtyPermille: 600,
  exportPerPeople: 150,
  trade: { loadsPerWorkplace: 12, peoplePerLoad: 60, pricePermillePerKm: 40, seaPermille: 400, shortagePermille: 1500 },
  history: { switchPermille: 250, growthPermillePerYear: 30, shrinkPermillePerYear: 50, stablePermille: 50 },
  guild: {
    archetype: "guild_hall",
    minPopulation: 400,
    ranks: [
      { title: "Initiate", reputation: 0, tier: 1 },
      { title: "Journeyman", reputation: 1000, tier: 2 },
      { title: "Craftsman", reputation: 3000, tier: 3 },
      { title: "Pupil of a master", reputation: 6000, tier: 4, pupil: true },
      { title: "Master of the guild", reputation: 12000, tier: 5, pupil: true },
    ],
  },
});

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
    /** Families sharing a home on average x10 (20 = 2): homes take fewer plots than households. */
    familiesPerHomeX10: z.number().int().min(10).default(10),
    /** Clear ground between the town and the craft quarter outside it (homes are kept away from workshops and warehouses), mm at scale 1. */
    worksBufferMm: z.number().int().min(0).default(0),
    /** Room for at most this many households per household (permille): with homes shared, the town is not built with a home to spare for every family. */
    homeSpacePermille: z.number().int().min(1000).optional(),
    /** How densely the town lives (permille, 1000 as laid out): set per town from its settings (`withDensity`), not in a rules file. */
    densityPermille: z.number().int().min(500).max(1500).optional(),
    /** Whether the town is growing, stable or shrinking: set per town from its settings, not in a rules file (stable when absent). */
    trend: z.enum(TRENDS).optional(),
  }),
  farming: FarmingSchema.default(DEFAULT_FARMING),
  watch: WatchSchema.optional(),
  mastery: MasterySchema.optional(),
  homeless: HomelessSchema.optional(),
  openGround: OpenGroundSchema.optional(),
  /** Street furniture, paving and terraces (none without it). */
  props: PropsSchema.optional(),
  /** What a town lives off, from the land around it (none without it, or without the land). */
  industry: IndustryRulesSchema.optional(),
  settings: SettingsSchema.default(DEFAULT_SETTINGS),
  /** Worship: the churches' seats hold at least `sharePermille` of the people (a mass at a time). */
  worship: z.strictObject({ archetypes: z.array(z.string()), sharePermille: z.number().int().min(0).max(1000) }).optional(),
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
    /**
     * Water from the edge of the town's footprint, metres: within the first a town sits against it (a port can,
     * on the sea, a lake or a river), within the second it is in easy reach; farther is a walk, and the site is
     * worth less the farther it is. People settle by water: nearer is never worse (the dry-feet rules keep the
     * town above floods).
     */
    waterRangeM: z.tuple([z.number().positive(), z.number().positive()]),
    /** Biomes whose resources (timber, game, fuel) draw settlers, 0 to 1000: a site with one within `resourceRangeM` of its footprint is worth up to 30% more. */
    resourcePermille: z.record(z.string(), z.number().int().min(0).max(1000)).default({}),
    resourceRangeM: z.number().positive().default(600),
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
  version: "settlement-rules/10",
  demographics: {
    householdSizeX10: 44,
    ageShares: { child: 280, adolescent: 170, adult: 410, elder: 140 },
    laborParticipationPermille: 850,
    classShares: { peasant: 610, artisan: 230, merchant: 100, clergy: 25, guard: 25, noble: 10 },
  },
  districtShares: { housing: 560, agriculture: 165, shopping: 110, manufacturing: 165 },
  layout: { block: [4, 2], parcelSizeMm: [12000, 20000], streetWidthMm: 6000, parcelsPerHouseholdPermille: 1550, farmSurplusPermille: 1250, familiesPerHomeX10: 20, worksBufferMm: 40000, homeSpacePermille: 1250 },
  farming: DEFAULT_FARMING,
  watch: DEFAULT_WATCH,
  mastery: DEFAULT_MASTERY,
  homeless: DEFAULT_HOMELESS,
  openGround: DEFAULT_OPEN_GROUND,
  props: DEFAULT_PROPS,
  industry: DEFAULT_INDUSTRY,
  settings: DEFAULT_SETTINGS,
  worship: { archetypes: ["chapel", "parish_church", "cathedral"], sharePermille: 500 },
  architecture: { storeyM: 2.7, groundCeilingM: 2.44, roofM: 2, characterM: 1.8 },
  fortification: DEFAULT_FORTIFICATION,
  archetypes: {
    // Families shared homes: a house holds two households, a tenement in the poor streets three.
    house: { kinds: ["housing"], weight: 10, households: 2, workers: 0, feeds: 0, floors: 2, role: "", shop: false, entrances: 2, capacity: 12 },
    tenement: { kinds: ["housing"], weight: 6, households: 3, workers: 0, feeds: 0, floors: 3, role: "", shop: false, entrances: 1, capacity: 16, wealth: ["low"] },
    // Gardens and orchards between the houses: with families sharing homes, the town needs fewer of them than plots.
    // Open ground (rules.openGround): placed only where the layout reserves it, never by the solve alone.
    park: { kinds: ["housing", "civic"], weight: 1, households: 0, workers: 0, feeds: 0, floors: 1, storeyM: 0.5, role: "", shop: false, entrances: 4, capacity: 150 },
    empty_lot: { kinds: ["housing", "shopping"], weight: 1, households: 0, workers: 0, feeds: 0, floors: 1, storeyM: 0.1, role: "", shop: false, entrances: 4 },
    garden: { kinds: ["housing"], weight: 8, households: 0, workers: 0, feeds: 0, floors: 1, storeyM: 0.5, role: "", shop: false, entrances: 1 },
    // A tall house on a busy street: the homes between the halls of the civic, entertainment and education quarters.
    townhouse: { kinds: ["civic", "shopping", "entertainment", "education"], weight: 3, households: 1, workers: 0, feeds: 0, floors: 3, role: "", shop: false, entrances: 2, capacity: 8 },
    artisan_house: { kinds: ["housing"], weight: 3, households: 1, workers: 1, feeds: 0, floors: 2, role: "artisan", shop: false, entrances: 2, capacity: 8 },
    farmstead: { kinds: ["agriculture"], weight: 10, households: 1, workers: 2, feeds: 30, floors: 2, role: "farmer", shop: false, entrances: 3, capacity: 8 },
    // Masters: a master's workplace does the work of four (rules.mastery.yield), with apprentices to learn from them.
    // A master farm feeds four times the people on a quarter of the land.
    master_farmstead: { kinds: ["agriculture"], weight: 1, households: 1, workers: 3, feeds: 120, floors: 2, role: "master farmer", shop: false, entrances: 3, capacity: 10 },
    master_smithy: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, storeyM: 4, role: "master blacksmith", shop: true, entrances: 2 },
    master_workshop: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 2, role: "master craftsman", shop: true, entrances: 2 },
    // Industry (rules.industry): only the town's own industry's workplace stands, in the craft quarter.
    sawmill: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 1, storeyM: 4.5, role: "sawyer", shop: false, entrances: 2 },
    mine: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 6, feeds: 0, floors: 1, storeyM: 4, role: "miner", shop: false, entrances: 1 },
    fishery: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 1, storeyM: 3.5, role: "fisherman", shop: true, entrances: 2 },
    master_fishery: { kinds: ["manufacturing"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 2, role: "master fisherman", shop: true, entrances: 2 },
    // A craft guild's hall (rules.industry.guild): by the square, where the guild meets, keeps its rolls and sells its recipes.
    guild_hall: { kinds: ["civic"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 3, storeyM: 4.5, role: "guild clerk", shop: true, entrances: 2, capacity: 120 },
    master_bakery: { kinds: ["shopping"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, role: "master baker", shop: true, entrances: 2, capacity: 16 },
    granary: { kinds: ["agriculture"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 6, role: "granary keeper", shop: false, entrances: 1 },
    mill: { kinds: ["agriculture", "manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 3, storeyM: 3.5, role: "miller", shop: false, entrances: 2 },
    // The market streets' shops: a draper, cobbler, butcher or chandler, the shopkeeper's family living above.
    shop: { kinds: ["shopping"], weight: 5, households: 1, workers: 1, feeds: 0, floors: 3, role: "shopkeeper", shop: true, entrances: 2, capacity: 12 },
    bakery: { kinds: ["shopping"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 2, role: "baker", shop: true, entrances: 2, capacity: 10 },
    smithy: { kinds: ["manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 4, role: "blacksmith", shop: true, entrances: 2 },
    workshop: { kinds: ["manufacturing"], weight: 4, households: 0, workers: 2, feeds: 0, floors: 2, role: "craftsman", shop: true, entrances: 2 },
    // The market is all comings and goings: open stalls on a corner plot, reached from every side.
    market: { kinds: ["shopping"], weight: 6, households: 0, workers: 1, feeds: 0, floors: 1, role: "trader", shop: true, entrances: 4, capacity: 200, minAccess: 2 },
    tavern: { kinds: ["entertainment"], weight: 2, households: 0, workers: 2, feeds: 0, floors: 3, role: "innkeeper", shop: true, entrances: 2, capacity: 40 },
    inn: { kinds: ["entertainment"], weight: 2, households: 0, workers: 3, feeds: 0, floors: 3, role: "innkeeper", shop: true, entrances: 2, capacity: 50 },
    theatre: { kinds: ["entertainment"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 1, storeyM: 9, role: "player", shop: true, entrances: 3, capacity: 400 },
    bathhouse: { kinds: ["entertainment"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 1, storeyM: 5, role: "bath keeper", shop: true, entrances: 1, capacity: 30 },
    // Churches and schools are controlled places: one or two doors, and only so many inside.
    chapel: { kinds: ["housing", "civic"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 8, role: "priest", shop: false, entrances: 1, capacity: 120 },
    // Church life: the parish church on the square with its churchyard and the priest's house beside it; the
    // church's almshouse-hospital for the sick, old and poor; a cathedral for a city; a monastery out on its own lands.
    parish_church: { kinds: ["civic"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 1, storeyM: 11, role: "priest", shop: false, entrances: 2, capacity: 400 },
    churchyard: { kinds: ["civic", "housing"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 1, role: "sexton", shop: false, entrances: 1 },
    rectory: { kinds: ["civic"], weight: 1, households: 1, workers: 1, feeds: 0, floors: 2, role: "clerk", shop: false, entrances: 1, capacity: 8 },
    hospital: { kinds: ["civic"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, storeyM: 3.5, role: "infirmarian", shop: false, entrances: 1, capacity: 30 },
    cathedral: { kinds: ["civic"], weight: 1, households: 0, workers: 6, feeds: 0, floors: 1, storeyM: 18, role: "canon", shop: false, entrances: 3, capacity: 2000 },
    monastery: { kinds: ["agriculture"], weight: 1, households: 0, workers: 8, feeds: 20, floors: 2, storeyM: 4, role: "monk", shop: false, entrances: 1, capacity: 60 },
    apothecary: { kinds: ["shopping"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 2, role: "apothecary", shop: true, entrances: 1, capacity: 6 },
    town_hall: { kinds: ["civic"], weight: 1, households: 0, workers: 3, feeds: 0, floors: 2, storeyM: 4, role: "clerk", shop: false, entrances: 2, capacity: 100 },
    // The watch: guard posts where trouble is likeliest (gates, market, poor streets), their headquarters, and the gaol.
    guardhouse: { kinds: ["housing", "civic", "shopping", "entertainment", "education"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 2, role: "town guard", shop: false, entrances: 1, capacity: 6 },
    watch_hq: { kinds: ["civic"], weight: 1, households: 0, workers: 4, feeds: 0, floors: 2, storeyM: 3.5, role: "captain of the watch", shop: false, entrances: 1, capacity: 20 },
    gaol: { kinds: ["civic"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 2, storeyM: 3.5, role: "gaoler", shop: false, entrances: 1, capacity: 24 },
    barracks: { kinds: ["civic"], weight: 1, households: 0, workers: 8, feeds: 0, floors: 2, storeyM: 3.5, role: "soldier", shop: false, entrances: 1, capacity: 60 },
    school: { kinds: ["education"], weight: 1, households: 0, workers: 2, feeds: 0, floors: 2, role: "teacher", shop: false, entrances: 1, capacity: 40 },
    library: { kinds: ["education"], weight: 1, households: 0, workers: 1, feeds: 0, floors: 2, storeyM: 4, role: "scribe", shop: false, entrances: 1, capacity: 30 },
    // Goods are kept out with the crafts, away from the homes.
    warehouse: { kinds: ["manufacturing"], weight: 2, households: 0, workers: 1, feeds: 0, floors: 1, storeyM: 5, role: "porter", shop: false, entrances: 2 },
  },
  required: {
    market: { min: 1, perPopulation: 400 },
    chapel: { min: 1, max: 3, perPopulation: 600, maxPerPopulation: 250 },
    granary: { min: 1, perPopulation: 500, maxPerPopulation: 200 },
    mill: { min: 1, perPopulation: 600, maxPerPopulation: 300 },
    bakery: { min: 1, perPopulation: 250, maxPerPopulation: 120 },
    smithy: { min: 1, perPopulation: 400, maxPerPopulation: 150 },
    tavern: { min: 1, perPopulation: 300, maxPerPopulation: 150, visitors: true },
    inn: { minPopulation: 250, perPopulation: 500, maxPerPopulation: 300, visitors: true },
    theatre: { minPopulation: 600, perPopulation: 2000, max: 2 },
    bathhouse: { minPopulation: 400, perPopulation: 1000, max: 3 },
    town_hall: { minPopulation: 200, min: 1, max: 1 },
    // Only a town with an industry has a guild (withIndustry).
    guild_hall: { max: 0 },
    parish_church: { minPopulation: 200, min: 1, perPopulation: 1500, max: 4 },
    churchyard: { min: 1, perPopulation: 1500, max: 4 },
    rectory: { minPopulation: 200, min: 1, perPopulation: 1500, max: 4 },
    hospital: { minPopulation: 400, perPopulation: 1500, max: 3 },
    cathedral: { minPopulation: 2000, min: 1, max: 1 },
    monastery: { minPopulation: 1000, min: 1, max: 1 },
    apothecary: { minPopulation: 250, perPopulation: 600, maxPerPopulation: 400 },
    // Guard posts: the layout reserves one at each gate, in the market and in the poor streets.
    guardhouse: { min: 1 },
    watch_hq: { minPopulation: 200, min: 1, max: 1 },
    gaol: { minPopulation: 200, min: 1, perPopulation: 2500, max: 2 },
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
    waterRangeM: [60, 800],
    resourcePermille: { forest: 1000, rainforest: 700, swamp: 300 },
    resourceRangeM: 600,
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
