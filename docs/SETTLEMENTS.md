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
- Entities are remembered per boot like every scene's, so a restart does not
  duplicate the town.
- Not spawned yet: roads (SG2 brings engineered roads) and the residents. The
  occupancy (households, npcs, shops) is in the manifest as data; putting people
  in the world needs a generic simulated-agent path in the engine, which is its own
  slice (the server has creatures and quest givers, not hundreds of idle villagers).

