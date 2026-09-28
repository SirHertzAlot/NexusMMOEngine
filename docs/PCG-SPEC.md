# PCG Spec — UE-style procedural content generation for the engine

Status: **slices 1–4 implemented** (2026-09-27):
`packages/scatter/` — `.pcg.json` schemas, point model, node registry,
cooker, reference evaluator, spawn-table schema, `examples/forest.*`;
`AssetRef` is now a first-class wire component (ComponentId 8: `.fbs`
`AssetRefBlock` on Snapshot/Delta, protocol codec, snapshot collect +
delta diff, `restoreFromState`, mirror `EntityMirror`).
`packages/addons/scatter/` — C++ N-API addon executing cooked plans at
chunk load; native output is `deepStrictEqual`-identical to the TS
reference evaluator (forest golden: 5 spawns, hash
`341b72c0…da757d`); strict-FP flags (`-ffp-contract=off`/`/fp:precise`).
`packages/engine-core/src/procgen/scatter-spawn.ts` — region
chunk-load integration: runs the forest plan at chunk spawn and emits
ECS entities (Transform with yaw→quaternion, AssetRef fnv1a32/variant,
Health for breakable archetypes — oak: 100, Velocity+BodyConfig statics
for colliders, picked up by PhysicsSystem's membership diff). Scatter
output is a pure function of (worldSeed, cx, cz, plan, table); entities
persist via snapshots; scatter runs only at chunk spawn, never on reboot
restore. Slice 5 (biome registry) is next.
Slice 4 (region chunk-load integration) is next.

Sources: UE "Procedural Content Generation Overview" docs (primary, via
Joey 2026-09-27) + secondary research (UE5.7 docs mirrors, PCG research
docs). Epic's docs domain was not directly fetchable during research;
the architectural picture was consistent across sources.

## 1. What UE PCG is (primary-docs summary)

PCG is a **rule-based placement and distribution engine**: it does not
invent geometry, it decides *where things go*. Core ideas:

- **Node graph as source of truth.** Material-Editor-style visual graph;
  spatial data flows in from a PCG Component (or PCG Volume), points are
  generated → filtered → modified through nodes, output updates in real
  time. Graphs are assets; **templates** bootstrap new graphs (Niagara-
  style); **graph instances** reuse a graph with overridden parameters
  (Material-Instance-style).
- **Points as universal intermediate.** Every node speaks points:
  transform, bounds, color, density, steepness, seed + user-defined
  attributes. **Density** is existence probability 0–1 (debug gradient
  black→white).
- **Node taxonomy** (the vocabulary): Sampler (generate points from
  volumes/surfaces/meshes/splines), Density, Filter, Point Ops, Spatial,
  Metadata, Param, Spawner (place actors/meshes at points), Subgraph,
  Hierarchical Generation, Control Flow, Debug, IO, Blueprint, Generic.
- **Attributes & metadata domains.** Static attributes (`$Position`,
  `$Rotation`, …) vs dynamic attributes; three metadata domains:
  `@Data` (per-data single values), `@Points`, `@Elements` (attribute
  sets). Attribute Selector with component swizzling (`$Position.ZYX`,
  Pitch/Yaw/Roll extractors).
- **Graph Parameters.** User-created overridable values on the graph;
  overridable per-instance and per-subgraph-node via override pins.
  `PCG_Overridable` C++ metadata auto-adds advanced pins.
- **Four generation modes:** editor-time (offline, cached), partitioned
  (grid cells tied to World Partition streaming — generate on load,
  clean up on unload; actors assigned to data/HLOD layers), hierarchical
  (multi-scale), runtime GPU compute (per-frame grass around player).
- **Determinism is opt-in:** explicit seeds, normalized point ordering
  before stochastic branches, immutable style/grammar keys per pass.
- **Debugging:** per-node debug render (D), enable/disable (E), inspect
  attribute list (A), debug tree + attributes panel.

## 2. Fit assessment vs our engine

**Transfers directly:**

- Graph → deterministic sampler = our locked "cook" model (C++ is the
  authority, JS/three.js only mirror). UE validates this at AAA scale.
- Points-as-intermediate → our ECS: a cooked scatter pass outputs point
  lists; the region turns them into entities (Transform + BodyConfig +
  asset-ref) via the existing spawn path.
- Partitioned generation ≈ our chunk lifecycle. Our procgen addon
  already generates per-chunk from `(seed, cx, cz, lod)` as a pure
  function; "cell loads → generate → unload → clean up" is the same.
- Density/attribute-driven placement upgrades hand-rolled spawn logic
  into data-driven biome/spawn tables.

**Does not transfer:**

- GPU compute path — our server is headless Node, no GPU; three.js must
  never own generation.
- In-editor live iteration — Unreal-Editor-specific; our equivalent is
  the standalone editor's play-mode (coarser).
- Actor spawning with behavior — UE spawns Actors with logic; we spawn
  ECS component bundles. Spawner concept transfers, payload doesn't.

**Adopt, don't invent:** the primary docs sharpen two design choices:

1. Our "scatter plans" should be **graph + parameter overrides**
   (instances), not a separate plan format. One forest graph, different
   density/scale params per biome.
2. Our point struct should carry a **small typed attribute table**
   (biome tag, slope, moisture…), not just transform+seed — keeps the
   C++→JS boundary narrow while filters stay expressive.

## 3. Relation to surveyed options

- **PICG/PCG-AI** *is* a UE-PCG-like system (C++17 deterministic graph
  core, `.pcg` source of truth, React/Three.js editor, GLB export). This
  research strengthens its recommendation as the **external
  authoring/cooking tool** — closest off-the-shelf analogue to the PCG
  graph editor. Adopt its editor; don't build one.
- **bromesh** is complementary, not competing: the *geometry* half
  (meshing, LOD, UVs, baking, collision) that spawner nodes
  consume/produce; PICG-or-equivalent is the *placement logic* half.

## 4. Proposed slice for our engine

**Authoring format:** `.pcg.json` node-graph documents — nodes with
typed settings/pins (sampler/filter/modifier/spawner, subgraph refs),
graph-level **parameters**, and **instances** (`{graph, paramOverrides}`).
Node vocabulary follows UE's taxonomy (subset to start). Compatible in
spirit with PICG's format so we can adopt rather than build an editor.

**Cooking step (offline, deterministic):** a cooker compiles a graph +
parameter set into a *scatter plan*: FastNoise2 sampler parameters +
seed-derivation rule, filter predicates (slope/density/attribute
bounds, exclusion shapes), spawn table (archetype → ECS component bundle
+ asset ref + transform/LOD rules). Cooked plans are **versioned build
artifacts**, same treatment as navmesh tiles. Cooker validates: pin
types, parameter types, attribute names against the point schema,
exclusion-shape sanity.

**Runtime C++ API** (new `scatter` addon, pure function like
`generateChunk`):

```cpp
// zero-copy into a JS-owned buffer; no native state, never on the tick hot path
scatterChunk(worldSeed, chunkX, chunkZ, planId,
             out /* SoA: x,y,z, rx,ry,rz, sx,sy,sz, archetypeId, variantSeed, attrCount, attrs... */);
```

Seed = `worldSeed XOR chunkHash`; canonical point ordering; strict-FP
noise (see risk below).

**ECS flow:** region chunk-load (already the navmesh-bake moment) →
`scatterChunk` → JS turns points into spawn commands → entities enter
the sim with standard components → clients see ordinary snapshot/delta
traffic. Scattered entities persist via the existing SQLite snapshot
path; chunk point data itself stays regenerable, never persisted.
Static decoration (grass/rocks) can bypass entities entirely and go to
the mirror as instanced batches, like the FX path does.

**Determinism/authority:** generation runs only in the region process;
the browser never generates. Scatter never runs per-tick — amortized on
chunk load on a worker thread, same discipline as navmesh baking.

## 5. Slices (thinnest first) and biggest risk

1. **Scatter data model** — point list layout (transform + density +
   seed + attribute table) + spawn-table schema + one new component
   (asset/variant ref). Small.
2. **Data-driven scatter plans** — hand-authored `.pcg.json` graphs +
   parameter instances + cooker validation, *no visual editor yet*.
   Small–medium. Delivers ~80% of the value.
3. **C++ scatter addon** — FastNoise2-backed samplers behind the
   pure-function boundary, cross-process determinism tests. Medium.
4. **Region integration** — chunk-load scatter → ECS spawn, persistence,
   border-chunk coherence. Medium.
5. **Graph editor UI** — adopt PICG's editor or build a tab in the
   standalone editor. Large — defer until slices 1–4 prove the pipeline.

**Biggest risk: cross-machine determinism.** Our FastNoise2 runs in
default RELAXED fp mode: bit-identical on one machine/binary, *not*
guaranteed across hosts. Multiple region shards on different machines
could disagree at chunk borders — visible seams, physics mismatches.
The `FASTNOISE2_STRICT_FP` evaluation already flagged in the
architecture brief must land before or with this work; fallback is
cooking scatter centrally and distributing plans. Second risk: a
node-graph editor is a product unto itself — adopt PICG's, don't build
one.

## 6. Editor debug UX (deferred requirement)

When the editor tab lands, mirror UE's per-node debugging: toggle debug
render per node, enable/disable node, inspect the point/attribute list
at any node. Our existing read-only debug channel is the seed: click a
node in the scatter plan → see its points.
