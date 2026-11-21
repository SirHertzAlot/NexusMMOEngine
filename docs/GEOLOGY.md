# Macro geology prototype (and the GeoForge evaluation)

A bounded, offline prototype of a geological "world skeleton" upstream of the
terrain survey: one region, a frozen geological snapshot with several
provinces, the landforms it implies, then drainage, two complementary
resources, a settlement pair and a bridge opportunity, through the engine's
own collision and navigation, persisted and reload-verified. It was built to
answer one question: is it worth extracting GeoForge's C++ tectonics core
through N-API? It sits behind an optional `geology` block in the world spec;
worlds without it bake exactly as before.

## What GeoForge's repository actually contains

Checked against the source on 2026-11-21 (`zajalist/GeoForge`, 3 commits, all
2026-04-02, one author).

| Claim (README) | What the code shows |
|---|---|
| C++17 physics engine compiled to WebAssembly | `archive/tectonics/`: `TectonicSimulation.cpp` (~2,100 lines), `GeoTypes`, Emscripten `Bindings.cpp`, a prebuilt `sim.wasm`. It is archived: the live Next.js app (`app/page.jsx`) runs `createManualSimulationStub()`, which returns zero plates, rifts and collisions. |
| Euler-pole plate motion, subduction, rifting, collisions, sutures | Present in the archived C++ as hand-tuned heuristics (fixed starting poles, thresholds, `orogenyHeight` capped at 11.5). No tests. |
| GPlates integration | `src/simulation/gplatespython/`: skeletons whose functions raise `NotImplementedError`, plus a GPML writer. The live feature is a JS A* "rift path" across a drawn polygon. |
| Terrain | None. Outputs are polygons and polylines in lat/lon on a unit sphere; no heightfield, drainage or resources. |
| License | **No LICENSE file.** `PROJECT_SUMMARY.md` says "License: (Specify your license here)". With no license, all rights are reserved: the code cannot be copied, ported or vendored. |

Dependencies are ordinary (Next 16, React 19, three 0.128, pyodide, numjs);
the C++ has none beyond the standard library.

The archived C++ was compiled natively for evaluation only (scratch
directory, nothing copied into this repo): it builds with `g++ -O2` (three
unused-variable warnings); its RNG is seeded from `std::random_device` with
no seed API, so runs are not reproducible by construction; its cost grows
superlinearly (one supercontinent, 5 Myr steps: 250 Myr in 37 ms, 500 Myr in
135 ms, 1,000 Myr in 0.7 s, 2,000 Myr in 10.7 s) while suture records
accumulate without bound (734 at 2,000 Myr).

We already own a native, deterministic tectonics stage:
`packages/addons/terrain-kernel` `computeTectonics` (Voronoi plates to uplift
and strain, no transcendentals, golden-tested, N-API). It is not wired into
the survey yet.

## The prototype

Code: `packages/engine-core/src/terrain/geology/`. Clean-room: written from
published concepts (Wilson cycle, cratons, rifts, sutures, Voronoi plate
mosaics as in our own kernel). No GeoForge code or data is used.

1. **Snapshot** (`snapshot.ts`): `GeologySpecSchema`, an explicit, editable
   record: generator name, version and params; the warp seed; the frame;
   plates (centre, velocity, continental or oceanic); cratons (ellipses);
   old sutures (polylines); widths and reliefs; designer overrides
   (retag the province at a point). `generateGeologySpec(seed, extent)`
   writes one, but everything downstream reads only the numbers.
