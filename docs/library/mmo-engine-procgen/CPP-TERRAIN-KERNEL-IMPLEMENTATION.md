# C++ Terrain Kernel — Implementation Plan & JS Baker Comparison

**Status:** analysis (2026-10-19). **Read-only research — no repo code was changed.**

This document **supersedes and extends** `CPP-TERRAIN-KERNEL-PLAN.md` (2026-10-11),
which is left untouched per the append-only research rule. Where this document
disagrees with the plan, this document wins — the disagreements are marked
**CORRECTION** and grounded in what the code actually does today.

**One-line summary:** Phase 1 (noise) is done and verified. Everything after it needs
a re-scoped plan, because the JS baker is far more complete than the plan assumed —
erosion, hydrology, and droplet weathering already exist in JS — and because the
plan's per-chunk ABI cannot host global bake stages like erosion. The honest shape
is: **C++ owns heightfield math behind a grid-level API; JS keeps orchestrating the
survey.** Several stages have no honest case for C++ at all.

---

## PART 1 — The implementation plan (phases after done Phase 1)

### Phase 1 — DONE (verified 2026-10-19)

FastNoise2 behind the narrow `ChunkDataSource` ABI
(`packages/engine-core/src/procgen/chunk-source.ts`), implemented in
`packages/addons/procgen/src/procgen.cc` (N-API `generateChunk`). 11/11
deterministic tests green; rerun-identical fingerprints across separate processes.
Nothing to do here.

### The architectural correction (read before the phases)

**CORRECTION to the plan:** the plan's Phase 3 says erosion runs "as a bake-time
pass inside `generateChunk`" — a pure function of `(seed, cx, cz, lod)` producing
one 16×16 tile. That is not implementable as stated. Erosion is inherently global:
droplet paths cross chunk borders, depression-filling and drainage need the whole
grid, rivers are computed from accumulated upstream flow. You cannot correctly erode
one tile in isolation; the current JS does erosion on the whole coarse grid once
(`terrain/erosion.ts`, called from `terrain/survey.ts`) and derives tiles afterwards.

The kernel therefore needs a **two-level API**, and every phase below is scoped
against it:

1. **Grid-level bake (new):** `bakeHeightfield(params, grid) → { height, flow }`.
   World-scale, runs once per bake (or per region-regen). This is where tectonics,
   erosion, and any future heightfield stage lives.
2. **Per-chunk sampling (done):** the existing `generateChunk(seed, cx, cz, lod)`.
   This serves the legacy live-regeneration path and LOD>0 fallback
   (`makeTileChunkSource` in `chunk-source.ts` always routes LOD>0 to the
   fallback). It stays exactly as it is.

Consequence: the C++ kernel never replaces the survey. The survey
(`terrain/survey.ts`) stays the JS orchestrator — climate, biomes, glaciers,
water maps, spawn selection — and calls into the kernel for heightfield math.

### Phase 2 — Grid-level kernel API (prerequisite for everything below)

**Scope:** Define and implement the C++ world-scale bake interface. No terrain
algorithms yet — just the API, the memory contract, and the determinism harness
it will be tested against.

- **Inputs:** a parameter block (world seed, grid dimensions, cell size, sea
  level, stage parameters), plus an input heightfield (initially noise).
- **Outputs:** eroded heightfield (`Float32Array`, metres) and flow accumulation
  (`Float32Array`, rain-weighted upstream area) — the JS side needs the flow
  field to derive lakes/rivers/water maps without re-running drainage itself.
- **Interface shape:** N-API addon mirroring the existing `packages/addons/procgen`
  pattern (`binding.gyp`, no C++ exceptions across the boundary); wasm32 build
  from day one as the reference both builds are checked against.
- **Acceptance criteria:** a no-op stage (input → output identity) round-trips a
  512×512 grid through N-API and wasm32 with byte-identical output; invalid
  inputs throw JS exceptions, never crash; the JS survey can call it and get
  back a usable grid.
- **Done looks like:** `packages/addons/terrain-kernel/` (or extension of the
  existing addon — decision documented) with the grid API, determinism tests
  green on Linux, and the wasm32 reference building in CI.

### Phase 3 — Tectonics macro stage (new capability)

