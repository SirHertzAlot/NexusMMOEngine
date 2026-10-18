# Settlements: procedural towns, baked offline

Status: **SG1 built** (the first vertical slice) and **SG3 spawning** in the world (this branch). SG2, SG3b and SG4 are planned; see
the [roadmap](ROADMAP.md) §4. The full design this follows is the
Procedural Settlement Engine specification (sections referenced as §n below).

## What it does

`@mmo-engine/settlement` turns a request (`settlementId`, `seed`,
`population`, optional rules) into a **settlement manifest**: a canonical JSON
document, identified by a content hash, that renderers, the scene spawner and
AI consume. It generates structure and population, not meshes.

    npm run settlement:bake -- --population 600 --seed 1234 --id 0182

writes `content/settlements/0182.settlement.json`. The same request always
gives the same file (a golden hash test pins it).

## The pipeline

Each stage reads what the one before wrote; a stage that fails stops the run
and the result names it (no exceptions across the API).

| Stage | Does | Spec |
|---|---|---|
| demographics | population to households, age cohorts, social classes, labour pool (integer counts that add up exactly) | §13 |
| demand | what must be fed, housed and staffed, and how many of each structure the size needs | §15 |
| layout | a street grid (sparse, connected graph), blocks split between housing, agriculture, shopping and manufacturing by distance and side, a parcel on every plot | §16–17 |
| structures | WFC over the parcel graph (`@mmo-engine/wfc`): domains from the district, forbidden neighbours as edge rules, required counts and ceilings, housing and food as minimum budgets, jobs as a ceiling on the labour pool | §18 |
| occupancy | households dealt into homes (an adult heads each), people dealt in with the demographic cohorts and classes, working-age people into jobs, a shop kept by one worker in each shop structure | §19–20 |
| validation | ten gates re-derived from the finished tables (demographics, housing, food, labour, road connectivity, structure coverage, zoning) | §22 |

The conventions are the engine's: stages are small and pure over typed data,
every collection is sorted by id, geometry is integer millimetres, each
domain has its own seeded RNG stream (`streams.ts`, the wfc package's
mulberry32), events are kept apart from the manifest and filtered by
verbosity (`silent` to `debug`), and the rules are data
(`SettlementRulesSchema`). Our game's rules are
`content/settlements/rules.json`, which every settlement CLI reads unless
`--rules file.json` names another (`MMO_SETTLEMENT_RULES` moves it;
`BUILTIN_RULES` stand in when it is absent, and the golden tests pin them).
The editor's **Towns** view (Dungeons & PCG) edits that file section by
section, saves it only when `checkRules` finds nothing (the schema, then every
archetype the rules name), and previews a town built from the unsaved rules
on a chosen land, with its plan, industry, guild and resource nodes.

## Decisions and deviations from the spec

- **TypeScript, not C++.** Bake-time generation in this engine is TypeScript
  (dungeon, wfc, placement, species); C++ is for hot paths. The determinism
  the spec asks for holds with integer data and seeded streams; nothing here
  uses wall-clock time, `Math.random` or unordered iteration.
- **sha256, not blake3**, for the content hash: it ships with Node, and the
  dungeon bake already uses it.
- **A street grid for now.** Terrain-aware site selection and engineered roads
  (§28: alignment, vertical profile, drainage, earthwork) come with SG2 behind
  the same `roads` shape.
- **The pre-bake already exists.** Survey, erosion, rivers, biomes and climate
  are the world bake in `engine-core/terrain`; SG2 reads those fields instead
  of regenerating them (spec §6 to §11).
- **No second client store.** The browser already mirrors authoritative ECS
  state (`@mmo-engine/mirror`); settlements reach it through the scene spawner
  (SG3), not a separate Three.js ECS (spec §29.11).

## Rules of thumb for the data

The labour ceiling is the binding constraint: jobs per structure must stay
low enough that a town full of non-housing parcels fits its labour pool, or
the structure solve has no solution and the run fails at the `structures`
stage with the solver's reason. The built-in set keeps most structures at one
job and the participation rate at 85 % of adults and adolescents.

## Spawning a town into the world (SG3)

Spawning is generic: it goes through the scene spawner, like creatures, items
and props, not a settlement-specific loader.

    npm run settlement:bake -- --id 0182 --seed 1234 --population 600 --scene --origin 200,-300
    MMO_SCENE=settlement-0182 npm run server

- `settlementScene(manifest, rules, { origin })` makes a world scene: one group
  at the origin, a node per structure with a `Structure` component (`kind`,
  `width`, `depth`, `height`, metres). The town is centred on the origin.
