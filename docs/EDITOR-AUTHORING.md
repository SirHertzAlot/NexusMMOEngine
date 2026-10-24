# Editor Authoring — the view-centered model (Phase B, first slice)

Joey's direction (2026-10-17, `VIEWPORT-AUTHORING-DESIGN.md` in the arch-docs):
designers author through the viewport — selection summons contextual module
widgets, the hierarchy is a relationship navigator, authoring speaks only the
13 canonical verbs, and every mutation carries a mandatory 5W1H provenance
envelope. This doc describes what Phase B built, how the two surfaces map to
it, and what is deliberately not done yet.

## The model layer — `apps/editor/src/authoring/`

Pure TypeScript, no React, no stores, no I/O. The UI is a thin renderer over it.

| File | What it owns |
|---|---|
| `facts.ts` | `SelectionFacts` — the one input everything evaluates: components present, vendor-map fact, creature kind, quest-giver fact, dungeon-entrance fact, and the Phase A marker values (FlowRef / VfxEmitter / AudioEmitter). |
| `relevance.ts` | Audit §5 rules 1–18 as an evaluator. Returns the applied widgets for a selection, with the character/characters pair (rules 2+12) and the quests/story pair (rules 7+16) merged into one widget with tabs each. Chat, HUD and scenes are scene-level only and never appear on an object selection. |
| `add-shelf.ts` | For each non-applied module, an establishability verdict grounded in the facts: *establishable* (with the one-click action — a canonical verb call such as `attachVendor`, or a component addition such as Health+Stamina) or *never-for-this-kind* (hidden by the UI — a plain prop/rock never offers the character sheet). |
| `hierarchy.ts` | Containment (scene → region → POI → object) plus reference edges (quest → giver, vendor → template, creature → patrol route / dialogue graph). Role filters are defined **as** relevance rules over the same facts (quest givers, vendors, loot spawners, mob spawners, dungeon entrances, environment, characters). Sorting by name or by provenance timestamp ("recently modified"). Saved views (role + sort + query) serialize/deserialize/apply. |
| `verbs.ts` | The 13 canonical verbs of audit §4 as a typed registry (name, aliases for the paired rows `spawnPack`/`detachVendor`, canonical home, signature). The `VerbCall` envelope requires who (actor + role), what, when, where (hierarchy path), why (intent), how (verb + params); validation rejects anonymous mutations (no actor, no role, no why). `VerbHistory` is the append-only log, queryable per object and per actor. |
| `widgets.ts` | The widget builder: relevance + caller-supplied applied state → view-models with the three anatomy zones (what it is / what's applied / CRUD), every CRUD affordance resolved to a `VerbCall` with a full envelope. Where no canonical verb honestly covers an action (binding a flow graph, adding an emitter), the widget carries no fake verb — the add shelf establishes those preconditions instead. |

Tests: `apps/editor/test/authoring-{relevance,add-shelf,verbs,hierarchy,widgets}.test.ts`.

## The UI — Design workspace

`apps/editor/src/ui/authoring-view.tsx`, registered in `App.tsx` as the first
workspace, **Design** (Designer surface):

- **Hierarchy pane** — scene picker (the editor's real scene documents via
  `scenes-client`), the containment tree, role-filter chips, name/recent sort,
  and a saved-view picker with save-current. Clicking a node writes the shared
  `editorSelection` store via the same `nodeSelection` the Scenes panel uses —
  picking here is picking there.
- **Stage** — a panel (not the 3D viewport in this slice) showing the selected
  object's name/kind/path, its reference edges, and the session history for
  that object from the `VerbHistory`.
- **Widget stack + add shelf** — rendered straight from the model layer. The
  facts adapter (`factsFromSelection`) reads the real `EditorSelection`; the
  applied-state lines are read from the selection's own component fields —
  the only state this slice claims. Widget tabs reuse the Phase A
  `merged-modals` tab bar.

Every other workspace is the **Developer surface** (data/IDE tooling over the
same pipeline); two left-dock titles say so ("Tables · Developer surface",
"Schema · Developer surface") as the labeling pattern to extend.

## Phase C — panel removal slate (nothing deleted in Phase B)

A standalone panel is removed only when the widget that replaces it is live
**and dispatching** (see gaps). Slated, in order:

| Standalone panel today | Replaced by | Remove when |
|---|---|---|
| ECS inspector component tables (Scene workspace, `ecs-inspector.tsx`) | Per-module widgets for the same selection | Widget CRUD dispatches through the verb layer and covers the components the inspector edits |
| Characters workspace Records panel | Merged Character widget (Sheet + Records tabs) | The widget's Records tab renders the panel (Phase A modal already proves the merge) |
| Story workspace quest & dialog panels | Merged Quests & dialogue widget (Quests + Dialogue tabs) | Same — widget renders both tabs against live quest content |
| Flow workspace entry point for per-object graphs | Flow widget (FlowRef marker) | Flow binding/unbinding dispatches as component edits from the widget |
| Art & audio panels (per-object emitters) | VFX / Audio widgets (marker-driven) | Emitter attach/edit dispatches from the widgets; scene-level ambient/music stays a scene widget |
| Modules workspace panels for vendor/economy | Vendor widget | Vendor template attach/detach + stock CRUD dispatch live |

Scene-level panels (Scenes document, HUD layout, region chat) are **not**
slated for removal — the design makes them scene-selection widgets, which is
a re-homing, not a deletion.

## Honest gaps in this slice

- **No live dispatch.** Widget and shelf verb actions are built, validated,
  enveloped and recorded in the session `VerbHistory` — and the UI says so on
  every click. They do not yet execute against the server verb layer, and
  component-shaped shelf actions (add Health+Stamina, bind FlowRef) only
  announce themselves. Wiring dispatch is the next slice.
- **Stage is not the viewport.** The 3D viewport stays in the Scenes
  workspace; selection is shared, but widgets do not yet render as viewport
  overlays/modals.
- **Applied state is selection-local.** Lines come from the selection's
  component fields, not from live system reads (vendor stock, dialogue
  graphs, abilities). The widget builder already accepts caller-supplied
  state per widget; live readers are future work per module.
- **Hierarchy references are only as good as the data.** Scene documents
  carry containment and component facts; quest→giver / vendor→template /
  patrol edges appear when node data carries them (the model supports them;
  today's scene-doc adapter has none to read).
- **History is in-memory.** The `VerbHistory` lives for the editor session;
  persistence, VCS commit metadata, and concurrent-edit surfacing from the
  design are not built.
- **Procgen quick-start is not in this slice.** Hand-place and procgen
  converge on the same facts/widgets by construction (a baked scene doc
  loads identically), but the rule-editor widget is future work.
