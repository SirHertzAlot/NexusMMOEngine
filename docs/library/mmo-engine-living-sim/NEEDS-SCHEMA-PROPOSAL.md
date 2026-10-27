# Needs Schema Proposal — Data Definitions

**Status:** Proposal, 2026-10-19. Not reviewed, not implemented.
**Scope:** data definitions only. No behavior scripting, no tick-loop logic, no decider design, no vendored code.
**Parents:** `NEEDS-WFC-THINKING-SPEC.md` (the draft — this proposal adopts its Part A shapes and does not contradict it), `DECISION-SUBSTRATE-SPEC.md` (the seam this sits behind), `SCRIPTING-LAYER-SPEC.md` (§4 `defineNeed`/`defineSpecies` author these rows).
**Replaces:** the hardcoded `habitat.world` biome-weight tables in `packages/species/src/species.ts` (`BUILTIN_SPECIES`).

## 1. The core inversion, stated once

Species do not declare *where they live*. They declare *what they need*, as data rows. The world declares *what conditions hold* at each location, as fields. One generic function scores the match. A freshwater obligate never spawns in saltwater because the score is zero there — not because anyone wrote a rule about that species. New species = new data rows. Zero new code, zero species names in systems.

## 2. Two layers: definitions vs. instance state

The proposal has two layers, and they live in different places for a reason.

**Layer 1 — definitions (content rows, versioned, authored).** `NeedDef` rows (the need catalog) and `SpeciesNeeds` rows (per-species tunings). These live in content, carry provenance, and change without code deploys.

**Layer 2 — instance state (per entity, runtime).** The existing `Needs` component (`packages/engine-core/src/components.ts:92`) is a fixed SAB struct with two hardcoded meters (`hunger`, `thirst`). That component stays exactly as it is: it is the tick-hot survival fast path, and widening a SAB struct per need-id is the wrong shape. The generalized per-need intensity state lives beside it, outside the 30Hz tick:

```ts
interface NeedState {
  entityId: number;
  /** need id -> current level, 1 = fully satisfied ... 0 = empty */
  levels: Record<string, number>;
  updatedTick: number;
}
```

Need levels decay per `NeedDef.decayPerHour` and recover when the entity's location satisfies the need's requirements. Evaluation happens in batches on the sim/edge side (never the tick), consistent with the draft's cadence rules. The existing `hunger`/`thirst` meters remain the wire-planned survival pair; everything else rides `NeedState`.

## 3. NeedDef — the need catalog (field list)

One row per need profile. Profiles are specific: a cold-band thermal profile and a temperate thermal profile are *different rows* (`need:thermal.arctic` vs `need:thermal.temperate`), because species may only tune weight and tolerance — never the anchors themselves (draft §A1 rule).

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | Stable id, e.g. `"need:hydration.fresh"`. Lowercase, dot-namespaced. |
| 2 | `schemaVersion` | integer | Row format version. Unknown versions are rejected loudly, never guessed. |
| 3 | `category` | enum | `"water" \| "food" \| "temperature" \| "shelter" \| "social" \| "custom"` |
| 4 | `decayPerHour` | number 0..1 | How fast `level` drains per sim-hour when the need is unsatisfied. Data, not code. |
| 5 | `thresholds` | `{ uneasy, urgent, critical }` | Level bands (each 0..1, strictly decreasing). Crossing below a band raises urgency. Intensity = `1 - level`. (Draft used a 4-tuple; named bands, same semantics.) |
| 6 | `conditionFields` | string[] | Which environment condition fields this need reads (see §6). |
| 7 | `requirement` | array of `{ field, anchors, hardBounds? }` | `anchors`: piecewise-linear `[fieldValue, satisfaction]` points mapping a field reading to 0..1 satisfaction. `hardBounds`: `[min, max]` — a reading outside the range forces suitability to 0 (hard exclusion; the entity never spawns there). |
| 8 | `actions` | string[] | Action families this need can fan out to for the thinking layer, in priority order, e.g. `["drink", "seek-water", "migrate"]`. These become candidates behind the decision-substrate seam — this schema does not define the actions. |
| 9 | `provenance` | `{ script, author }` | Which script/author produced the row. Every row carries it (draft invariant 8). |

