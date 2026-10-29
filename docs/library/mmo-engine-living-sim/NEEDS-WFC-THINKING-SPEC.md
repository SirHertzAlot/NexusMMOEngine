# Needs-Driven Ecology + WFC Thinking — Design Spec

**Status:** Draft by Arlo, 2026-10-11. Not reviewed, not implemented.
**Parents:** `SELO-ALGORITHM-EXTRACTION.md` (environment condition fields), `SCRIPTING-LAYER-SPEC.md` (§4 `defineNeed`/`defineAction`/`defineVariant`, §14 invariants), `DECISION-SUBSTRATE-SPEC.md` (§8 stub decider, §7 async cadence), `LIVING-SIM-DEEP-DIVE.md` (§8.1 carrying capacity, §1.1 design north star).
**Scope:** Two systems sharing one philosophy — species and sentients are *data*, never hand-written per-case code. Part A covers where things live (ecology/placement). Part B covers what sentients do (the "thinking" layer).

---

## The core inversion

Selo hardcodes a species table: a human writes `beech: +damp×9` and every new species needs a new row. This spec inverts it:

- **Species declares needs** (data components).
- **Environment provides conditions** (fields).
- **One generic system matches them.** A freshwater obligate never spawns in saltwater or desert because the suitability score is zero there — not because anyone wrote a rule for that species.

New species = new data row. Zero new code. This is the ECS path: systems act on components autonomously.

---

## PART A — Needs-driven ecology (placement)

### A1. Needs component schema

```ts
interface NeedDef {
  id: string;                    // "need:hydration.fresh"
  category: "water" | "food" | "temperature" | "shelter" | "social" | "custom";
  // How fast the need depletes per sim-hour when unsatisfied (data, not code)
  decayPerHour: number;          // 0..1
  // Intensity curve: [satiated, uneasy, urgent, critical] thresholds
  thresholds: [number, number, number, number]; // each 0..1, strictly increasing
  // Which environment condition fields this need reads (see A2)
  conditionFields: string[];     // ["water.fresh", "water.salinity"]
  // How condition values map to satisfaction — scored, never hardcoded per species
  requirement: {
    field: string;
    // satisfaction = f(fieldValue); piecewise-linear over anchor points
    anchors: [value: number, satisfaction: number][];
    // hard exclusion: fieldValue outside [min,max] ⇒ suitability 0 (never spawns)
    hardBounds?: [number, number];
  }[];
  // Which action families this need can generate for the thinking layer (Part B)
  actions: string[];             // ["drink", "seek-water", "migrate"] in priority order
}

interface SpeciesNeeds {
  speciesId: string;
  // References to NeedDef ids; species only TUNES weights (scripting spec §4)
  needs: Record<string, { weight: number; tolerance: number }>;
  // Variant constraints for the WFC generator (A5)
  variantAxes: string[];         // ["biome", "aggressor-role"]
}
```

`defineNeed` / `defineSpecies` in the scripting layer author exactly these shapes (Scripting Spec §4). Systems never read scripts; they read validated rows.

### A2. Environment condition fields (the conditions side)

The substrate is Selo's habitat *fields*, extracted reimplementation-clean (`SELO-ALGORITHM-EXTRACTION.md`). Minimum field set:

| Field | Source | Notes |
|---|---|---|
| `moisture` | groundwater function | **Port verbatim** — pure integer-hashed f(x, z, seed), zero baked state |
| `water.shoreDist` | river corridors | 0.45–5.2 m = shore-specialist band; water itself blocks placement |
| `water.salinity` | river/ocean classification | fresh vs salt — the freshwater-obligate axis |
| `temperature` | biome field | arctic exclusion axis |
| `aridity` | moisture inverse + biome | desert exclusion axis |
| `forest.density` | organic layer | 0.28–0.48 + **edge gradient** (see below) |
| `forest.edgeGradient` | organic layer | berries want the *edge itself*, not just the right density |
| `soil.fertility` | groundwater-derived | farm placement, grazer forage |

Determinism note: river topology and groundwater are integer-hashed and portable; terrain noise/meander/shoreline jitter from Selo used sin-hashing and must be replaced with integer hashes (u32 goldens, per scatter-pipeline discipline) before any of this is trustworthy.

### A3. The suitability function

