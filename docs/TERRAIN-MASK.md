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

Mask compute runs across worker threads (one slab of chunk rows per worker).

| run | survey | tiles (includes mask compute and map writes) | mask compute | total | peak RSS |
| --- | --- | --- | --- | --- | --- |
| without masks (2 runs) | 14.5 s, 14.6 s | 6.1 s, 7.2 s | - | 20.6 s, 21.8 s | 383, 373 MB |
| with masks, 1 thread (earlier, 2 runs) | 16.8 s, 14.7 s (no mask) | 14.3 s, 12.7 s | 5.7 s, 4.8 s | 31.6 s, 30.1 s | 462, 459 MB |
| with masks, workers (2 runs) | 14.7 s, 15.1 s | 9.2 s, 9.4 s | 2.1 s, 2.1 s | 24.0 s, 24.5 s | 597, 613 MB |

- With the masks in workers, the bake is about 3 s slower (about 13 to 16%).
  The compute is 2.1 s; the rest is writing four channel maps to region.db.
- Peak memory rises by about 230 MB. Each worker gets its own copy of the
  source arrays, and the slabs are held until assembly. Sharing those arrays
  without copies would fix this.
- The recorded envelope (docs/OPEN-WORLD-PLAN.md, 2026-09-28) includes the
  catalog step, which these runs skip. This is not a direct envelope check.

## Client delivery

No protocol change. The bake can write `terrain-mask.bin` (option
`maskAssetPath`): the `TMSK` format in `packages/art` (`encodeTerrainMaskAsset`
/ `decodeTerrainMaskAsset`), RGBA rows in world order. The client decodes it and
hands the RGBA to `packTerrainMask` / `setTerrainMask`. Fetching the file in the
app (the dev server serving it next to the assets) is not wired yet.

## Inputs and gaps

- **Inputs:** survey height (slope = gradient), moisture, log-normalised flow,
  and biome. The base channel is half noise, half the biome's ground type. The
  golden hashes were repinned for this; rock, wet and path bytes did not change.
- **Path channel is empty.** The terrain bake routes no roads. Roads come from
  the settlement stage (`onSurvey` hook), which runs after the terrain bake, so
  there is no road data at mask time. Fixing it means either running road routing
  before the masks, or a second mask pass after settlements. That is an
  ordering decision, recorded here rather than made.
- **Visual check** of the blend is owed to a human on a GPU.