## 4. SpeciesNeeds — the species declaration (field list)

One row per species. It tunes needs; it never describes habitat.

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `speciesId` | string | Stable id, e.g. `"mire-newt"`. Lowercase id format, same as the species roster. |
| 2 | `schemaVersion` | integer | Row format version, rejected-if-unknown like above. |
| 3 | `needs` | `Record<needId, { weight, tolerance }>` | `weight` (≥0): how strongly this need pulls the suitability product — the specialist's key need gets the big weight. `tolerance` (0..1): how far below peak suitability the entity accepts before the thinking layer starts generating `migrate` actions. Species tune *only* these two numbers. |
| 4 | `variantAxes` | string[] | Constraint axes for the WFC variant generator (draft §A5), e.g. `["biome", "size"]`. |
| 5 | `provenance` | `{ script, author }` | As above. |

What is deliberately absent: biome affinity maps, habitat tables, per-species placement rules. Those are exactly what the suitability function replaces.

## 5. Suitability — signatures only

```ts
// The one generic function. No per-species branches.
// Returns 0..1. Returns 0 on any hard exclusion: the species never spawns there.
function suitability(
  species: SpeciesNeeds,
  pos: Vec2,
  fields: ConditionFields,
): number;

// Derived by sampling, not analytic: condition fields are arbitrary functions,
// so the gradient is measured (sample nearby cells, weight by delta-suitability),
// exactly as the draft's migration section describes. Drives displacement recovery.
function suitabilityGradient(
  species: SpeciesNeeds,
  pos: Vec2,
  fields: ConditionFields,
  sampleRadius: number,
): { dx: number; dz: number; gain: number };

// Maps a need's current level to urgency for the decider's state digest
// ("Needs vector", substrate spec §4 — quantized, fixed vocabulary, never prose).
function needIntensity(need: NeedDef, level: number): number; // 0..1
```

Semantics (adopted verbatim from the draft §A3, not redefined): per need, take the max satisfaction across its requirements; any `hardBounds` violation returns 0 immediately; multiply `needSat ^ weight` across needs. Placement samples or WFC-places entities weighted by the result; carrying capacity consumes it as the capacity field (draft §A6).

## 6. Condition field contract — what the world must supply

The habitat systems supply these fields at any queried location. Ranges are part of the contract; a field outside its range is a bug in the supplier, not the schema.

| # | Field | Range | Meaning | Supplied by |
|---|---|---|---|---|
| 1 | `water.fresh` | 0..1 | Fresh water availability at the location | hydrology / water maps |
| 2 | `water.salinity` | 0..1 | 0 = fresh, 1 = seawater — the freshwater-obligate axis | water classification |
| 3 | `water.shoreDist` | signed meters | Distance to nearest shoreline; negative = submerged. The 0.45–5.2 m band is the shore-specialist zone (draft §A2). | river/ocean classification |
| 4 | `temperature` | 0..1 | 0 = polar … 1 = volcanic — the arctic-exclusion axis | biome/climate field |
| 5 | `aridity` | 0..1 | Dryness — the desert-exclusion axis | moisture inverse + biome |
| 6 | `moisture` | 0..1 | Groundwater-derived dampness | groundwater function |
| 7 | `forest.density` | 0..1 | Canopy cover | organic layer |
| 8 | `forest.edgeGradient` | 0..1 | How much this spot *is* a forest edge (edge species want the edge itself, not just the right density) | organic layer |
| 9 | `soil.fertility` | 0..1 | Ground productivity for forage/farming | groundwater-derived |
| 10 | `forage.abundance` | 0..1 | Derived: how much edible matter is here, as judged by the habitat systems | habitat systems |

## 7. Worked example 1 — freshwater obligate ("mire-newt")

Need definitions (content rows):

