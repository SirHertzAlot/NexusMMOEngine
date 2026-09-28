# Open-World Landscapes — Plan & Checklist

Goal: grow the world from a 48 m chunk demo into massive, explorable
landscapes, where one generous biome is several kilometres across and a
world holds many biomes.

Legend: `[x]` done · `[ ]` planned · **⚑** decision needed before building.

## Where we are

- [x] Terrain is data: one global heightmap grid, stored as 16×16-sample
      chunk tiles (16 m each) that share their borders; the server reads
      tiles, the editor's Terrain tab sculpts them.
- [x] Deterministic generator (FastNoise2 FBm, exact chunk seams),
      amplitude/frequency parameters.
- [x] Art: 4,080 pack models converted to GLB, previewable in the editor.
- Current world: 3×3 chunks = **48 m × 48 m**. Heights: 1 KiB per chunk.

## Decisions (2026-09-28)

- **Scale: a 4 × 4 km world for now** — 250 × 250 chunks (62,500), ~61 MB
  of stored heights. Its full-resolution heightmap is 3,751 × 3,751 samples
  (~56 MB), small enough for the bake to hold in memory.
- **Vertical range: default ~250 m of relief** in mountain biomes (plains
  stay within a few metres); a world-spec value, easy to change.
- **LYGIA: not used.** Shading is our own (three.js).
- **SurrealDB: embedded engine** (`@surrealdb/node` 3.0.3 with the
  `surrealdb` 2.0.8 SDK) — no separate server process. Verified on the dev
  machine: `rocksdb://` and `mem://` work; `surrealkv://` hangs on Windows,
  so worlds use `rocksdb://`. Queries are SurrealQL 3 (`type::record`,
  not `type::thing`). Single writes cost ~2.4 ms, so bulk data is batched.
- **ECS: keep bitECS; no rewrite, no EnTT.** The slice 1.5 benchmark ran the
  same C++ kernel over a bitECS world and a pure C++ world: equal at 10k
  entities, bitECS faster at 100k — both under 1% of the tick. What the
  open world needs is inside the ECS, not a new one:
  - **Capacity:** this bitECS stops at 100,000 entities by default
    (`setDefaultSize` raises it; ~160 MB of component arrays per million).
  - **Streaming:** only chunks near players hold live entities (Phase 2).
  - **What is an entity:** interactive/breakable/simulated things are
    entities; static scenery can be chunk data the client draws. A fully
    loaded 4 km world at today's density would be ~290k props.
  - Reopen the JS-vs-C++ world decision (EnTT is the natural candidate)
    only if bitECS exceeds 50% of the tick at 10k entities.

## Original decision notes

1. **Scale.** How big is "two of these" — which size should one
   generous biome be? For reference (16 m chunks, 1 KiB of heights each):

   | Biome | Chunks | Stored heights |
   |---|---|---|
   | 2 × 2 km | 15,625 | ~15 MB |
   | 4 × 4 km | 62,500 | ~61 MB |
   | 8 × 8 km | 250,000 | ~244 MB |

   A 16 × 16 km world is ~1 million chunks (~1 GB of heights): only a
   fraction can ever be loaded at once, so everything below streams.
