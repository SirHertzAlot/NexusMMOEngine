# Incremental, content-addressed world bake

Design for roadmap **WX2** (the bake half of "super massive worlds"). The
runtime half — a lazy, version-keyed terrain cache — is the opencode agent's
`feat/terrain-lazy-cache` branch; this document is the bake that fills it
incrementally.

## Problem

`npm run bake:world` materializes the whole world up front:

| World | Chunks | `terrain_tiles` | `world_maps` | Total |
|---|---|---|---|---|
| 4×4 km (today) | 62,500 | 82 MB | 11 MB | **103 MB** |
| 16×16 km | 1,000,000 | ~1.3 GB | ~180 MB | **~1.5 GB** |
| 32×32 km | 4,000,000 | ~5.2 GB | ~720 MB | **~6 GB** |

Cost is linear in area, and 80% of it is `terrain_tiles` — one float32
heightmap per 16 m chunk. Two consequences:

1. **Storage.** A 32 km world is ~6 GB before anyone plays.
2. **Iteration.** Every terrain spec change forces a full re-bake, which is
   why `docs/DECISIONS.md` reads like a list of "re-bake needed" entries.

## Principle

> Cost is proportional to attention, not to area.

The engine already believes this everywhere except the bake:

- `Chunk.heights` is *"written by the region server on network snapshots/deltas
  ONLY. Never persisted"* — the server is the authority and streams.
- Navmesh tiles are *"versioned deterministic build artifacts"*, keyed by
  `(worldSeed, chunkX, chunkZ, terrainVersion, agentProfile, bakeConfigHash)`.
- `makeTileChunkSource(tiles, fallback)` **already falls back to procgen** when
  a tile is absent — so the server runs fine with no tiles at all.
- `heightsFingerprint(heights)` already content-addresses a heightfield.

So the tiles are already a cache. The bake just doesn't treat them that way.

## Design

### 1. Separate the survey from the tiles

The bake produces three things, only one of which is global:

| Output | Scope | Cost |
|---|---|---|
| **Survey** — regions, rivers, water, erosion, biomes, climate fields | whole world, iterative | 250×250 cells |
| **Catalog** — per-chunk region/biome/min-max/river | derived from survey + tiles | 62,500 rows |
| **Spawn-area entities** | `MMO_BAKE_RADIUS` | small |

The **tiles are not part of the bake.** They are a derived, content-addressed
cache that fills on demand. The server already regenerates them via procgen
when missing, so this is safe.

### 2. Content-address the survey

```
surveyHash = sha256(canonicalJson(spec))
```

Stored in `meta`. On re-bake, if the spec is unchanged the survey is skipped
entirely — its maps and catalog rows are already in the db.

### 3. Content-address the tile cache

A tile's bytes are a pure function of `(seed, cx, cz, lod, terrainVersion,
surveyHash)`. Store that key beside the tile:

```sql
CREATE TABLE IF NOT EXISTS terrain_tile_keys (
  cx INTEGER NOT NULL, cz INTEGER NOT NULL, lod INTEGER NOT NULL,
  seed TEXT NOT NULL, survey_hash TEXT NOT NULL, terrain_version INTEGER NOT NULL,
  height_fingerprint INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cx, cz, lod)
);
```

LOD 0 tiles are stored in `terrain_tiles` (via the existing `TerrainTileStore`);
LOD > 0 tiles go into a separate `terrain_tile_data` table, so the existing
`TerrainTileStore` API is unchanged.

- `has(cx, cz, lod, seed, surveyHash)` — is the stored key current?
- `put(...)` — write tile + key in one transaction; no-op when unchanged.
- `invalidateSurvey(surveyHash)` — drop every tile baked under an older survey.
- `invalidateRegion(rx, rz, regionsPerSide)` — drop one region's tiles.

### 4. Regional re-bake

`regionsPerSide` already partitions the world square. Add:

- `npm run bake:world -- --region 2,1` — re-bake only that region's tiles.
  A regional re-bake re-runs the survey (it needs it for tile generation),
  calls `invalidateRegion` to drop that region's tiles, then regenerates only
  that region's chunks. The other regions' tiles are untouched.
- `npm run bake:world -- --survey-only` — re-run just the survey (maps +
  catalog), invalidating the tile cache for the new survey hash.

The `--force` overwrite gate deletes `world.db` + WAL sidecars ONLY on a forced
full bake; incremental mode (`--region`/`--survey-only`) updates the world in
place and never deletes it.

### 5. Parallelize the tile loop

The per-chunk loop in `world-bake.ts` is embarrassingly parallel — each chunk's
heights come from `heights.generateChunk(seed, cx, cz, lod, out)`, independent
of every other chunk. Run it across worker threads, writing in batches.

## Contract between the two pieces

`packages/engine-core/src/persist/terrain-cache.ts` (new) is the primitive the
bake consumes:

```ts
export interface TerrainCacheOptions {
  dbPath: string;
  /** The terrain pass version; bumping it invalidates every cached tile. */
  terrainVersion: number;
  /** Minimum chunk coordinate (required for invalidateRegion). */
  minChunk?: number;
  /** World size in chunks (required for invalidateRegion). */
  sizeChunks?: number;
}

export class TerrainCache {
  constructor(opts: TerrainCacheOptions);
  has(cx: number, cz: number, lod: number, seed: bigint, surveyHash: string): boolean;
  put(cx: number, cz: number, lod: number, seed: bigint, surveyHash: string, heights: Float32Array): boolean;
  invalidateSurvey(surveyHash: string): number;
  invalidateRegion(rx: number, rz: number, regionsPerSide: number): number;
  close(): void;
}
```

`has`/`put` reuse `heightsFingerprint()` from `procgen/chunk-source.ts` rather
than inventing a second hash.

`terrainVersion` is optional in `TerrainBakeOptions` and defaults to 1; the
bake passes `procgen.terrainVersion` (a deterministic `fnv1a32` of the
generator version + amplitude + frequency).

## Stages

1. **TerrainCache** — the content-addressed store + unit tests. Self-contained.
2. **Survey hashing + skip** — `surveyHash` in meta; skip the survey when the
   spec is unchanged.
3. **Regional + parallel tile regeneration** — `--region`, `--survey-only`,
   worker-thread tile loop.
4. **Wire `bake-all`** — `--only world --region ...` so a terrain tweak re-bakes
   one quadrant instead of the world.

## Risks

- **Determinism versioning.** A derived tile is only safe if a `terrainVersion`
  bump invalidates the cache. The navmesh already does this; mirror it.
- **The survey is global and iterative** (erosion, 150,000 droplets). A spec
  change re-runs it; that is unavoidable. The win is that the *tiles* no longer
  have to be rewritten for free — only the affected regions.
- **Erosion is the bake's hot spot** and scales with area. Run it on a coarser
  grid and upsample, or per-region in parallel.
- **The navmesh tile cap** (8192 tiles × 512 polys) is a hard ceiling on
  resident navigation data — decide the navigation strategy separately.