```ts
{
  id: "need:hydration.fresh", schemaVersion: 1, category: "water",
  decayPerHour: 0.08,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["water.fresh", "water.salinity"],
  requirement: [
    // Salt kills the score outright: hard exclusion, not a gentle slope.
    { field: "water.salinity", anchors: [[0, 1], [0.05, 0.9], [0.2, 0.2], [1, 0]], hardBounds: [0, 0.05] },
    { field: "water.fresh",    anchors: [[0, 0], [0.3, 0.5], [0.7, 1]] },
  ],
  actions: ["drink", "seek-water", "migrate"],
  provenance: { script: "needs/water.scm", author: "design" },
},
{
  id: "need:forage.shallows", schemaVersion: 1, category: "food",
  decayPerHour: 0.05,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["water.fresh", "water.shoreDist"],
  requirement: [
    // Aquatic invertebrates: needs fresh water, prefers the shallows.
    { field: "water.fresh",     anchors: [[0, 0], [0.4, 0.6], [0.8, 1]] },
    { field: "water.shoreDist", anchors: [[-8, 0.3], [-2, 1], [0.5, 0.8], [6, 0.1]] },
  ],
  actions: ["forage", "migrate"],
  provenance: { script: "needs/water.scm", author: "design" },
},
{
  id: "need:thermal.temperate", schemaVersion: 1, category: "temperature",
  decayPerHour: 0.03,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["temperature"],
  requirement: [
    { field: "temperature", anchors: [[0, 0], [0.2, 0.4], [0.45, 1], [0.7, 0.6], [1, 0]], hardBounds: [0.05, 0.95] },
  ],
  actions: ["seek-shade", "seek-warmth", "migrate"],
  provenance: { script: "needs/thermal.scm", author: "design" },
},
```

Species row:

```ts
{
  speciesId: "mire-newt", schemaVersion: 1,
  needs: {
    "need:hydration.fresh":  { weight: 3.0, tolerance: 0.15 },  // the specialist's key need
    "need:forage.shallows":  { weight: 1.5, tolerance: 0.30 },
    "need:thermal.temperate":{ weight: 1.0, tolerance: 0.45 },
  },
  variantAxes: ["biome", "size"],
  provenance: { script: "species/wetlands.scm", author: "design" },
}
```

Why it works with no per-species rules: in the ocean, `water.salinity` ≈ 1 violates the `[0, 0.05]` hard bound → `suitability` returns 0 → the newt never spawns there. In desert, `water.fresh` ≈ 0 → satisfaction ≈ 0 → effectively excluded. Nobody wrote a desert rule or an ocean rule. The exclusion is a property of the need definition, reusable by every freshwater species that references it.

## 8. Worked example 2 — arctic species ("tundra-yak")

Need definitions (content rows; note the *separate* thermal profile row — species tune weights, never anchors):

```ts
{
  id: "need:thermal.arctic", schemaVersion: 1, category: "temperature",
  decayPerHour: 0.04,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["temperature"],
  requirement: [
    // Peaks in the cold band; heat is a hard exclusion.
    { field: "temperature", anchors: [[0, 1], [0.15, 1], [0.3, 0.4], [0.5, 0]], hardBounds: [0, 0.4] },
  ],
  actions: ["seek-cold", "migrate"],
  provenance: { script: "needs/thermal.scm", author: "design" },
},
{
  id: "need:forage.lichen", schemaVersion: 1, category: "food",
  decayPerHour: 0.04,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["soil.fertility", "temperature", "forest.density"],
  requirement: [
    // Lichen grows on poor soil; needs the cold; not under closed canopy.
    { field: "soil.fertility",  anchors: [[0, 1], [0.3, 0.8], [0.7, 0.3], [1, 0.1]] },
    { field: "temperature",     anchors: [[0, 1], [0.3, 0.7], [0.6, 0]], hardBounds: [0, 0.55] },
    { field: "forest.density",  anchors: [[0, 1], [0.4, 0.5], [0.8, 0.1]] },
  ],
  actions: ["forage", "migrate"],
  provenance: { script: "needs/forage.scm", author: "design" },
},
{
  id: "need:rest.shelter", schemaVersion: 1, category: "shelter",
  decayPerHour: 0.03,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["forest.density", "water.shoreDist"],
  requirement: [
    { field: "forest.density", anchors: [[0, 0.2], [0.3, 1], [0.8, 0.8]] },
  ],
  actions: ["rest", "seek-shelter"],
  provenance: { script: "needs/shelter.scm", author: "design" },
},
```

Species row:

```ts
{
  speciesId: "tundra-yak", schemaVersion: 1,
  needs: {
    "need:thermal.arctic":   { weight: 3.0, tolerance: 0.20 },
    "need:forage.lichen":    { weight: 1.5, tolerance: 0.35 },
    "need:hydration.fresh":  { weight: 1.0, tolerance: 0.40 },  // snowmelt; reuses the §7 row
    "need:rest.shelter":     { weight: 0.8, tolerance: 0.50 },
  },
  variantAxes: ["biome"],
  provenance: { script: "species/tundra.scm", author: "design" },
}
```

Why it works: anywhere `temperature` > 0.4, the hard bound fires → suitability 0. The yak is the *only* thing with high suitability in the deep-cold band, so it is "there because it is its habitat of choice" (draft §A3) — expressed entirely as data. The two examples share the `need:hydration.fresh` row unchanged: need definitions are reusable across species, which is the whole point of the catalog.

## 9. The decision-substrate seam (what the decider consumes)

This schema stops where the substrate starts. The handoff points, in the substrate's own terms (`DECISION-SUBSTRATE-SPEC.md`):

- **Candidates:** needs whose intensity has crossed their `uneasy` band fan out to their `actions` list. Those action families become the candidates for `behavior.goal-select.v1` (choice) and `behavior.action-score.v1` (score). The schema defines *which* actions a need can produce; it never scores or picks one.
- **Needs vector:** the substrate's state digest (§4) takes a quantized needs vector (hunger, rest, safety, social, purpose — fixed vocabulary). `needIntensity` (§5) is the function that produces those quantized values from `NeedState.levels`. The digest format itself is the substrate's contract, not this document's.
- **No decider design here.** The stub decider (substrate §8) and any future model adapter consume candidates and intensities through the frozen `DecisionRequest`/`DecisionResponse` interface. This schema is compatible with either and implements neither.

## 10. What this replaces in `species.ts` (migration map)

`packages/species/src/species.ts` today (`BUILTIN_SPECIES`, line ~81): every species carries a hardcoded `habitat.world` biome-weight map — the exact species→habitat table this schema eliminates — plus a `sustenance` array that is already a proto-needs list.

| Current field | Fate under this schema |
|---|---|
| `sustenance: ["food","water","rest",…]` | Migrates 1:1 to need ids (`need:forage.*`, `need:hydration.fresh`, `need:rest.shelter`; undead `necromancy`/`lifeforce`/`emotion` become `need:essence.*` rows, dungeon-scoped). The array was always needs wearing a different name. |
| `habitat.world` biome weights | **Deleted.** Replaced by `suitability` over the species' needs. This is the core deletion. |
| `habitat.dungeon.themes`, `drawnTo` | Retained. Dungeon room-archetype attraction is a separate placement concern, out of scope for this schema. |
| `pack`, `tier`, `boss`, `minRank`, `body`, `kind`, `tags`, `name` | Retained. Not habitat; not touched. |
| `BUILTIN_SPECIES` (the hardcoded roster) | Moves to content JSON via `loadSpecies`. The engine ships zero species rows (sample pack only, clearly marked) — the schema itself contains no species entries by construction. |

## 11. Data-level invariants (testable, no behavior)

1. **No per-species code.** Adding a species or need is a data row. A test asserts the systems directories contain zero species-name string literals (draft invariant 1).
2. **Exclusion is absolute.** `suitability == 0` ⇒ seeded long-run placement never puts that species in the excluded region (draft invariant 2).
3. **Rows are versioned and attributed.** Every row carries `schemaVersion` and `provenance`; unknown versions are rejected, never guessed (draft invariant 8, substrate §4 discipline).
4. **The schema contains no species entries.** A test asserts the schema definition files reference no species ids — species live only in content rows.

## 12. Open questions (for Joey)

- Intensity curve shape: the draft asks whether piecewise anchors are overkill for v1 vs simpler linear/exponential decay. This proposal keeps the draft's anchors; the question stands.
- Whether `tolerance` should also scale the migration *urgency* (not just the trigger point) — currently it is trigger-only.
- Cadence for `NeedState` re-evaluation per sentience tier (draft proposes instinct 1Hz / social 0.2Hz / strategic on-demand; unchanged here).

## 13. Implementation notes (2026-10-19, branch `arlo/needs-schema`)

