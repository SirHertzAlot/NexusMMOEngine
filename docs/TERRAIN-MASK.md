# Terrain material masks (Phase 2)

## What is built

- **Schema** (`packages/art/src/media/terrain-mask.ts`): `TerrainMaskSpec` (zod):
  `seed`, `resolution` (samples per 16 m chunk side, default 16), `noiseScaleMetres`,
  `rock` (slope ramp in degrees, moisture damping), `wet` (moisture ramp, flow boost),
  `path` (feather cells). Channels are fixed and independent:
  R base noise, G rock, B wet, A path.
- **Per-chunk bake** (`engine-core/src/terrain/terrain-mask.ts`): `bakeTerrainMask`
  is pure and seeded; noise is sampled at world coordinates so chunk edges agree.
- **World bake** (`engine-core/src/terrain/mask-bake.ts`, wired into
  `bakeWorldTerrain` after the survey and before scatter): samples the survey's
  height (slope = gradient), moisture, and log-normalised flow at each mask
  sample. Stored as four `mask_<channel>` maps in region.db. `masks: false` skips it.
- **Client** (`apps/client/src/render/terrain/terrain-material.ts`): `uMask`
  (RGBA, `packTerrainMask`) blended over the ground colour: rock greys it, wet
  darkens it, path lightens it. The cel patch runs after, so masked terrain
  still shades cel. `TerrainRenderer.setTerrainMask` / `clearTerrainMask`.

## Tests (all green)

- `engine-core/test/terrain-mask.test.ts` (10): determinism, a golden hash
  (53f76bb5), seed sensitivity, one channel per parameter, road and feather,
  validation.
- `engine-core/test/terrain-mask-bake.test.ts` (7): through the real world bake
  on the tiny test world: maps stored and sized, determinism, golden hashes per
  channel (base 91fc6984, rock abdbd432, wet 5495cfa9, path 38699dc5), `masks: false`
  stores nothing, rock and wet threshold changes move only their own channel.
- `apps/client/test/world-shading.test.ts`: the terrain material samples the
  mask and keeps the cel patch; the packer puts rock in G.
- Existing `bake-world.test.ts` still passes (28 of 28 with the new tests).

## Measured (default world, 250×250 chunks = 62 500 chunks, 4 cores, no catalog)

| run | survey | tiles (includes mask bake and map writes) | mask bake | total | peak RSS |
| --- | --- | --- | --- | --- | --- |
| without masks (2 runs) | 16.8 s, 14.7 s | 8.1 s, 8.0 s | - | 24.9 s, 22.8 s | 387, 385 MB |
| with masks (2 runs) | 17.2 s, 17.3 s | 14.3 s, 12.7 s | 5.7 s, 4.8 s | 31.6 s, 30.1 s | 462, 459 MB |

- The mask adds about 7 to 9 s to the total (about 30 to 35%). About 5 s is
  the mask compute, and the rest is writing four 16 MB channel maps, which sit
  inside `tilesMs`.
- Resolution 16 is the default for this reason. At 64 the compute is about 4×
  that. Mask compute is single-threaded here; moving it into the tile workers
  would bring it under the tile time.
- The existing envelope recorded in `docs/OPEN-WORLD-PLAN.md` (2026-09-28)
  includes the catalog step, which this measurement skips. So this run is not
  a direct envelope pass or fail. The honest read is that the mask adds about a
  third to the bake, and that is over the envelope unless the compute is
  parallelised or resolution is lowered.

## Gaps (stated plainly)

1. **Path channel is empty.** The survey has no road field. `bakeWorldMasks`
   takes an optional `road` array and uses it when given, but nothing passes one.
2. **Biome is not an input.** The spec lists biome among the inputs. The current
   channels are not biome-dependent. A biome-driven channel is open.
3. **Client delivery is not wired.** The client gets terrain tiles over the
   protocol. The mask has no protocol channel yet. Adding one is a networking
   change, which is a non-goal for this build, so it needs a decision.
   Until then `setTerrainMask` has no caller.
4. **The envelope is not verified** (see above). Parallelising the mask compute
   inside the tile workers, or lowering resolution, is the next step.
5. Visual check of the blend is owed to a human on a GPU.
