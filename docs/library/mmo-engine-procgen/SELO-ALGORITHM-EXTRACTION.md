# Selo Settlement Engine — Algorithm Extraction for the Living Sim

**Source:** `SeloSlav/medieval-settlement-threejs` (public repo, main branch, extracted 2026-10-11)
**License:** Custom "Selo Empire Code License" — MIT permissions on code; art, branding, and creative content carved out into LICENSE-ASSETS.md. Joey verified this reading: code techniques are usable, art is not. This document contains algorithm descriptions for clean-room reimplementation, not code copies.
**Purpose:** Extract the procedural-generation algorithms needed for the living sim's environment foundation — terrain, rivers/water, and the ecological placement logic that determines which organics exist where.

---

## Executive Summary

Four subsystems were extracted in parallel: **rivers/hydrology**, **terrain**, **organics** (forest + foraging + resources), and **roads/settlement**.

**The headline findings:**

1. **Rivers are the environment's spine, and this engine treats them that way.** Surface water (river corridors) and subsurface water (analytic groundwater function) are two independent systems. The groundwater function is the single most portable piece in the entire codebase — pure integer-hashed function of (x, z, seed), zero baked state, designed so "the server runs the same seeded sampler."

2. **"Which organics exist where" is answered by distance-to-water bands plus habitat scoring.** Water blocks all placement; a 0.45–5.2m shore band is reserved for shore specialists (reeds, shore stone); beyond that, per-species habitat suitability functions (moisture × temperature × soil × light) decide winners. Berries want forest edges (density 0.28–0.48 + edge gradient), mushrooms want deep interior (density ≥ 0.68), game wants dense cover (≥ 0.55).

3. **Roads are player-drawn, not procedurally generated.** There is no "grow road network from seed" algorithm. What exists is reusable downstream infrastructure: graph storage with auto-junctions, Dijkstra routing, automatic bridge placement, frontage snapping. The procedural road-layout layer (arterial → lane hierarchy along contours) must be built.

4. **Determinism is mixed and must be fixed during port.** River topology and groundwater use integer hashes (portable). Terrain noise, meander geometry, and shoreline jitter use `Math.sin`-based hashing (NOT bit-identical across platforms). The port must standardize on integer hashes — the codebase itself was already migrating that direction in newer code.

5. **The master architectural pattern is layered suitability:** macro structure (seeded) → continuous habitat fields (moisture/temperature/soil/light as noise-derived factors) → per-organism suitability functions → placement via scoring + spacing constraints. Each layer is independently testable.

---

## Part 1: Rivers & Hydrology (Environment Foundation)

### 1.1 The Two Water Systems

Deliberate design: surface and subsurface water are independent.

- **Surface water** (rivers, ponds): polyline corridors → rasterized mask fields. Used for rendering, terrain carving, placement blocking, navigation.
- **Subsurface water** (groundwater/aquifers): pure analytic function `sampleWorldGroundwaterScore(x, z, seed, hydrology)`. Explicitly has NO dependency on river fields, shore distance, or ponds. Farms, wells, and clay deposits query it directly — no baked state, no field dependency. This is the server-authoritative pattern.

### 1.2 River Corridor Generation

**Inputs:** bounds, seed (default 0x7e57e1e), riverCount (default 4), tributaryCount (default 1), drain point (default {x:0, z:-88}).

**Procedure per river:**
1. **Start point:** ray from map center at `angle` to bounding edge. Angle = mountain-biased blend: `mountainAngle × 0.58 + edgeAngle × 0.42`, with hash jitter. Starts bias toward the north/top edge.
2. **Control points (11):** lerp from start toward drain, with:
   - `convergence = smoothstep(0.68, 1, t)` — straightens near drain
   - `upstreamDamp = 1 − smoothstep(0, 0.24, t) × 0.82` — calms headwaters
   - `meanderEnvelope = sin(t×π) × (72 + hash×48) × scale × (1 − convergence×0.88) × upstreamDamp`
   - Two superimposed sine waves (waveA: freq 7.4, waveB: freq 12.8) offset perpendicular to flow
   - Plus upstream extension point, final point = drain
