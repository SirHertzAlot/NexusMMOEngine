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
(`SettlementRulesSchema`, `BUILTIN_RULES`; a game replaces them with
`--rules file.json`).

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

