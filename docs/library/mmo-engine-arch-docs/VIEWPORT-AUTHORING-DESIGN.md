# Viewport-Only Authoring Design

Joey's direction, 2026-10-17. Companion to `MODULE-AUTHORING-AUDIT.md` (the audit this
design is grounded in — every relevance rule and verb below traces to a file path there).

## Governing principle: separation of concerns, at two levels

Everything in this design is one principle applied twice.

**Functional** — the code separates *mechanism* from *criteria*. The engine owns
generics (verbs, systems, templates); content owns the operating criteria (which items,
what prices, which dialogue). A hard-coded value is the violation: a number in code
that should have been a parameter. The verb layer, the narrow module interfaces, and
the promote-to-generic rule for chronic conflicts are the functional implementation.

**Operational** — the workflow separates *roles* from each other. Designers author
content through the viewport; developers build mechanisms through the IDE. Neither
reaches into the other's layer: designers never edit code to change a price,
developers never hand-edit content to fix a system. Per-feature branches, the 5W1H
envelope, and the two-surfaces-one-pipeline invariant are the operational
implementation.

When the separation holds, the levels reinforce each other: a designer configuring a
vendor template exercises the functional separation (criteria, not mechanism), and the
provenance envelope records it at the operational level (who, why, when). When it
breaks — a hard-coded value, a shared branch, an anonymous mutation — both levels feel
it.

## Engine vs. editor: different optimizations

The engine and the editor serve different consumers, and each optimizes for its own.

**The engine** is machine-facing: separation of concerns, DRY, SOLID, Event Driven
Backend (EDB) on a DDA, ECS-friendly, highly performant. Architectural excellence with
zero compromise for human convenience — the engine's job is to be fast, clean, and
correct.

**The editor** is human-facing: it optimizes the designer's entire workflow — seeing,
navigating, and changing the game with minimum friction. It never asks the engine to
be less of an engine; it asks the engine to present itself well.

The verb layer is the contract between them: the engine exposes capabilities, the
editor makes them authorable. Neither side borrows the other's job — the engine
doesn't do UX, the editor doesn't do architecture.

## Engine vs. game: the packaging split

The engine/game boundary is the same mechanism-vs-criteria split, one level up.
**Engine** = code, schemas, loaders, systems, the verb layer. **Game** = content
packs (rules, quests, dungeons, items, creatures, dialog) that configure the
engine's generics. Verified 2026-10-17: the functional separation already exists —
`content/*.ts` files are Zod-validated loaders reading `content/<domain>/` JSON dirs,
`MMO_RULES` env overrides the rules dir, `rankOrder`/`starterBase` are injectable
`ItemService` config, not hard-coded. The coupling is packaging, not architecture:
the engine repo ships a full game content set and defaults to it, so there is no
bright line between "the engine" and "our game."

The fix, in order: (1) declare the boundary — engine ships zero game content (sample
pack only, clearly marked); (2) extract the repo's `content/` into the game content
pack, selected via the existing `MMO_RULES`/content-dir seams; (3) audit engine code
for hard-coded content-ID assumptions (systems that presume a specific species, item,
or quest exists break the boundary silently).

## The principle

**Selection summons modules.** The 3D viewport is the entire authoring interface. Clicking
a game object opens contextual widgets inside the viewport — one per relevant module —
each showing what's already applied to that object, with CRUD to edit it. Modules have no
standalone UI presence: no module browser, no module panels, no navigation to maintain.
The viewport plus selection state *is* the navigation.

## Framing principles

**1. Name who's doing the work.** Every workflow, widget, and verb call names its actor:
designer (viewport surface) or developer (IDE/data surface). The surfaces are
role-based, not skins. When we spec a widget, we say who it's for and what they need —
never a generic "user."

**2. The 5W1H of every action.** Every mutation through the verb layer carries its
provenance: who (actor identity/role), what (which verb), when (timestamp/session),
where (the target object's place in the scene hierarchy), why (the calling intent —
quest reward, vendor stock, hand tweak, procgen run), how (the verb and its parameters).
Authored content is never anonymous. This is what keeps multi-designer projects sane,
and what lets a designer ask "why does this blacksmith sell that sword?" and get an
answer instead of a shrug.

Provenance is load-bearing, not decorative — the tool is going collaborative, and the
5W1H envelope is what version control, auditing, and concurrent editing stand on:

- **Mandatory envelope.** No verb executes without actor, intent, timestamp, target,
  and parameters. The verb layer rejects anonymous mutations.