3. **Smooth:** Catmull-Rom through controls, 12 samples per segment.
4. **Resample:** arc-length at 2.6m spacing.
5. **Width/depth profiles** (progress p ∈ 0..1):
   - `halfWidth = lerp(2.4, 12, p^0.68) × scale` — widens downstream
   - Headwater boost: `lerp(hw, max(hw, 8.5×scale), 1 − smoothstep(0, 0.18, p))`
   - `channelDepth = lerp(0.9, 2.65, p^0.82) × scale`
   - Mouth flare near drain (within 130m): width → 26m, depth → 3.65m

**Tributaries:** branch from parent at 36% + i×8% along its length, start 58m away at hashed angle, scale 0.62, kept only if >30 points.

**Data structure:** `RiverPoint { x, z, progress, halfWidth, channelDepth }` polylines. 32m spatial grid index. **Serialization** (`serialize()` → polylines + water bodies) is the bake-and-distribute mechanism.

**Determinism note:** corridor topology (starts, jitter, control structure) uses integer `hashF64` — portable. Meander shape uses `Math.sin` — NOT bit-identical. Port strategy: bake once on one platform, ship serialized polylines; or replace sin-meander with hash-noise equivalent.

### 1.3 Terrain Carving

**Generic rivers:** `(1 − smoothstep(hw×0.28, hw×0.95, dist))² × channelDepth` — squared falloff, full depth at center, zero at 0.95×halfWidth.

**Entrenched rivers (the Kupa pattern — worth stealing):**
- Bank-to-water drop: 3.2m. Min channel water depth: 2.15m.
- Water surface follows **monotone hydraulic grade** `(0.5 − progress) × terrainSpan × 0.0034` — an analytic downstream fall, NEVER the tessellated bed. This is the key trick: interpolation of the bed can't create uphill water.
- Bank support radii: full within 1.1×halfWidth, feather to 1.25×.

### 1.4 The Shore-Band Placement Rules

Rasterized field pipeline: corridor mask → dilate (close gaps) → shore signed-distance → organic shore field (smoothed) → shore distance field.

The placement predicate table — this directly answers "which organics exist where":

| Query | Rule |
|---|---|
| Water | mask ≥ 0.48 |
| Blocked for props | wet OR shore distance < 4.2m |
| Grass blocked | wet OR shore in [0.45, 5.2]m (reed band) |
| Shore stone candidate | shore in [0.45, 5.2]m AND not water |
| Mud blend | 1 − smoothstep fade over shore 0.18→11m |

**Takeaway:** vegetation placement = f(shore-distance bands). Water blocks all; 0.45–5.2m = shore specialists; beyond = normal biome rules modulated by groundwater score.

### 1.5 Groundwater (Most Portable Piece)

```
sampleAquiferPotential(x, z, seed):
  broad = valueNoise(x/145 + 11.7, z/145 − 8.3, seed ^ 0x68bc21eb)      // 145m basins
  local = valueNoise((x + z×0.28)/58 − 17.1, (z − x×0.19)/58 + 23.4, seed ^ 0x02e5be93)  // 58m local
  seam  = 1 − |valueNoise((x − z×0.46)/92 + 4.6, (z + x×0.31)/92 − 12.8, seed ^ 0x7f4a7c15) × 2 − 1|  // 92m ridged veins
  return smoothstep(0.22, 0.78, broad×0.5 + local×0.32 + seam×0.18)

sampleWorldGroundwaterScore(x, z, seed, hydrology):
  wetness = clamp01(hydrology / 100)
  return clamp01((0.06 + aquifer×0.72) × (0.72 + wetness×0.56) + (wetness − 0.5)×0.18)
```

