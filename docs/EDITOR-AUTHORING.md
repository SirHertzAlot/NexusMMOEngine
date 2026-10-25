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
| `widgets.ts` | The widget builder: relevance + caller-supplied applied state → view-models with the three anatomy zones (what it is / what's applied / CRUD), every CRUD affordance resolved to a `VerbCall` with a full envelope. Where no canonical verb honestly covers an action (binding a flow graph, adding an emitter), the widget carries no fake verb — the add shelf establishes those preconditions instead. Two non-verb affordance kinds ride as dispatch plans: component removals (the flow widget's unbind) and plan actions (vendor stocking). |
| `inputs.ts` | Action input descriptors as data: each widget/shelf action that needs a designer-supplied value declares its fields (picker with a named real source — `item-bases` / `creature-kinds` / `vendor-templates` — or a number), with prefills where the facts carry one (a vendor's current template, a creature's kind, teleport x/z from the selection's Transform position). `WidgetAction.callWith(values)` rebuilds the call with the values in its params; unfilled fields leave the placeholder and the dispatch mapper refuses it — the mapper is the single gate. Also the parser for the admin `vendor list` answer. |

Tests: `apps/editor/test/authoring-{relevance,add-shelf,verbs,hierarchy,widgets,templates,dispatch,inputs}.test.ts`.

## The UI — Design workspace

`apps/editor/src/ui/authoring-view.tsx`. The **Design** workspace is declared
in `App.tsx` (first tab); its panel is contributed by the new `authoring`
module (`modules/authoring/editor`) through the module registry, like every
other panel — the shell hardcodes no panel views.

- **Hierarchy dock** (inside the view pane, left edge) — scene picker (the
  editor's real scene documents via `scenes-client`), the containment tree,
  role-filter chips, name/recent sort, and a saved-view picker with
  save-current. Clicking a node writes the shared `editorSelection` store via
  the same `nodeSelection` the Scenes panel uses — picking here is picking
  there.
- **View pane / stage** — a panel (not the 3D viewport in this slice): the
  identity bar across its top names the selected object; its center zone
  shows the object's reference edges and, after a dispatch, the live inspect
  read-back; the session history for the object runs along its bottom strip.
- **Selection widgets — floating in the view pane** — rendered straight
  from the model layer as an overlay stack inside the pane (see Layout).
  The facts adapter (`factsFromSelection`) reads the real
  `EditorSelection`; the applied-state lines are read from the selection's
  own component fields — the only state this slice claims. Widget tabs
  reuse the Phase A `merged-modals` tab bar. Actions render their declared
  input fields inline (see Widget inputs).
- **Add-shelf strip** (docked at the pane's right edge) — the
  "available to add" catalog for the selection, plus the server-status
  line and the shared intent ("why") field the widget actions also use.

Every other workspace is the **Developer surface** (data/IDE tooling over the
same pipeline); two left-dock titles say so ("Tables · Developer surface",
"Schema · Developer surface") as the labeling pattern to extend.

### Layout — panels embedded in the view pane, widgets floating in it (Joey, 2026-10-24 evening)

Joey's direction, naming his reference set — *"embed the panels into
the viewport pane… like other editors like VSCode and Blender and
Unity and PlayCanvas"*: the workspace columns are gone. The workspace
is **one view pane** (a single framed canvas), and the panels dock
**inside** it, at its edges:

- **Left edge, inside the pane — the hierarchy dock** (Find): VSCode's
  sidebar / Unity's Hierarchy docked against the scene view. Scene
  picker, containment tree, role filters, saved views.
- **Right edge, inside the pane — the add-shelf strip** (Act): the
  "available to add" catalog — what could be established on the
  selection — plus the server-status line and the shared intent
  ("why") field. It stays docked: it is a catalog, not a selection
  widget. (The selection widgets themselves are NOT here — see the
  next bullet.)
- **Top, inside the pane — the identity bar**: the selected object's
  name, kind, id and hierarchy path, spanning the pane's full width,
  with the two dock toggles at its ends.
- **Bottom, inside the pane — the provenance strip**: the session
  history (5W1H + dispatch outcomes) as a collapsible strip, like
  VSCode's panel/console.
- **Floating in the pane — the selection widgets** (Joey's refinement,
  same evening): the widgets are not docked anywhere. When the shared
  selection lands on an object — a hierarchy pick here, or an object
  picked in Scenes — its contextual widgets appear as a **floating
  card stack inside the pane**, absolutely positioned over the
  viewport-focus zone and anchored toward its right-center, so they
  read as summoned by the object; the layout never reflows for them.
  The stack scrolls itself when tall (inset-bounded, its own
  overflow). A **× dismisses** it until the selection changes or the
  object is clicked again — dismissal is view state only; the
  selection is untouched. With nothing selected, nothing floats: the
  pane shows its plain stage. This restores Joey's original
  2026-10-17 design — *"clicking a game object summons contextual
  widgets/modals within the viewport"* — which the docked slices had
  temporarily traded for columns. No drag-to-move in this slice.
- **The center is the pane's own middle** — the relationships /
  viewport-focus zone — unobstructed and dominant (the floating
  widgets overlay it; they do not displace it). The docks sit at its
  edges; they are not columns beside it. Both docks and the
  history strip **collapse** (edge toggles in the identity bar; the
  strip's own header), and collapsing returns the width/height to the
  center zone. Collapse state persists in local prefs
  (`authoring-embedded-panels`), like the presentation pins. The rule
  of thirds now governs composition inside the pane (identity /
  viewport-focus / provenance down its height; the work still flows
  left → right: find, see, act).
- **History of the layout:** fixed rails (288px / flex / 320px) →
  equal-thirds columns → centered quarter/half/quarter grid →
  embedded panels → floating selection widgets. Each step is Joey's
  refinement of the last. The Legacy presentation is untouched by
  all of it — it keeps its own original two-panel layout behind its
  pin, as designed.
- **What this does NOT do:** the panels are embedded, and the widgets
  float, within the Design workspace's view pane — none of it is an
  overlay on the real-time 3D render. The stage is still a panel; the
  live 3D viewport stays in the Scenes workspace (selection shared).
  Making the stage itself the 3D viewport — the widgets floating over
  the actual render — is future work (see gaps).

## Widget inputs — real fields for widget and shelf actions

The dispatch slice's blocker was placeholder params: the widgets
emitted an empty def, amount 0, an empty template, x/z of 0,0, and the
mapper honestly refused them all. Actions now declare their input
fields as data (`authoring/inputs.ts`), the view renders compact
inline fields on the action row, and the chosen values flow into the
call's params (`callWith` for widgets, `shelfActionParams` for the
shelf). The dispatch mapper remains the single gate: an unfilled or
invalid field still records and still reads the mapper's refusal.

| Action (verb) | Field | Data source | Offline behaviour |
|---|---|---|---|
| Give item (giveItem) | Item base picker | Gameplay snapshot refs — `content/rules/items.json` base names, via `loadGameplay()` (the editor's dev host) | List loads without a play server; the give itself records offline, as before |
| Give gold (giveGold) | Gold amount (number) | Typed by the designer | — |
| Grant quest reward (grantQuestReward) | Item base picker + gold amount | Same picker + number; params compose into the mapper's give + gold steps | Same |
| Change template (attachVendor) | Vendor template picker, prefilled with the current template | Admin `vendor {sub:"list"}` on the running server — only templates DEFINED there (content/vendors.json templates are defined lazily, when a scene names one or an admin defines one), refetched when the link goes live and after vendor dispatches | Picker disabled with the note "Vendor templates live on the running server — start it to list them." |
| Spawn pack / Spawn creature (spawnPack / spawnCreature) | Creature kind picker, prefilled with the selected creature's kind | Gameplay snapshot refs — `content/rules/creatures.json` kind names (the registry the server's spawn command checks) | List loads without a play server; the spawn records offline |
| Teleport (teleport) | X / Z numbers, prefilled from the selected object's Transform position when the selection carries one, editable before dispatch | The selection itself (scene-node transform / Transform fields) | — |
| Dungeon "Give item reward" (giveItem) | Item base picker | Same item-bases source | Same |
| Take item (takeItem) | Item base picker (takes one of that base) *or* an item instance id (number) — the id wins when both are filled | Item-bases picker (same source) + typed id (ids come from give/drop messages and the inventory) | Fields render; the take records offline |
| Move item (moveItem) | Item id + destination character id (numbers) | Typed by the designer (a character's holder id is in its inspect dump's CharacterRef line) | Same |
| Count base (countBase) | Item base picker | Same item-bases source | The read records offline |
| Def of item (defOf) | Item id (number) | Typed by the designer | Same |
| Shelf "Place as item" (placeItemFixture) | Item base picker + X / Z numbers prefilled from the selected object's position | Item-bases picker + the selection itself | Same |

Two targeting truths the inputs surfaced, stated on the actions
themselves in the UI: admin give/gold (and quest rewards, which
resolve to them) act on the **console holder only**, so those actions
build calls for the editor's avatar and say so in a note — a call
naming another character still refuses in the mapper, never silently
redirected. The bag verbs (takeItem, countBase) carry the same truth
and the same style of note; moveItem is the exception its service
signature dictates — the destination is a character (holder) id the
designer types. And admin spawn with no x/z plants at the caller's
avatar, so the spawn actions no longer carry the fake 0,0 — the
placeholder that would have spawned at the world origin is gone.

**Live smoke (2026-10-24, inputs slice):** real server booted in a
scratch dir, the editor's real `BackendClient`, calls built by the
real widget builder with input values exactly as a click produces
them, executed by the real executor. giveItem {base:"sword"} →
dispatched, server: *"gave Flaming Steel Sword (item 1)"*.
attachVendor {templateId:"smoke-shop"} (template defined via admin,
picker list read + parsed from `vendor list`: *"vendors: smoke-shop"*)
→ dispatched, server: *"vendor \"smoke-shop\" attached to 51"*, with
the inspect read-back. spawnPack {kind:"goblin"} → dispatched,
server: *"spawned a pack of 3 goblin"*. The smoke also found that
vendor attach resolves its target with `resolveEntityTarget` — a bare
wire-id lookup with no "me" alias — so attach dispatches for
live-entity selections (whose ids are wire ids) and is refused
("no such target", surfaced as the outcome) for scene-document
selections; see gaps.

**Live smoke (2026-10-24, server-homes slice):** same pattern, for
the verbs that gained admin homes. giveItem {base:"sword"} →
*"gave Vampiric Silver Sword (item 1)"*; defOf {item:1} → read:
*"item 1: Vampiric Silver Sword [uncommon sword] ad9dd3d5a1457722"*;
countBase {base:"sword"} → *"you carry 1 × sword"*; takeItem
{item:1} (the items widget's new action, by instance id) →
*"took Vampiric Silver Sword (item 1) from your bag"*, and countBase
again → *"you carry 0 × sword"* — the bag read-back proves the
removal. placeItemFixture {base:"sword", x:5, z:5} → *"placed
Yrithra, Keen Mithril Sword of the Titan (item 2) as 52 at 5, 5 — a
fixture, it stays"*. addcomponent: a vendor-spawned entity (53) took
the shelf's FlowRef plan through `executePlan` → *"FlowRef added to
53 (graph=0 enabled=1)"*, the inspect read-back showing *"FlowRef:
graph 0 enabled 1"*; the same plan again → refused, *"entity 53
already has FlowRef"*. moveItem is covered at gateway level with two
real characters (the smoke server has one login).

## End-to-end authoring — is the loop completable?

Walked step by step against the built code (2026-10-24; re-walked after
the live-dispatch slice and again after the embedded-panels + widget-inputs
slice, same evening). The skeleton is coherent:
every hand-off uses the same facts, the same shared selection store,
and the same verb/envelope types. Execution is no longer the break:
dispatch is wired for every verb with an honest admin home, and the
remaining breaks are named per verb below — verbs with no admin home
stay unsupported, by design, until the server grows one.

| # | Step | Status |
|---|---|---|
| 1 | Choose the presentation (template pin / rollback) | Live — builtins only |
| 2 | Load a scene | Live (scenes-client; errors surface) |
| 3 | Navigate / filter / save a view of the hierarchy | Live — saved views are session state, not persisted |
| 4 | Select an object | Live — shared `editorSelection`; picking here is picking in Scenes |
| 5 | Relevance summons the widgets | Live — rules 1–18 incl. merged tabs; the widgets float in the view pane, summoned by the selection (dismissible, re-summoned on the next pick) |
| 6 | Read what's applied | **Partial** — selection-local component fields, PLUS the live `inspect` read-back (its lines join the widgets when the read-back's target is this selection); still not live system reads (vendor stock, dialogue graphs, abilities). On live-entity selections the selection-local lines are also the edit surface (step 8's per-field edits) |
| 7 | Add what's missing (add shelf) | **Live for ECS-shaped additions** — establishability is live; verb-shaped shelf actions dispatch with real input fields (step 8); component-shaped additions dispatch as `addcomponent` steps (the server adds the component at its defaults) for every shelf name that is an ECS component — Health+Stamina, CharacterRef, PlayerIntent, FlowRef, VfxEmitter, AudioEmitter, and Collider (whose ECS form is BodyConfig). **Unsupported, with reasons:** QuestGiver and DungeonEntrance — scene-document names with no ECS component to add (see gaps) |
| 8 | Act (widget CRUD) | **Live for verbs with an admin home** — dispatched over the shared server link with the outcome recorded beside the call. Actions render real input fields (item-base / creature-kind / vendor-template pickers fed by real lists, amount and coordinate numbers with Transform prefills), so the dispatching verbs dispatch from clicks with designer-chosen values — live-smoked end to end (give, vendor attach, spawn, and — after the server-homes slice — take, countbase/defof reads, addcomponent). Dispatching: giveItem & giveGold (console holder only), takeItem & moveItem (the `items` bag sub-actions — console holder's bag; moveItem's destination is a character id), spawnCreature/spawnPack, teleport, attachVendor/detachVendor, placeItemFixture (`drop` at an exact position, as a fixture), grantQuestReward (composite give+gold, console holder); reads: resolveBase, defOf, countBase (via `items`). The non-verb affordances dispatch too, as plans through the same executor: the flow widget's unbind (`removecomponent`), per-field edits of applied-state lines on live-entity selections (`set` — scene selections stay read-only), and the vendor widget's stock action (`vendor stock`, by exact def name; template must already be defined). **Unsupported, with the reason:** startDialogue alone — dialogue is player-initiated and no honest admin trigger exists |
| 9 | Provenance history | **Partial** — in-memory session log, per-object, now carrying each call's dispatch outcome + server message; not persisted / not VCS metadata |
| 10 | See the result | **Partial** — a dispatched mutation re-inspects its target and the stage shows the read-back dump (and the widgets absorb it when the target is the selection). Seeing it in the 3D viewport is still a **gap** — viewport is in the Scenes workspace; no in-place 3D feedback, no viewport overlays |
| 11 | Quick-start procgen parity | **Gap** — converges by construction via scene docs; no rule-editor widget |

**Verdict:** the loop is completable end to end for the verbs the
admin surface honestly implements — find, select, intend, dispatch,
and see the read-back — and it stops, explicitly and with reasons, at
startDialogue (no admin home exists) and at the two shelf names that
are not ECS components (QuestGiver, DungeonEntrance). What remains
(3D-viewport feedback, persistent history, procgen rule editing, live
system reads) is depth, not viability.

## Live dispatch — how a VerbCall reaches the world

`apps/editor/src/authoring/dispatch.ts` (pure mapper + executor, tested
in `authoring-dispatch.test.ts`). A VerbCall maps to a **DispatchPlan**:

- `{ kind: "admin", command, args }` — one real admin command
  (`give`, `gold`, `spawn`, `teleport`, `vendor attach/detach`,
  `items` bag sub-actions for takeItem/moveItem, `drop` with an exact
  position + the fixture flag for placeItemFixture, `addcomponent`
  for shelf component additions, `removecomponent` for component
  removals — the flow widget's unbind, `set` for per-field edits of
  applied state, and `vendor` `stock` for the vendor widget's stock
  action — the last three are plan-shaped affordances, not canonical
  verbs, built by `removeComponentPlan` / `fieldEditPlan` /
  `vendorStockPlan` in the same mapper).
- `{ kind: "composite", steps }` — an honest sequence
  (grantQuestReward → repeated `give` steps + `gold` steps, in order;
  a refusal stops the sequence and names the step; a multi-component
  shelf addition → one `addcomponent` step per component).
- `{ kind: "read", command, args }` — a query, not a mutation
  (resolveBase → `items` browse; defOf / countBase → the `items`
  command's read sub-actions).
- `{ kind: "unsupported", reason }` — no admin command honestly
  implements the verb (the full set + reasons are in Honest gaps).

The executor drives an injectable transport — in the UI, the shared
`serverLink.admin` gated by `useServerLink()`'s phase (no second gate,
no parallel channel); in tests, a fake. It returns a **DispatchOutcome**
(`dispatched` / `refused` with the server's message / `unsupported` with
the reason / `offline` when no server is live) and never reports
dispatched on a refusal or offline. The call's 5W1H "why" stays local
provenance — it is never stuffed into admin args. After a dispatched
mutation the executor re-inspects the acted-on entity through the same
link, and the view shows that read-back in the stage (the reflection
step); when the server isn't running, the action still records and its
outcome reads `offline — nothing was dispatched`.

### Admin home: `removecomponent` (authoring-depth slice)

The flow widget's unbind needed a server home, and it now has one:
admin `removecomponent {entity, component}` (engine-core
`admin/remove-component.ts`, beside `addcomponent` in the same style;
cookbook covers it). It rides bitECS `removeComponent` through the
live world, so queries, systems and `inspect` stop seeing the
component. Refusals: unknown entity, unknown component, component
absent — and **God / Noclip**, which stay with their `god` / `noclip`
toggle commands (the toggles own the session-facing side of those
states, exactly as `addcomponent` leaves the tags to them). No other
guard set: the engine's systems select by component presence
(defineQuery) and its registration-driven subsystems (nav obstacles,
physics bodies) subscribe to enter/exit queries, so removal is a
normal ECS event — despawn itself removes every component through
this path. Like `set`/`addcomponent` it is an admin power tool whose
writes land in the command log.

The same slice's other two affordances needed no new server surface:
per-field edits ride the existing `set` (its whitelist is the gate),
and vendor stocking rides the existing `vendor stock` sub-action.

## The templating system — pseudo version control for presentation

`apps/editor/src/authoring/templates.ts` (pure, tested in
`authoring-templates.test.ts`). A **view template** is data, not code:
`{ id, slot, version, status, definition }` where the definition names a
layout, its panes, and — by reference only — the widget ids it can summon
and the hierarchy role filters it exposes (both validated against the
registries in `relevance.ts` / `hierarchy.ts`). No component code lives in
a template, so a template version can be created, pinned and rolled back
without a build.

- **Version immutability.** Published versions never change. An edit
  creates the next version as a draft; the earlier published version is
  byte-identical afterwards.
- **Status chain.** draft → published → deprecated → retired, one step at
  a time, every transition carrying a 5W1H provenance entry validated by
  the same `validateProvenance` the verb layer uses.
- **Presentation pins decide everything.** A per-project pin map
  `{ slot → templateId@version }` with its own provenance-carrying history
  is the ONLY thing that decides which UI a slot presents. Rollback is
  re-pinning the previous target from that history.
- **Defensive resolution.** The resolver refuses a pin that is unknown,
  draft, retired, or whose definition references an unknown widget/filter,
  and falls back to the last known-good resolution for the slot (or the
  built-in legacy template), reporting the reason. It never yields a blank
  view. A deprecated-but-pinned version still resolves, flagged as
  deprecated. A retired version cannot be newly pinned.
- **Builtins, addressable from day one.** Slot `authoring` has two:
  `legacy-data-editor@1` (published — the old modules/ECS-inspector
  presentation) and `viewport-authoring@1` (published — this view). Both
  are versions 1 of their own template id; the pin, not the code, chooses.

**UI:** the Authoring view's header is the presentation control — it shows
the active template@version + status (plus any fallback reason), and its
pin buttons switch the presented UI for real: *Legacy view* renders the
actual `ModulesPanel` + `EcsInspectorPanel`; *Authoring view* renders this
designer surface; *Roll back pin* re-pins the previous target. Pins are
mirrored to the editor's local prefs (`authoring-presentation-pins`) so a
restart keeps the choice. Pin changes validate provenance through the same
envelope rules as verb calls.

### Retirement playbook (how the old view goes away gracefully)

1. **Register, don't delete.** The old presentation becomes the legacy
   template (done: `legacy-data-editor@1`). It stays fully runnable.
2. **Move the pin.** Retirement of the old view = pinning the slot to the
   new template for the project. That is the whole step — reversible by
   construction.
3. **Grace period.** The legacy template is deprecated (not retired)
   while the pin stays on the new view. If anything regresses, **rollback
   is one pin move**: *Roll back pin* in the presentation control, or
   re-pin `legacy-data-editor@1` — no code change, no rebuild.
4. **Retire.** Only when the criteria below hold, retire the legacy
   version through the gate — which REFUSES while any slot still pins it,
   so retirement can never strand a project on a dead template.
5. **Delete (Phase C only).** The legacy template registration and the old
   panels behind it are deleted when ALL of these documented criteria
   hold: (a) the project pin has been on the new template for the whole
   grace window the team sets; (b) the pin history shows no rollback to
   legacy inside that window; (c) the widget that replaces each old panel
   is live AND dispatching (per the slate below). These are criteria for a
   human decision — no automation performs the deletion.

## Phase C — panel removal slate (nothing deleted yet — see the status column for why)

A standalone panel is removed only when the widget that replaces it is live
**and dispatching** (see gaps). Slated, in order:

| Standalone panel today | Replaced by | Remove when | Status after the authoring-depth slice (2026-10-24) |
|---|---|---|---|
| ECS inspector component tables (Scene workspace, `ecs-inspector.tsx`) | Per-module widgets for the same selection | Widget CRUD dispatches through the verb layer and covers the components the inspector edits | **Blocked** — deletion criteria (a)/(b) unmet (below); (c) met for what the widgets expose: per-field editing now dispatches from the widgets' applied-state lines on live-entity selections (numeric fields via admin `set`, the set whitelist gating; `fieldEditTarget`/`fieldEditPlan` in dispatch.ts). The widgets' applied lines remain selection-local fields + read-backs, not the inspector's full live component tables — the inspector also stays the live-entity picker that feeds those selections |
| Characters workspace Records panel | Merged Character widget (Sheet + Records tabs) | The widget's Records tab renders the panel (Phase A modal already proves the merge) | **Blocked** — (a)/(b) unmet; (c) unmet: the merged widget carries the Sheet + Records tabs, but renders applied-state lines, not the Records panel's record data (no live character-record read feeds it) |
| Story workspace quest & dialog panels | Merged Quests & dialogue widget (Quests + Dialogue tabs) | Same — widget renders both tabs against live quest content | **Blocked** — (a)/(b) unmet; (c) unmet: the tabs render as structure, not against live quest content, and dialogue has no dispatch at all (startDialogue has no admin home) |
| Flow workspace entry point for per-object graphs | Flow widget (FlowRef marker) | Flow binding/unbinding dispatches as component edits from the widget | **Blocked** — (a)/(b) unmet; (c) **met**: binding dispatches (shelf `addcomponent` FlowRef) and unbinding now dispatches from the flow widget itself (`removecomponent` FlowRef, the admin home this slice added) |
| Art & audio panels (per-object emitters) | VFX / Audio widgets (marker-driven) | Emitter attach/edit dispatches from the widgets; scene-level ambient/music stays a scene widget | **Blocked** — (a)/(b) unmet; (c) half met, narrowed: emitter *attach* dispatches (shelf `addcomponent`), and the per-field edit path now exists for emitter fields too (VfxEmitter.template/intensity, AudioEmitter.clip/radius are `set`-writable and field-editable when a selection's applied lines expose them) — but today's live entity picks project only transform/velocity/intent/chunk/health/body through the mirror, so emitter fields do not yet appear on live selections to be edited; the remaining (c) gap is that exposure, not the edit path |
| Modules workspace panels for vendor/economy | Vendor widget | Vendor template attach/detach + stock CRUD dispatch live | **Blocked** — (a)/(b) unmet; (c) **met**: attach/detach dispatch live (proven), and stock now dispatches from the vendor widget (template picker + exact def name + price + qty → `vendor stock`; the template must already be defined on the server — the precondition is named on the action, and an undefined template returns the server's refusal) |

**Why nothing was deleted in this slice (the playbook applied
literally):** playbook step 5 allows deletion only when (a) the
project pin has been on the new template for the whole grace window
the team sets, (b) the pin history shows no rollback to legacy inside
that window, and (c) each replacing widget is live AND dispatching.
No grace window has been set, and pins live in per-user local prefs —
so (a) and (b) cannot be shown to hold for any project today, and
deleting on that evidence would violate the playbook. Every entry
above is therefore advanced to its correct pre-removal state: after
the authoring-depth slice the (c) gaps stand at — flow **met**,
vendor **met**, ECS inspector **met for the fields the widgets
expose**, art/audio narrowed to an exposure gap (emitter fields are
not yet projected onto live selections), characters and story
unchanged (they need live content reads, not dispatch). Deletion
itself still waits on a human setting the grace window: (a)/(b)
remain Joey's call, and no panel was deleted in this slice.

Scene-level panels (Scenes document, HUD layout, region chat) are **not**
slated for removal — the design makes them scene-selection widgets, which is
a re-homing, not a deletion.

## Honest gaps in this slice

- **Dispatch covers only what the admin surface honestly implements.**
  `apps/editor/src/authoring/dispatch.ts` maps each VerbCall to the real
  admin commands (gateway `onAdmin` + `packages/engine-core/src/admin/`)
  and executes them over the shared `serverLink`; outcomes are
  dispatched / refused (server message carried) / unsupported / offline,
  never faked. After the server-homes slice, the unsupported verb set
  is one: **startDialogue** (dialogue is player-initiated through the
  quest channel; no honest admin trigger exists, and none was faked).
  The bag verbs and reads ride the `items` command's sub-actions
  (take / move / defof / countbase, through ItemService — bags are
  never edited around the service), and placeItemFixture rides `drop`
  with an exact position and the fixture flag (ItemService.placeFixture).
  **giveItem / giveGold / grantQuestReward / takeItem / countBase**
  act on the console holder only — the admin commands take no
  character target — so a call naming another character is
  unsupported, never silently redirected; moveItem is the exception
  by its service signature: its destination is a character (holder)
  id, and its source defaults to the console holder. **Component-shaped
  shelf additions dispatch** through the server's `addcomponent`
  command for every shelf name that is an ECS component (Health,
  Stamina, CharacterRef, PlayerIntent, FlowRef, VfxEmitter,
  AudioEmitter — and Collider, whose ECS form is the BodyConfig the
  scene spawner writes). Two shelf names are not ECS components and
  stay unsupported with the reason: **QuestGiver** (a scene-document
  role resolved at scene spawn by placing a quest post) and
  **DungeonEntrance** (a scene-document kind marker; no such component
  exists in the engine). The placeholder-params gap is **closed** for
  widget and shelf actions: they render real input fields (see Widget
  inputs) and dispatch with designer-chosen values, live-smoked.
  What remains narrow, honestly: the vendor-template picker lists
  only templates DEFINED on the running server (the server defines
  content/vendors.json templates lazily); vendor attach/detach and
  `addcomponent` resolve their target by bare wire id, so they
  dispatch for live-entity selections and are refused — with the
  server's refusal as the recorded outcome — for scene-document
  selections, whose ids are node ids; and takeItem's widget offers a
  base picker or an instance id (the service's take-by-instance is
  the precise form; take-by-base destroys one of that base). The
  authoring-depth slice's plan-shaped affordances carry their own
  exact limits: vendor **stock** addresses defs by exact name (a
  typed field — the editor holds no def-name list, and admin stock
  has no base arg), needs the template already defined on the
  server, and has no read-back — `vendor list` names defined
  templates, not their stock, so the stock dispatch reply is the
  confirmation; **removecomponent** refuses God/Noclip by name
  (their toggle commands own them) as well as absent components.
- **Per-field edits ride selection-local lines, on live entities
  only.** A widget's applied-state line edits only when it exposes
  one numeric field (`Component.field: value`, the selection-local
  shape) and the selection is a live server entity (an entity-list
  pick with a wire id) — scene-document selections stay read-only,
  and the card says so. Live read-back lines are reflections, not
  editors (the inspect dump packs fields under display labels).
  Which components a live pick exposes is bounded by the mirror's
  projection (transform / velocity / intent / chunk / health /
  body today): emitter fields (VfxEmitter, AudioEmitter) are
  `set`-writable and field-editable in the model, but do not yet
  appear on live selections to be edited.
- **Stage is not the viewport.** The panels are embedded in the
  Design workspace's view pane (docks at its edges, collapsible) and
  the selection widgets float inside that pane, summoned by the
  selection — but the pane is still a panel: the real-time 3D render
  stays in the Scenes workspace; selection is shared, but widgets do
  not yet render as overlays on the 3D view itself, and a dispatch's
  result is reflected as an inspect read-back in the pane — not yet
  as a change you watch happen in 3D. The floating stack has no
  drag-to-move yet, either.
- **Applied state is selection-local, plus read-backs.** Lines come from
  the selection's component fields and — after a dispatch — from the
  live `inspect` read-back for that target; they are not live system
  reads (vendor stock, dialogue graphs, abilities). The widget builder
  already accepts caller-supplied state per widget; live readers are
  future work per module.
- **Hierarchy references are only as good as the data.** Scene documents
  carry containment and component facts; quest→giver / vendor→template /
  patrol edges appear when node data carries them (the model supports them;
  today's scene-doc adapter has none to read).
- **History is in-memory.** The `VerbHistory` lives for the editor session;
  persistence, VCS commit metadata, and concurrent-edit surfacing from the
  design are not built.
- **Templates are builtins-only in this slice.** The registry, pins and
  resolver are fully general and tested with hand-registered templates,
  but the UI ships the two builtin templates and pin/rollback controls —
  there is no template editor (creating/editing template versions from the
  UI) yet, and template definitions are not persisted to project files;
  pins are the only presentation state persisted (local prefs).
- **Procgen quick-start is not in this slice.** Hand-place and procgen
  converge on the same facts/widgets by construction (a baked scene doc
  loads identically), but the rule-editor widget is future work.