2. **Frame**: a planar region extract (the engine's world is planar). World
   metres, x east, z south. The record also states where that plane sits on
   a sphere (azimuthal equidistant about an origin lat/lon, planet radius)
   and its scale (default 100 geological km per world km, so the 4 km world
   is 400 km of geology). `worldToLatLon`, `latLonToWorld` and
   `unitVectorToWorld` (the globe representation) convert explicitly; they
   round-trip to under a micrometre and use det-math only.
3. **Provinces** (`provinces.ts`): per survey cell, the nearest plate and the
   exact distance to its Voronoi edge; the relative normal velocity across
   that edge picks orogen (with a foreland basin on the down-going side),
   arc, rift (with shoulders) or transform; interiors are platform or ocean;
   cratons win over every belt; sutures leave worn ridges. Provinces are
   connected patches with stable ids (`G01`…); small patches merge. The
   output uplift (smooth polynomial profiles, along-strike saddles that
   become passes) replaces `rangeUplift` in the survey. Everything after it
   (erosion, lakes, rivers, climate, biomes, fine tiles) is unchanged.
4. **Opportunities** (`opportunities.ts`): two resources sampled with
   spacing from a designer table keyed to province kinds (never exact
   guarantees); settlement candidates (flat, near fresh water, near some
   resources); the pair chosen jointly with the best bridge over a river that
   blocks carts, and only when a cart route exists without the bridge;
   alternative routes by the penalty method; readability, surveying,
   monopoly and newcomer metrics. Runs on any survey, so the baseline gets the
   identical pass.
5. **Persistence** (`record.ts`, `world-bake.ts`): the bake stores the
   snapshot itself, the province table and the fields hash in
   `world_docs.geology_snapshot`, and the maps `geology_province`,
   `geology_kind`, `geology_plate`, `geology_uplift` in region.db. Geology is
   frozen: nothing runs in the tick. A client-side artifact would follow the
   terrain-mask pattern (a baked asset, no protocol change); none is needed
   yet because the client sees geology only through the terrain.

Determinism: classification uses only + − × ÷ and sqrt; the warp noise comes
from the strict-IEEE procgen addon; projections use det-math. Golden hashes
pin the province fields with and without noise
(`test/geology.test.ts`).

## Verified

`packages/engine-core/test/geology.test.ts` (14 tests):

- snapshot generation is deterministic and survives a JSON round trip;
  projections round-trip; the 100 m-north step matches the frame's scale;
- province fields are golden-pinned (plain and with the strict-IEEE noise);
  at least four provinces of three kinds; ids are stable; an override
  retags one province and changes no cell outside it;
- the survey takes its uplift from the provinces (no ranges), deterministic,
  different from the baseline;
- the bake persists snapshot, table, maps and hash; **reload** re-derives the
  stored maps from the stored snapshot (not the seed) to the same hash, and
  re-baking from the stored snapshot gives byte-identical tiles; every shared
  chunk edge agrees (no seams);
- the baked tiles go through the server's `ChunkNavmesh` (tile cache) and a
  path crosses a 3×3 chunk block; a box dropped on a Jolt height-field
  collider built from a baked tile comes to rest on the surface.

## Prototype vs the designer-guided baseline

`npm run geology:compare --workspace=@mmo-engine/engine-core` surveys the
default 4 km world three times per arm (seeds 7, 11, 23): same coast,
climate, erosion and biomes; the baseline uses today's wind-placed range,
the geology arm the snapshot. Volcanoes are off in both (they sit on the
baseline's range axis). Results: see the table below and the PR.

| signal | baseline 7 | geology 7 | baseline 11 | geology 11 | baseline 23 | geology 23 |
|---|---|---|---|---|---|---|
| survey ms | 11981 | 11523 | 11499 | 10973 | 10579 | 11255 |
| geology classify ms / provinces | n/a | 154 / 31 | n/a | 155 / 27 | n/a | 104 / 22 |
| snapshot JSON bytes | n/a | 1611 | n/a | 1611 | n/a | 1603 |
| opportunity pass ms | 1758 | 1743 | 1709 | 1759 | 1890 | 1665 |
| landform regions (≥0.5% land) | 8 | 24 | 5 | 18 | 9 | 19 |
| land share in 6 largest regions | 0.95 | 0.59 | 0.95 | 0.66 | 0.95 | 0.72 |
| landmarks (peaks ≥40 m proud) | 17 | 20 | 19 | 30 | 20 | 23 |
| macro coherence (≥400 m variance share) | 0.45 | 0.47 | 0.51 | 0.41 | 0.48 | 0.44 |
| viable settlement sites | 10 | 12 | 12 | 11 | 9 | 12 |
| viable routes between the pair | 4 | 3 | 3 | 4 | 4 | 3 |
| bridge saving | 58% (23 m span) | 54% (16 m span) | 79% (16 m span) | 5% (16 m span) | 68% (16 m span) | 18% (23 m span) |
| route exists without bridge | yes | yes | yes | yes | yes | yes |
| survey advantage (hidden-province table, default) | 0.00 | 0.92 | 0.00 | 0.83 | 0.00 | 0.92 |
| survey advantage (visible-province table) | n/a | 0.17 | n/a | -0.25 | n/a | 0.17 |
| max share of a resource in one region | 0.79 | 0.25 | 0.79 | 0.17 | 0.69 | 0.21 |
| starter ore / fuel within 600 m of spawn | 0 / 3 | 4 / 2 | 2 / 1 | 3 / 1 | 1 / 3 | 4 / 3 |
| land changed by a local edit | 32.8% | 19.4% | 38.4% | 18% | 35.8% | 7.5% |

Reading it against the brief's success signals (these are offline proxies;
the player-facing ones need a playtest):

| Question (brief) | Signal | Result |
|---|---|---|
| Is geography more readable? | landform regions, land in the 6 largest, landmarks | **Better.** 18–24 distinct regions vs 5–9; the baseline is one big lowland (95% of land in six regions) vs 59–72%; landmarks 20–30 vs 17–20. |
| Does it create better decisions? | viable sites, viable routes, bridge saving | **No better.** Sites 11–12 vs 9–12, routes 3–4 vs 3–4. The baseline's single range makes *bigger* bridge detours (58–79% saved vs 5–54%). |
| Does surveying matter? | top-quarter deposit capture, survey vs terrain | **Only with hidden provinces.** Keyed to visible belts, survey adds nothing (−0.25..0.17). Keyed to cratons and sutures (which erode flat), survey beats reading the terrain by 0.83–0.92 lift. That table is now the default (measured). The baseline has no hidden layer: 0. |
| Is it controllable? | land changed by a local edit | **Better.** Retagging one province changed 7.5–19% of the land; moving the baseline's range 250 m changed 33–38%. |
| Is it affordable? | survey time, classify time, snapshot size | **Yes.** Same survey time (10.6–12.0 s either way); classification 104–155 ms; the snapshot is 1.6 KB of JSON; maps add ~0.5 MB (u16 provinces) plus kind/plate/uplift. |
| Safeguards | route without bridge, monopoly share, starter resources | Route without bridge: always (enforced). One region's share of a resource: 0.17–0.25 vs 0.69–0.79 (geology spreads ore over several provinces). Starter ore/fuel near spawn: 3–4 / 1–3 vs 0–2 / 1–3. |
| Does it outperform simpler methods? | all of the above | **Partly.** The wins are readability, editability, resource spread and surveying; none of them needed a plate *simulation*: a frozen, editable snapshot of provinces does it. Routes and bridges did not improve. |

Proxies, not players: "players recognise regions" and "players choose among
routes" need a playtest on a baked geology world.

## The bridge-detour gap

Routes were already at parity (3–4 viable routes in both arms). Bridges were
not: the chosen pair's bridge saves 5–54% (mean 26%) in the geology arm
against 58–79% (mean 68%) with the baseline range. The cause is drainage
shape. One long range gathers rain into a few long trunk rivers across the
lowland, which is where crossings matter. Several belts split the land into
many short catchments, and rifts tend to flood into sea arms and lakes
(sea and lakes block carts, but they are not bridgeable). The close-up of
seed 7 shows the one good case, a crossing at a rift mouth.

Relief variants, same 3 seeds (bridge saving for the chosen pair; survey
advantage; max share of one resource in one province):

| variant | bridge saving (7 / 11 / 23, mean) | survey advantage | monopoly |
|---|---|---|---|
| default (rift −45 m, foreland −14 m) | 54 / 5 / 18%, 26% | 0.83–0.92 | 0.17–0.25 |
| deep rift (−90 m) + foreland −35 m | 3 / 39 / 21%, 21% | 0.50–1.25 | 0.21–0.25 |
| shallow rift (−18 m, shoulders 30 m) | 28 / 50 / 22%, 33% | 0.33–0.83 | 0.21–0.29 |
| wide foreland (1,100 m, −30 m) | 7 / 26 / 13%, 15% | 0.83–1.33 | 0.21–0.33 |
| baseline (range) | 58 / 79 / 68%, 68% | 0 | 0.69–0.79 |

No variant comes near the baseline, and the best one (shallow rifts) costs
surveying, so the defaults stay as they are. Geology stays **opt-in**. A
designer who wants a big crossing can still place a rift or suture where a
trunk river should run. That is an authoring choice the snapshot supports,
but no generator default can promise it.

The server was run against a baked geology world (seed 7, 4 km): the bake
took 20 s (survey 11.8 s, 62,500 tiles 7.6 s), the settlement stage ran on
it, and the server restored all tiles at tick 0 and ran 2,400 ticks without
errors.

## Recommendation

**No-go on extracting GeoForge's C++ core through N-API.** The license gate
fails (no license: we may not copy it), and even with a license the core
would not earn its maintenance: it is archived and unwired upstream, has no
seed API or tests, is globe-scale and outputs no terrain, and its cost grows
superlinearly with simulated time. We already have a deterministic N-API
plate stage (`terrain-kernel` `computeTectonics`) to grow if a native path is
ever needed; this prototype's classification costs ~150 ms in TypeScript, so
it is not needed now.

**Keep the concept, not the simulation.** Keep the geology snapshot as an
opt-in, offline authoring layer (the `geology` block in a world spec): a
frozen, explicit, editable province map that drives macro relief and, above
all, resource placement through hidden provinces. Do not run tectonics in
the tick. Next steps if wanted: an editor panel to place plates, cratons and
sutures and preview provinces (the editor already has world terrain tools);
a playtest of one baked geology world; and wiring `computeTectonics` into
the classification only if a profile ever shows the TypeScript stage
mattering.

## Open for the person

- GeoForge's author could be asked to add a license. Not needed for this
  recommendation; it would only matter if we wanted to read their code as a
  reference going forward.
- The geological scale (100 geo-km per world km) and origin lat/lon are
  fiction choices, recorded in every snapshot; they change nothing in the
  terrain.
- Whether a geology snapshot should become part of the default world, or stay
  opt-in. The measurements favour it for readability, editability and
  resources, not for routes; that is a game-direction call.
