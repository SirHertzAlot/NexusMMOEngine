# Graphify — exposing the ECS graph behind every game object

Joey's ask (2026-10-27): the approved editor layout is fine, but the granularity
must go deeper — expose the entities, components, and systems each game object
maps to (based on its scripts/content), via a scraper ("Graphify") that serves
that backend data concisely, drillable as deep as we want.

## Verdict up front: Node/TypeScript, not C++

Three grounded reasons:

1. **The metadata is born in TypeScript.** Components are defined in
   `packages/engine-core/src/components.ts` (bitECS), schemas live in the
   protocol package, objects are authored in content/scene JSON, and every
   editor host is already TS. A harvester runs where the data is born.
2. **The live state lives in the Node world server.** Entity component values
   sit in the server's bitECS stores / SAB. Only Node can read them; the editor
   already has a read-only debug channel + ECS inspector doing exactly that.
3. **The C++ layer holds no names to scrape.** Native kernels sit behind bulk
   SoA boundaries — buffers, not component names or system registrations.
   Scraping C++ source (worse: typescript2cxx output, which emulates JS types)
   would be the fragile path.

**How C++ participates when systems migrate (C++ Tick Phase 3):** by
*declaration*, not scraping. Each system — TS or C++ — ships a machine-readable
access declaration (components read / written, per field where it matters).
Same discipline as the SAB logging code dictionary: one generated contract both
languages honor, checked in CI. The harvester consumes TS registrations and
C++ declarations identically.

## What exists today vs what's missing

- Exists: component definitions (`components.ts`), per-system bitECS queries
  (`defineQuery`, created once per system in/near `systems.ts`), the editor's
  live ECS inspector (per-entity component values, read-only), the authoring
  layer's component→widget mapping (`authoring/relevance.ts`, `widgets.ts`),
  the 13 authoring verbs, a graph view (`apps/editor/src/graph-view.ts`).
- Missing: **system→component access is implicit in query code, declared
  nowhere as data** (the one exception — combat's ownership declaration — is a
  prose comment on an unpushed local branch). Object→entity mapping exists at
  runtime (scene docs, spawn records) but is never presented as one graph.

## The harvest ("Graphify")

A Node build-time tool (rerun on content/code change, hash-stamped like the
bake) that emits **one versioned graph artifact** (`ecs-graph.json`):

**Node kinds:** `object` (content/scene game object) · `entity` (archetype /
live id) · `component` · `field` · `system` · `module` · `verb`
**Edge kinds:** `instantiates` (object→entity) · `has` (entity→component) ·
`fieldOf` (component→field) · `reads` / `writes` (system→component/field) ·
`touches` (verb→component) · `contributedBy` (system→module) ·
`summonedAs` (component→widget)

**Sources, in order of trust:**
1. Component registry — `components.ts` + protocol schemas (names, ids, fields, types).
2. System declarations — new `access` block per system (reads/writes);
   until a system declares, fall back to static extraction of its
   `defineQuery` terms and mark those edges `inferred` in the artifact.
   Inferred edges are visibly second-class in the UI — never presented as fact.
3. Content/scene JSON + bake/spawn records — object→entity→component instances.
4. Authoring layer — relevance/widgets/verbs for the designer-facing names.

**Live overlay (runtime, Node):** selecting an object asks the world server
(host API, selection-scoped — never a full-world scan) for current field
values, tick, and which systems ran on it last tick. Static graph + live
values are separate layers; the UI badges the graph's build hash against the
server's so a stale graph is visible, never silent.

## Granularity ladder (the answer to "as granular as we want?")

Yes — five levels, folded by default, expanded on demand:

1. **Object** — "Baker's Stall": components + systems as chips (the concise view).
2. **Entity** — live id, archetype, spawn source (hand-placed / procgen / bake).
3. **Component** — fields with live values, defaults, schema ranges.
4. **Field** — which systems read/write *this field*, tick order, last writer.
5. **System / verb** — the system's module, its full access set, the authoring
   verbs and content scripts that can change the field.

## Surfacing in the approved wireframe (amendment, layout unchanged)

- Right rail "APPLIED" becomes **ECS FOOTPRINT**: component chips; expanding a
  chip shows fields + R/W system badges. A depth control sets the default fold
  level (Object / Components / Fields / Systems) per user.
- A **Graph toggle** in the viewport overlays the selected object's
  neighborhood (object ↔ components ↔ systems) on the render — the
  `graph-view.ts` lineage, fed by `ecs-graph.json`.
- Widget headers gain a "maps to" line: widget → component(s) → system(s), so
  the designer-facing name and the engine name are never more than a glance apart.

## Phasing

- **G0 (prototype):** mock `ecs-graph.json` in exactly this schema behind the
  wireframe prototype — footprint drill-down included — so the comparison
  covers granularity, not just layout. The real harvester later plugs into the
  same artifact shape with zero UI rework.
- **G1:** static harvester for sources 1, 3, 4 (components, content objects,
  authoring) + `inferred` system edges from query extraction.
- **G2:** per-system `access` declarations become the contract (TS first;
  C++ systems declare as they migrate); inferred edges retire system by system.
- **G3:** live overlay (values, last-writer, tick order) + graph staleness badge.
