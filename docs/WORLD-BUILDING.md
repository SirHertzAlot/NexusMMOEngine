# World Building

How the world is generated, how to change it, and what to do when a change
needs the world rebuilding. This is the practical companion to
[OPEN-WORLD-PLAN.md](OPEN-WORLD-PLAN.md), which records the design decisions
and the measured results behind them.

The short version: **terrain is baked once and then it is data, not a
formula.** Players walk on stored chunk tiles that the editor can sculpt, so
changing the generator afterwards does not retroactively move the ground
under anyone's feet.

## The world spec

A world is described by one checked-in JSON file, validated with Zod:
`packages/engine-core/worlds/default.world.json`. Another spec is selected
with `MMO_WORLD_SPEC`; `MMO_WORLD_SPEC=none` bakes the small legacy 3 × 3
world instead.

The shipped spec:

| Field | Value | Meaning |
|---|---|---|
| `name` | `default` | |
| `seed` | `1234` | the world's seed, recorded at bake time |
| `sizeChunks` | `250` | 250 × 250 chunks at 16 m = **4 × 4 km** |
| `chunkWorldSize` | `16` | metres per chunk |
| `coarseCell` | `8` | survey resolution, metres |
| `regionsPerSide` | `2` | the region grid (2 × 2) |
| `biomes` | 13 | ordered rules, see below |
| `minBiomeArea` | `6000` | cells; smaller patches are absorbed |
| `land` | — | coast side, shelf, rise, relief |
| `ranges`, `volcano` | — | the mountain chain and its volcano |
| `climate`, `erosion`, `glaciers`, `rivers`, `lakes` | — | the simulation below |

`land` is where the map's shape comes from: the default is a peninsula with
the sea to the **south** (`waterEdge` 0.6 — the sea covers 60% of that edge,
plus the lower parts of the east and west), a 300 m shelf falling to a
40 m-deep sea floor, land rising 30 m over the first 1200 m inland, and broad
25 m swells every 1500 m.

`spawn` is optional and takes either an explicit point or a biome:

```json
"spawn": { "biome": "plains" }
```

```json
"spawn": { "x": 1200, "z": 900 }
```

Give both `x` and `z` or neither. A bare biome means "the biggest region of
that biome near the middle of the land"; the default is `plains` when the
world has it, else the catch-all biome. The spawn must be on dry land in the
named biome. Whatever it resolves to is written into the bake's metadata and
is where players and the 3 × 3 pinned area end up.

## How the terrain is made

`npm run bake:world` runs a pipeline of independent, individually tested
stages under `packages/engine-core/src/terrain/`:

1. **Land** (`landmass.ts`) — the coast frame, warped for bays and headlands;
   one landmass, with islands below `minIslandArea` sinking; the mountain
   chain across the prevailing wind with spurs branching off at an angle, and
   the volcano raised on it *after* erosion so it reads as young (lobed cone,
   crater, vent heat).
2. **Erosion** (`erosion.ts`, `glaciers.ts`) — thermal collapse to the angle
   of repose (38°); glaciers that form where it is cold and snowy, flow down
   the drainage, melt with warmth and sunshine, grind U-shaped valleys, calve
   at the sea and drop terminal moraines; stream-power river incision weighted
   by rain and meltwater; droplet erosion where it rains, leaving deltas.
   The relief passes below sharpen what this produces.
3. **Water** (`hydrology.ts`) — the sea is everything below sea level and open
   to it; lakes form in hollows that are deep, large and wet enough; rivers
   come from rain-weighted drainage, with depressions filled so every cell
   drains to a lower neighbour.
4. **Climate** (`climate.ts`, `sun.ts`) — sunlight per slope over an equinox
   day with cast shadows; temperature falling with height and distance from
   the sea (freezing the far north), sun-facing slopes warmer, vents hot; rain
   carried off the sea by the wind, falling faster uphill and spent behind
   ranges, which is what puts a desert in the rain shadow; a UV index stored
   for gameplay.
5. **Biomes** (`biomes.ts`) — ordered rules, **first match wins**, read over
   the climate and water results. Then a majority filter plus `minBiomeArea`
   merges specks into real regions, and each biome adds its own surface
   character (dunes across the wind, flat swamps, rolling or ridged hills).
