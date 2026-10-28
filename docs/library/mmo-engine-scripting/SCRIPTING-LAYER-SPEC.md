# Scripting Layer Specification — Data-Definition Scripts, Built-in IDE, Designer Authoring

**Status:** Draft for review (2026-10-11)
**Scope:** v1 — data-definition scripting. Behavior scripting (custom actions, event handlers) is explicitly out of scope; see §16.
**Design goal:** Devs build systems independently. Designers build entities/components via authoring UIs. Players write scripts in a built-in IDE. All three produce the same validated data.

---

## 1. Purpose

The engine's systems (needs, suitability, WFC variants, spawning, placement) consume typed data. Today that data is authored as JSON (e.g. `packages/species` roster files) or hardcoded. The scripting layer gives every author type a dev-friendly way to produce that data:

- **Devs** own systems, Zod schemas, and the script API. They never write content scripts.
- **Designers** author entities, components, species, needs, and variants — via scripts, via visual builders, or both (round-tripped).
- **Players/modders** write scripts in the built-in IDE using the same DSL under a tighter sandbox.

A script is a TypeScript module. It does not run gameplay logic. It *declares data*. Execution happens at authoring time and bake time, inside a sandbox, and the output is validated before it touches any pipeline.

---

## 2. Design Principles

1. **Scripts produce data, never behavior.** A script cannot move an entity, damage anything, or run in the tick loop. It emits definitions; systems consume definitions.
2. **One pipeline, three frontends.** Hand-written script, UI-generated script, and player mod all flow through the same path: parse → sandbox-execute → Zod-validate → data pipeline. No special cases.
3. **Schemas are dev-owned; content is author-owned.** The contract between them is the versioned script API (`@engine/script-api`) and the Zod schemas behind each `defineX`.
4. **Deterministic by construction.** Same script source + same API version + same world seed = byte-identical definitions. No exceptions; see §8.
5. **Fail closed.** A script that fails validation emits nothing. A player script that exceeds its sandbox emits nothing. Partial output never reaches the pipeline.

---

## 3. Trust Tiers

| Author | Trust | Runs where | Capabilities |
|---|---|---|---|
| Dev | Full | Engine repo | Writes systems, schemas, script API |
| Designer (internal) | High | Authoring machine, bake | Full DSL; local files; no capability restrictions beyond the sandbox |
| Player / modder | Untrusted | Hardened sandbox, edge | Same DSL; timeouts, memory caps, definition-count caps; scripts signed and versioned; loaded at world init only |

Capability differences are enforced by the sandbox configuration, not by convention. A player script physically cannot reach an API the designer tier has, because it isn't in its context object.

---

## 4. v1 Scope — What Scripts Define

Data-definition only. Each maps to a dev-owned Zod schema:

| `defineX` | Produces | Existing schema it extends |
|---|---|---|
| `defineComponent(name, def)` | Component type: fields, types, defaults | New (component registry) |
| `defineEntity(name, { components })` | Entity archetype: component composition + values | New (entity registry) |
| `defineSpecies(name, def)` | Species incl. needs, habitat, variants | `packages/species` `SpeciesSchema` |
| `defineNeed(name, def)` | Need: decay, thresholds, action mapping | New (needs registry) |
| `defineAction(name, def)` | Action data for needs→action collapse | New (action registry) |
| `defineBiome(name, def)` | Biome: condition ranges, tags | Extends world-gen biome data |
| `defineVariant(base, biome, overrides)` | Explicit species variant (WFC also generates implicit ones) | Species variant table |

Scripts may also `import` shared helpers from other *script* files (constants, builder functions) — imports are resolved within the script sandbox, never to engine internals or npm.

---

## 5. The DSL Surface