- Hash: `Math.imul` chain (0x9e3779b1, 0x85ebca77, 0x7feb352d, 0x846ca68b) — **integer math, bit-identical everywhere**. Port verbatim.
- Well yield: `base × (0.32 + 0.68×score)` — minimum 32% even when dry.
- Grade labels: ≥0.82 Excellent, ≥0.62 Good, ≥0.42 Fair, ≥0.22 Poor, else Dry.

---

## Part 2: Terrain Generation

### 2.1 The Master Entry

`sampleWorldRawTerrainHeight(x, z, settings, dimensions, layout)` — pure function. A singleton-backed wrapper also exists; reimplement against the pure form.

**Inputs:** (x, z) in meters, seed (u32 — top 12 bits = preset signature, bottom 20 bits = ~1M variations), topography slider (0–100 → relief 0.55–1.45), hydrology, mapSize, river layout (nullable).

### 2.2 Noise Primitives — Standardize on Integer Hashes

Three hash variants exist; the codebase was migrating from sin-hash (old) to integer-hash (new):

- **Portable (use these):** `hash2` and `hashF64` — `Math.imul` chains, bit-identical. `valueNoise` = bilinear interp of hash at integer corners with smootherstep easing. `fbm` = Σ valueNoise × 0.5^(i+1), normalized, minus 0.5 → (−0.5, +0.5). `ridgedFbm` = per-octave `1−|2n−1|`, squared, frequency multiplier 2.03 (not 2.0) → (0, 1).
- **Not portable (replace):** sin-based `hash(x,z) = fract(sin(x×127.1 + z×311.7) × 43758.5453123)`; direct `Math.sin`/`Math.cos` in terrain formulas.

### 2.3 Composition Order (Full Stack)

```
preset sampler (x, z, seed, relief)
  → river channel replacement / bank blend (needs RiverLayout)
  → valley & pit depressions subtracted
  → building platform raises added
  → mesh sampling (bilinear on baked grid)
```

**Generic stack:** relief-scaled fbm octaves (0.014 freq × 5.6 amp + 0.04 freq × 1.2 amp) + broad sin/cos waves (replace with noise) + gaussian basin depression + domain-warped macro drainage (warp coords ±48m, then valley/ridge/terrace fields) + edge-hill border mountains (smoothstep on max(|x|,|z|)) + alpine massifs when topography > 62.

**Key reusable patterns:**
- **Seed encoding:** preset signature in high 12 bits, variation in low 20 bits. Per-field XOR salts (`seed^0x4c31`, etc.), per-octave salts (`seed + octave×0x131`), seeded noise-domain offsets.
- **Elliptical influence fields:** `exp(−d²×k)` for localized features (alluvial fans, sinkhole bowls, ponds).
- **Domain-warped macro structure:** warp coordinates with low-freq fbm before sampling valley/ridge fields — creates coherent large-scale drainage that doesn't look tiled.
- **Coupled hydrology anchors:** spring/ponor positions derived from the SAME seeded basin frame (center + rotation from seed bits) as the terrain — water and landform share a coordinate frame, so they can't diverge. This is the architectural basis for "rivers tell us where organics live."
- **Hydraulic channel replacement:** inside 70% of channel half-width, replace terrain with monotone hydraulic datum; smoothstep blend back to natural outside. Guarantees flow direction.

### 2.4 Determinism Audit (Terrain)

| Element | Verdict |
|---|---|
| `hash2`, `hashF64` | ✅ Integer — bit-identical |
| sin-hash, direct sin/cos | ❌ Replace |
| `exp`, `pow`, `hypot`, `atan2` | ⚠️ Usually stable IEEE 754, not guaranteed — audit usage |
| Seed/bitwise ops, smoothstep, lerp, bilinear | ✅ Exact |
| State | ✅ Pure functions, no RNG state, no iteration-order dependence |

---

## Part 3: Organics — "Which Exist Where and Why"

### 3.1 The Placement Pipeline

