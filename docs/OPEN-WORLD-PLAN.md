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

## ⚑ Decisions before building

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

- [ ] World spec file (seed, size, vertical scale, biome count) — data,
      not env vars.
- [ ] Two-level generation: a coarse global field (e.g. 8 m cells) for
      continents, mountain ranges, rivers, and biomes; fine 1 m detail per
      chunk on top. Baked in tiles with overlapping halos so memory stays
      bounded and seams stay exact.
- [ ] Erosion and flow (rivers) on the coarse field (PICG
      `HeightFieldErode`/`FlowField` or native C++; GPU later if too slow).
- [ ] Store fine tiles (existing `TerrainTileStore`) plus coarse maps
      (height, biome id, moisture, flow) for the editor and world server.
- **Verify:** exact seams at every chunk and bake-tile border; same seed →
  identical bytes; bake time and peak memory reported per biome.

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
