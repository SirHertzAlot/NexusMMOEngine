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
- [x] **Phase 1 done:** `npm run bake:world` bakes a **4 × 4 km** world
      from `packages/engine-core/worlds/default.world.json` (below). Only
      the 3×3-chunk spawn area is live in the ECS until streaming
      (Phase 2) lands.

## Decisions (2026-09-28)

- **Scale: a 4 × 4 km world for now** — 250 × 250 chunks (62,500), ~61 MB
  of heights; world.db is ~92 MB on disk (SQLite page overhead). The bake
  never holds the full-resolution heightmap: it builds each tile from the
  coarse survey, in batches.
- **One landmass, a peninsula (2026-09-28):** the sea opens onto the
  south edge and the lower 70% of the east and west edges (60% of the
  world's edge); the land runs off the north edge, and the far north is
  frozen. One mountain chain runs across the prevailing wind with spurs
  branching off it (no parallel rows), a volcano on it (the highest peak,
  ~550 m, with a crater); most peaks hold ice.
- **Biomes emerge, uncapped:** no biome counts. Climate (wind-carried
  rain, rain shadows, temperature by height and distance from the sea)
  and water (sea, lakes, rivers) are simulated, and ordered biome rules
  read the result — deserts form behind ranges, swamps by lakes, slow
  rivers and sheltered inlets.
- **LYGIA: not used.** Shading is our own (three.js).
- **SurrealDB: embedded engine** (`@surrealdb/node` 3.0.3 with the
  `surrealdb` 2.0.8 SDK) — no separate server process. Verified on the dev
  machine: RocksDB and `mem://` work; SurrealKV hangs on Windows, so worlds
  use RocksDB. The engine's URL parsing mangles paths (drive letters, `..`);
  only `rocksdb:C:/absolute/path` (no `//`) lands where intended. A store
  closed in a process can't be reopened by that process, and an open one
  keeps Node running — so each process shares one connection per store
  and closes them at shutdown (`closeWorldCatalogs`). Queries are
  SurrealQL 3 (`type::record`, not `type::thing`). Single writes cost
  ~2.4 ms, so bulk data is batched (62,500 chunk rows in ~15 s).
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
   | --- | --- | --- |
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

- [x] **World spec** (checked-in JSON, zod-validated): seed, size in
      chunks (250), coarse cell (8 m), region grid (2 × 2), then the
      land (coast side and shape, shelf, rise), ranges, climate, erosion,
      rivers, lakes, and the ordered biome rules. `MMO_WORLD_SPEC` picks
      another spec; `none` bakes the legacy 3×3 world. `npm run
      preview:world -- [spec] [out.png]` draws a spec's biomes, rainfall
      and temperature in ~10 s without baking — the loop for tuning one.
- [x] **Climate-driven survey** on an 8 m grid (507 × 507 with margins),
      rebuilt 2026-09-28 (`src/terrain/`):
  - *Land* (`landmass.ts`): a peninsula mask from a warped coast frame
    (bays, headlands; one landmass, tiny islands sink); land rises from
    the shore with broad swells, the sea floor falls to a shelf. One main
    chain across the wind (`ranges.center` pins it; it may run on past
    the land edge), spurs branching off at 35–80° and merging where they
    join, ridges warped into a network. Volcanoes sit on the chain,
    raised after erosion (young): a lobed cone, a crater, vent heat.
  - *Erosion* (`erosion.ts`, `glaciers.ts`): thermal collapse to the
    angle of repose (38°); glaciers — ice where it's cold and snowy
    enough, flowing down the drainage, melting with warmth and sunshine
    (shaded ice lasts), grinding U-shaped valleys, calving at the sea,
    dropping terminal moraines, feeding rivers and lakes with meltwater;
    stream-power river incision weighted by rain and meltwater (valleys,
    up to ~24 m); droplet erosion spawned where it rains (deltas).
  - *Water* (`hydrology.ts`): sea = below sea level and open to it;
    lakes in hollows deep, large and wet enough (dry ones stay dry);
    rivers from rain-weighted drainage.
  - *Climate* (`climate.ts`, `sun.ts`): sunlight per slope over the day
    (the sun over the sea edge, an equinox path, cast shadows);
    temperature from the sea edge, a cooling curve that freezes the far
    north, a steep lapse rate, sun-facing slopes warmer and vents hot;
    rain carried off the sea by the wind, falling faster uphill, spent
    behind ranges; a UV index (sun height, slope, altitude, cloud, snow
    reflection) stored for gameplay.
  - *Biomes* (`biomes.ts`): first matching rule wins (temperature, rain,
    height, slope, distance to sea / any water / fresh water, sea
    exposure); a majority filter and a minimum patch size make regions;
    each biome adds surface character (dunes across the wind, flat
    swamps, rolling or ridged hills).
  - Default world: a spine down the peninsula (westerly wind: wet west,
    rain-shadow desert east), the volcano mid-spine, a frozen north.
    Biomes % of the world: sea 48, forest 8.4, glacier 8.1, snow 7.6,
    mountains 7.4, tundra 6.8, desert 4.5, beach 3, plains 2.9, volcanic
    2.1, swamp 0.8, lake 0.4; UV index 2.6–18 over land. Survey ~12 s,
    full bake ~21 s.
- [x] **Fine heightmap:** bicubic upsampling of the survey to the 16/15 m
      sample grid plus native detail noise × biome roughness — a pure
      function of the global sample, so seams are exact by construction.
- [x] **Storage:** tiles → `TerrainTileStore` (world.db, 2,500 per
      transaction; ordinary rowid table — `WITHOUT ROWID` spilled every
      1 KiB tile into overflow pages, 284 MB → 92 MB; old tables migrate on
      open); survey maps → world.db `world_maps`; chunk catalog (region,
      biome, height range, river) → SurrealDB at `<data>/surreal`.
- [x] **Bounded tools:** the terrain tool exports one area
      (`{cx, cz, radius}`, radius ≤ 32 chunks) and validates a save against
      only the edited tiles' stored neighbours; the editor's Terrain tab
      has an Area box and pins the area's outer edge so edits never open a
      seam with unloaded tiles.
- [x] **Spawn area only in the ECS:** the bake spawns and scatters just the
      3×3 start area; the rest waits for streaming (Phase 2).
- [x] **Players spawn on the ground** (the gateway asks the terrain; it
      used to spawn at y = 0, which fell 13 m into the swamp or would land
      inside a mountain). The server uses the seed recorded by the bake.
- **Verified (2026-09-28):** exact seams over all chunks (test world) and
      over the wire (4 km world); same spec → identical survey bytes; every
      biome at its configured count; bake 4.6 s survey + 11 s tiles + 15 s
      catalog, peak 329 MB; the server boots on the baked world in < 1 s
      and the end-to-end probe passes (grounding, jump, walking across
      chunk borders, scatter on the surface).

## Phase 2 — Server streaming (region)

- [x] **ChunkStreamer** (the first system of every tick): chunks load
      within 8 chunks (`MMO_STREAM_RADIUS`) of any player, nearest first,
      inside a per-tick time budget; chunks farther than 10 for 5 s
      unload. The 3×3 spawn area stays loaded. A load is the chunk entity
      (terrain reaches clients through it) plus its contents; physics
      bodies follow automatically, navmesh tiles through `ChunkNavmesh`.
- [x] **Scatter placed once, then persisted, never duplicated:** an
      unloading chunk's entities are written to its row in world.db
      (`chunk_entities`, one transaction per pass, before any despawn —
      an emptied chunk gets an empty row) and come back from it; only a
      chunk that has never unloaded is scattered. After a restart, chunks
      in the snapshot are adopted and their stale rows ignored.
- [x] **Navmesh tiles follow chunks**, baked on a worker thread on first
      visit (5-40 ms each on Windows) and cached in the registry after;
      cliff chunks with no walkable surface have no tile. The service
      holds 8,192 tiles (it held 128).
- [x] **Entity budget:** the streamer stops loading at 90,000 live
      entities (bitECS holds 100,000) and warns, instead of failing mid-tick.
- [x] **Spawn point from the world spec** (`spawn`: a biome or x/z;
      default the plains region nearest the centre, on its flattest dry
      spot); players spawn there and are held inside the world's edge.
- [x] The editor's terrain tool reads and re-seats props in unloaded
      chunks' rows too.
- [ ] A region owns a chunk range; the world server assigns ranges
      (registration exists; the catalog records them; with
      `REGION_CHUNK_RANGE` set, the streamer loads only inside it).
- [x] **Physics colliders from the terrain:** a static Jolt height field
      per loaded chunk, added and removed with it (`addTerrain` in the
      addon), so physics bodies rest on the surface characters walk on and
      clients render. Jolt splits cells along the other diagonal, so each
      field is rotated 90° with its samples re-indexed to match; removing
      one wakes the bodies resting on it. Stayed on Jolt (no PhysX).
- **Verify:** walk 4 km in a straight line with flat server memory, ticks
  under 33 ms, and no duplicate scatter after restarts.
  **Result (2026-09-28, in-process soak on the 4 km world, one player at
  4× walking speed, all server systems incl. terrain colliders):** 3.8 km
  across the world: tick p50 ~1.2 ms, p99 under 9 ms; then 20 km back and forth: JS heap flat at 18.5 MB, RSS
  plateaus at ~290 MB (caches) after the first lap, 19,890 loads, every
  chunk scattered once, 0 duplicates; after a restart, 731 loads all
  restored from rows, 0 duplicates. End-to-end: a client sees the full
  17×17 ring (289 chunks) stream in, scatter on the surface.

## Phase 3 — Client streaming, LOD, culling

- [x] **Terrain renderer** (client): streamed chunks as meshes on one
      shared opaque material (was a transparent material per chunk);
      normals match across chunk borders; skirts close the step to the
      far horizon.
- [x] **Far horizon:** the welcome carries the world's coarse map (16 m
      cells: elevation, biome, rivers, ~340 KB); the client draws the whole
      world from it and hides it wherever chunks are loaded.