2. **Vertical range.** Mountains need hundreds of metres of relief
   (today's amplitude is 2 m).
3. **LYGIA.** Commercial use is *not* free: it is dual-licensed under the
   Prosperity License (non-commercial) and the Patron License (sponsors /
   contributors), or a paid permanent licence for one version. Decide how
   we license it before any LYGIA code ships. It is GPU shader code
   (GLSL, TSL, HLSL, WGSL, MSL, CUDA, OSL) — there is no CPU C++ version.
   Recommended: use it client-side (three.js GLSL/TSL) for terrain
   shading, sky, water; keep server generation on FastNoise2 (+ PICG
   heightfield nodes). CUDA only if the world bake moves to the GPU (the
   Quadro P1000 supports CUDA; the toolkit isn't installed).
4. **SurrealDB.** Install the `surreal` server binary now (world-level
   store), or keep terrain in region SQLite until the world server needs it.

## Phase 1 — World bake at scale (server, offline)

Terrain is baked once and stored, so the bake only needs to be
reproducible (same spec → same bytes), not identical across platforms.

- [ ] **World spec** (checked-in JSON): seed, size in chunks (250), coarse
      cell size (8 m), vertical relief, biome types with finite counts and
      parameters, region grid.
- [ ] **Coarse fields** on an 8 m grid (~470 × 470): continental elevation,
      moisture, temperature.
- [ ] **Biome regions:** a finite number of Voronoi regions, each assigned
      a biome type that fits its elevation/moisture/temperature; smooth
      blending at borders.
- [ ] **Coarse elevation per biome** (mountains: ridged, high relief;
      plains: gentle; swamp: near water level; desert: dunes; …).
- [ ] **Erosion and rivers** on the coarse grid (droplet erosion + flow
      accumulation → river mask).
- [ ] **Fine heightmap:** the coarse elevation upsampled to the 16/15 m
      sample grid plus per-chunk detail noise scaled by biome roughness —
      one global grid, so chunk seams are exact by construction.
- [ ] **Storage:** fine tiles → `TerrainTileStore` (world.db, batched
      transactions); coarse maps → world.db; chunk catalog (region, biome,
      height range) → SurrealDB (embedded, `rocksdb://`, batched).
- [ ] **Bounded tools:** the terrain tool and editor load a chunk range
      around a point, never all 62,500 tiles.
- [ ] **Spawn area only in the ECS:** the bake still spawns and scatters
      just the start area; the rest loads with streaming (Phase 2).
- **Verify:** exact seams everywhere; same spec → identical bytes; every
      biome type present with its configured count; bake time and peak
      memory reported; the server boots on the baked world and serves the
      spawn area from stored tiles.

## Phase 2 — Server streaming (region)

- [ ] Load chunk entities, navmesh tiles, and scatter only around players
      (area of interest); unload unused chunks; memory stays bounded.
- [ ] Scatter placed once, on a chunk's first load, then persisted —
      never duplicated.
- [ ] A region owns a chunk range; the world server assigns ranges
      (registration already exists).
- **Verify:** walk 4 km in a straight line with flat server memory, ticks
  under 33 ms, and no duplicate scatter after restarts.

## Phase 3 — Client streaming, LOD, culling

- [ ] Client requests chunks by distance; the server sends heights only for
      those (today every chunk ships in every snapshot).
- [ ] LOD rings: 1 m samples near, 2/4/8 m far (downsampled from stored
      tiles), with no cracks between levels.
- [ ] Frustum culling, instanced props, far-horizon terrain.
- [ ] Terrain shading by height, slope, and biome (LYGIA if licensed).
- [ ] Run the browser on the NVIDIA P1000, not the Intel UHD 630 (Windows
      Settings → Display → Graphics) — the likely cause of the 3 fps.
- **Verify:** 60 fps with a 2 km view distance on the dev machine; crossing
  biomes with no hitches.

## Phase 4 — Editor at scale

- [ ] World map overview (downsampled height and biome); click to jump.
- [ ] Sculpt only the loaded area around the camera; large brushes for
      mountain-scale edits.
- [ ] Regenerate one region from the world spec without touching others.
- **Verify:** sculpt 3 km from the origin, save, and see it in game.

## Phase 5 — Biomes

- [ ] Biome registry: a finite set (mountains, forest, desert, swamp,
      plains, rainforest, …), each with terrain parameters, scatter sets,
      and creature tables.
- [ ] Biome placement from the coarse fields (elevation, moisture,
      temperature) with finite counts per world.
- **Verify:** every biome is recognisable on the world map and in game.

## Later (builds on Phase 5)

Settlements and WFC, mesh-manipulation graph nodes (bromesh), modular
character assembly, spawn balancing by habitat.