**Scope:** The one phase with no JS equivalent. Today ranges are placed by wind
(`placeRanges` in `terrain/landmass.ts`, 409 lines) — authored, not simulated.
This phase adds real plate tectonics: Voronoi plates + velocity field →
divergence/curl → uplift and strain fields that condition the base heightfield,
so mountain ranges form where plates converge and rift valleys where they split.

- **Inputs:** world seed, plate count / size parameters, grid.
- **Outputs:** uplift field (metres) and strain field (0..1), consumed as
  conditioning inputs to the noise stage.
- **Acceptance criteria:** convergent boundaries produce continuous ranges
  (measured: ridge continuity metric on the output field); divergent boundaries
  produce rift signatures; same seed → byte-identical fields across platforms;
  golden tests against recorded outputs.
- **Done looks like:** the kernel can produce a tectonically-conditioned
  heightfield end-to-end (tectonics → noise → grid API), and the survey can
  substitute it for `rangeUplift` behind a flag.
- **Honest flag:** this could prototype in JS first (it's bake-time, brand-new,
  and iteration speed matters more than bake speed for a v1). Starting in C++
  is a choice, not a necessity — the plan should record which was chosen and why.
  The Guy-Shalev technique is cited MIT in the plan; re-verify the license at
  port time, don't trust the citation.

### Phase 4 — Erosion port (thermal / fluvial / droplet)

**Scope:** Port the three existing, tuned JS operators to C++ on the grid-level
API: `thermalErosion`, `fluvialErosion`, `dropletErosion` (all in
`terrain/erosion.ts`, 234 lines), plus the multi-scale schedule (erode →
upsample → erode). The kernel must carry its own depression-filling and drainage
internally (it cannot call back into JS per cell) and return the flow
accumulation alongside the heightfield.

- **Inputs:** heightfield grid, climate fields the operators need (rain share,
  sea level), iteration budgets from the world spec (today: 30 thermal passes,
  12 fluvial passes, 150,000 droplets at 0.35 strength —
  `packages/engine-core/worlds/default.world.json`).
- **Outputs:** eroded heightfield + flow accumulation, byte-identical-or-better
  vs the JS reference on fixed seeds.
- **The droplet decision:** the JS `dropletErosion` is already a tuned
  Hans Theobald Beyer implementation (per-droplet step cap, brush smoothing,
  sea-deposit deltas). SimpleHydrology's droplet operator is license-cleared for
  a direct port (MIT — take code only from the GitHub repo, credit weigert and
  Nick McDonald), but it would be a *second* implementation to tune to this
  engine's look. **Recommendation:** port the existing JS algorithm first
  (behavioral parity is the acceptance bar); keep SimpleHydrology as the
  reference for the port, not a replacement to re-tune.
- **Acceptance criteria:** on fixed seeds, C++ output matches the JS reference
  to the bit (both use integer ops and fixed iteration counts — no tolerance
  fudge); bake-time speedup measured and recorded (target: order-of-magnitude
  on the droplet stage, the dominant cost); the survey can swap the JS
  operators for the kernel behind a flag with no other changes.
- **Done looks like:** `surveyWorld` runs its erosion step through the kernel
  with identical survey stats (`erodedMeanM`, `deepestCutM` in the bake report).

### Phase 5 — Selo composition (gated on a definition spike)

**Scope:** UNKNOWN — and that is the point of this phase's first step. The plan
names "Selo composition (ported techniques: hydraulic carving, river corridors,
groundwater fields)" but the engine's generator was already extracted from Selo
into the JS design; there is no crisp delta between "Selo techniques" and what
`terrain/` already does.

- **Step 1 (spike, JS):** write the delta document — what, precisely, does the
  kernel add that `landmass.ts` / `hydrology.ts` / `erosion.ts` don't already do?
  If the answer is "nothing structural," this phase is cancelled and its budget
  returns to Phase 4 hardening.
- **Step 2 (only if the spike finds a delta):** port the delta onto the
  grid-level API with the same acceptance bar as Phase 4.
- **Done looks like:** either a ported, tested delta — or a written decision
  that the phase was unnecessary. Both are legitimate outcomes.

### Phase 6 — wasm32 reference hardening and native fast path

**Scope:** Make the determinism story real end-to-end. Today the addon is
native-only (node-gyp); the wasm32 reference the plan promises does not exist.

