# Settlements: procedural towns, baked offline

Status: **SG1 built** (the first vertical slice). SG2 to SG4 are planned; see
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
| validation | seven gates re-derived from the finished tables (demographics, housing, food, labour, road connectivity, structure coverage, zoning) | §22 |

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