6. **Fine heights** (`world-heights.ts`) — bicubic upsampling of the coarse
   survey to the 16/15 m sample grid, plus native detail noise scaled by biome
   roughness. It is a pure function of the global sample, so **chunk seams are
   exact by construction** rather than by patching afterwards.

The 13 biomes in the shipped world are `beach, desert, forest, glacier, lake,
mountains, plains, rainforest, sea, snow, swamp, tundra, volcanic`. Each rule
is a `when` clause over the climate and water fields plus a `roughness`:

```json
{ "id": "sea", "when": { "water": "sea" }, "roughness": 0.2 }
```

**Biomes are not capped or counted.** They emerge from climate and water, so
a change to rainfall or temperature changes where they are.

### Relief passes (sharp peaks, carved valleys)

Four switchable passes, all off unless the world file names them (a world
without them bakes exactly as before). `worlds/default.world.json` turns them
on, so re-bake it (`npm run bake:world:force`); towns' site selection moves
with the new slopes.

| Key | Default | What it does |
| --- | --- | --- |
| `ranges.crest.sharpness` | `0` | 0..1: blends the range cross-section from the rounded quartic dome toward a pointed ridge (`(1-r)^1.6`), so a crest is a line, not a crown |
| `ranges.crest.detailOctaves` / `detailStrength` | `0` / `0.5` | 1..5 octaves of domain-warped ridged multifractal (Musgrave) over the range, each octave weighted by the last so detail gathers on crests; strength is the share of the range height it modulates |
| `erosion.incision.passes` / `k` / `areaExponent` / `maxCutM` | `0` / `0.0012` / `0.5` / `40` | implicit stream-power incision, `h = (h + F·h_receiver)/(1+F)`, `F = k·area^m/distance`, outlet-first so it is stable for any `k`; summits (no drainage area) stay, trunk valleys deepen; no cell is cut more than `maxCutM` in total; flow is re-routed every 3 passes |
| `erosion.rockTalusDeg` / `rockFromM` / `rockSpanM` | unset / `150` / `100` | bare rock holds a steeper angle than scree: the thermal angle rises from `talusDeg` to `rockTalusDeg` over `rockSpanM` above `rockFromM`, so crests stay sharp while the slopes below weather to scree; unset = one angle |
| `volcano.gullies` | `0` | 0..1: radial gullies between spur ridges on the cone's flanks (the cone is raised after erosion, so without this it stays perfectly smooth) |

Cost: the default world's survey goes from about 9.6 s to 13.5 s (the
incision's flow re-routing). The passes work on the coarse grid in typed
arrays, same seed, same bytes.

## Baking

```bash
npm run bake:world          # refuses to overwrite an existing world.db
npm run bake:world:force    # stop the server first, then overwrite
```

The bake shares the server's data folder and seed variables, plus:

| Variable | Default | |
|---|---|---|
| `MMO_WORLD_SPEC` | `worlds/default.world.json` | the spec to bake; `none` = the legacy 3 × 3 world |
| `MMO_BAKE_RADIUS` | `1` | chunks around spawn that are populated at bake time |
| `MMO_BAKE_FORCE` | unset | `1` overwrites (same as `bake:world:force`) |
| `MMO_WORLD_CATALOG` | enabled | `0` skips the SurrealDB chunk catalog |

Only the spawn area is populated during the bake; the rest of the world fills
in as players explore it. The output lands in `MMO_DATA_DIR` (default
`packages/engine-core/data/world.db`, roughly 92 MB for the 4 km world — partly
SQLite page overhead over ~61 MB of heights) and is gitignored.

**Tuning loop:** `npm run preview:world` draws the spec's biomes, rainfall,
temperature and UV index to `world-preview.png` in about ten seconds without
baking anything. Use it to iterate on a spec, then bake once you are happy.

### When a change needs a re-bake

| You changed | What it needs |
|---|---|
| The generator, the spec, or the seed | a re-bake (`bake:world:force`) — the ground is stored, so it will not move by itself |
| Terrain in one area | the editor's Terrain tab, or the terrain tool |
| The scenery plan or spawn table | nothing, **but only in chunks that have never loaded** — see the caveat below |

