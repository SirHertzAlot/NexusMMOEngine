# Graphify Harvester — Spec

**Status:** SPEC — commissioned by Joey 2026-10-27 ("Spec the Graphify harvester
first"). Companion to `GRAPHIFY-ECS-EXPOSURE.md` (the design note: why Node,
the granularity ladder, the editor surfacing). This document is the buildable
spec: sources, artifact schema, extraction rules, the declarations contract,
CLI, validation, and phases. Nothing here is built yet.

**One-sentence summary:** a Node/TypeScript build-time tool that harvests the
engine's component registry, system queries, module manifests, content objects,
and authoring maps into **one versioned, hash-stamped graph artifact**
(`ecs-graph.json`) — so the editor (and any dev, via CLI) can answer "what is
this game object made of, and what touches it?" at any depth, with every edge
labeled by how it is known.

---

## 1. Locked decisions

1. **Node/TypeScript.** The metadata is born in TS, the live state lives in the
   Node world server, the C++ kernels hold nameless SoA buffers. (Rationale:
   the design note.)
2. **Hybrid extraction — introspect first, parse second, never guess.**
   Component schemas come from *running* the real modules and introspecting
   the bitECS component objects (ground truth, drift-proof). System access
   comes from declarations where they exist, else static extraction of
   `defineQuery` terms, labeled `inferred`. Anything the extractor cannot
   resolve goes on an explicit `unresolved` list — it is never guessed.
3. **Declarations are the long-term contract.** An optional `access` block per
   system (schema in §6). Declared edges outrank inferred ones; the inferred
   set is expected to shrink to zero for simulation systems.
4. **The artifact is committed and CI-checked**, like bake goldens:
   `graphify --check` fails CI if the committed artifact differs from a fresh
   harvest of the same tree.
5. **Confidence is data.** Every edge carries `confidence: "declared" |
   "introspected" | "extracted" | "inferred"` and a `source` pointer
   (`file:line` or the declaring module). Consumers must render inferred
   edges as second-class.

### The shape principle (Joey's framing, 2026-10-27)

Identification is by shape, because in this ECS the shape *is* the identity:

- An **entity** is a bare id — a data tag with no fields of its own.
  Everything knowable about it is which component stores contain its id.
- A **component** is a typed store: a field layout (its shape) plus a
  membership set of entity ids. Two entities with the same membership pattern
  share an **archetype** — the shape signature is the join key for the
  whole graph.
- A **system** is a named pass over a shape: its query terms name the stores
  it walks, and its body touches those stores' fields directly, by name.
  What a system acts on — and which fields it reads vs writes — is therefore
  structural fact, extractable mechanically (§5.2), not a matter of
  interpreting intent.

The harvester never has to understand what code *means*; it reads shapes:
store schemas, membership, query terms, direct field accesses.

## 2. Non-goals

- No runtime/gameplay role. Graphify never runs in the tick or the gateway.
- No live values in the artifact. Live field values are a separate overlay
  (Phase H4) served by the world server, selection-scoped.
- No C++ source parsing, now or later. Native systems join by declaration (§6.3).
- No general code-graph ambitions (call graphs, import graphs). ECS only.

## 3. Sources (verified against origin/main 75895c5b, 2026-10-27)