```
seed + sliders
  → forest cores placed (seeded RNG)
  → forest density field (cores + noise + meadow breaks)
  → terrain accessibility (flood fill from founding meadow)
  → regional resource plan (budgets: which families, how many nodes)
  → territory targets (where on the map each node should go)
  → per-family site picking (habitat suitability scoring)
  → yields + seasonal regrowth (runtime)
```

**Placement is scoring + rejection sampling, not simulation.** Each organic type has hard habitat thresholds, a suitability score function, spacing constraints, and water/terrain clearance checks.

### 3.2 Forest Placement

- **Cores:** ~12–16 seeded elliptical cores (radii 60–128m, strength 0.78–1.22, per-core coniferBias 0.32–0.84). Minimum spacing, avoid central clearing. Design note: "fewer, broader cores produce distinct continuous woods with real meadow gaps."
- **Density field:** max over cores of elliptical falloff × strength + warped-fbm woodland/meadow mosaic + hill-edge woods + multi-scale canopy noise, saturated to [0,1].
- **Tree placement:** rejection sampling with Poisson-disc spacing. Core trees (density ≥ 0.18), hill-edge trees (≥ 0.22), saplings (≥ 0.42). Blocked by roads, buildings, water.
- **Habitat factors** (7 orthogonal axes): density (canopy closure), hillFactor (elevation/cold), dampRavine (moisture), lowerWarmth (temperature — valleys warmer), poorerGround (soil quality), plantedPatch, coniferBias.

### 3.3 Species Selection (Weighted Habitat Scoring)

13 species, each with base weight modified by habitat factors. The table encodes a Central European forest ecology — swap species and weights for your world's flora, keep the pattern:

- **Beech** (28): +damp×9 +warm×5 −cold×7 — moist valley broadleaf dominant
- **Silver fir** (24): +cold×12 +damp×9 — cold moist conifer
- **Norway spruce** (11): +cold×16 +planted×8 — cold slopes, plantations
- **Scots pine** (3.5): +poor×9 +dry×4 — poor dry soils, edges
- **Black pine** (2.6): +poor×7 +cold×4 — karst/ridges
- (+ 8 more: larch, sycamore maple, norway maple, ash, wych elm, lime, hornbeam, sessile oak)

Conifer bias multiplies conifer weights by lerp(0.76, 1.34, bias). Zone modifiers adjust for hill-edge vs sapling zones.

**Reusable pattern:** weighted species selection from orthogonal habitat axes (moisture × temperature × soil × light).

### 3.4 Foraging Placement (The Ecology Layer)

| Kind | Habitat rule | Ecological logic |
|---|---|---|
| **Mushrooms** | density ≥ 0.68 (deep interior), greedy best-score, ≥118m spacing | Damp shaded undisturbed forest floor |
| **Berries** | density in [0.28, 0.48] + edge-gradient scoring, stochastic acceptance (0.42 + score×0.5), ≥180m spacing | Ecotone species — want forest/meadow edge, not just the right band |
| **Game** | density ≥ 0.55, clear of water, ≥180m spacing | Cover without deepest interior |
| **Fish** | river points, max 58m from shore, needs 7m dry camp footprint | Tied to hydrology, not forest |

**The berry rule is the subtlest and most valuable:** it scores the density *gradient* to 4 neighbors at 18m — rewarding sharp forest/meadow transitions. Berries don't just want the right density band; they want the *edge*. Stochastic acceptance preserves natural variation instead of greedy clustering.

### 3.5 Regional Resource Planning

- **Budgets by map size:** small 5 / medium 20 / large 40 nodes; rich-node caps; min-food floors.
- **Food kind selection:** game always included (only winter food — the reliability anchor). Fish affinity ← hydrology slider; mushrooms ← forestDensity; berries ← mid-density (the ecotone preference again: `(100 − |forestDensity − 50|)/360`).
- **Geological allocation:** first 2 slots guarantee iron + salt; then stone, clay; rich-grade caps (max 1 rich clay, 1 rich fish per world).
- **Territory distribution:** balanced rounds, no territory starved; seeded sub-streams per subsystem (`deriveSubSeed`).
- **Terrain accessibility:** flood fill from founding meadow on 12m grid, max grade 0.45, max rise 48m — the generic "can settlers reach it" field.

