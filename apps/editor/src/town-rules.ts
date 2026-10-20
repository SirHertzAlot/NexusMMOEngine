/**
 * Town rules forms (roadmap EG4, Dungeons & PCG › Towns): labelled fields
 * with help for the sections of content/settlements/rules.json a designer
 * tunes by number. Keys are relative to the section (the panel passes the
 * section as the base path). Sections with no form here (buildings,
 * required buildings, industry, street dressing…) keep the tree editor, and
 * every form section can still open its full tree. Browser-safe.
 *
 * Shares are permille, as the file stores them: 1000 is everyone.
 */

import type { FieldSectionSpec, FieldSpec } from "./rules-control.js";

const int = (min?: number, max?: number) => ({ kind: "number", int: true, min, max }) as const;
const permille = int(0, 1000);
const metres = { kind: "number", min: 0 } as const;
const archetype = { kind: "enum", options: "archetypes" } as const;
const shares = (keys: readonly string[]): FieldSpec[] => keys.map((k) => ({ key: k, label: `${k[0].toUpperCase()}${k.slice(1)} (‰)`, ...int(0) }));

const ACCESS_LABELS = { port: "Port", river: "River or lake", road: "Road", remote: "Remote" } as const;

export const TOWN_FORMS: Readonly<Record<string, readonly FieldSectionSpec[]>> = {
  demographics: [
    {
      title: "Households and work",
      fields: [
        { key: "householdSizeX10", label: "Household size ×10", ...int(1), help: "Mean people per household, times ten: 44 is 4.4." },
        { key: "laborParticipationPermille", label: "Who works (‰)", ...permille, help: "Share of adults and adolescents who work." },
      ],
    },
    { title: "Ages", help: "Share of the people at each age. Must add up to 1000.", fields: shares(["child", "adolescent", "adult", "elder"]).map((f) => ({ ...f, key: `ageShares.${f.key}` })) },
    { title: "Classes", help: "Share of the people in each class. Must add up to 1000.", fields: shares(["peasant", "artisan", "merchant", "clergy", "guard", "noble"]).map((f) => ({ ...f, key: `classShares.${f.key}` })) },
  ],
  districtShares: [
    { title: "District shares", help: "How the town's blocks split between the district kinds. Must add up to 1000.", fields: shares(["housing", "agriculture", "shopping", "manufacturing"]) },
  ],
  layout: [
    {
      title: "Blocks and streets",
      fields: [
        { key: "block", label: "Block (parcels along–across)", kind: "pair" },
        { key: "parcelSizeMm", label: "Parcel size (mm, along–across)", kind: "pair" },
        { key: "streetWidthMm", label: "Street width (mm)", ...int(1) },
        { key: "worksBufferMm", label: "Craft quarter buffer (mm)", ...int(0), def: 0, help: "Clear ground between the town and the craft quarter outside it." },
      ],
    },
    {
      title: "Homes and plots",
      fields: [
        { key: "parcelsPerHouseholdPermille", label: "Parcels per household (‰)", ...int(1000), help: "1000 is one parcel per household; more leaves room for everything else." },
        { key: "familiesPerHomeX10", label: "Families per home ×10", ...int(10), def: 10, help: "20: two families share a home on average." },
        { key: "homeSpacePermille", label: "Home space (‰)", ...int(1000), optional: true, help: "Room for at most this many households per household. Empty: no cap." },
        { key: "farmSurplusPermille", label: "Farm surplus (‰)", ...int(1000), def: 1250, help: "Farm plots feed everyone times this, so granaries and mills fit too." },
      ],
    },
  ],
  farming: [
    {
      title: "Farmland",
      fields: [
        { key: "acresPerPersonX10", label: "Acres per person ×10", ...int(1), def: 15, help: "Arable, fallow and pasture together: 15 is 1.5 acres." },
        { key: "fieldAspect", label: "Field depth per frontage", ...int(1), def: 2, help: "A holding's field is this many times deeper than its road frontage." },
      ],
    },
  ],
  watch: [
    {
      title: "Buildings",
      help: "These stand only on the plots the layout reserves for them.",
      fields: [
        { key: "post", label: "Guard post", ...archetype },
        { key: "headquarters", label: "Headquarters", ...archetype },
        { key: "gaol", label: "Gaol", ...archetype },
      ],
    },
    {
      title: "Posts and streets",
      fields: [
        { key: "villageEntrancePosts", label: "Village entrance posts", ...int(0, 4), help: "Posts at the ends of an open village's main road." },
        { key: "marketPlotsPerPost", label: "Market plots per post", ...int(1) },
        { key: "poorHomesPerPost", label: "Poor homes per post", ...int(1) },
        { key: "lowIncomePermille", label: "Poor streets (‰ of housing)", ...permille, help: "Farthest from the square, nearest the craft gate." },
        { key: "highIncomePermille", label: "Well-off streets (‰ of housing)", ...permille, help: "Nearest the square." },
      ],
    },
  ],
  mastery: [
    {
      title: "Masters",
      help: "Masters run master workplaces that do the work of several ordinary ones, and draw people to the town.",
      fields: [
        { key: "oneInPeople", label: "One master in (people)", ...int(1) },
        { key: "yield", label: "Master workplace yield", ...int(1), help: "A master workplace does the work of this many ordinary ones." },
        { key: "landFactor", label: "Master farm land factor", ...int(1), help: "A master farm needs this fraction of the land: 4 is a quarter." },
        { key: "residentsPerMaster", label: "Residents per master", ...int(0) },
        { key: "visitorsPerMaster", label: "Visitors per master", ...int(0), help: "People who come through (taverns, inns)." },
        { key: "communityMasters", label: "Masters for a community", ...int(1), help: "A town with this many masters of one profession is a master community in it." },
      ],
    },
    {
      title: "Grand masters",
      help: "Pupils pay a grand master to learn, so the town grows around that one discipline.",
      fields: [
        { key: "grandMaster.oneInMasters", label: "One grand master in (masters)", ...int(1) },
        { key: "grandMaster.pupils", label: "Pupils each", ...int(0) },
        { key: "grandMaster.pupilsPerWorkplace", label: "Pupils per extra workplace", ...int(1) },
      ],
    },
  ],
  settings: [
    {
      title: "When a town is remote",
      fields: [
        { key: "remoteWalkM", label: "Remote beyond a walk of (m)", ...metres, help: "A town farther than this from the spawn is remote." },
        { key: "remotePressurePermille", label: "Remote below land pressure (‰)", ...permille, help: "Or when its land is this poor." },
      ],
    },
    ...(Object.entries(ACCESS_LABELS) as [keyof typeof ACCESS_LABELS, string][]).map(([k, label]) => ({
      title: `${label} towns`,
      fields: [
        { key: `access.${k}.maxPopulation`, label: "Most people", ...int(1) },
        { key: `access.${k}.masteryPermille`, label: "Master chance (‰ of the rules')", ...int(0, 5000) },
        { key: `access.${k}.trendPermille`, label: "Grow–shrink chance (‰)", kind: "pair", help: "Chance of growing, then of shrinking; the rest is stable." },
        { key: `access.${k}.densityPermille`, label: "Density range (‰)", kind: "pair", help: "Drawn per town between these; 1000 is the layout as given." },
      ] satisfies FieldSpec[],
    })),
  ],
  sites: [
    {
      title: "Ground",
      fields: [
        { key: "maxSlopePermille", label: "Steepest ground (‰ rise)", ...int(1) },
        { key: "maxReliefM", label: "Most relief across the town (m)", ...metres, def: 3 },
        { key: "minElevationM", label: "Lowest ground above water (m)", ...metres, def: 4 },
        { key: "maxElevationM", label: "Highest ground (m)", ...metres, def: 60 },
        { key: "lowlandBandM", label: "Lowland band above sea (m)", ...metres, def: 40 },
        { key: "ridgeHeightM", label: "Mountain above (m)", ...metres, def: 120 },
        { key: "mountainClearanceM", label: "Clear of mountains by (m)", ...metres, def: 300, help: "0 turns it off." },
        { key: "walkSlopeDeg", label: "Steepest walkable step (°)", kind: "number", min: 1, max: 89, def: 25 },
        { key: "requireReachable", label: "Must be reachable on foot", kind: "bool", def: true, help: "Off allows plateaus ringed by cliffs." },
      ],
    },
    {
      title: "Water, land and spacing",
      fields: [
        { key: "waterRangeM", label: "Water: against–in reach (m)", kind: "pair", help: "Within the first a town sits against water; within the second it is in easy reach." },
        { key: "fertilityPermille", label: "Fertility by biome (‰)", kind: "map", help: "e.g. plains: 1000, forest: 450. A biome not listed is 0." },
        { key: "resourcePermille", label: "Resources by biome (‰)", kind: "map", def: {}, help: "Biomes whose timber, game or fuel draw settlers." },
        { key: "resourceRangeM", label: "Resource range (m)", ...metres, def: 600 },
        { key: "minSpacingM", label: "Sites at least apart (m)", ...metres },
        { key: "minPressurePermille", label: "Least pressure for a site (‰)", ...permille },
      ],
    },
  ],
  homeless: [
    {
      title: "Homeless",
      fields: [
        { key: "permille", label: "Share homeless, least–most (‰)", kind: "pair", help: "Drawn per town and scaled by its density." },
        { key: "minPopulation", label: "From a population of", ...int(0) },
        { key: "shelters", label: "Shelters (buildings)", kind: "list", help: "Where they sleep, comma-separated building kinds." },
      ],
    },
  ],
  openGround: [
    {
      title: "Parks and lots",
      fields: [
        { key: "park", label: "Park building", ...archetype },
        { key: "lot", label: "Empty lot building", ...archetype },
        { key: "parkPerPeople", label: "One park per (people)", ...int(1) },
        { key: "lotsPermille.growing", label: "Empty lots, growing town (‰ of homes)", ...int(0, 500) },
        { key: "lotsPermille.stable", label: "Empty lots, stable town (‰ of homes)", ...int(0, 500) },
        { key: "lotsPermille.shrinking", label: "Empty lots, shrinking town (‰ of homes)", ...int(0, 500) },
      ],
    },
  ],
  worship: [
    {
      title: "Worship",
      fields: [
        { key: "archetypes", label: "Churches (buildings)", kind: "list" },
        { key: "sharePermille", label: "Seats for (‰ of the people)", ...permille, help: "One mass at a time." },
      ],
    },
  ],
  architecture: [
    {
      title: "Heights",
      help: "Every proportion is measured against the human.",
      fields: [
        { key: "storeyM", label: "Storey, floor to floor (m)", ...metres },
        { key: "groundCeilingM", label: "Ground-floor ceiling (m)", ...metres },
        { key: "roofM", label: "Roof above the top storey (m)", ...metres },
        { key: "characterM", label: "The human (m)", ...metres },
      ],
    },
  ],
  fortification: [
    {
      title: "Walls",
      fields: [
        { key: "minHouseholds", label: "Walled from (households)", ...int(0), def: 45, help: "Smaller towns are open villages." },
        { key: "setbackMm", label: "Setback from streets (mm)", ...int(0), def: 4000 },
        { key: "thicknessMm", label: "Thickness (mm)", ...int(1), def: 2000 },
        { key: "heightM", label: "Height (m)", ...metres, def: 6 },
        { key: "pieceMm", label: "Longest piece (mm)", ...int(1), def: 6000, help: "One wall model's run." },
        { key: "gateHeightM", label: "Gate height (m)", ...metres, def: 8 },
      ],
    },
    {
      title: "Towers",
      fields: [
        { key: "towerMm", label: "Tower side (mm)", ...int(1), def: 5000 },
        { key: "towerHeightM", label: "Tower height (m)", ...metres, def: 9 },
        { key: "towerSpacingMm", label: "Most wall between towers (mm)", ...int(1), def: 40000 },
      ],
    },
  ],
};