- **History lives with the content.** Every authored entity and relationship carries
  its change chain — not just current state, but who changed what, when, and why.
- **Queryable.** Per-object history ("every change to this vendor"), per-actor
  activity, exportable audit log.
- **Version control native.** Content changes map to VCS commits/branches with the
  envelope as commit metadata — the content-side complement to the Dev IDE's Ghost
  Sync attribution. `why` becomes the commit message; `who`/`when` become the author
  line.
- **Concurrency without silence.** When two designers touch the same object, provenance
  makes it visible and attributable. Last-writer-wins is never silent — the loser sees
  who, what, and when.

**3. Start from need, not capability.** The UI is organized around designer intents ("I
want this NPC to sell things"), never engine nouns ("VendorSystem"). The add-shelf is
the pattern: the engine advertises what it can do for the selected object, in the
designer's language. When a need has no engine answer yet, that gap is visible — it's
the signal to promote a new verb, not a silent dead end.

**4. Visibility is king.** Moving through the hierarchy of objects *and their
relationships* within a scene is first-class. The hierarchy view renders containment
(scene → building → room → chest) and reference relationships (quest → giver,
vendor → template, creature → patrol route, dialogue → quest) alike. Navigation is
relationship-following: click the quest, see its giver; click the giver, see their
dialogue. The designer never loses the thread of how things connect.

## The click flow

1. **Select.** Click an object in the viewport, or pick a node in the hierarchy.
2. **Evaluate relevance.** The editor runs each module's one-line relevance rule
   (audit §5) against the selection. Rules are cheap predicate checks against components
   and system lookups the code already exposes — e.g. `VendorSystem.vendorOf(entity)`,
   `CreatureSystem.kindOf(entity)`, `Has(Health)`.
3. **Render widgets.** One widget per matching module, stacked as viewport modals/docked
   cards. Clicking a rock yields transform + physics only. Clicking the blacksmith yields
   vendor, dialogue/quests, creature, character, combat widgets — because the rules say so,
   not because the designer went looking.
4. **Edit.** Each widget shows current applied state first, CRUD second. Every mutation
   goes through the shared verb layer (§5 of this doc), never around it.

## Widget anatomy

Every contextual widget has the same three zones:

- **What it is** — one-line identity: "Vendor · Blacksmith Mara · template `weapons-tier2`".
- **What's applied** — current state read live from the systems: stock lines and prices,
  dialogue nodes attached, abilities granted, patrol route, etc. Never a blank form.
- **CRUD** — add/remove/edit affordances scoped to that widget: add a stock line, detach
  the vendor template, attach a new dialogue graph, grant an ability.

Two widgets merge into one modal with tabs (audit §3): character/characters and
quests/story each claim the same selection today. One click, one modal.

## Available modules (the add shelf)

Each selection shows two groups:

- **Applied** — widgets for modules whose relevance rule matches (above).
- **Available to add** — modules whose rule doesn't match but *could*, with a one-click
  affordance that establishes the precondition: "Add vendor" (attaches a template via
  `VendorSystem.attach`), "Add combat" (adds Health/Stamina components), "Add flow
  behavior" (binds a flow graph, once the marker exists).

Availability isn't universal — a rock can't take the character sheet. Each relevance rule
gets a companion *establishability* check grounded in the same code: if the precondition
is something the editor can create (attach template, add component, bind graph), the
module appears in the available list; if the object kind can never satisfy it, it stays
hidden. This gives designers discovery for free: instead of knowing the engine has a
vendor system, they click the NPC and see "Vendor — not applied · Add". The engine's
capabilities advertise themselves through the selection.

## The hierarchy

The scenes module *is* the hierarchical breakdown view — scene → region → POI → object —
not an object widget. Selecting at any level of the hierarchy summons the scene-level
widgets (chat channels, ambient audio, trade/auction config, HUD is global-only and never
selection-driven). Drilling down narrows the relevance evaluation to the selected node.

**Sorted and filtered views.** The hierarchy is sortable, filterable, and groupable by
role: environment components, characters, quest givers, loot spawners, mob spawners,
vendor NPCs, dungeon entrances — any relevance rule doubles as a filter. "Show me every
quest giver in this region" is a one-click view; picking from the list jumps the
viewport to the object and summons its widgets. Views are saved per project, so the
designer builds the slices they navigate by ("all spawners," "vendors needing stock
review"). The 5W1H provenance feeds this too: sort by recently modified, filter by
"everything Mara touched this week." Knowing where every component lives is what makes
editing them easy — the hierarchy answers "where" before the designer has to ask.

## The verb layer

The authoring layer speaks **only** the 13 shared verbs (audit §4). A quest reward, a
vendor sale, a loot drop, and an admin `give` are four call sites for `giveItem`, not four
features. The "give the player something" widget is one widget reused by four workflows.

This is what kills the duplication class Joey suspected: there is exactly one place that
knows how to give/take/move/count items, and every widget resolves to it.

## Build order

**Code first (small, mechanical):**
1. Promote the 5 verbs from inline adapters to `ItemService`/defs (audit D1–D5):
   `defOf`, `moveItem`, `takeItem`, `countBase`, `resolveBase`. Delete the duplicated
   lambdas in `server.ts`. No behavior change — pure extraction.
2. Add the 3 missing per-object markers so flow, vfx, and audio can join
   selection-driven UI: a flow-binding ref, an emitter ref, an audio-emitter ref
   (audit §5, relevance gaps). Until these exist, those three stay scene-level.
3. Merge the widget pairs (character/characters, quests/story) at the UI layer.

**Then widgets:** one contextual widget per module per the relevance rules, each wired to
the verb layer. Server modules first (rules already code-grounded); flow/vfx/audio after
their markers land.

**Then removal:** delete the standalone workspace panels as their widgets come online.
No panel is removed until its widget replacement is live — the editor never regresses.

## What this replaces

The current data-heavy editor: hunt through panels, edit raw components, hand-wire
connections the engine already understands. Under this design the designer never sees a
component table unless they ask for it — they see the blacksmith, what's applied to her,
and the verbs to change it. Coding becomes the exception: custom logic that no verb
covers yet, which is the signal to promote a new verb.

## Two authoring modes, one object model

**Hand-author:** drag an archetype or object into the viewport. It loads, selection
summons its widgets, you configure it — applied state, CRUD, add shelf, as above.

**Quick-start procgen:** rule-based generators (village, dungeon, forest, encounter
zone) populate the scene from authored rules plus a seed. The rules are completely
authorable — designers tune them through a rule editor, itself a scene-level widget
(rules are content: applied state + CRUD like everything else), no code. Deterministic:
same rules + same seed = same scene, re-rollable at will.

**The convergence rule:** both modes produce identical scene objects. A procgen'd
blacksmith and a hand-placed blacksmith are indistinguishable to the widget layer —
same vendor widget, same CRUD, same add shelf. If procgen emits something the widgets
can't edit, that's a bug, not a feature.

**Composition:** the modes mix freely. Procgen a village, hand-tweak the tavern,
hand-place the quest giver, procgen the surrounding forest. Hand-authored objects act
as constraints/pins for later procgen runs ("keep my placed buildings, fill in the
rest"). The existing procgen stack — style profiles, WFC settlement layout, the
population pipeline — becomes rule packs the quick-start generators draw on, rather
than separate systems the designer must learn.

## Two surfaces, one pipeline

The viewport authoring tool is the **designer surface**: simple, minimalist,
view-based, full control over designing the game, no code. Developers get the
**developer surface**: the Dev IDE plus data-focused helper tooling (DB CRUD forms,
backend layer inspectors) for interacting with every layer directly.

The invariant: both surfaces resolve to the **same verb layer and the same validated
data pipeline**. "Add vendor" in the viewport and a vendor-template row edit in a DB
form are two doors into `attachVendor` — never separate formats that can drift apart.
Designers get simplicity; developers get depth; the engine sees one pipeline.

## Collaboration: branches and the conflict signal

**No shared branches.** Every feature automatically creates its own branch — no
developer works on a shared branch, ever. This extends the Dev IDE's Ghost Sync model
(auto-branch per script) to all work including content changes, whose 5W1H envelope
becomes the commit metadata. "Who's messing with what" is structurally impossible:
your branch is yours until merge, and merge requires a green pipeline plus a clean
rebase.

**Chronic conflicts are a code smell, not a process problem.** If the same files keep
conflicting, the codebase is saying something: values are hard-coded where a generic
should exist. The fix is never "merge more carefully" — it's to extract the hard-coded
value into a configured generic (a template, a rule, a parameter) that accepts its
operating criteria.

This is the same fix as the entire authoring design. A hard-coded vendor inventory
causes dev merge conflicts; promoting it to a vendor template makes it
designer-authored content with full 5W1H provenance. The collaboration problem and the
authoring problem converge: **things developers fight over in merges become things
designers configure in widgets.** Code holds the generic; content holds the criteria;
provenance records who set what.