- The scene spawner turns a `Structure` node into a static box resting on the
  ground (the node's height is added to the ground height under it, like every
  node), carrying an `AssetRef` whose hash is `fnv1a32("structure:<kind>")`. The
  client already draws a static prop without a model as a box of its body's
  size, so a spawned town is visible before any art is mapped.
- **Mapping kinds to art later** is only a table from `structure:<kind>` to a
  model in the art manifest; nothing on the server changes.
- **Wet footing.** The scene spawner refuses (and reports as skipped) a building
  whose footprint, sampled about a metre apart, has any point less than 1 m above
  the water surface (sea or lake) or on a river cell, instead of drowning it.
  Upstream, a settlement request can carry `site: { origin, dry }` (`--world` does):
  parcels whose footprint (a 5 x 5 grid of tests) is not dry are dropped before the
  structures are solved, and the grid grows a block row at a time (up to 3) to make up
  for them; if the dry parcels still cannot house and serve the town, generation fails
  with "the site is too wet for the town ... choose a drier site". A dry site is the
  same town as no site. `--origin` without `--world` has no terrain to test, so only
  the spawner's refusal protects it.
- Entities are remembered per boot like every scene's, so a restart does not
  duplicate the town.
- Not spawned yet: roads (SG2 brings engineered roads) and the residents. The
  occupancy (households, npcs, shops) is in the manifest as data; putting people
  in the world needs a generic simulated-agent path in the engine, which is its own
  slice (the server has creatures and quest givers, not hundreds of idle villagers).

## Choosing where a town stands (SG2a)

`selectSites(terrain, rules.sites, count)` reads the world bake's coarse
fields and returns the best places, best first. A cell's *pressure* (0 to 1000)
is its slope factor, its distance from water (near enough to drink and mill,
not on the bank, which floods) and the fertility of the biome around it,
multiplied; sites keep `minSpacingM` apart. The input is structural, so
`surveyWorld(spec)` from engine-core passes in as it is (with the biome ids);
the settlement package does not depend on the engine.

    npm run settlement:bake -- --world packages/engine-core/worlds/default.world.json --site 1 --scene

surveys the world (several seconds), places the town at its best site and
writes the scene there. On the shipped 4 x 4 km world that finds two sites
with the default 1.5 km spacing; `rules.sites` is data like the rest.

### Flat, low land only (SG2c)

Slope alone is deceptive: a gentle grade over a long distance is a big change
in height, and a coarse cell's slope can hide a ridge. So site selection also
reads the height field over the town's whole footprint (`townHalfExtentM`, half
the block grid's larger side, passed to `selectSites` as `extentM`). A cell is
rejected when, within that reach:

- any ground is above `maxElevationM` (absolute) or more than `lowlandBandM`
  over the sea;
- the ground rises and falls by more than `maxReliefM` (highest minus lowest,
  default 3 m);
- the footprint's lowest ground (not its centre) is less than `minElevationM`
  (default 4 m) over the sea, or over any lake surface or river bed within a
  cell of the footprint: a coastal tread 1 m up is a tidal flat, not a home.
  The floor is never below `TerrainFields.safeFloorM`, which the bake CLI sets
  to the spawner's `STRUCTURE_MARGIN_M` (1 m) plus the world's `detailAmplitude`
  (1.5 m, the most the stored tiles' detail noise can pull ground under the
  survey): 2.5 m, so a site that passes never has a structure refused for wet
  footing. (On the default 4 km world this took the 600-person site from 269 of
  273 structures refused to none.) The default world's plains pass keeps its
  coastal tread 5 m above the water (`plains.coast.marginM`) so the shore still
  has sites;
- there is water, a river or ice;
- any ground within `mountainClearanceM` is above `ridgeHeightM` (a mountain);
- the centre cannot be walked to from the world's spawn (or, with no spawn, from
  the largest connected land): 8-neighbour steps no steeper than `walkSlopeDeg`
  (default 25), water blocking, rivers and ice not. A flat plateau ringed by
  cliffs passes every rule above and is still not a site: nobody could reach a
  home there. `requireReachable: false` turns it off. `TerrainFields.spawn`
  carries the spawn (the bake CLI passes `spawnPoint`); the engine's
  `reachableLand` (`terrain/reach.ts`) is the same rule over a whole survey.

Lower and flatter also scores higher (each factor takes the pressure from 1000
down to 500 at its limit). A `Site` reports its `elevationM` and `reliefM`. The
defaults are strict on purpose, and the CLI says "the world has fewer sites"
rather than build on a hillside. Before the plains pass (TE2, `plains` in the
world spec, see `WORLD-BUILDING.md`) the shipped 4 x 4 km world had no site at
3 m of relief for 100, 300 or 600 people (the dry land was a thin, rolling
strip: 6 m of relief for 100, 10 m for 300, 25 m for 600). With the plains
pass on, which the default world does, it has sites for all three, the nearest
under 500 m from the spawn (strict defaults; 2 / 2 / 1 sites at the 1.5 km
spacing).