- Build the kernel to wasm32; run the full phase 2–4 golden suite against it.
- Native (x86_64, ARM) must be bit-identical to the wasm32 reference on all
  golden cases. FastNoise2 SIMD determinism across x86/ARM is the known risk —
  the plan already flags the scalar fallback; exercise it here, don't defer it.
- **Acceptance criteria:** the determinism contract from the plan holds as a
  CI job, not a claim: same `(seed, params)` → byte-identical output on
  Linux/macOS/Windows/wasm32.
- **Done looks like:** the contract is enforced by CI, and the bake can run on
  any platform and produce the same `world.db` bytes.

### Explicit non-goals (stay JS under this plan, permanently)

- **Climate, biomes, glaciers, sun/UV** (`climate.ts`, `biomes.ts`,
  `glaciers.ts`, `sun.ts`): half the survey, zero coverage in the kernel plan,
  bake-time, cheap relative to erosion. No honest C++ case — see Part 2.
- **Hydrology water maps** (lakes, rivers, sea as gameplay data): the kernel
  returns flow accumulation; JS derives the maps. The survey keeps the
  authoritative water/biome/region maps.
- **Survey orchestration** (spawn selection, region labeling, catalog writing,
  `world-bake.ts`): I/O-bound, trivially cheap. No C++ case.
- **Chunk assembly / shared borders**: already done (addon seamless edges;
  `WorldHeights` bicubic + detail). Nothing to build.

---

## PART 2 — What the JS baker does today

### The pipeline (all paths from `packages/engine-core/src/`)

**Entry:** `bake-world.ts` — `npm run bake:world`. Reads the world spec
(`packages/engine-core/worlds/default.world.json`: 250×250 chunks, 8 m coarse
cells, seed 1234), then:

**Stage 1 — Survey** (`bakeWorldTerrain` → `surveyWorld(spec)` in
`terrain/survey.ts`, 382 lines). One coarse grid (~506×506 cells for the default
4 km world), built the way nature would, in order:

1. **Noise fields** — via `noiseField()`, which calls the **C++ addon**
   (`makeProcgenChunkSource` from `procgen/chunk-source.ts`) one 16×16 block at
   a time. Seeds derived per-field by `fieldSeed` (mulberry32 mixing). The
   addon is already load-bearing here.
2. **Landmass** (`terrain/landmass.ts`, 409 lines): coast frame (peninsula with
   noise-warped wandering coast), `baseElevation`, mountain ranges placed
   across the prevailing wind (`placeRanges`, seeded layout), `rangeUplift`,
   volcanoes (`placeVolcanoes` / `raiseVolcanoes`).
3. **Erosion** (`terrain/erosion.ts`, 234 lines): thermal collapse to talus
   angle (38°, 30 passes) → glaciers grind U-valleys (`terrain/glaciers.ts`,
   140 lines) → fluvial stream-power incision (12 passes, each re-running
   fill+drainage) → droplet weathering, Beyer method (150,000 droplets,
   seeded) → thermal again. Stats recorded: mean/max erosion, deepest river cut.
4. **Water** (`terrain/hydrology.ts`, 232 lines): sea mask, `fillDepressions`
   (priority-flood, Barnes/Lehman/Mulla 2014), `findLakes`, `accumulate` over
   `drainage`, `carveRivers`.
5. **Climate** (`terrain/climate.ts`, 131 lines; `terrain/sun.ts`, 147 lines):
   rainfall with rain shadows, temperature, sunlight-with-shadows, UV index.
   **Uses `Math.sin`/`Math.cos`** (`sun.ts:49-52`, `biomes.ts:266`,
   `landmass.ts:177-178`) — platform FP, see determinism below.
6. **Biomes** (`terrain/biomes.ts`, 278 lines): classification from all fields
   above, smoothing, connected regions, per-biome surface character → the
   `roughness` map.

**Stage 2 — Fine tiles** (`terrain/world-heights.ts`, 70 lines;
`WorldHeights implements ChunkDataSource`): per chunk, bicubic-upsampled survey
elevation + detail noise (**C++ addon again**) scaled by blended biome
roughness. 62,500 tiles for the default world, written in batches to `world.db`.

**Stage 3 — Storage & catalog** (`terrain/world-bake.ts`): 15 survey maps
(elevation, biome, region, moisture, rain, temperature, water, water_level, ice,
melt, sun, uv, flow, river, roughness) into `TerrainTileStore`; SurrealDB world
catalog; spawn-point selection; WFC formations; entities/scatter in the spawn
area; tick-0 snapshot.

