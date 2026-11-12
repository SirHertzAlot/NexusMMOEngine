# Terrain material masks (Phase 2, partial)

Status: the schema and the pure bake are built and tested. Not yet wired
into the world bake, not consumed by the client terrain shader, and the
default-world time envelope is not verified.

## What is built

- `packages/art/src/media/terrain-mask.ts`: `TerrainMaskSpec` (zod). Fields:
  `seed`, `resolution`, `noiseScaleMetres`, `rock` (slope ramp, moisture
  damping), `wet` (moisture ramp, flow boost), `path` (feather cells).
  Channels are fixed and independent: R base noise, G rock, B wet, A path.
- `packages/engine-core/src/terrain/terrain-mask.ts`: `bakeTerrainMask`
  takes slope, moisture, flow and road samples for one chunk and returns
  resolution² RGBA bytes. `maskHash` is FNV-1a over those bytes.
  Noise is sampled at world coordinates so chunk edges agree.
- Tests (`packages/engine-core/test/terrain-mask.test.ts`, 10): determinism,
  a pinned golden hash (53f76bb5), seed sensitivity, one-channel-per-parameter
  (rock, wet, path each change only their channel), road and feather
  behaviour, spec and input validation.

## Measured

- One 64×64 chunk: 0.75 ms (single thread, Node 22, this container).
  Output 16 384 bytes.
- Not yet measured: the default world's total time against the terrain
  bake's own envelope. The recorded 2026-09-28 figure (docs/OPEN-WORLD-PLAN.md)
  is 11 s of tiles for a 4 km test world, generated in worker threads. The
  mask bake would need the same chunk count and a parallel run to compare.
  This is an open item, not a pass.

## Still open

1. Wire `bakeTerrainMask` into `bakeWorldTerrain` after the survey and before
   scatter, feeding it the survey's slope, climate moisture, flow
   accumulation and roads.
2. Persist the mask per chunk (format and version field).
3. Client: blend the terrain textures with the mask
   (`render/terrain/terrain-material.ts`).
4. Detail placement (Phase 3) reads the same channels.
5. Hash and seam tests on a real survey, not only the fixture.