The spawner then grounds each building on its whole footprint, not its centre:
the floor stands on the highest ground sample under it (a plinth of 5 cm above
on a slope), the body reaches the lowest, and a foundation slab (a static box
named `structure:foundation`) fills the gap from the lowest ground to the floor.
The terrain is not edited.

What is still a plain grid: the roads (SG2b brings engineered alignments,
profiles and drainage, spec §28) and the layout does not yet bend to a river
or a slope; each building stands on the highest ground under its footprint at spawn.

## Showing the town: art models with a box fallback (SG4a)

A `Structure` node may name an art model (`asset`, a catalog id). The server
gives the entity that model's asset hash, which the client already resolves
from the catalog the dev server serves out of the ignored `assets/` folder; the
body stays the footprint box. With no model named, or with the art not served,
the client draws the stand-in box of the body's size, so the town is always
visible.

The box is centred on the ground (half-height equal to the building's height),
so a model's base sits on the ground and a stand-in shows exactly `height`
above it.

    npm run settlement:bake -- --id 0182 --seed 1234 --world packages/engine-core/worlds/default.world.json --site 1 --scene --catalog assets/catalog.json

`--catalog` builds a kind-to-models map by name pattern (`buildArtMap`,
`DEFAULT_ART_PATTERNS`: the packs' whole-building presets) and each structure
takes one by its id, the same one every time. A kind with no match stays a
box. **The baked scene names licensed models, so
`content/scenes/settlement-*.scene.json` is gitignored: bake it locally.**
The manifest itself holds only archetypes and can be committed.

Checked end to end: a world baked into a scratch folder, `MMO_SCENE=settlement-0182`,
the client logged in and walking among 288 buildings (12 kinds, all mapped),
and the same town as stand-in boxes.

## Baking towns with the rest of the world

`npm run bake:all` runs the world bake, site selection, `settlement:bake --world --site k --scene` for each town (`--sites N`, `--auto-size` for 600/300/100 when a size has no site) and `settlement:scale-fit`, into the folders the `MMO_*` path variables name (`MMO_CONTENT_DIR`, `MMO_SETTLEMENT_OUT`, `MMO_SCENES_DIR`, `MMO_CATALOG`, `MMO_SCALE_OUT`); the three settlement CLIs read the same variables and `settlement:bake` takes `--scenes <dir>`. See the README, "Baking everything".

## Building scale

The global scale document (`content/scale.json`, `resolveScale(doc, "building")`)
makes houses bigger or smaller, so the town they stand in must follow.

- **Rules stay authored at scale 1.** `generateSettlement({ scale })` (and
  `layOut`'s last argument) multiplies the parcel size and street width by the
  factor (`scaledLayout`). A street never gets narrower than 2 m
  (`MIN_STREET_MM`), so a 0.7 m capsule always passes.
- **The manifest records it** (`scale`, default 1), so it is inside the hash: a
  different scale is a different town. The golden hash was re-pinned for the new
  field. `settlement:bake --scale <file>` reads a scale doc and bakes at its
  building factor.
- **The scene stays authored at scale 1.** A `Structure` node means "this size at
  scale 1"; the server's spawner applies the factor at spawn. Footprints are sized
  `(scaled parcel - 2 m margin) / factor`, so once the spawner multiplies them they
  leave 1 m to the scaled parcel's edge. Heights are `buildingHeightM` (see Architectural scale), unscaled.
  Node positions come from the scaled parcels.
- **Per-asset factors** (an `assets` entry for one model) are applied by the
  spawner on top and do not move parcels; use the report to see which overflow.

    npm run settlement:scale-report -- [--catalog assets/catalog.json] [--scale content/scale.json]

Per kind, every mapped model's size before and after its factor, the parcel
(width x depth) it must fit, and `OVERFLOW` where the scaled footprint exceeds the
parcel minus the margin; the exit code is 1 if any overflow. It reads the licensed
catalog locally and prints model ids to the terminal only.

## Architectural scale

The world is real scale (`content/scale.json` building factor 1): a human is 1.8 m,
and buildings are drawn for that human, not as flat boxes.

- **A storey is 1.5x the human**: `architecture.storeyM` 2.7 m floor to floor, the
  ground-floor ceiling `groundCeilingM` 2.44 m (8 ft), `roofM` 2 m, `characterM` 1.8 m.
- **Archetypes carry `floors`** (and an optional `storeyM` for tall halls) instead of a
  flat `heightM`. `buildingHeightM(archetype, architecture)` = ground storey +
  (floors - 1) x storey + roof, where an archetype's own `storeyM` replaces both the
  ground ceiling and the storey. A 2-storey house is 2.44 + 2.7 + 2 = 7.14 m, not 5 m;
  a chapel (one 8 m nave) 10 m; a mill (3 x 3.5 m) 12.5 m; a granary 8 m; a warehouse 7 m.
  The scene's `Structure.height` is this value. Rule files stay data-driven: a game
  changes the numbers, not the code.
- **The rules version is `settlement-rules/2`**, recorded in every manifest, so the
  golden hash was re-pinned on purpose (layout and placement did not change).
- **Art is brought to size per model**, not by one factor:

      npm run settlement:scale-fit -- [--catalog assets/catalog.json] [--scale content/scale.json] [--out content/scale.local.json]

  For each mapped model, the factor that brings its height to its archetype's
  `buildingHeightM`, held to what fits the parcel (parcel minus the 2 m margin): the
  smaller of the two. The output names licensed models, so it defaults to the gitignored
  `content/scale.local.json`; run the server with `MMO_SCALE=content/scale.local.json`.
  `settlement:scale-report --scale content/scale.local.json` then shows no overflows.


## Town plan: square, quarters, walls, gates and farms (SG5)

Before this, a town was a grid of blocks dealt to districts at random: taverns and
bakeries sat in housing blocks, the craft and farm districts were scattered, every
building faced the same way and there was no wall. Generator `settlement-gen/0.2.0`,
rules `settlement-rules/4` lay it out like a planned medieval town (the history it
draws on: [`MEDIEVAL-TOWN-LIFE.md`](MEDIEVAL-TOWN-LIFE.md)):

- **The square.** The block where the two primary roads cross is the town square (a
  village green): no plots, a paved, walk-through `town_square` node and a
  `town_well` at its centre. It is in the manifest as `square` (null if water took it).
- **Quarters grown from the square.** Seven district kinds: `housing`, `agriculture`,
  `shopping`, `manufacturing`, and now `civic`, `entertainment`, `education`. Each
  quarter inside grows block by block from its best block, a neighbour at a time, so
  it stays one piece: the civic quarter (town hall, guardhouses, parish church,
  rectory, almshouse-hospital, barracks, cathedral) first round the square, then the
  market, then the entertainment quarter (taverns, inns, theatre, baths) from one gate
  in along the main road, then the education quarter (schools, library) by the centre;
  housing is the rest (and may be several neighbourhoods). In a quarter's last block,
  its plots are the ones nearest the square and the rest are homes, so a village's
  tavern block is a tavern and its neighbours.
- **Sized by what must stand there.** Housing, shopping and manufacturing take
  `districtShares` of the plots the households need (the shares now cover only those
  four kinds); civic, entertainment and education get a plot per building that may
  stand only there (`required` counts) plus a quarter as many to spare. So a village of
  100 has one school and one tavern, and a city of 2500 a quarter of each.
  `required.<kind>.minPopulation` keeps a kind out of smaller places (theatre 600,
  library 800, barracks 1200, cathedral 2000, town hall and parish church 200);
  `maxPerPopulation` caps a kind at one per that many people.
- **Crafts and farms outside.** The craft quarter lines both sides of the road out of
  one gate, nearest the wall (the "districts" stream picks the side); beyond it, and
  along the other three roads, as many farm plots as feed the town (with
  `layout.farmSurplusPermille`, default 1250). A `monastery` stands among the farms in
  a town of 1000 or more.
- **Church life.** A `parish_church` with its `rectory` and the `hospital`
  (almshouse and infirmary) in the civic quarter, a `churchyard` beside them and among
  the homes, `chapel`s in the neighbourhoods, an `apothecary` in the market, and
  `forbiddenAdjacent` keeps taverns off churches, schools and churchyards.
- **Guards.** `guardhouse` (one per 300, "town guard", 4 jobs) and, for cities,
  `barracks` ("soldier", 8 jobs); occupancy staffs them like any workplace.
- **Every building faces its street.** `Parcel.facing` (0/90/180/270) is the yaw the
  scene writes to `transform.rotation[1]`.
- **A wall round a town, not round a house.** `rules.fortification` (defaulted, so old
  rule files parse): a town of `minHouseholds` (45) or more gets a ring wall
  `setbackMm` outside the outer street, `thicknessMm` thick and `heightM` tall, split
  into `town_wall` pieces no longer than `pieceMm` (one model's run), `wall_tower`s at
  the corners, beside each gate and at least every `towerSpacingMm`, and a
  `town_gate` where each primary road leaves, as wide as the street plus a metre each
  side. Smaller places are open villages. Pieces are in the manifest's
  `fortifications`; the scene makes them `Structure` nodes of those kinds, and a gate
  carries `Collider: none` so the spawner makes it walk-through (no slab). Pieces that
  would stand in water are dropped and counted in `wallOpenToWater`.
- **Gates.** `fortification` checks the ring is closed, one gate per side on a road,
  streets inside and crafts and farms outside; `district_quarters` checks each quarter
  inside (housing aside) is one connected group of blocks (empty blocks, the square
  or water, join their neighbours) and the crafts are on one road.
- **Beside water.** `layOut(..., dry)` takes the site's dryness test (mm from the town's
  centre): quarters take dry blocks first and the crafts the driest road, so a shore
  town keeps its tavern and school on land. Wet plots are still dropped by the
  generator as before.
- **Acreage (settlement-rules/5).** A farm is a holding, not a plot: `Parcel.holding`
  is one field beside its road, `farming.acresPerPersonX10` (15: arable, fallow and
  pasture) acres for each person the farmstead feeds (45 acres, about 300 by 600 m at
  scale 1, `farming.fieldAspect` 2 deep to 1 wide), the farmstead in its yard at the
  road edge. Holdings follow each other along the roads out, the far side of a road
  staggered by half a holding, so every farmstead stands alone in its fields; the first
  holding on a road starts far enough out that its depth clears the next road's fields.
  A town of 600 farms about 1100 acres, a city of 2500 nearly 5000, reaching kilometres
  out. The scene draws each field as a flat walk-through `farm_field`; a farm whose
  fields are not dry is dropped with its plot. Gate `farm_acreage`: every farm has its
  own land, no two holdings overlap or reach a town or craft plot, and the acres cover
  the people.
- **The watch.** `rules.watch` puts guard posts where trouble is likeliest: inside
  every gate (an open village at the two ends of its main road), one per
  `marketPlotsPerPost` (10) market plots, and one per `poorHomesPerPost` (20) homes in
  the poor streets. Housing plots carry `wealth`: the `lowIncomePermille` (30%)
  farthest from the square and nearest the craft gate are `low`, the 20% nearest the
  square `high`. A `watch_hq` (headquarters, "captain of the watch") stands at the
  back of the civic quarter and the `gaol` on the civic plot beside it (towns of 200 or
  more). The layout reserves these plots (`Parcel.post`, with why: gate, market, poor,
  headquarters, gaol), and those archetypes stand nowhere else. Gate `town_watch`
  re-derives it from where the buildings stand.
- **Access and capacity.** Archetypes carry `entrances` and `capacity` (written to the
  scene's `Structure`): a market is open stalls with 4 ways in and room for 200, a
  parish church 2 doors for 400, a chapel, school or gaol one door. `Parcel.access` is
  the streets a plot is open to (2 on a block's corner) and `minAccess: 2` keeps markets
  on corners; the market quarter grows out from the square along the main roads where
  the traffic is, and takes the corner plots of its blocks first. Gate
  `access_capacity` checks the corners and that the churches (`rules.worship`) seat
  half the people.
- **Homes apart from the works.** Warehouses moved out to the craft quarter, granaries
  to the farms and artisans' homes to the housing quarter; the craft quarter starts
  `layout.worksBufferMm` (40 m) further out than before, and gate `works_separation`
  checks no home is nearer a workshop or warehouse than that.
- **Shared homes.** Families shared houses: a `house` holds 2 households, a
  `tenement` (poor streets only, `wealth: ["low"]`) 3. Housing is the homes the
  households need at `layout.familiesPerHomeX10` (2 per home) with a quarter spare,
  `garden`s (yards and orchards) fill plots no one needs, and
  `layout.homeSpacePermille` (1250) caps the room built at 1.25 households' worth per
  household. Occupancy fills tenements first, then the other homes a family at a time,
  so no home stands empty while another is shared. A town of 600 houses its 136
  households in about 107 homes. Market streets gained a `shop` (shopkeeper living
  above) and merchants' townhouses.
- **Mastery.** `rules.mastery`: each person is a master of their profession with a
  chance of one in `oneInPeople` (100), drawn per town from the "mastery" stream, so one
  town has none and the next a cluster; each master's profession is drawn by weight
  (farming 6, crafting 3, smithing 2, baking 2). A master runs a master workplace
  (`master_farmstead`, `master_smithy`, `master_workshop`, `master_bakery`, with
  apprentices) that does the work of `yield` (4) ordinary ones: the ordinary
  archetype's required count drops by 4 per master and the craft quarter by 3 plots per
  master smith or craftsman. A master farm feeds 4 times the people (120) on a
  `landFactor`th (a quarter) of an ordinary holding, stands nearest the town on a dry
  road, and the town needs that many fewer farms. Masters draw people:
  `residentsPerMaster` (10) more live there (in the demographics) and
  `visitorsPerMaster` (50) come through, which taverns and inns (`required.<kind>.visitors`)
  also serve. Three or more masters of one profession make a master community
  (`manifest.mastery.communities`). The master is the first worker of their workplace
  (`npc.mastery`, for players to learn from); the others are apprentices. Gate
  `mastery` checks a workplace and a working master for every master.
- **Masters on the best ground (settlement-rules/6).** Masters can pay for the safest,
  best-placed land. Master farms take the holdings nearest the town on every road, and the
  ordinary farms start no nearer than the masters' fields reach: the near ground is
  theirs, farther from bandits and wild animals. Master smiths and craftsmen take the dry
  craft plots nearest the town. A master baker takes a corner plot by the square, after the
  corners the markets need. All are pinned like the watch's posts (`post.why` "master"). Gate
  `mastery` also checks that no ordinary farm or workplace stands nearer the town on its road
  than a master's.
- **Grand masters.** `rules.mastery.grandMaster`: each master is a grand master with a
  chance of one in `oneInMasters` (20). Pupils pay a grand master to learn their craft over
  years: each brings `pupils` (30) more people to live in the town (in `residents`), and
  the town builds one more of the discipline's ordinary workplaces for every
  `pupilsPerWorkplace` (5) pupils, so it grows around the one discipline it honours
  (`manifest.mastery.discipline`, the profession with the most grand masters). The grand
  master is `npc.grandMaster`, with the role "grand master ...".
- **The homeless.** `rules.homeless`: a town of `minPopulation` (150) or more has between 1
  and 3 in 100 of its people without a home, drawn per town (the "homeless" stream) and
  scaled by density. `demographics.homeless` is part of the population and in no household;
  households are formed from the housed people only. The homeless are the poorest
  (peasants). Each has `npc.home` and `npc.household` set to null and a `npc.shelter`, one
  of the hospitals, monasteries and churches dealt round in turn, or none, to sleep rough,
  where the town has no shelters. Without work their role is "beggar" ("orphan" for a
  child); with work they are day labourers like anyone.
- **Access, size and density.** `request.access` (port, river, road or remote;
  `siteAccess(site)` reads it off a selected site) sets what a town's place allows, from
  `rules.settings.access`. Goods and food move far more cheaply by water than overland, so a
  port keeps up to 3500 people (about 4200 with the people its masters draw), a river town
  3000, a road town 2500 and a remote town 600. These are the largest the structure solve builds
  reliably today; a port of 4000 or more does not solve yet.
  A larger request is capped (`manifest.setting.requestedPopulation` against `population`,
  with a "capped" event). Access also sets density, a draw per town from a range: ports
  1050 to 1200, river towns 950 to 1100, road towns 850 to 1000, remote towns 600 to 800.
  Density scales families per home (`withDensity`) and the share of poor streets
  (tenements). A sparse town also gets a bigger housing quarter in gardens and yards, so the
  same people cover more ground. Masters go where their goods sell, so a town's chance of
  masters is `masteryPermille` of the rules': 1500 for a port, 250 for a remote town, which
  lacks much else besides. Sites now carry `waterKind` (sea, lake, river or none) and
  `walkM`, the walk from the spawn. A site is a port with the sea within the far water
  range, a river town with a river or lake, and remote past `remoteWalkM` (1500 m) or on
  poor land. Without `access`, a town is laid out as before, uncapped. Gate `setting` checks
  the cap and the homeless.
- **Ports on the water, settlers by water and forest (settlement-rules/7).** Water is measured
  from the edge of the town's footprint (`site.shoreM`), not its centre. A port must sit against
  the sea, a lake or a river: within `waterRangeM[0]` (60 m) of the footprint. A town with only
  water in sight is a river town (river or lake) or a road town. Nearer water never lowers a
  site's pressure any more; the dry-feet rules already keep the town above floods. Biomes in
  `sites.resourcePermille` (forest 1000, rainforest 700, swamp 300) within `resourceRangeM`
  (600 m) of the footprint raise a site's pressure by up to 30% (`site.resourcePermille`), for
  the timber, game and fuel.
- **Parks and empty lots.** `rules.openGround`: a park per `parkPerPeople` (600) on the
  middling streets, and empty lots as a share of the homes that depends on the town's trend.
  Each town with a setting is growing, stable or shrinking (`setting.trend`), drawn from its
  access's `trendPermille`: ports usually grow, remote towns often shrink. A growing town has 5
  in 100 of its homes' worth of lots, cleared on its outskirts (the outer quarter of its
  housing) waiting to be built on. A shrinking town has 8 in 100, abandoned plots inside it
  (the inner half). A stable town has a few, scattered. Neither stands on the poor streets,
  which the town's crowding needs. Both are pinned like posts (`post.why` "park" or "lot"),
  never placed by the solve alone, and walk-through in the scene.
- **Street props, paving and terraces (settlement-rules/8, settlement-gen/0.5.0).** A props
  stage runs after occupancy and fills `manifest.props` from `rules.props`. Each prop has a
  kind, a centre, a facing and a size in mm. A walled town's streets are paved out to its gates
  (`roads.edges[].surface`); a village's streets and the roads beyond the gates stay earth, and
  so does a street that runs into water. The scene lays a walk-through `paved_road` slab along
  each paved street. Lamps stand at the plots' boundaries, every second plot on each side, the
  two sides staggered, with one at each corner of the square. The square has benches round its
  edge, a fountain from 1000 people and the town's statue from 2000. Each grand master gets a
  gilded statue (`honours`, the NPC). A park has two benches facing a fountain or a statue (the
  "props" stream picks). Taverns, inns, warehouses and bakeries have a barrel and a crate at the
  door; well-off homes have a planter either side of it. The town hall, churches, library and
  townhouses stand on a terrace raised over their plot (600 mm). Stone steps run out into the
  street before the door (200 mm rises, 350 mm treads), and the building, and anything at its
  door, stands on top. Gate `props` checks that nothing you walk into stands in a building or
  in another prop, that every terrace has its building and stairs, and that every statue's
  grand master is one of the town's. `DEFAULT_PROP_PATTERNS` maps prop models by name
  (case-insensitive) for `--catalog`.
- **Industry (settlement-rules/9, settlement-gen/0.6.0).** A town lives off the land around it.
  `selectSites` records each site's `biomes`, the permille share of every biome within its
  reach. Given that `land` (the CLI passes it with `--world`), `townIndustry` scores timber
  (forest, rainforest, swamp), mining (mountains, volcanic, glacier, desert, tundra), fishing
  (sea, lake or river near the town) and farming (fertile land, at 600 priority so it wins only
  where nothing richer is near). The richest is the town's industry (`manifest.industry`):
  - Its size. The access's cap is scaled from 40% with no industry to 100% at full
    abundance (`industryCap`), so big towns stand only where the resource is.
  - Its export: the rarest material near (by crafting tier), and what the town is known for,
    such as yew longbows, silver-inlaid blades, fire- or frost-forged blades, heartwood
    furniture or salted sea fish.
  - Its workplaces: one sawmill, mine, fishery or mill per 150 people at full abundance (at
    most twice that), with their stock (log piles, ore carts, fish racks, grain sacks) at the
    door. They are the export (`required[].export`), so masters of the trade add to them and
    never replace them. No other industry's workplace stands in the town.
  - Its masters: 60% of them practise its craft (crafting, smithing, fishing or farming).
  Without `land` a town has no industry and none of those workplaces. Gate `industry` checks
  the primary is the richest, that its workplaces (or its masters') stand and that no other
  industry's do. The home-space cap (`homeSpacePermille`) now counts only the households in
  town, not the farmsteads' families. Before, a town with fewer master farmers needed more
  farms than the cap left room for, and the structure solve failed.
- **Guilds (settlement-rules/10, settlement-gen/0.7.0).** A town with an industry has the craft
  guild of its profession (`manifest.guild`). From 400 people it has a `guild_hall` by the square,
  on a terrace with a banner either side of the door. Its best master leads it (a grand master
  first). A player earns reputation with the guild, and each rank (Initiate, Journeyman,
  Craftsman, Pupil of a master, Master of the guild) may buy its recipes up to the rank's tier.
  The town's signature product is taught only from the first rank that needs a master to take the
  player on as a pupil. The game server keeps each player's reputation; the manifest says what
  each town's guild offers. Gate `guild` checks the hall, its master and the ranks' tiers.
- **What players gather (settlement-rules/11, settlement-gen/0.8.0).** A town given its land
  has its resources as objects in the world (`manifest.resources`):
  - Kinds: tree stands (Woodcutting), ore veins (Mining) and fishing spots (Fishing). Farming
    has its fields.
  - Counts: its own industry has three per workplace, so a 1000-person mining town gets about
    24 veins. Every other resource rich enough near it gets up to six (a mountain town with some
    forest gets a couple of tree stands).
  - Placement: in the open ground from the town's edge out to 400 m, about 25 m apart, clear of
    its plots, fields, roads and wall. Fishing spots go on the water off the shore, so only
    where the world is known (`request.site`).
  - Materials: each node gives one of its industry's products near the town, the rarer tiers
    fewer (weight `1 / tier`). The town's first node of its own industry is always what it is
    known for, so there is some to find.
  - Stock: each node holds `stock` gathers less what the town has used up
    (`land.depletedPermille`), and comes back after `regrowHours`: trees after 72 hours, fish
    after 6, ore never.
  - In the scene each is a `Structure` (its look; `DEFAULT_PROP_PATTERNS` maps models) and a
    `ResourceNode` component (material, tier, skill, stock, regrowHours, town) in
    `packages/scene`. Gate `resources` checks that none stands on the town's ground or on
    another node, and that each has its industry's kind and material.
  - Players gather from them in the game (`packages/engine-core/src/gathering`, catalog 0x24): E
    by a node takes one into the materials pouch and trains its skill (woodcutting, mining,
    fishing). A worked-out node is drawn low and comes back after its regrow time (on the wall
    clock, across restarts); stocks and pouches are saved in `gathering.db`.
- **A region of towns** (`region.ts`, `npm run settlement:region -- --world <file>`). Gate
  `industry` also accepts an industry the town has long worked (`land.worked`) while it is rich
  enough and nothing beats it by `history.switchPermille`.
  - `planRegion(sites)` makes each site a town of its access and industry, as big as its land
    keeps.
  - `tradeRegion` gives each industry a good (timber, metal, fish, grain). A workplace sends 12
    loads a year, and every town needs a load of each good per 60 people. A town uses its own
    good first and buys what it lacks from towns with loads to spare, cheapest first. A load
    costs 4% more per km by road; between two sea ports it goes by sea at 40% of that. What a
    town cannot get at all costs 1.5 times the dearest load.
  - `evolveRegion(region, years)` runs it on year by year. A town uses up its industry's stock
    (`land.depletedPermille`) as hard as it works it, up to 1% a year for ore. Forests and fish
    regrow; ore does not. The land then keeps fewer people, and the town grows (3% a year) or
    shrinks (5% a year) toward that. Its rarest product runs out first (a silver town becomes an
    iron town). When the stock is too poor it turns to the next best thing, only once that is
    25% richer, so towns do not flip back and forth.
  - `regionTownRequest(snapshot, townId)` is what to pass to `generateSettlement` to build that
    town as it stands (`request.trend` comes from the history).
  - The default world has room for only two towns of 600 people: a fishing port and a remote
    timber town, trading fish for wood 2.5 km apart.
- **Walls and gates are never houses.** `buildArtMap` keeps any model whose name says
  Wall, Gate, Gatehouse, Arch(way), Tower, Portcullis, Palisade, Rampart or Battlement
  (`FORTIFICATION_NAME`) out of every building kind, and the house-archway presets are
  gone from the bakery and workshop patterns. Those models map to the three wall kinds
  instead (`FORTIFICATION_KINDS`). New kinds have name patterns too (inn, theatre,
  bathhouse, town hall, guardhouse, barracks, school, library, churches, hospital,
  monastery, apothecary, well). `scale-fit` and `scale-report` size a wall model to its
  piece (`kindRoom`) rather than to a parcel.

Still to do: see "Next steps" in [`MEDIEVAL-TOWN-LIFE.md`](MEDIEVAL-TOWN-LIFE.md)
(a day by the bells, market days, guild streets, parishes, inner walls), plus roads
spawned as surfaces and a wall that follows the ground.

## Green squares

`greenMask` / `greenSquares` (engine-core `terrain/green.ts`) read the survey grid, the data the biome preview draws: a
cell is green when its biome is in `rules.sites.greenBiomes` (plains, forest, rainforest), it is not water, river or ice,
and it stands `safeFloorM` over the sea. The largest all-green squares are taken greedily, none under
`rules.sites.minSquareCells` (24 cells). `npm run preview:world -- --squares` outlines them on the biome panel and writes
`<out>.squares.json`: each square in grid cells and in world metres.

- **Sites** lie inside a square, far enough from its edge for the town's footprint (in a smaller square, at its centre);
  a site scores by how much of the requested town fits (`Site.fitM`).
- **Size**: `settlement:bake --world` bakes `min(requested, what fits)` people (`fitHouseholds`) and logs `[square]`.
- **Farms**: the dry test everywhere in the bake is green land. A farm's field needs half its sample points green, and a
  lane steps past up to six holdings of wet ground to reach it. When the plots left cannot hold the farms and food the
  town needs, the demand is capped (`capDemand`, event `farms_capped`): the missing food is imported, the masters are the
  workplaces that could be built, and a lone farm that overruns a small town's labour is dropped, so the town keeps no
  farms rather than failing as "too wet".