**Runtime:** the server reads **stored tiles**
(`makeTileChunkSource(tiles, procgen)` in `bake-world.ts:139`) — the C++ addon
is the fallback for unbaked chunks and for **all LOD > 0**. The editor sculpts
tiles through `terrain-tool.ts` (572 lines: export/generate/import/map/
regenerate); `terrain/region-regen.ts` (147 lines) re-runs the JS survey for one
region and edge-blends it into stored neighbours.

**Determinism today:** the survey header states the contract plainly —
`terrain/survey.ts`: *"this only needs to be reproducible (same spec → same
bytes), not bit-identical across platforms."* The addon is bit-identical
(verified 11/11); the survey is not (Math.sin/cos in sun, biomes, landmass;
float32/float64 mixing). This is safe today because tiles are baked once,
stored, and never regenerated — the server reads `world.db`, not the generator.

### Overlap: what the JS baker already does that the C++ plan would redo

| Plan item | JS status (file) | Verdict |
|---|---|---|
| Noise primitive | C++ addon, load-bearing in survey + detail (`survey.ts` `noiseField`, `world-heights.ts`) | **Done — nothing to redo** |
| Droplet erosion | `dropletErosion`, Beyer method, tuned (step caps, brush) — `terrain/erosion.ts` | **Full overlap — port, don't reinvent** |
| Thermal erosion | `thermalErosion` — `terrain/erosion.ts` | **Full overlap — port** |
| Fluvial erosion | `fluvialErosion` (stream power) — `terrain/erosion.ts` | **Full overlap — port** |
| Depression fill / drainage / accumulation | `fillDepressions`, `drainage`, `accumulate` — `terrain/hydrology.ts` | **Full overlap — port (kernel needs its own copies)** |
| River carving | `carveRivers` — `terrain/hydrology.ts` | **Overlap — stays JS as a map-derivation step** |
| Mountain ranges | `placeRanges`/`rangeUplift` (wind-placed) — `terrain/landmass.ts` | **Different method — tectonics is new, not a port** |
| Selo composition | Techniques already extracted into the JS design | **No defined delta — Phase 5 spike or cancel** |
| Chunk assembly / shared borders | Addon seamless edges + `WorldHeights` bicubic | **Done — nothing to redo** |
| Climate / biomes / glaciers / sun | `climate.ts`, `biomes.ts`, `glaciers.ts`, `sun.ts` | **Not in the plan at all — stays JS** |

### Division: what stays JS vs moves to C++, and why

The standing rule — *"bake-time-only code can stay JS; only tick-hot code needs
C++"* — is the right default, and terrain baking is bake-time (the server reads
stored tiles; nothing here runs in the tick). So the C++ move needs justification
on other grounds. The honest justifications, per stage:

| Stage | Home | Why |
|---|---|---|
| Noise | **C++ (done)** | Already there; bit-identical; also serves the live LOD>0 path |
| Grid-level kernel API | **C++** | Prerequisite plumbing; no JS equivalent needed |
| Tectonics | **C++ (or JS prototype first)** | New capability; C++ justified by determinism of the new stage, not speed |
| Erosion (thermal/fluvial/droplet) | **C++** | **Bake speed** — 150k droplets + 30 thermal + 12 fluvial-with-refill passes dominate bake time; 10–50× headroom matters for bigger worlds and for the editor's interactive region-regen. **Determinism** — removes the Math.* platform variance from the heightfield |
| Kernel-internal drainage/fill | **C++** | The kernel can't call back into JS per cell; it needs its own copies |
| Water/biome/region *maps* | **JS** | Derivation from kernel outputs; cheap; no C++ case |
| Climate / biomes / glaciers / sun | **JS** | Half the survey, bake-time, cheap vs erosion, no cross-platform requirement (stored tiles). **No honest C++ case** |
| Survey orchestration / catalog / spawn | **JS** | I/O-bound. **No honest C++ case** |
| Selo composition | **Undecided** | No defined delta — spike first (Phase 5) |

**The single most important division decision:** the survey stays a JS
orchestrator; C++ owns heightfield math behind the grid-level API. The
per-chunk `generateChunk` ABI is for the legacy live path (done); the bake path
was never per-chunk and must not be forced into that shape.