```ts
// One generic function. No per-species branches.
function suitability(species: SpeciesNeeds, pos: Vec2, fields: Fields): number {
  let s = 1;
  for (const [needId, tuning] of Object.entries(species.needs)) {
    const need = needRegistry.get(needId);
    let needSat = 0;
    for (const req of need.requirement) {
      const v = fields[req.field](pos);
      if (req.hardBounds && (v < req.hardBounds[0] || v > req.hardBounds[1]))
        return 0;                        // hard exclusion — never spawns here
      needSat = Math.max(needSat, sampleAnchors(req.anchors, v));
    }
    s *= Math.pow(needSat, tuning.weight);
  }
  return s; // 0..1
}
```

Worked examples (Joey's, 2026-10-11):

- **Freshwater obligate:** `need:hydration.fresh` has `hardBounds: [0, 0.05]` on `water.salinity`. In ocean or desert (no fresh field above threshold) suitability is 0 — it never spawns there, and no one wrote a desert rule.
- **Arid-intolerant creature:** temperature/aridity requirement anchors score 0 in arctic/desert bands → effectively excluded.
- **Arctic specialist:** requirement anchors peak in the cold band; it's the *only* thing with high suitability there — "there because it's their habitat of choice."

Placement = rejection-sampled or WFC-placed entities weighted by `suitability`. Selo's species table is replaced; Selo's *fields* are kept.

### A4. Migration (displacement → gradient home)

When an entity is displaced (teleport, herd push, unnatural forcing), no scripted "go home" behavior is needed:

1. Each tick-batch, sentient entities sample `suitability` at current position.
2. If below their `tolerance`, the thinking layer (Part B) generates `migrate` actions biased along the suitability gradient (sample N nearby cells, weight by Δsuitability).
3. Migration *emerges* from the gradient — the creature "tries to find its way back to a more inhabitable place" because the field, not a script, pulls it.

### A5. WFC variant generation (a thousand bats)

The bake-time WFC (already earmarked for settlement layout; Scripting Spec §167) gains a second job:

- **Input:** species archetype (e.g. `goblin`) × constraint set (biome fields at spawn region, aggressor-role).
- **Constraint propagation:** biome constraints eliminate infeasible traits (arctic ⇒ fur/insulation traits required, desert ⇒ heat traits); `prime-aggressor` status (apex in vicinity) biases toward larger frame, aggressive features.
- **Stochastic collapse:** yields the concrete variant — frost goblin vs dune goblin, 10 goblin types from one archetype the way there are 1000 bat types.

`defineVariant` provides explicit hand-tuned variants; the WFC generates implicit ones. Both land in the variant table. Deterministic given (archetype, constraints, seed) — golden-testable.

### A6. Carrying-capacity hookup

`LIVING-SIM-DEEP-DIVE` §8.1's population pipeline (survey → capacity → demand → job slots → households → individuals) consumes `suitability` as the capacity field: a region's carrying capacity for a species is the suitability-weighted area, not a hand-tuned number. Cities balance on needs, so populations don't crash from poor balance (Joey's directive, 2026-10-01).

---

## PART B — WFC thinking (sentient action selection)

### B1. The pipeline: needs → actions → collapse → thought

```
Needs (components, decaying)
  → fan out to candidate actions (data-driven mapping from defineNeed.actions
    + defineAction registry — NOT code)
  → constraint propagation ELIMINATES infeasible actions
  → probability weights = needIntensity × capacity × context
  → WFC collapse over the action space
  → the collapsed action is the entity's next "thought"
```

Thinking *is* repeated collapse. The wolf doesn't run a hunt script:

1. Hunger 0.82 (urgent) fans out `[forage, hunt-easy, hunt-hard, scavenge]`.
2. **Constraint propagation eliminates before scoring:** `hunt(golem)` — golem is inedible (edibility constraint) — never enters the distribution. `hunt(orc)` — risk exceeds the wolf's capacity (capacity constraint) — eliminated. `hunt(troll)` — same. What's left: `[hunt(rabbit), hunt(deer), forage(berries)]`.
3. Weights: hunger 0.82 × rabbit-ease 0.9 × proximity vs deer 0.5 → collapse yields `stalk(rabbit)` most runs, `forage(berries)` sometimes.
4. Next batch, hunger 0.31 (satiated): the need fans out weakly or not at all; the wolf's next thought is social/rest.

### B2. Why WFC instead of utility-max

Two reasons, both load-bearing:

1. **Elimination before scoring is cheaper and more correct.** "Can't eat rock" never enters the probability distribution — no zero-scores to compute, no edge cases where a zero slips through.
2. **Collapse is stochastic, so entities think believably, not optimally.** A wolf that always picks the mathematically perfect prey is a robot; one that usually picks well but sometimes fixates is an animal. (Design north star: emotional connection, §1.1.)