## Scenery

The first time a chunk loads, its scenery is placed and then **persisted**.
Every unload writes the chunk's entities to its row in `world.db` — even an
empty one — so a chunk is populated exactly once, ever, and a restart restores
from those rows instead of re-running scatter.

`MMO_SCATTER` picks what grows:

| Value | What it places |
|---|---|
| `ecology` (default when `assets/manifest.json` exists) | natural placement of the art pack's nature set: trees in groves, scree round boulders, flower patches, reeds at the shore, lily pads on shallows |
| `pcg` | the PCG forest graph, drawn with the engine's own procedurally cooked PICG trees — this is what you get without the licensed art |

The default is `ecology` on a machine that has the art packs (because its
clients can draw them) and `pcg` otherwise. Any other value is a startup error.

### The ecology plan

`packages/engine-core/content/ecology/wilds.ecology.json` is a plan of
**17 layers, run in order**. A layer with a parent (`place.parent`, or an
`avoid` pointing at another layer) must come after the layer it references;
`parseEcologyPlan` rejects a plan that gets this wrong rather than silently
placing nothing.

There are three kinds of layer:

- **`field`** — one candidate per world-space cell of `spacing` metres, kept
  with a `chance` scaled by noise-driven `density` ramps, the layer's `biome`
  multiplier, `slope`, and `aboveWater`. This is the workhorse: groves,
  meadows, reeds, lily pads.
- **`around`** — satellites of another layer's points, with a `count` range, a
  `radius` range, and an optional `downhill` drift. This is how scree clusters
  round a boulder and runs down the fall line, and how a flower patch shares
  one pick (`samePick`).
- **`formation`** — points decided **together** by Wave Function Collapse
  (`@mmo-engine/wfc`) rather than one by one, so a layer can express things
  that need to agree with their neighbours: a ring of standing stones around a
  clearing, tents around a fire. A formation layer lists `options` (weighted,
  tagged, each with its own assets) and constraints — `avoid` (minimum
  distances between tags), `needs` (a tag must be near another, optionally at
  least `count` times) and `counts` (at most so many per tile). The shipped
  plan opens with exactly this: `stoneCircles` puts at most one `centre` per
  tile, six or more `stone`s within 6.5 m of it, and no two centres within
  45 m.

**Sea level and habitat.** Below the water (the sea, a lake) is for aquatic
content only. A layer's `habitat` says where it may stand: `"land"` (the
default) needs its ground at least the plan's `landMarginM` (default 0.3 m,
`LAND_MARGIN_M` in `procgen/habitat.ts`) above the water surface, wherever the
water lookup finds no water too (the sea level is the floor); `"shore"` keeps to
its `aboveWater` band round the water line (reeds, ground a little under to a
little over the surface); `"water"` is aquatic (coral, kelp, lily pads), the only
kind placed below the water, on the floor between the depths of its `aboveWater`
range (negative metres; `onWater: true` floats it on the surface instead).
`parseEcologyPlan` refuses a shore layer without a band and a water layer
without a depth range. The same rule runs in the PCG path (a spawn-table
archetype takes `habitat: "water"` with `depthM: [shallowest, deepest]`) and in the
scene spawner, which refuses (and lists under `skipped`) a land prop in the water
and a building whose footprint is not at least `STRUCTURE_MARGIN_M` (1 m) above
it or lies on a river cell. One source of the water: the world's sea level
(`sea_level` meta, from the spec) and the surface lookup built from the bake's
`water_level` map.

A layer also carries `assets` (weighted, with per-asset scale) and
`biomeAssets` overrides — pines on the cold heights, broadleaves below — and
an optional `collision` block so a boulder is something you can stand on or
walk into.

Candidates are **world-space cells**, so a candidate belongs to exactly one
chunk and chunks agree at their borders no matter what order they load in.
Formation tiles are solved at bake time and cached in `world.db`
(`formation_tiles`), keyed by world seed, terrain version, plan hash, layer and
tile index, because solving a tile takes tens of milliseconds — far too long
for a tick. A tile missing from the cache is solved on demand.