### Stages with no honest case for C++

1. **Biome/climate/sun/UV classification** — pure functions over the survey
   grid, run once per bake, dwarfed by erosion cost, and their outputs are
   stored in `world.db`, so cross-platform variance never reaches gameplay.
2. **Survey orchestration** (spawn selection, region labeling, catalog,
   `world-bake.ts`) — I/O-bound; porting it would be architecture theater.
3. **Selo composition as currently sketched** — there is no defined delta vs.
   the existing JS; no case exists until the Phase 5 spike writes one.

### Determinism: today vs under the plan

- **Today:** addon bit-identical (11/11 green). Survey reproducible *per
  machine* (Math.sin/cos in `sun.ts`, `biomes.ts`, `landmass.ts`; f32/f64
  mixing) — explicitly accepted in the survey header because tiles are stored.
  Gameplay is unaffected: the server reads `world.db`. The real exposure is
  narrow: multi-machine bakes disagreeing, and editor region-regen (which
  re-runs the JS survey on the editor's machine) vs stored tiles — the
  edge-blending in `region-regen.ts` exists partly to absorb this.
- **Under the plan:** the heightfield stages become bit-identical everywhere
  (wasm32 reference, CI-enforced). **Caveat the plan must state:** if climate /
  biomes / sun stay JS with `Math.sin`, the *world* is still not bit-identical
  across platforms — only the heightfield is. That is a coherent, defensible
  scope ("deterministic heightfield; reproducible survey"), but it must be
  stated, not implied. Full-world bit-identity would require porting or
  integer-izing the remaining stages — currently unjustified (see above).

### Risks and open questions per phase

- **Phase 2 (grid API):** *Risk:* inventing a second, subtly different
  heightfield convention (units, sea level, edge margins — the survey uses a
  3-cell `MARGIN`). Mitigate by deriving the kernel's grid contract from
  `CoarseGrid` exactly. *Open:* extend the existing addon vs new
  `terrain-kernel` package — decide on build-time cost, not aesthetics.
- **Phase 3 (tectonics):** *Risk:* plates that look worse than the authored
  wind-placed ranges (the current ranges are design-tuned; simulation is not
  automatically prettier). Mitigate with a side-by-side bake comparison before
  the survey flag flips. *Open:* Guy-Shalev license re-verification at port
  time; tectonics resolution vs chunk streaming (the plan's own open question —
  answered by the grid API: macro fields are baked once, sampled per chunk).
- **Phase 4 (erosion):** *Risk:* behavioral drift — the JS droplet operator
  has engine-specific tuning (step caps, brush, delta-at-sea-mouth); a
  from-scratch SimpleHydrology port would need re-tuning. Mitigate by porting
  the JS algorithm first (parity), treating SimpleHydrology as reference.
  *Open:* iteration budgets are spec-driven today (`default.world.json`
  erosion block) — the kernel must accept budgets as parameters, not
  constants, or world-spec tuning breaks.
- **Phase 5 (Selo):** *Risk:* the whole phase. Mitigate with the spike-first
  gate; cancellation is a success state.
- **Phase 6 (wasm32):** *Risk:* FastNoise2 SIMD divergence x86↔ARM (plan
  flags it; the current native addon README already documents RELAXED FP).
  Mitigate with the scalar fallback path exercised in CI, not just documented.
- **Cross-cutting:** the plan's "on-demand 0x21 tile serving" open question is
  stale — 0x21 is trade/vendor/auction in the current protocol
  (`net/gateway.ts`); tiles come from `world.db`. Drop it. The "golden tests
  vs the current JS generator" line in the plan's Phase 1 is likewise moot —
  no JS noise generator exists; the addon was the original implementation.

---

## Recommended build order (smallest-first)

1. **Phase 2** — grid API + determinism harness (unblocks everything; no
   algorithms).
2. **Phase 4** — erosion port (biggest bake-time win; fully specified inputs).
3. **Phase 3** — tectonics (new capability; needs the API; consider a JS
   prototype first).
4. **Phase 6** — wasm32 hardening (fold into each phase's done criteria if
   cheap; standalone otherwise).
5. **Phase 5** — Selo spike (only if someone still wants it after 1–4).

*End. Research-only: no repo code was modified for this analysis. All file
paths are relative to `~/workspace/nexus-engine` unless stated.*