- [x] **Texturing by slope, height, and biome** (procedural, no LYGIA):
      biome ground colours from the map, rock on steep faces (triplanar),
      snow on flatter ground above the snow line, mud along rivers.
- [x] **Instanced props:** scatter draws in 3 draw calls (was a mesh,
      geometry, and material per prop).
- [x] Camera kept above the ground; daylight sky and 2.6 km fog.
- [x] Rendering showed the first bake's mountains as walls on their
      region borders; fixed by the biome `ramp` retune (Phase 1).
- **Measured (2026-09-28, headless Edge on the dev machine's Intel UHD
  630):** 60 fps with 289 chunks, ~1,900 entities, and the full 4 km
  horizon. (The earlier 3 fps was likely the per-chunk transparent
  materials and a mesh per prop, not only the GPU choice.)
- [ ] Client requests chunks by distance; the server sends each client
      only its area (today every loaded chunk goes to every client).
- [ ] LOD rings between the 1 m chunks and the 16 m horizon.
- [ ] Pack textures (from the licensed art, kept out of git) in place of
      the procedural colours.

## Phase 4 — Editor at scale

- [ ] World map overview (downsampled height and biome); click to jump.
- [x] Sculpt one loaded area at a time (done in Phase 1: Area box, pinned
      edges).
- [ ] Load the area around the camera as it moves; large brushes for
      mountain-scale edits.
- [ ] Regenerate one region from the world spec without touching others.
- **Verify:** sculpt 3 km from the origin, save, and see it in game.

## Phase 5 — Biomes

- [ ] Biome registry: each biome's scatter sets and creature tables (its
      terrain rule and surface character live in the world spec).
- [x] Biome placement from the coarse fields — done in the climate-driven
      survey (Phase 1): biomes emerge from climate and water, uncapped.
- **Verify:** every biome is recognisable on the world map and in game.

## Later (builds on Phase 5)

Settlements and WFC, mesh-manipulation graph nodes (bromesh), modular
character assembly, spawn balancing by habitat.