`MMO_ECOLOGY` points at another plan file. The shipped plan and the WFC
constraints behind it are designed in
[DUNGEONS-AND-LOOT.md](DUNGEONS-AND-LOOT.md).

### The PCG graph

`content/pcg/` is the PCG asset library the server cooks and serves:

- `index.json` lists the parts (`trunk`, `crown-round`, `crown-conifer`) as
  `.pcgsubgraph` files with GUIDs, and the tree assets (`oak`, `birch`,
  `pine`) as `.pcg` graphs with a variant count.
- Each tree graph is cooked into meshes by the `addon-picg` native addon. If
  the addon is not built, assets are still listed but clients keep their
  placeholder shapes rather than failing.
- Assets and their cooked meshes are served over the gateway's own HTTP
  surface, authenticated by session tokens. See
  [PCG-SPEC.md](PCG-SPEC.md) for the graph format.

`MMO_PCG_ASSETS` points at a different library.

### The caveat that catches everyone

> A chunk is populated once, ever. Changing a scenery plan has **no effect on
> any chunk that has already loaded**.

Visited areas keep what they grew. This is deliberate — harvesting a tree is
an ordinary entity change and it persists — but it means a plan change needs a
fresh world to be visible everywhere:

```bash
MMO_DATA_DIR=./data/fresh npm run bake:world
MMO_DATA_DIR=./data/fresh npm run server
```

Accounts live in the data folder too, so register again in the fresh world.
The code notes that a proper fix is a content version on the `Chunk` component
so a plan change invalidates only what it should; until then, a fresh database
is the answer.

## Editing terrain by hand

The editor's **Terrain** tab and the terrain tool sculpt the baked world's
stored tiles. Two properties make this safe:

- **Seams stay closed.** Samples on a chunk border are shared between the
  neighbouring chunks, so a brush that crosses a border moves both tiles
  identically. A save that would open a seam against an unloaded tile is
  refused.
- **Edits are bounded.** The tool works on one area (`{cx, cz, radius}`,
  radius ≤ 32 chunks), pins the area's outer edge so unloaded neighbours are
  never disturbed, and validates the save against only the edited tiles'
  stored neighbours.

Props in unloaded chunks are re-seated too: their rows are exported, adjusted
and written back, so a raised hill does not leave trees buried in it.

A server owning the world refuses to let the tool save over it — stop the
server first. See [EDITOR.md](EDITOR.md) for the UI.

Terrain edits also invalidate derived data correctly: a chunk's navmesh tile is
keyed by a fingerprint of its own heights, so a sculpted chunk re-bakes and an
untouched one keeps its cache.

## Scaling the world

| World | Chunks | Stored heights |
|---|---|---|
| 2 × 2 km | 15,625 | ~15 MB |
| 4 × 4 km | 62,500 | ~61 MB |
| 8 × 8 km | 250,000 | ~244 MB |
| 16 × 16 km | 1,000,000 | ~1 GB |

Set `sizeChunks` in the spec. The practical limits are not the file size but
two things the engine already handles explicitly: the streamer stops loading at
90,000 live entities (bitECS holds 100,000) and warns rather than failing
mid-tick, and only a fraction of any large world is ever resident. The client
draws the whole world from the coarse map in the welcome (the far horizon), so
even 16 × 16 km is visually continuous.

## Checklists

**Add a biome.** Give it an `id` and a `when` clause over the climate and water
fields in the spec's `biomes` array, in the right order relative to the other
rules (first match wins), and give it a `roughness` so its surface differs.
Then re-bake. If it needs its own scenery, wire it into the ecology plan — but
remember only unvisited chunks will pick it up.

**Change the map's shape.** Edit `land` (coast `side`, `waterEdge`, `tip`,
`taper`, `wander`) and the `ranges`/`volcano` blocks, preview with
`npm run preview:world`, then re-bake. Expect the biome map to shift: rainfall
and temperature are downstream of the land.

**Add a tree to the PCG forest.** Add a `.pcg` graph under `content/pcg/trees/`,
list it in `index.json` with an `id`, `graph`, `displayName` and `variants`,
and add it to the scatter plan or spawn table. No re-bake is needed for
unvisited chunks.