### 3.6 Yields & Seasonality

Game year-round (winter anchor); berries/mushrooms spring–autumn; fish spring–autumn with spring regrowth. Visual counts use logarithmic compression of authoritative stock.

---

## Part 4: Roads & Settlement Layout

### 4.1 Critical Framing

**Roads in this engine are player-drawn, not procedurally generated.** There is no "grow road network from seed" algorithm. What exists is complete downstream infrastructure:

- **Graph model:** undirected planar graph (RoadNode {id, position, edgeIds, junctionType}, RoadEdge {id, nodes, controlPoints, sampledPath, width}).
- **Auto-junctions:** adding a path simplifies (0.85m), snaps endpoints within 5.4m, detects crossings via 2D segment intersection, auto-splits crossed edges into junction nodes. Junction classification by degree (≤1 endpoint, 2 bend, 3 T, 4 cross, 5+ complex).
- **Pathfinding:** Dijkstra with binary heap — deliberately NOT A*. Edge weight = pure polyline length; terrain cost pushed to build-time. BFS connected-components cached per topology (buildings on same component skip Dijkstra). All routes vetoed against open water.
- **Automatic bridges:** scan sampled path for contiguous wet runs via `isWaterAt` callback; runs <1.8m crossed at grade; longer runs get bridges (deck = peak water Y + 0.28m clearance, 3.2m flat approach, ≤9% grade ramps, 10–22m clamped). Pure functions, portable.
- **Building frontage:** roadside snap (project onto nearest edge within 24m, keep cursor's side, setback = roadHalfWidth + footprintDepth + 0.65m), yaw via atan2 toward road, elliptical smoothstep terrain pads.
- **Spatial index:** uniform 48m grid, int32-packed cell keys, AABB prefilter → exact SAT polygon overlap.

### 4.2 What's Missing (Must Be Built)

The procedural road-*layout* layer: arterial → lane hierarchy following terrain contours, and building *site selection* (frontage lot stamping). Suggested approach: seed → founding site → contour-following arterials via heightfield A* (cost = slope + water penalty) → lane subdivision → lot stamping using the snap/yaw/conflict machinery above.

### 4.3 Determinism Notes (Roads)

Graph ops, Dijkstra (with 1e-6 epsilon tie-breaks — should become lexicographic (cost, nodeId) for guaranteed agreement), BFS components, bridge detection all deterministic given ordered input. One red flag: `pseudoRandomYaw` uses sin-hash — replace with integer hash.

---

## Part 5: Cross-Cutting Determinism Audit

| Subsystem | Portable | Must fix in port |
|---|---|---|
| River topology (starts, tributaries, control jitter) | ✅ integer hashF64 | — |
| River meander geometry | ❌ Math.sin | Replace with hash-noise octaves along t, or bake once |
| Groundwater function | ✅ integer imul hash | Port verbatim |
| Organic shore jitter | ❌ sin-hash | Replace with integer hash |
| Terrain (newer presets) | ✅ hash2/hashF64 | — |
| Terrain (older/generic) | ❌ sin-hash + sin/cos waves | Replace with integer-hash noise |
| Forest/foraging placement structure | ✅ mulberry32, deriveSubSeed, fixed order | Replace underlying fBm hash |
| Roads (graph, Dijkstra, bridges) | ✅ deterministic | Lexicographic tie-breaks; fix pseudoRandomYaw |

**Port strategy (matches the bake philosophy):**
1. Generate world layout ONCE at bake time on a single platform; serialize polylines and fields.
2. Clients/servers consume baked geometry + evaluate only the portable analytic functions live (groundwater, habitat factors with integer hashes).
3. Replace all sin-hashes with integer hashes in the port — the codebase was already migrating that direction.

---

## Part 6: Reimplementation Roadmap (Living-Sim Environment Sim)

Ordered by dependency:

1. **Groundwater** — port `sampleWorldGroundwaterScore` verbatim. Unblocks: wells, farm fertility, clay deposits, habitat moisture axis.
2. **Terrain core** — integer-hash noise primitives + generic fbm stack + composition order. Unblocks everything spatial.
3. **River corridors** — port corridor generator (sin→hash-noise meander), bake + serialize. Unblocks: carving, shore fields, water queries.
4. **Carving + shore fields** — valley depression cross-section, mask→dilate→signed-distance pipeline, shore-band placement rules.
5. **Habitat fields** — 7-factor sampling (moisture/warmth/soil/light from noise + groundwater + shore distance).
6. **Organics placement** — layered suitability: cores → density → species scoring → foraging rules → regional budgets.
7. **Road layout (new)** — contour-following arterials via heightfield A*, then reuse bridge/frontage/conflict machinery.
8. **Validation gates** — connectivity (no isolated regions), water flow (monotone downstream), carrying-capacity sanity.

---

## Source File Index

| File | Role | Port |
|---|---|---|
| `rivers/riverHash.ts` | Integer hash | ✅ verbatim |
| `rivers/RiverLayout.ts` | Corridor gen, sampling, carving, serialization | ✅ core — swap sin meander |
| `rivers/RiverField.ts` | Mask rasterization, shore fields, placement queries | ✅ core — strip THREE |
| `rivers/organicShoreField.ts` | Signed distance, smoothing, dilation | ✅ — swap sin hash |
| `rivers/RiverWaterLevel.ts` | Column depth, water surface | ✅ verbatim |
| `hydrology/sampleAuthoritativeHydrology.ts` | Groundwater function | ✅ verbatim — most portable |
| `hydrology/sampleHydrology.ts` | Grade labels, well yield | ✅ verbatim |
| `terrain/TerrainHeight.ts` | Generic heightfield stack | ✅ — swap sin hash/waves |
| `terrain/LicPoljeTerrainField.ts` | Structured basin preset (pattern reference) | ✅ pattern — own constants |
| `terrain/RegionalFlatlandTerrainField.ts` | Meadow preset (pattern reference) | ✅ pattern |
| `world/worldTerrainPresets.ts` | Seed encoding, preset dispatch | ✅ pattern |
| `forestry/forestry.ts` | Forest cores, density, species scoring | ✅ — swap noise hash, own species |
| `foraging/ForagingLayout.ts` | Berry/mushroom/game/fish placement | ✅ — own constants |
| `foraging/foragingYields.ts`, `foragingSeason.ts` | Yields, seasonality | ✅ pattern |
| `world/regionalResourceDistribution.ts` | Budgets, food selection, geology | ✅ pattern |
| `world/resourceTerrainAccessibility.ts` | Flood-fill reachability | ✅ verbatim pattern |
| `roads/RoadNetwork.ts` | Graph, junctions, crossing resolution | ✅ reusable infra |
| `roads/RoadPathfinder.ts` | Dijkstra + component cache | ✅ — lexicographic ties |
| `roads/RiverBridgeSpans.ts` | Auto bridge detection + ramps | ✅ verbatim constants |
| `buildings/BuildingTerrainLayout.ts` | Frontage snap, yaw, pads | ✅ reusable |
| `placement/placementSpatialIndex.ts` | 48m grid index | ✅ reusable |
| `rivers/WaterBaseline.ts` (812 lines) | WebGPU water shader | ❌ render-only, skip |
| `rivers/WaterHydraulics.ts` | Rock deflection | ❌ render-only, skip |
| `src/generated/*` | SpacetimeDB bindings | ❌ backend-specific, skip |

*Detailed per-subsystem references with full formulas were extracted to /tmp/selo-{rivers,terrain,organics,roads}.md during this session.*