| # | Source | Path(s) | Method | Trust |
|---|--------|---------|--------|-------|
| S1 | Component registry | `packages/engine-core/src/components.ts`, `body.ts` (Body, Injury), `magic.ts` (Mana) | Runtime introspection: import the modules, walk the exported bitECS component objects + `COMPONENT_IDS` | introspected |
| S2 | Component name registry + defaults | `packages/engine-core/src/admin/add-component.ts` (`REGISTRY`, defaults table — already drift-tested against the live schemas) | Introspection / parse | introspected |
| S3 | System queries | `defineQuery` call sites across `packages/engine-core/src/**` (20+ files) | TS AST extraction (§5.2) | inferred |
| S4 | System declarations | `access` blocks (§6) — none exist yet | Parse / import | declared |
| S5 | Tick order + system roster | The ordered system construction in `packages/engine-core/src/systems.ts` | AST extraction of the construction list | inferred → declared once S4 lands |
| S6 | Modules | `modules/*/manifest.json` + server entries (35 module dirs) | JSON parse + entry-file scan | introspected (manifest), inferred (entry scan) |
| S7 | Content objects | `content/scenes/*.scene.json` (node trees: id, name, transform, `components`), settlement bake outputs/manifests | JSON parse | introspected |
| S8 | Scene→ECS realization | The scene loader (`packages/scene`) mapping scene component kinds (e.g. `Structure`) to ECS components at spawn | AST extraction of the mapping site; explicit table once it exists | inferred |
| S9 | Authoring maps | `apps/editor/src/authoring/verbs.ts` (each verb's `home` literally names its owning system/service), `relevance.ts` (`WIDGET_IDS`, per-widget `modules`), `authoring-view.tsx` (`COMPONENT_WIDGET`) | AST extraction | introspected |
| S10 | Protocol schemas | `packages/protocol` (field types/ranges where the wire schema defines them) | Import / parse | introspected |

**Classification rule (learned from the sources):** `snapshot.ts` alone holds
14 `defineQuery` calls — persistence/snapshot/gateway systems query *everything*
by design. Every system node therefore carries `role: "simulation" |
"infrastructure" | "authoring"`. The editor footprint defaults to simulation
systems; infrastructure edges exist in the artifact but are folded away.
Role is assigned in a small reviewed config in the graphify package, not inferred.

## 4. The artifact: `content/graph/ecs-graph.json`

Committed to the repo; regenerated by the tool; consumed by the editor's
content host and by the `graphify --why` CLI.

```jsonc
{
  "meta": {
    "schemaVersion": 1,
    "builtFromCommit": "<git sha>",
    "graphHash": "<sha256 of canonical nodes+edges>",
    "sourceHashes": { "packages/engine-core/src/components.ts": "<sha256>", "...": "..." },
    "counts": { "components": 0, "systems": 0, "objects": 0, "edges": 0 },
    "unresolved": [ { "site": "file:line", "what": "query built from a variable", "system": "<name?>" } ]
    // NOTE: no timestamps inside the hashed region; generation time, if kept, lives outside `meta.graphHash` inputs.
  },
  "nodes": [ /* sorted by id, see §4.1 */ ],
  "edges": [ /* sorted by (from, kind, to), see §4.2 */ ]
}
```

### 4.1 Node kinds and id conventions

| Kind | Id form | Key fields |
|------|---------|-----------|
| `component` | `component:Health` | `fields: [{name, type, arrayLen?}]`, `componentId` (from `COMPONENT_IDS`), `sab: boolean`, `tag: boolean` |
| `field` | `field:Health.current` | `type`, parent component (also an edge) |
| `system` | `system:IntentSystem` | `role`, `module`, `tickIndex` (when known), `declared: boolean` |
| `module` | `module:combat` | manifest summary |
| `object` | `object:places/P0001` | `name`, `scene`, `spawnSource: "scene" \| "bake" \| "procgen"` |
| `archetype` | `archetype:<hash of component set>` | the shared component signature — objects link here so 1,300 baked townsfolk don't repeat their component lists |
| `verb` | `verb:attachVendor` | `home`, `signature` (from S9) |
| `widget` | `widget:vendor` | `modules`, `rules` (from S9) |

### 4.2 Edge kinds

`hasComponent` (archetype/object→component) · `fieldOf` (field→component) ·
`reads` / `writes` (system→component or system→field; field-level only when
declared or unambiguously extracted, else component-level) · `excludes`
(system→component, from `Not(...)` query terms) · `instantiates`
(object→archetype) · `realizes` (scene component kind→ECS component, S8) ·
`contributedBy` (system→module) · `touches` (verb→component/system, via the
verb's `home`) · `summons` (component→widget) · `operatesOn` (widget→component,
from applied-state projections).

Every edge: `{ from, to, kind, confidence, source }`.

## 5. Extraction pipeline

Five stages, each a pure function of the repo tree; the whole run is
deterministic (sorted output, canonical JSON, no timestamps in hashed data) —
two runs on the same tree are byte-identical.

1. **Introspect.** In a Node child process, import S1/S2 modules; read each
   component's field names + bitECS types from the live objects; read
   `COMPONENT_IDS`. This is why introspection beats scraping: the SAB swap
   and any future registry change are reflected automatically.
2. **Parse.** TypeScript compiler API over S3–S6, S8, S9:
   - `defineQuery([...])` arguments: bare identifiers → query terms;
     `Not(X)` → `excludes`; identifiers resolved through imports to component
     node ids. A query assigned to a variable inside a system factory is
     attributed to that system by lexical scope; unattributable queries go to
     `unresolved`.
   - Read/write direction comes from the shape of the system's own code
     (§1, shape principle): inside a system body a component store is a named
     set of flat arrays, so a field access is unambiguous —
     `Health.current[eid]` on the left of an assignment is a write of
     `field:Health.current`; the same expression in any read position is a
     read. Direct accesses yield field-level `reads`/`writes` edges at
     `extracted` confidence. Query terms alone (no body access found) yield a
     component-level edge marked `inferred` with direction unknown — the UI
     shows "uses", not R/W. Access that leaves the system body — stores passed
     into shared helpers, computed property access, writes performed by
     utility modules on a system's behalf — is not traced: the site is
     recorded in `unresolved`, never guessed.
   - Tick order: the ordered construction list in `systems.ts` → `tickIndex`.
3. **Join.** Content objects (S7) → archetypes by component signature;
   scene kinds → ECS components via S8 `realizes` edges; verbs → systems via
   `home` strings (S9); widgets → components via `COMPONENT_WIDGET` + relevance.
4. **Validate.** §7 invariants; any failure aborts the emit (no partial artifact).
5. **Emit.** Canonical JSON + `graphHash`; `--check` mode re-runs and diffs.

## 6. The declarations contract (the durable piece)

### 6.1 Shape

```ts
// packages/engine-core/src/system-access.ts (new, or co-located per system)
export interface SystemAccess {
  system: string;                      // matches SimSystem.name
  reads:  AccessRef[];                 // component-level or field-level
  writes: AccessRef[];
  excludes?: string[];                 // component names from Not(...) terms
}
type AccessRef = string | { component: string; fields: string[] };
```

### 6.2 Wiring

- `SimSystem` gains an **optional** `access?: SystemAccess` (backwards
  compatible; `systems.ts` interface is `{ name, step }` today).
- Systems not constructed as `SimSystem` objects (module server entries,
  factories) declare in a per-module `system-access.json` beside the manifest.
- CI rule: every simulation system in the tick roster must be declared or sit
  on a reviewed `inferred-allowlist` in the graphify package; the allowlist
  only shrinks (a ratchet test asserts its size never grows).

### 6.3 C++ systems

A migrated system ships the same `SystemAccess` as JSON, generated from its
native registration (the C++ tick program's code dictionary discipline — the
same pattern as the SAB logging dictionary). The harvester reads the JSON;
it never reads C++ source. Declared is declared, whatever language declared it.

## 7. Validation invariants (all testable, all enforced at emit)

1. Every edge endpoint exists as a node.
2. Every component in the introspected registry appears exactly once.
3. Every `field:` node belongs to a component whose introspected schema has that field.
4. Every declared edge names a real component/field (declarations are validated, not trusted).
5. Every system in the tick roster appears, with a `role`.
6. No edge claims `declared` confidence without a declaration source.
7. `unresolved` entries carry a `file:line` site — an unresolved with no site fails the build.
8. Archetype signatures are pure functions of their component sets (same set → same id).
9. The artifact round-trips its own JSON schema (Zod) — consumers never parse a malformed graph.
10. Determinism: a second run on the same tree produces a byte-identical file.

## 8. CLI

New workspace package **`packages/graphify`** (`@mmo-engine/graphify`), bin `graphify`:

- `graphify build [--out content/graph/ecs-graph.json]` — full harvest.
- `graphify --check` — rebuild to memory, diff against committed, validate (CI).
- `graphify --why <object|component|system>` — the concise human answer in the
  terminal: for an object, its archetype + components + systems; for a field,
  its readers/writers with confidence labels. This is the dev-side "concise
  exposure" of the same data the editor renders.
- Editor consumption: the editor's content host serves the committed artifact;
  the UI compares `meta.builtFromCommit` + the world server's build id for the
  staleness badge (never silently stale).

## 9. Phases (each gated on Joey's word)

- **H1 — Registry + content graph.** Introspection (S1, S2), content objects +
  archetypes (S7), authoring maps (S9), artifact + schema + `--check`,
  fixture golden test (a tiny synthetic tree → known graph) + determinism test.
  *Acceptance:* artifact validates; counts match a hand count of the registry;
  `--why component:Health` prints its fields and the widgets/verbs touching it.
- **H2 — Inferred system edges.** AST extraction of `defineQuery` (S3), tick
  order (S5), module contribution (S6), `realizes` edges (S8), roles config,
  `unresolved` reporting. *Acceptance:* every roster system present;
  field-level R/W edges extracted for direct store accesses; query-only edges
  labeled `inferred`; unresolved list non-silent and reviewed in the PR.
- **H3 — Declarations contract.** `SystemAccess` type + `SimSystem.access`,
  declarations for the simulation roster (densest systems first — the same
  order as C++ Tick Phase 3), allowlist ratchet in CI. *Acceptance:* R/W
  split live for declared systems; inferred count for simulation systems at
  or near zero.
- **H4 — Live overlay.** World-server host read (selection-scoped): current
  field values + last-writer per field for one entity, reusing the admin
  `inspect` path's projections. Editor badges stale graphs. *Acceptance:* one
  entity's live footprint in the editor with values matching `inspect` output;
  no full-world scans (query is by entity id, bounded).

## 10. Risks and open questions

- **Module server entries are plain JS** (`modules/*/server.js`). The TS
  compiler API parses JS, but types are absent: module contribution edges stay
  `inferred` until a module declares its systems in its manifest. Acceptable;
  declared in §6.2 as the fix path.
- **Baked towns are the big object source** (hundreds of residents per town).
  Archetype collapsing keeps the artifact compact, but bake manifests must
  expose per-object component signatures — if a bake output lacks them, H1
  covers scene JSON only and says so in `meta.counts` (no silent partial graph:
  `meta.coverage` lists which object sources were harvested).
- **Scene kinds ≠ ECS components** (`Structure` in scene JSON is a content
  schema). The `realizes` mapping lives in loader code today; if the mapping
  is diffuse, H2 reports it as unresolved rather than approximating it.
- **Indirect access is the residue.** Direct store accesses are extracted in
  H2 (§5.2); what remains genuinely hard is indirection — stores handed to
  shared helpers, computed keys, writes from utility modules on a system's
  behalf. Those sites are the `unresolved` list by construction. If the list
  turns out long for a few hot systems, declarations (§6) are the fix, in
  tick-density order — not a smarter tracer.

## 11. Where this feeds

- The editor prototype (approved layout) consumes `ecs-graph.json` from day
  one — mock first, real artifact when H1 lands, same schema either way.
- M5 board items: "Editor UI end-goal gap closure" (the footprint rail is its
  granularity half). C++ Tick Phase 3 consumes §6 declarations as systems
  migrate. The future GraphQL live-ops layer can query this artifact as its
  static schema backbone.