Implemented as specified, TDD, all green. Files:

- `packages/species/src/needs.ts` — `NeedDef` (9 fields), `SpeciesNeeds` (5 fields), `NeedState` (3 fields), `NeedCatalog`, `ConditionFields`, the 10-field `CONDITION_FIELDS` contract, `assertConditionFields`, `NEEDS_SCHEMA_VERSION = 1`. Unknown versions rejected loudly via Zod refine, never guessed.
- `packages/species/src/suitability.ts` — pure, off-tick: `sampleAnchors`, `suitability`, `suitabilityGradient`, `needIntensity` (1 − level, 3-decimal quantized), `candidateActions` (uneasy-band fan-out for the substrate seam), `wantsToMigrate` (tolerance trigger-only).
- `packages/species/src/need-state.ts` — `NeedStateStore` interface + `MapNeedStateStore`, `updateNeedLevels` (decay per `decayPerHour`, refill where satisfied), `NeedBatchRunner` with `NEED_EVAL_CADENCE_HZ = { instinct: 1, social: 0.2, strategic: 0 }`. The stub decider was not touched.
- `content/species/needs.json` — 13 need rows (the §7/§8 rows verbatim, plus `thermal.cool`, `thermal.warm`, `forage.general`, and `essence.*` for the dungeon-scoped).
- `content/species/species.json` — the 19 species as data rows with `needs` declarations; `habitat.world` biome tables deleted per the migration map; dungeon fields, sustenance, pack/tier/boss/minRank/drawnTo/body retained.
- `content/species/README.md` — marks the directory as the sample pack.
- `packages/species/src/species.ts` — `BUILTIN_SPECIES` deleted; `loadSpecies(file?, catalog?)` reads the sample pack from `content/species` (`MMO_SPECIES_DIR` override), merges a game's file over it by id, and checks every problem (pack/tier, demons, `needs.speciesId` key match, unknown need ids when a catalog is passed); `loadSpeciesPack(dir)` returns the validated roster + catalog unit. `worldSpawnTable`/`pickWorldPack` kept as the legacy path for games that still author `habitat.world`.
- Consumers updated: `engine-core/species-roster.ts` (no-file fallback is now the sample pack), `apps/editor` gameplay-host + content-catalog (the `SpeciesModule` interface lost `BUILTIN_SPECIES`; the "shipped" baseline is `loadSpecies()`).

Decisions (all reversible):

1. **Piecewise anchor intensity curves kept** (proposal default; open question 1).
2. **Tolerance is trigger-only for migration urgency** (open question 2): `wantsToMigrate` fires when `suitability < 1 − max(tolerances)`; tolerance does not scale urgency beyond the trigger.
3. **Cadence per the draft** (open question 3): instinct 1 Hz, social 0.2 Hz, strategic on-demand (`NeedBatchRunner` skips strategic unless forced).

Deviations and clarifications:

- `suitability` takes the catalog as an explicit first argument (no global registry) so it stays pure and testable.
- `suitabilityGradient` takes a `fieldsAt` sampler rather than a single `fields` snapshot: the gradient must sample nearby cells, which one snapshot cannot do.
- Essence anchors are `[[0,0],[0.01,1],[1,1]]`: zero ambient essence means the need is unmet. (A `[[0,1],…]` shape would wrongly satisfy a dungeon-scoped need on a `dungeon.essence: 0` reading.)
- `habitat.world` stays in the schema as an optional legacy field so existing game files keep parsing; the sample pack carries none.
- A requirement reading a field the supplier does not provide contributes 0 satisfaction — this is how dungeon-scoped needs score 0 in the open world while staying satisfiable once dungeon systems supply `dungeon.essence`.
- Semantic note (no change): under max-across-requirements, a salt-free desert scores the freshwater *aspect* of `need:hydration.fresh` as satisfied (no salt); the mire-newt's desert exclusion comes from the product across needs (≈0.009 total, effectively excluded) while the ocean is the hard 0 via `hardBounds`. If min/product semantics are ever wanted, that is a design change, not a bug fix.
- Game-file removal semantics are unchanged (merge over the sample pack by id): fully replacing the pack is the queued engine/game extraction, not this task.