### B3. Capacity gating — the sentient rock

Sentience is a component:

```ts
interface Sentience {
  // which thinking cadence + action-space this entity gets; absent = no thinking
  tier: "none" | "instinct" | "social" | "strategic";
  capacity: { strength: number; risk: number; /* ... */ }; // what constraints check
}
```

The thinking system skips entities without it. A rock has no needs, runs no collapse, never thinks. No special cases — the pipeline is capacity-gated by construction. ("A sentient rock would most likely never eat" — correct, because it has no hunger need and no Sentience component.)

### B4. Cadence — never the tick

Like the decision substrate (§7): the thinking layer lives in the NPC edge microserver, async, batched. Tiered brains (FSM/utility → BT → GOAP-lite) consult the collapsed thought; the thinker never owns the tick. Anti-cheat telemetry replay discipline applies (Substrate Spec §12 pattern).

### B5. This IS the stub decider

`DECISION-SUBSTRATE-SPEC.md` §8 defines the deterministic stub that runs behind the seam until Ollama model licenses are verified. The needs→WFC pipeline is the first concrete implementation of that stub:

- Question pack `behavior.goal-select.v1` → candidates = collapsed action space.
- The narrow interface (`DecisionRequest`/`DecisionResponse`) is unchanged; the WFC thinker is one more implementation behind it, alongside the future Ollama adapter.
- If an LLM decider ever earns its place, it swaps in without touching needs components or the action data.

---

## PART C — Air-tight invariants (numbered, testable)

1. **No per-species code.** Adding a species, need, or action is a data row. A test asserts the systems directory contains zero species-name string literals.
2. **Exclusion is absolute.** If `suitability(species, pos) == 0`, long sim runs never place that species within the excluded region (statistical test over seeded runs).
3. **No tick execution.** The thinker has no import path to tick-hot code; asserted by dependency-direction test (same pattern as Scripting Spec §14).
4. **Deterministic collapse.** Same (needs state, capacities, seed) ⇒ byte-identical collapsed action. Golden tests.
5. **Elimination precedes scoring.** Constraint-violating actions are absent from the candidate set passed to weighting — asserted by instrumented test, not by inspecting weights.
6. **Capacity-gated.** Entities without `Sentience` never enter the pipeline; a 10k-entity soak with 9,999 rocks shows zero thinker invocations for them.
7. **Migration converges.** A displaced entity in a connected region reaches suitability ≥ its tolerance within N batches (bounded; N scales with region size).
8. **Round-trip provenance.** Every need/action/variant row carries the script + author that produced it (Scripting Spec invariant, extended here).

---

## PART D — Integration map

| Touches | How |
|---|---|
| Scripting layer | `defineNeed`/`defineAction`/`defineVariant` are the authoring surface; this spec is their runtime consumer. Scripting Spec §14 invariants (validation, provenance, tier monotonicity) apply unchanged. |
| Decision substrate | This pipeline implements the §8 stub decider behind the frozen interface. |
| WFC solver | One solver, three jobs: settlement layout, species variants (bake), action collapse (runtime batches). |
| Species package | Existing sustenance/habitat data migrates into `NeedDef` rows; `loadSpecies` keeps working (Scripting Spec §"packages/species"). |
| Carrying capacity (§8.1) | Consumes `suitability` as the capacity field. |
| Selo extraction | Supplies the condition-field substrate (groundwater verbatim; shore bands; edge-gradient organics rule). Its species *table* is replaced by Part A. |

## PART E — Build order (sequenced for cold execution)

1. Condition fields + `suitability` (A2, A3) — unlocks placement.
2. Needs registry + placement sampling (A1, A3) — species package migration.
3. Bake-time WFC variants (A5) — prototype content multiplier.
4. Thinker stub behind substrate seam (B1–B5) — sentients start "thinking."
5. Migration gradient (A4) — displacement recovery.
6. Carrying-capacity hookup (A6) — populations stop crashing.

**Open questions for Joey:** (a) the need-intensity curve shape — piecewise anchors are proposed; is a simpler linear/exponential decay acceptable for v1? (b) thinking cadence per tier — proposal: instinct 1Hz, social 0.2Hz, strategic on-demand; (c) whether `prime-aggressor` should be a computed vicinity role or an authored constraint.