```ts
// scripts/species/wolf.ts
import { defineSpecies, defineNeed, rng } from '@engine/script-api';

defineNeed('hunger', {
  // decay per in-game hour at rest; systems scale by activity
  decayPerHour: 0.08,
  // [satiated, hungry, starving] thresholds drive action generation
  thresholds: [0.25, 0.6, 0.9],
  // which action families this need can generate, in priority order
  actions: ['forage', 'hunt-easy', 'hunt-hard', 'scavenge'],
});

defineSpecies('wolf', {
  kind: 'beast',
  // needs are references to defineNeed definitions, with species tuning
  needs: {
    hunger:  { weight: 1.0 },
    thirst:  { weight: 0.7 },
    safety:  { weight: 0.9 },
  },
  // sustenance kinds drive placement: what keeps it alive, where it gathers
  sustenance: ['food', 'water'],
  pack: [3, 8],
  tier: [1, 2],
  // habitat is DERIVED, not authored: the suitability system matches
  // needs against biome condition fields at bake time. Authors may add
  // explicit overrides, but the default is emergent placement.
  habitatOverrides: {},
});
```

Design rules for the API:

- **References, not copies.** `needs: { hunger: {...} }` references the `hunger` need definition; species only tune weights. One definition of hunger serves every species.
- **Composition over inheritance.** Entities compose components; species reference needs; variants override fields. No prototype chains to debug.
- **Every `defineX` returns an opaque handle**, not the raw object — scripts can't mutate another definition after the fact. This keeps execution order-independent.
- **API version is declared per project** (`script-api: 1` in the project manifest), not per file. Mixed versions in one project are a validation error.

---

## 6. Script Lifecycle

```
author writes .ts (IDE or editor)
  → typecheck against @engine/script-api types (red squiggles, autocomplete)
  → compile (esbuild, in-memory, no disk output for player scripts)
  → static lint (banned globals, import allowlist)
  → execute in sandbox → definitions[] (in-memory)
  → canonicalize order (sort by kind, then name)
  → Zod-validate each definition against its schema
  → pass: emit to data pipeline (registry / sim.db / bake)
  → fail: structured diagnostics, zero definitions emitted
```

Execution contexts:

- **Authoring time** (editor): live reload on save; validation feedback in the IDE within milliseconds; preview pane shows "what this script defines."
- **Bake time** (world bake): all project scripts execute headlessly; output baked into `sim.db` and registries. Bake fails loudly on any validation error.
- **Edge** (player mods): validated once on submission; re-validated on load; executed at world/zone init; never re-executed per tick.

---

## 7. Sandbox Model

Execution uses `node:vm` with a frozen context. The context contains exactly:

- The `defineX` functions (bound to a per-execution collector).
- `rng()`: seeded PRNG (see §8). The *only* source of randomness.
- A minimal `console` (warn/error only, captured to diagnostics — no stdout side effects).
- Safe built-ins: `Math` (minus `Math.random`, which is deleted), `JSON`, `Array`, `Object`, etc.

Not present: `require`, `import` (resolved statically pre-execution against the allowlist), `process`, `fetch`, `fs`, `eval`, `Function`, `WebAssembly`, timers, `Date`.

Static lint (pre-execution) rejects:

- Imports outside `@engine/script-api` and relative script files.
- References to banned globals (`Math.random`, `Date`, `performance`, etc.) — caught by scope analysis, not just runtime absence.
- Top-level `await`, generators yielding across definitions, or any control flow the collector can't linearize.

Resource limits (configurable per tier):

| Limit | Designer | Player |
|---|---|---|
| Execution timeout | 30s | 5s |
| Memory | 512MB | 64MB |
| Definitions per file | 10,000 | 1,000 |
| Import depth | 10 | 5 |

Exceeding any limit aborts execution; the script emits nothing.

---

## 8. Determinism Contract

A script's output must be a pure function of **(script source, script-api version, world seed)**.

Enforced by:

1. **No ambient nondeterminism.** Banned globals are absent from the context *and* rejected by lint. There is no clock, no OS randomness, no environment to read.
2. **Seeded RNG.** `rng()` is seeded per execution as `hash(scriptPath, worldSeed, apiVersion)`. Same inputs → same sequence, on every platform (integer hash, not `Math.sin`-based).
3. **Canonical output order.** Definitions are sorted by (kind, name) before validation and emission. Map iteration order, where used internally, never leaks into output.
4. **No floating-point traps in the contract.** Validation schemas round-trip through canonical JSON; the pipeline stores what was validated. Bake reproducibility is tested by the golden suite (same scripts + seed → byte-identical `sim.db` rows).

The species/variant WFC collapse at bake time uses the same seeded RNG discipline — variants are deterministic given the inputs.

---

## 9. Validation & Error Model

Every definition kind has a dev-owned Zod schema, versioned with the script API. Validation is per-definition; failures are collected, not thrown.

Error shape (what the IDE renders):

```ts
{
  file: 'scripts/species/wolf.ts',
  line: 14, column: 5,
  definition: 'species/wolf',
  path: 'needs.hunger.weight',   // schema path
  expected: 'number between 0 and 1',
  received: '1.5',
  hint: 'Need weights are normalized 0–1; values above 1 usually mean you wanted thresholds instead.',
}
```

Three error classes, surfaced distinctly in the IDE:

1. **Parse errors** — syntax. "Your script doesn't parse."
2. **Type errors** — API misuse caught by tsc. "You're calling it wrong."
3. **Validation errors** — schema failures. "The data is wrong."

Atomicity: a file with any error emits zero definitions. Errors never crash the bake process; they're collected per file and reported as a batch.

---

## 10. Built-in IDE

Embedded in the editor app (`apps/editor`). Built on **Monaco** (MIT) — the VS Code editor component.

Features (v1):

- **Script explorer**: project script tree, grouped by definition kind.
- **Language service**: autocomplete from `@engine/script-api` types, hover documentation, signature help. Types are generated from the same source as the runtime API — they can't drift.
- **Live validation**: typecheck on keystroke (debounced), sandbox-validate on save, Zod errors rendered inline with the error shape from §9.
- **Definition preview**: "what does this script define" — expandable tree of the emitted definitions, before they're committed to the pipeline.
- **Diff view**: what changed in the data pipeline if this script is accepted (added/modified/removed definitions).
- **One-click actions**: validate, bake-dry-run, revert to last-good.

The IDE edits files on disk for designer projects (standard filesystem). Player mods are submitted as text through the mod pipeline (§13), never as filesystem writes.

---

## 11. Entity & Component Authoring (Designer UIs)

Designers who don't want to write scripts use visual builders. Both builders generate scripts — the script is the source of truth, not a side artifact.

- **Component builder**: form-based field definition (name, type, default, constraints) → generates `defineComponent(...)`.
- **Entity builder**: component palette → drag components onto the entity → set field values → generates `defineEntity(...)` composing them.

**Round-trip guarantee:**

- Generated scripts carry a header marker (`// @generated entity-builder v1 — safe to hand-edit`).
- Hand-edited scripts re-parse into the builders. The builders operate on the parsed definition model, not on the script text, so formatting and comments survive.
- If a script diverges beyond what a builder can represent (e.g. programmatic generation with loops), the builder shows it in **custom mode**: full fidelity view, no editing widgets, and — critically — it never rewrites or clobbers the file. The designer's code is never destroyed by the tool.

---

## 12. Versioning & Migration

- The script API is versioned (`@engine/script-api` major version). Projects declare the version they target.
- Schemas evolve with the API. **Migrations are dev-owned**: when a schema changes, devs ship a codemod for the common cases.
- Loading a script targeting an older API version: the validator reports precisely what changed ("`pack` is now `{min,max}` instead of `[min,max]` — run `engine migrate scripts/` to auto-fix") and refuses to guess.
- API versions are append-only supported for N-1 (current and previous major). Older scripts must migrate.

---

## 13. Security Model (Player Scripts)

Defense in depth, in execution order:

1. **Submission gate**: scripts submitted as text; size-capped; scanned by the static linter before anything executes.
2. **Hardened sandbox**: per §7, player-tier limits. No filesystem, no network, no timers, no dynamic import.
3. **Validation gate**: same Zod schemas as designer scripts. A mod can't define anything the schema forbids (e.g. needs with negative decay, entities with unknown components).
4. **Signing & versioning**: accepted mods are signed and pinned to a script-api version. Tampered or version-drifted mods fail closed at load.
5. **Blast-radius containment**: mod definitions live in a namespaced registry overlay. They can add species/variants/entities; they cannot redefine engine components or alter existing definitions. Removal of a mod removes exactly its overlay — no residue.
6. **No tick access, ever** (§14, I1). The most a malicious script can do is define bad data, which validation rejects.

---

## 14. Invariants (The Air-Tight Core)

These are numbered, testable, and non-negotiable. Every implementation phase must hold all of them:

- **I1 — No tick execution.** No script, designer or player, ever executes in the simulation tick loop. Scripts run at authoring time, bake time, or world init. A test asserts the tick path cannot import the script executor.
- **I2 — Systems never read scripts.** Systems read validated data (registries, `sim.db`). There is no code path from a system to a script file. A test asserts the dependency direction.
- **I3 — Deterministic output.** Same (source, apiVersion, worldSeed) → byte-identical definitions. Covered by golden tests in CI.
- **I4 — Atomic validation.** A script file with any error emits zero definitions. Covered by fault-injection tests.
- **I5 — Lossless round-trip.** A UI-generated script, parsed and re-emitted without edits, is text-identical. Covered by round-trip tests.
- **I6 — Tier monotonicity.** Player-tier capabilities ⊆ designer-tier capabilities, enforced by sandbox construction (not by flag checks scattered through code).
- **I7 — Full provenance.** Every definition records (script file, line, author, apiVersion, worldSeed). Auditable end-to-end.

---

## 15. Integration Points

- **`packages/species`**: `defineSpecies` emits `SpeciesSchema`-compatible data (extended with needs/variant fields). The existing JSON roster loading (`loadSpecies`) keeps working — scripts are a frontend, not a replacement.
- **Needs registries**: `defineNeed` / `defineAction` feed the needs-driven placement and the WFC action-collapse system (the "thinking" layer).
- **WFC**: `defineVariant` provides explicit variants; the bake-time WFC generates implicit biome variants from species + biome constraints. Both land in the variant table.
- **Component/entity registries**: new; back the ECS archetype definitions designers author.
- **Bake pipeline**: script execution is a bake stage, before world generation. Bake order: scripts → registries → terrain → water → organics → settlements → validation gates.
- **Editor** (`apps/editor`): hosts the IDE, the builders, and the preview/diff views.

---

## 16. Explicitly Out of Scope (v1)

- **Behavior scripting**: custom per-tick logic, event handlers, AI overrides. This needs the tick-safety design (determinism under concurrency, performance budgets, hot-reload semantics) and is a separate spec. The data layer here is its prerequisite — behavior scripts will act on the components and needs defined here.
- **Visual scripting**: node-graph authoring that compiles to scripts. The script text is the IR; visual builders (§11) come first.
- **Multiplayer script sync**: how mods distribute to clients. Transport, not authoring.
- **Mod marketplace/review pipeline**: submission UX and human review are product work built on the technical gates in §13.

---

## 17. Implementation Phases

- **Phase 1 — Core**: `@engine/script-api` types + `defineX` implementations, `node:vm` sandbox executor, static linter, Zod validation pipeline, CLI (`engine scripts validate`, `engine scripts bake-dry-run`). Invariants I1–I4, I7 tested.
- **Phase 2 — IDE**: Monaco integration in `apps/editor`, language service from API types, explorer, live validation, definition preview, diff view.
- **Phase 3 — Builders**: component builder + entity builder with round-trip guarantee (I5 tested).
- **Phase 4 — Player pipeline**: hardened sandbox tier, submission gate, signing, registry overlay, mod load/unload. Invariant I6 tested.

Each phase holds all invariants from §14 that apply to it; a phase is not done until its invariant tests are green.
