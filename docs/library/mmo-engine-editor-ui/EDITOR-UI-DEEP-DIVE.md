# Editor UI — Deep-Dive Companion

**Date:** 2026-10-05
**Status:** Research companion. Evaluations and proposals, not build orders.
**Relation to the program:** Companion to `COMPREHENSIVE-EDITOR-BUILD-PLAN.md`
(slices 1–10) and the October 2026 editor UI mockups. Each section takes one
suggestion area from the mockup review, grounds it in supporting code,
scholarly/first-hand sources, and real implementations, and ends with
concrete acceptance criteria a builder can execute against. Append-only:
add sections; do not rewrite existing ones without Joey.

**How to read:** §1–§3 are the architectural bets (navigation, time-travel,
collaboration). §4–§8 are per-view deep dives (FX lab, command palette, data
version control, localization, combat timeline). §9 is craft. The Works Cited
is MLA, matching the shader R&D bundle's convention.

---

## §1. Cross-panel deep linking: everything is a hyperlink

### §1.1 The idea

The mockups show isolated panels that reference each other's data: the
scenario replay names "bot 7 stuck at 431, 0, 188"; the audio event lists
"fired by: sword.slash · hit frame 13"; the quest graph names dialog beats;
the database names entities. Today those are dead text. The proposal: every
entity ID, tick number, coordinate, and content path in every panel is a
live link that navigates to the relevant panel with the relevant target
selected — bot 7's failure opens the viewport teleported to (431, 0, 188)
with the replay loaded; frame 13 opens the combat timeline scrolled to the
hit frame; a quest step opens its dialog beat.

This is not decoration. In a tool with 10+ views over one world, navigation
*is* the workflow. The cost of a panel-per-task UI without deep linking is
paid on every debugging session: the user becomes the router, carrying IDs
in their head between panels.

### §1.2 Supporting sources

The navigation grammar for this already exists in developer tools. VS Code's
Quick Open uses a unified input with sigil sub-modes (`>` commands, `@`
symbols, `#` workspace symbols, `:` lines) inside one fuzzy-matched field,
with a top-50 MRU bucket floating recents (Eugenelim; Jasoniwu). Sublime
Text's Goto Anything pioneered combinable operators (`tp@rf` — file matching
"tp", then symbol matching "rf") with instant navigation as you type
(Jasoniwu). The transferable lesson: **one addressing scheme across many
targets, with instant feedback and recency weighting.**

For the editor, the addressing scheme is the world's own coordinate system:
`entity:<id>`, `tick:<n>`, `pos:<x,y,z>`, `content:<path>`, `quest:<id>`,
`anim:<clip>@frame<n>`. A central `navigateTo()` intent in the controller
layer (per the plan's MVC contract — views emit events, controllers own side
effects) resolves these addresses to panel + selection state.

### §1.3 Implementation sketch

```ts
// Model: a link is data, not a component
type EditorAddress =
  | { kind: 'entity'; id: string }
  | { kind: 'tick'; n: number; scenario?: string }
  | { kind: 'position'; x: number; y: number; z: number; region?: string }
  | { kind: 'content'; path: string; field?: string }
  | { kind: 'animFrame'; clip: string; frame: number };

// View: one link component used by every panel
function EntityLink({ id }: { id: string }) {
  const nav = useNavigation(); // controller hook
  return <button className="link" onClick={() => nav.go({ kind: 'entity', id })}>{id}</button>;
}

// Controller: resolves address → { panel, selection }, restores prior layout on "back"
```

The dockview-react shell (locked in the build plan) already supports
programmatic panel focus and state; the work is the address registry and the
discipline that every panel renders addresses through the link component
instead of plain text.

### §1.4 Acceptance

- From any panel, one click on any entity/tick/coordinate/content reference
  reaches the owning panel with the target selected and visible.
- A "back" affordance returns to the originating panel and selection.
- New views added under the plan's slice process must register their
  addressable targets; the plan's PR checklist gains a "deep-link coverage"
  item.

---

## §2. Time-travel debugging: scrub the live world

### §2.1 The idea

The mockups already contain two-thirds of a time machine: the scenario
replay has a tick scrubber (tick 4,812 / 6,000), and the database panel has
the append-only event ledger (128k rows). The proposal: scrub the **live
world** — not just a recorded scenario — back to any recent tick, inspect
full state (characters, positions, ledger, assertions), then release back to
live. No game editor does this well; the engine's architecture makes it
feasible.

### §2.2 Supporting sources

**Event sourcing (Fowler).** Martin Fowler's pattern captures "all changes
to an application state as a sequence of events," with three facilities that
map exactly onto the proposal (Fowler, via Chichasescheese):

1. **Temporal Query** — "determine the application state at any point in
   time... by starting with a blank state and rerunning the events up to a
   particular time."
2. **Complete Rebuild** — "discard the application state completely and
   rebuild it by re-running the events from the event log."
3. **Event Replay** — reverse a past event and replay later events to compute
   corrected consequences.

The engine's ledger is already an event log; the mockup's "1,284 events
flushed · checkpoint" is the vocabulary of event sourcing. The editor needs
only the query side: given tick T, materialize state.

**GGPO / rollback netcode.** The fighting-game rollback model (GGPO, 2006;
standard in Street Fighter 6, Guilty Gear Strive) requires exactly three
game-supplied primitives: `save_game_state`, `load_game_state`, and
`advance_frame` (Gregorik). The library rewinds to a saved frame, applies
corrected input, and re-simulates. The editor's time-travel is the same
shape without the networking: save periodic snapshots, load on scrub,
re-simulate forward to the inspected tick. The Roblox rollback-netcode
implementation states the contract plainly: "You supply a deterministic
`simulate(state, p1Input, p2Input)` function. The library handles everything
else" (Kingpinged).

**Seeded determinism.** The engine already treats determinism as a
first-class property: "a pure, seeded game engine gives you multiplayer
almost for free... the server does not reimplement any rules" (Mighty840),
and the sim-lab work targets bit-identical reproduction. Determinism is
what makes re-simulation from a snapshot trustworthy — the same inputs
reproduce the same state, so the inspected past is the actual past.

### §2.3 Implementation sketch

```ts
// The debug channel (protocol-v3, read-only per the build plan) streams:
//   - snapshots every N ticks (ring buffer, e.g. 10 min)
//   - the event/ledger stream between snapshots
// Scrubbing to tick T:
async function inspectAt(tick: number) {
  const snap = snapshotRing.nearestBefore(tick); // binary search
  let state = snap.state;
  for (const e of ledger.between(snap.tick, tick)) state = applyEvent(state, e);
  return state; // rendered read-only; live sim untouched
}
```

Cost control: snapshots are the memory budget (state size × ring depth);
the ledger between snapshots is the CPU budget (replay length). Tune the
snapshot interval so worst-case replay stays under ~200ms — the scrub must
feel instant. The editor never writes live ECS state (locked in the plan);
the inspected state renders in a fenced read-only mode with the viewport
tinted, reusing the play-mode tint pattern from the mockups.

### §2.4 Acceptance

- Scrub to any tick within the retention window (default: last 10 minutes
  of the live session); full state inspectable (characters, positions,
  ledger slice, assertion results at that tick).
- Worst-case scrub latency < 200ms on the reference machine.
- "Resume live" returns to the live tick with no state pollution; the
  inspected past is visually distinguished (tint + badge) at all times.
- Determinism audit: re-simulating from a snapshot reproduces the recorded
  ledger hash — a failing audit surfaces as a data-integrity warning, not
  a silent wrong past.

---

## §3. Collaborative presence and conflict model

### §3.1 The idea

The mockups show the hard parts of multi-user editing already designed:
a locks panel ("terrain tile 0,0 — Sam · since 10:14 — read-only") and a
semantic conflict resolver (goblin aggro: base 12, yours 14, theirs 16,
with Keep/Take). The proposal adds the cheap, high-feel layer on top:
Figma-style presence — collaborator avatars in the viewport at their camera
position, colored selection outlines on rows they're editing — and adopts
an explicit conflict model for everything the locks don't cover.

### §3.2 Supporting sources

**Figma's multiplayer (first-hand).** Figma's co-founder Evan Wallace
documented the design in "How Figma's multiplayer technology works" (2019).
The key decisions, as reconstructed from first-hand analyses (Devopsdaily;
Sujeet):

- **Rejected Operational Transforms** as too complex to reason about
  (transform functions grow quadratically with operation types).
- **Not true CRDTs either** — "Figma isn't using true CRDTs." CRDTs buy
  decentralization; Figma *has a central server* (the referee), so they
  kept the shape and dropped the overhead (no vector clocks, no tombstone
  GC).
- **The document is `Map<ObjectID, Map<Property, Value>>`** and the server
  holds the latest value per property per object — a last-writer-wins
  register. Conflicts exist only between two writes to the *same property
  on the same object*. Granularity does the heavy lifting: two people
  editing different properties of one rectangle never conflict.
- **Optimistic local updates** with suppression of conflicting server
  echoes (otherwise the winner watches their object flicker).
- **Fractional indexing** for sibling ordering.

The transferable principle: **match conflict granularity to the domain.**
The engine's content is already property-granular (creatures.json rows and
fields, quest steps, emitter params) — LWW per property per object is the
natural model, with the mockup's explicit conflict UI reserved for the
cases that matter (same property, both changed).

**Hybrid version-control research** converges on the same layered answer
for heterogeneous content: CRDTs (Automerge/Loro) for JSON-like specs,
content-addressed blob storage for binary assets, and a version DAG in
SQLite for metadata (Localgpt RFC, via the three-tier artifact
architecture). The editor's content is JSON-first, which keeps the simple
end of this spectrum viable.

### §3.3 What to adopt

1. **Presence first:** avatars + camera frustums in the R3F viewport,
   colored row highlights in tables. Transport over the existing edge
   connection; ephemeral (no persistence).
2. **LWW per property** for all JSON content, with the server (or the
   content service) as the referee. The mockup's conflict resolver stays
   for same-property collisions — but they will be rare by construction.
3. **Coarse locks** for the resources the mockup already locks (terrain
   tiles, navmesh regions, world map): exclusive, visible, expiring, with
   the "release" affordance shown.
4. **Undo that rewrites history at the moment of action** rather than
   replaying a fixed stack (Figma's approach) — matters as soon as two
   people interleave edits.

### §3.4 Acceptance

- Two editors see each other's presence (viewport avatars, table row
  highlights) with < 500ms latency on the reference network.
- Same-property collision surfaces the mockup's resolver; different-
  property edits to the same object merge silently.
- Lock expiry and takeover are explicit; no silent lock loss.

---

## §4. FX lab: measured budgets, not proxy budgets

### §4.1 The idea

The mockup's FX lab is the standout panel: emitter parameters, size/color
over life curves, and **budget per quality tier** with an over-budget
warning ("Low is over budget: lower the rate or drop to 60% on low").
The proposal upgrades it from proxy budgets (particle counts) to measured
budgets (frame-ms on named hardware), adds stills capture per experiment
(the shader R&D program requires stills for every verdict), and wires each
emitter to the game event that fires it.

### §4.2 Supporting sources

**Spector.js (Babylon.js).** The WebGL frame debugger Joey already adopted
captures a full frame's GL commands: every draw call, shader, texture, and
GL state, with a result panel for inspection (BabylonJS; Realtimerendering).
It now ships an MCP server so AI assistants can "load a URL, capture
frames, and inspect draw calls, shaders, textures, and GL state" directly
(BabylonJS MCP). For the FX lab, the relevant capability is per-draw-call
cost attribution: which emitter's draw calls cost what.

**three.js native counters.** `renderer.info` exposes `{ calls,
triangles, points, lines }` and `{ geometries, textures }` per frame; the
standard performance workflow is Stats + Chrome DevTools Performance +
Spector.js for GPU capture, with instancing as the biggest structural win
(Githoaitandev). The lab's measurement harness should read `renderer.info`
deltas around an emitter's draw, not wall-clock the whole frame.

### §4.3 Implementation sketch

```ts
// Controller: measure an emitter in isolation
async function measureEmitter(emitterId: string, tier: QualityTier) {
  applyTier(tier);                    // quality.ts presets
  warmup(30);                         // shader compile, cache settle
  renderer.info.reset();
  for (let i = 0; i < 120; i++) { tickEmitter(); render(); }
  const { calls, triangles } = renderer.info.render;
  const ms = gpuTimer.query();        // EXT_disjoint_timer_query where available
  return { ms, calls, triangles };    // recorded against the emitter + tier
}
```

The lab stores measurements per emitter per tier per machine profile. The
over-budget warning graduates from advisory to gating: an emitter over
budget on a tier cannot be *promoted* to that tier's content set until the
budget passes or the tier's budget is explicitly revised (with the revision
itself recorded — budgets are content, versioned like everything else in
§6).

Stills: one click captures the emitter against the experiment's reference
scene at the tier's settings — feeding the R&D program's stills
requirement directly instead of relying on manual screenshots.

Event wiring: each emitter declares `firedBy: CombatEvent | QuestEvent |
...`, and the lab renders the reverse link too (from the combat timeline's
`hit.spark` back to the emitter). This is §1's deep linking applied to FX.

### §4.4 Acceptance

- Every emitter shows measured frame-ms, draw calls, and triangles per
  tier on the named reference hardware — not just particle counts.
- Over-budget emitters are blocked from tier promotion (with an explicit
  override path that records who and why).
- One-click stills capture per emitter per tier, stored with the
  measurement.
- Every emitter links to its firing game event(s) and back.

---

## §5. Command palette: the universal verb

### §5.1 The idea

Ctrl+K appears in the mockups and the live-ops admin console already
accepts `spawn goblin x3 at Aria`. The proposal: a real command palette —
fuzzy-matched, context-aware, with a natural-language-ish grammar for
world commands — as the primary interface for power users, with every menu
action registered in it.

### §5.2 Supporting sources

The pattern is thoroughly documented across tools. VS Code's palette uses
subsequence fuzzy matching with a top-50 MRU bucket floating recents, and
sigil sub-modes (`>`, `@`, `#`, `:`) inside one input (Eugenelim). Raycast
and Linear score by **frecency** (frequency × recency, Mozilla's algorithm)
and collapse sections into a flat ranked list as you type (Eugenelim).
Sublime's scoring weights run-length × position with matched characters
bolded inline (Eugenelim). The distilled best practices (Lysandre001):

- Include all menu and context actions; display associated hotkeys.
- Support aliases for frequently used commands; group with sections.
- Fuzzy matching forgiving of typos and partial matches.
- Context-scoped registration — commands appear only where valid
  (Nubisco's `setContext('editor')` pattern).

For the world-command grammar (`spawn goblin x3 at Aria`, `bake region
0,0`, `diff creatures against main`), the admin console in the mockup is
the seed. Keep the grammar small and positional rather than building a
real parser: `<verb> <target> [x<n>] [at <place>]`. Every command maps to
one MVC intent — the palette is a view over the intent registry, which is
why "include all menu actions" falls out naturally if menus are also built
from the registry.

### §5.3 Acceptance

- Every menu and toolbar action is registered in the palette with its
  hotkey shown; unregistered actions are a PR-checklist failure.
- Frecency-ranked, fuzzy-matched, with `?` documenting the grammar.
- World commands (`spawn`, `bake`, `diff`, `teleport`, `scenario run`)
  parse the positional grammar and route through the same intents as the
  GUI equivalents — no shadow code paths.

---

## §6. Gameplay data version control: Git semantics for game data

### §6.1 The idea

The mockup's Gameplay view is the most differentiated screen in the set:
semantic diff of `creatures.json` (field-level before/after, not line
diff), a three-way conflict resolver, merged-cleanly reporting, and a
locks panel. The proposal grounds it in established content-pipeline
practice so the semantics are real, not mockup-deep.

### §6.2 Supporting sources

**Git LFS for binaries.** The standard pattern: `.gitattributes` routes
binary types (`*.png`, `*.psd`, `*.fbx`) through LFS, with `git lfs lock`
for files requiring exclusive edit (Zottiben). The mockup's "LOCAL ONLY ·
NEVER COMMITTED — /assets/ · 412 files · licensed art" maps directly:
licensed binaries stay LFS-locked and local-only; the editor surfaces
their lock state.

**Source vs. generated separation.** Provenance discipline from asset
pipelines: prompts, seeds, and workflow JSON are the source of truth;
generated outputs are committed only after human approval; every shipped
asset carries a sidecar provenance record (model SHAs, seed, inputs,
license) — "no provenance JSON = not approved for ingestion" (Zottiben).
For the engine: bake outputs (navmesh tiles, loot tables, world bakes)
are generated artifacts with provenance sidecars, never hand-edited.

**Data-file rules.** The practices that keep JSON content sane at scale:
valid JSON enforced in CI, documented schemas per file, no orphaned
entries, versioned schemas on breaking changes, sensible defaults
(Perezandy). The editor's validation panel (the quest view's "Reply leads
nowhere / 3 lines missing in fr / Reward items exist") is this discipline
made visible.

### §6.3 What the Gameplay view needs underneath

- **Semantic merge driver** for the content JSON: field-level three-way
  merge (the mockup shows it; the driver makes it true). Same-property
  collisions surface the resolver; everything else merges silently —
  consistent with §3's LWW-per-property model.
- **Locks as content:** the mockup notes "Locks live in
  `content/locks.json` on a pushed commit. No lock server." Good — locks
  are versioned data, not server state.
- **Hot-reload provenance:** "Saved tables hot-reload into the running
  server" (creatures view) must record *which* revision is live, so a
  playtest anomaly can be traced to the exact content commit.

### §6.4 Acceptance

- Field-level diff and three-way merge work on real content files, not
  just the mocked creatures table.
- Binary assets route through LFS with lock state visible in the editor.
- Every hot-reload records the content revision now live on the server.

---

## §7. Localization pipeline: pseudo-locale as a first-class view

### §7.1 The idea

The mockup's Story view is unusually complete for a game editor: string
namespaces, per-locale completion bars, missing/stale/over-length filters,
a pseudo-locale preview pane, ICU message-format display, and extraction
status ("302 client strings behind", "17 literals left in 4 files"). The
proposal: treat this as the reference implementation and harden the
automation behind it.

### §7.2 Supporting sources

**Pseudo-localization** is the industry's standard early-i18n technique:
replace characters with accented equivalents (`Account Settings` →
`[Åççôûñţ Šéţţîñğš]`), expand text ~40%, and bracket the result. One pass
exposes truncation, clipping, hardcoded strings (they don't transform),
and encoding failures simultaneously (Naimuropu; Saboor-hamedi). The
mockup's pseudo-locale pane showing `Wárðën Hálê` with `!!!` padding is
exactly this.

**Automated checks** that should run in CI, not just display in the
editor: missing keys fail the build; unused keys are flagged (dead
translations cost maintenance); interpolation safety — every placeholder
present in every locale (Cadus0uza). The mockup's "Missing · 41, Stale · 6,
Over length · 3" filters are the UI over these checks.

**Layout under translation:** German and Finnish expand ~35% over English;
RTL (Arabic, Hebrew, Persian) requires logical CSS properties
(`margin-inline-start`) and `dir="rtl"` rendering without overlap —
verified, not assumed (Cadus0uza). The editor's HUD-layout view (with its
overlap checker at 90–125% UI scale) is the natural home for a
"render this layout in pseudo-locale + RTL" preview mode.

### §7.3 Acceptance

- Pseudo-locale is one click from any string table and from the HUD
  layout view (with RTL mirroring).
- Missing-key and interpolation-safety checks run in CI and block merge;
  the editor surfaces the same results (no divergent implementations).
- Extraction is automated: "literals left in N files" trends toward zero,
  enforced by a lint rule on hardcoded user-facing strings.

---

## §8. Combat timeline: frame-accurate, tick-aligned, presentation-separated

### §8.1 The idea

The mockup's combat timeline is the right shape: `sword.slash`,
24 frames at 30fps, with tracks for wind-up, hit frame, cancel window,
root motion, sound, VFX, target reaction, and camera — plus "server ticks
shown" and an animation mask. Two hardenings: align the timeline to the
**server tick grid** explicitly (the game runs at 30Hz; frames and ticks
coincide here, but the invariant should be visible and enforced), and keep
**hit-stop and other juice strictly presentation-side**.

### §8.2 Supporting sources

**Presentation/gameplay separation.** The cleanest statement of the rule
comes from a recent combat-system spec: "Server time never pauses.
Hit-stop is presentation-only, local to the affected fighters, and capped
at 35 ms... It never changes input, hitbox, projectile, or simulation
timing" (Reitenji). The timeline's camera-shake and hit-stop tracks must
be marked as presentation-only in the data model, not just by convention —
a designer should not be able to put gameplay in the camera track.

**Shared combat profiles.** "Animation timing is driven by the same combat
profiles as the server... Attack trails render the shared sweep path, so
the visible reach is the authoritative reach" (Reitenji). The timeline
edits the profile; the server and the client both consume it. There is no
separate client-side combat model to drift.

**Frame data as a design tool.** Fighting games expose frame meters with
per-state coloring (neutral, movement, attack, guard, damage) as first-
class training UI (Confetti3). The editor's timeline is the authoring-side
equivalent: the same frame vocabulary, used to author rather than to train.

### §8.3 Acceptance

- The timeline renders the 30Hz server tick grid; any event placed
  off-tick is flagged (or the track is declared tick-exact by schema).
- Presentation-only tracks (camera, hit-stop) are schema-marked and
  cannot carry gameplay effects; validation fails otherwise.
- Hit frame, sound, VFX, and target-reaction tracks all derive from the
  one combat profile the server consumes — verified by a consistency
  check, not by convention.

---

## §9. Craft: the unglamorous list that decides whether it ships

1. **Contrast audit.** Several muted grays in the mockups will fail
   sustained readability. Run the palette against WCAG AA for text and fix
   the token scale, not individual screens.
2. **Empty states.** Every mockup shows full data. Design the empty ones —
   no scenarios, no quests, no strings — with guided creation. That's where
   new users land.
3. **Virtualize the big tables.** 128k ledger rows and 18k props will choke
   a DOM table. The database view's pagination is the right instinct;
   apply windowed rendering everywhere a table can exceed ~500 rows.
4. **Editor performance budget.** The editor is a tool, but it renders a
   game viewport: set its own frame budget (e.g., viewport ≤ 8ms when idle)
   and measure it in CI like the game.
5. **Shortcut overlay.** F5, Ctrl+F5, Ctrl+Shift+S, Ctrl+K are scattered
   through the mockups — press `?` should show all of them, and the
   palette (§5) should be the fallback for everything else.
6. **Failure states per the UI/UX reference.** The build plan already
   requires them; the mockups show the happy path. Every async panel
   (pipeline runs, deploys, bakes) needs its dead-process, failed-run, and
   offline variants designed, not discovered.

6. **Failure states per the UI/UX reference.** The build plan already
   requires them; the mockups show the happy path. Every async panel
   (pipeline runs, deploys, bakes) needs its dead-process, failed-run, and
   offline variants designed, not discovered.

---

## §10. Code examples

Full modules a builder can adapt. All TypeScript, React 19, following the
build plan's MVC contract (views emit events up; controllers own side
effects; models never touch the network).

### §10.1 Navigation — address registry and link components (§1)

```ts
// src/ui/navigation/addresses.ts — Model: addresses are data
export type EditorAddress =
  | { kind: 'entity'; id: string }
  | { kind: 'tick'; n: number; scenario?: string }
  | { kind: 'position'; x: number; y: number; z: number; region?: string }
  | { kind: 'content'; path: string; field?: string }
  | { kind: 'animFrame'; clip: string; frame: number }
  | { kind: 'questStep'; quest: string; step: string };

export interface PanelTarget { panel: string; selection: Record<string, unknown> }

// src/ui/navigation/registry.ts — Model: which panel owns which address kind
const routes: Record<EditorAddress['kind'], (a: never) => PanelTarget> = {
  entity: (a) => ({ panel: 'viewport', selection: { focusEntity: (a as {id:string}).id } }),
  tick: (a) => ({ panel: 'scenarios', selection: { tick: (a as {n:number}).n, scenario: (a as {scenario?:string}).scenario } }),
  position: (a) => ({ panel: 'viewport', selection: { camera: a } }),
  content: (a) => ({ panel: 'gameplay', selection: { path: (a as {path:string}).path } }),
  animFrame: (a) => ({ panel: 'characters', selection: { clip: (a as {clip:string}).clip, frame: (a as {frame:number}).frame } }),
  questStep: (a) => ({ panel: 'story', selection: { quest: (a as {quest:string}).quest, step: (a as {step:string}).step } }),
};
export function resolveAddress(a: EditorAddress): PanelTarget {
  return (routes[a.kind] as (x: EditorAddress) => PanelTarget)(a);
}

// src/ui/controllers/useNavigation.ts — Controller: owns history + dispatch
export function useNavigation() {
  const dock = useDock();            // dockview-react shell
  const [history, setHistory] = useState<PanelTarget[]>([]);
  const go = useCallback((addr: EditorAddress) => {
    const target = resolveAddress(addr);
    setHistory(h => [...h, dock.currentTarget()]); // for "back"
    dock.focusPanel(target.panel, target.selection);
  }, [dock]);
  const back = useCallback(() => {
    setHistory(h => { const prev = h[h.length - 1]; dock.focusPanel(prev.panel, prev.selection); return h.slice(0, -1); });
  }, [dock]);
  return { go, back, canGoBack: history.length > 0 };
}

// src/ui/views/links.tsx — View: one link component per address kind, used by every panel
export function EntityLink({ id, children }: { id: string; children?: React.ReactNode }) {
  const { go } = useNavigation();
  return <button className="editor-link" onClick={() => go({ kind: 'entity', id })}>{children ?? id}</button>;
}
export function TickLink({ n, scenario }: { n: number; scenario?: string }) {
  const { go } = useNavigation();
  return <button className="editor-link" onClick={() => go({ kind: 'tick', n, scenario })}>tick {n.toLocaleString()}</button>;
}
export function PositionLink({ x, y, z }: { x: number; y: number; z: number }) {
  const { go } = useNavigation();
  return <button className="editor-link" onClick={() => go({ kind: 'position', x, y, z })}>({x}, {y}, {z})</button>;
}
// Rule: panels render addresses through these components, never as plain text.
```

### §10.2 Time-travel — snapshot ring buffer and inspection (§2)

```ts
// src/debug/time-travel.ts — Model + Controller (debug channel is read-only per plan)
export interface Snapshot { tick: number; hash: string; state: ArrayBuffer; }
export interface WorldEvent { tick: number; type: string; payload: unknown; }

export class SnapshotRing {
  private buf: Snapshot[] = [];
  constructor(private capacity: number) {}
  push(s: Snapshot) { this.buf.push(s); if (this.buf.length > this.capacity) this.buf.shift(); }
  nearestBefore(tick: number): Snapshot | null {
    let lo = 0, hi = this.buf.length - 1, best: Snapshot | null = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1;
      if (this.buf[mid].tick <= tick) { best = this.buf[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }
  memoryBytes(): number { return this.buf.reduce((n, s) => n + s.state.byteLength, 0); }
}

// Controller: materialize state at tick T from snapshot + ledger replay
export async function inspectAt(tick: number, ring: SnapshotRing, ledger: WorldEvent[],
    applyEvent: (state: unknown, e: WorldEvent) => unknown,
    deserialize: (b: ArrayBuffer) => unknown): Promise<{ state: unknown; replayed: number }> {
  const snap = ring.nearestBefore(tick);
  if (!snap) throw new Error(`tick ${tick} is outside the retention window`);
  let state = deserialize(snap.state);
  let replayed = 0;
  for (const e of ledger) {
    if (e.tick <= snap.tick) continue;
    if (e.tick > tick) break;
    state = applyEvent(state, e); replayed++;
  }
  return { state, replayed };
}

// Determinism audit: re-simulation must reproduce the recorded ledger hash
export async function verifyDeterminism(fromTick: number, toTick: number,
    ring: SnapshotRing, ledger: WorldEvent[], hashState: (s: unknown) => string,
    applyEvent: (s: unknown, e: WorldEvent) => unknown,
    deserialize: (b: ArrayBuffer) => unknown, expectedHash: string): Promise<boolean> {
  const { state } = await inspectAt(toTick, ring, ledger, applyEvent, deserialize);
  return hashState(state) === expectedHash;
}
```

### §10.3 Collaboration — LWW property store and fractional index (§3)

```ts
// src/collab/store.ts — Model: last-writer-wins per property per object
export interface PropWrite { obj: string; prop: string; value: unknown; ts: number; actor: string; }
export class LwwStore {
  private cells = new Map<string, PropWrite>(); // key: `${obj}.${prop}`
  // Local apply: optimistic, immediate
  localWrite(obj: string, prop: string, value: unknown, actor: string): PropWrite {
    const w = { obj, prop, value, ts: Date.now(), actor };
    this.cells.set(obj + '.' + prop, w);
    return w; // sent to the referee; echoed back on ack
  }
  // Remote apply: server is the referee — its arrival order IS the order.
  // Discard server echoes that conflict with unacknowledged local writes
  // (prevents the winner's UI flickering to the loser's value and back).
  remoteWrite(w: PropWrite, pendingLocal: Set<string>): 'applied' | 'discarded' {
    const key = w.obj + '.' + w.prop;
    if (pendingLocal.has(key)) return 'discarded';
    const cur = this.cells.get(key);
    if (!cur || w.ts >= cur.ts) { this.cells.set(key, w); return 'applied'; }
    return 'discarded';
  }
  read(obj: string, prop: string): unknown { return this.cells.get(obj + '.' + prop)?.value; }
}

// Fractional index for sibling ordering (simplified; production: use a tested lib)
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function midpointKey(a: string | null, b: string | null): string {
  let i = 0, out = '';
  while (true) {
    const ca = a && i < a.length ? DIGITS.indexOf(a[i]) : 0;
    const cb = b && i < b.length ? DIGITS.indexOf(b[i]) : DIGITS.length - 1;
    if (cb - ca > 1) return out + DIGITS[(ca + cb) >> 1];
    out += DIGITS[ca]; i++;
    if (i > 64) return out + 'V'; // degenerate guard; rebalance in production
  }
}

// Presence is ephemeral: { actor, panel, selection, camera? } over the edge
// connection, 2s heartbeat, no persistence. Rendered as viewport avatars
// and colored table-row highlights.
```

### §10.4 Command palette — registry, fuzzy scorer, grammar (§5)

```ts
// src/ui/palette/registry.ts — Model: every command is an MVC intent
export interface Command {
  id: string;                    // 'world.bake-region'
  title: string;                 // 'Bake region'
  keywords?: string[];           // aliases: ['rebake', 'regen']
  hotkey?: string;               // 'Ctrl+Shift+B'
  contexts?: string[];           // undefined = global; ['viewport'] = scoped
  run: (args: string[]) => void; // dispatches the MVC intent — same path as the menu
}
export class CommandRegistry {
  private cmds = new Map<string, Command>();
  register(c: Command) { this.cmds.set(c.id, c); }
  all(context?: string): Command[] {
    return [...this.cmds.values()].filter(c => !c.contexts || !context || c.contexts.includes(context));
  }
}

// Fuzzy scorer: subsequence with word-boundary and run bonuses (VS Code-style)
export function fuzzyScore(query: string, target: string): number {
  query = query.toLowerCase(); target = target.toLowerCase();
  let qi = 0, score = 0, run = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      const boundary = ti === 0 || ' .-_/'.includes(target[ti - 1]);
      score += boundary ? 8 : run > 0 ? 4 : 1;
      run++; qi++;
    } else run = 0;
  }
  return qi === query.length ? score : -1;
}

// Frecency: frequency x recency (Mozilla-style decay)
export function frecency(uses: number, lastUsedAt: number, now = Date.now()): number {
  const days = Math.max(0.1, (now - lastUsedAt) / 86400000);
  return uses / Math.pow(days, 0.7);
}

// World-command grammar: <verb> <target> [x<n>] [at <place>] — positional, no parser combinator needed
export function parseWorldCommand(input: string): { verb: string; target: string; count: number; at?: string } | null {
  const m = input.trim().match(/^(\w+)\s+([\w.-]+)(?:\s+x(\d+))?(?:\s+at\s+([\w\s.-]+))?$/i);
  if (!m) return null;
  return { verb: m[1].toLowerCase(), target: m[2].toLowerCase(), count: m[3] ? parseInt(m[3], 10) : 1, at: m[4]?.trim() };
}
// 'spawn goblin x3 at Aria' -> { verb:'spawn', target:'goblin', count:3, at:'Aria' }
// The verb dispatches the same intent as the GUI button — no shadow code paths.
```

### §10.5 FX measurement harness (§4)

```ts
// src/ui/controllers/useFxMeasure.ts — Controller
export interface FxMeasurement { emitter: string; tier: string; ms: number; calls: number; triangles: number; machine: string; at: number; }

export async function measureEmitter(
  emitterId: string, tier: string,
  applyTier: (t: string) => void,
  tickEmitter: () => void, render: () => void,
  readInfo: () => { calls: number; triangles: number }, // renderer.info.render
  gpuMs: () => number | null,                            // EXT_disjoint_timer_query, nullable
): Promise<FxMeasurement> {
  applyTier(tier);
  for (let i = 0; i < 30; i++) { tickEmitter(); render(); } // warmup: compile, caches
  const c0 = performance.now();
  readInfo(); // reset baseline
  const FRAMES = 120;
  for (let i = 0; i < FRAMES; i++) { tickEmitter(); render(); }
  const wallMs = (performance.now() - c0) / FRAMES;
  const info = readInfo();
  const measured = gpuMs();
  return {
    emitter: emitterId, tier,
    ms: measured ?? wallMs,      // prefer GPU timer; fall back to wall with a flag
    calls: info.calls / FRAMES, triangles: info.triangles / FRAMES,
    machine: navigator.userAgent, at: Date.now(),
  };
}
// Promotion gate: an emitter whose measured ms exceeds the tier budget cannot
// be promoted to that tier's content set. Overrides record { who, why, at }.
```

### §10.6 Combat timeline tick-grid validation (§8)

```ts
// src/ui/validation/combat.ts — Model: schema-level rules
export const TICK_HZ = 30;
export type TrackKind = 'gameplay' | 'presentation';
export interface TimelineEvent { track: string; kind: TrackKind; frame: number; data: unknown; }

export function validateTimeline(clipFps: number, durationFrames: number, events: TimelineEvent[]): string[] {
  const errors: string[] = [];
  const framesPerTick = clipFps / TICK_HZ;
  for (const e of events) {
    // Rule 1: gameplay events must land on tick boundaries
    if (e.kind === 'gameplay' && Math.abs(e.frame / framesPerTick - Math.round(e.frame / framesPerTick)) > 1e-6)
      errors.push(`${e.track}@frame ${e.frame}: gameplay event off the ${TICK_HZ}Hz tick grid`);
    // Rule 2: presentation tracks can never carry gameplay payloads
    if (e.track === 'camera' || e.track === 'hitstop') {
      if (e.kind !== 'presentation') errors.push(`${e.track}@frame ${e.frame}: marked gameplay on a presentation-only track`);
      if ('damage' in (e.data as object) || 'hitbox' in (e.data as object))
        errors.push(`${e.track}@frame ${e.frame}: gameplay payload on a presentation track`);
    }
  }
  if (durationFrames % framesPerTick !== 0)
    errors.push(`clip length ${durationFrames}f is not a whole number of ticks at ${clipFps}fps/${TICK_HZ}Hz`);
  return errors;
}
```

---

## §11. Benchmarks

### §11.1 Measured micro-benchmarks

Run 2026-10-05 on this machine: AMD EPYC 9D25 (2 vCPU), 7.7 GB RAM, Node
v24.20.0. These are algorithm-level costs for the design choices in §10 —
**not** engine measurements. They bound the designs, they don't validate
the product.

| # | Benchmark | Result |
|---|---|---|
| 1 | Fuzzy-score 5,000 commands × query `"spw gob"` | **1.50 ms** |
| 2 | Fuzzy-score 50,000 commands × query `"bake reg"` | **9.55 ms** |
| 3 | Fractional-index: 10,000 sequential key inserts | **23.3 ms** (one-time) |
| 4 | LWW merge: 100,000 property writes | **35.1 ms** |
| 5 | Snapshot serialize: 1,000-entity state → JSON | **0.74 ms**, 113 KB |
| 6 | Snapshot parse: 113 KB JSON → state | **0.75 ms** |
| 7 | Ledger replay: 5,000 movement events applied | **0.33 ms** |

Raw output and the benchmark script are reproducible: the script is
`bench.mjs` (used for this run); port it into the repo's perf suite if the
numbers need re-verification on reference hardware.

### §11.2 What the numbers establish

- **Command palette (§5/§10.4):** scoring 50k commands takes 9.55ms —
  under one frame at 60Hz. The palette will feel instant at any realistic
  registry size; no indexing, web worker, or debouncing required. The
  design constraint is ranking quality (frecency), not throughput.
- **Fractional indexing (§3/§10.3):** 10k ordered inserts in 23ms, one-
  time per session load. Key growth under sequential insert is the known
  weakness (Figma names it); the 64-char degenerate guard in §10.3 is the
  mitigation, with periodic rebalancing for long sessions.
- **LWW collab model (§3):** 100k property writes merge in 35ms. The
  conflict model is computationally free relative to rendering — the cost
  of collaboration is network and UX, not merge CPU. This supports the
  Figma-derived choice: property-level LWW needs no heavier machinery.
- **Time-travel (§2/§10.2):** serialize + parse of a 1,000-entity snapshot
  costs ~1.5ms total; replaying 5,000 ledger events costs 0.33ms. The
  §2 acceptance target (< 200ms worst-case scrub) has ~130× headroom at
  this state size. Memory is the real budget: 113 KB/snapshot × 600
  snapshots (10 min at 1Hz) ≈ **68 MB** — acceptable for a dev tool, and
  reducible with delta snapshots or lower snapshot frequency for larger
  worlds. Size the ring buffer from measured state bytes, not from a
  fixed snapshot count.
- **Snapshot frequency guidance:** at 1Hz snapshots the worst-case replay
  is 30 ticks × events-per-tick — milliseconds. Even 0.2Hz snapshots keep
  replay under ~50ms at typical event rates. The ring is cheap; prefer
  more snapshots over longer replays.

### §11.3 Published reference numbers (from the research)

These are not our measurements — they are the industry numbers the
designs are calibrated against, with sources in the Works Cited:

- **Instancing vs. draw calls:** un-instanced ground-effect rendering in
  the WoW reimplementation produced ~47k draw calls and dropped frame
  rate 10×; GPU instancing collapsed it to batched draws (Open-Realm).
  The editor viewport must instance or it will not survive the world's
  prop counts (18,431 props in the mockup's ecology line).
- **Voronoi fracture cost:** O(n²) in fragment count, CPU-side
  (Sinanata). Cap fragment counts per destruction event; the cost is
  one-time per event, then fragments are ordinary meshes.
- **WebGPU compute headroom:** 2–10× gains are common for draw-call-heavy
  scenes vs. WebGL (Songfeitong). Relevant to the FX lab's WebGPU path
  and to Exp 7's TSL-compute particles.
- **Rollback resimulation budget:** GGPO-style systems resimulate up to
  ~8 frames per tick on misprediction (Gregorik) — the same order of
  magnitude as the time-travel replay window, which is why the snapshot
  interval math transfers.
- **Grass wind cost target:** < 0.3ms added at 10k swaying instances
  (the program's own Exp 6 acceptance bar).

### §11.4 Benchmark harnesses for the engine (CI)

Micro-benchmarks bound designs; the engine needs its own harnesses in CI.
Each maps to an acceptance criterion already in this document:

1. **Palette latency:** seed a 10k-command registry, measure p99
   keystroke→render time. Budget: < 16ms (one frame).
2. **Scrub latency:** snapshot ring at production state size, measure
   p99 `inspectAt` at worst-case replay distance. Budget: < 200ms (§2.4).
3. **FX per-tier measurement:** the §10.5 harness, run on the named
   reference hardware per tier, stored with the emitter. Budget: tier
   budgets from the R&D program; promotion blocked on failure (§4.4).
4. **Timeline validation:** the §10.6 validator over all combat clips in
   CI. Budget: zero errors — it is a correctness gate, not a perf gate.
5. **Editor viewport idle:** render the world viewport with no interaction,
   measure frame p99. Budget: ≤ 8ms idle (§9.4) — the editor must not burn
   the machine it's debugging on.

---

## Works Cited

BabylonJS. *Spector.js*. GitHub, https://github.com/BabylonJS/Spector.js/.

BabylonJS. "MCP Server." *Spector.js*, GitHub,
https://github.com/babylonjs/spector.js/blob/HEAD/mcp/README.md.

Brendt. "What Event Sourcing Is Not About." *stitcher.io*, 2021,
https://github.com/brendt/stitcher.io/blob/HEAD/app/Blog/Content/2021-04-09-what-event-sourcing-is-not-about.md.

Cadus0uza. "i18n & l10n Testing." *qa-supreme*, GitHub,
https://github.com/cadus0uza/qa-supreme/blob/HEAD/skills/i18n-l10n-testing/SKILL.md.

Chichasescheese. "Fowler Event Sourcing Clip." *systemdesign*, GitHub,
https://github.com/chichasescheese/systemdesign/blob/HEAD/vault/code-core/clippings/fowler-event-sourcing-clip.md.

Confetti3. "Training Lab." *sf4-ember-netplay*, GitHub,
https://github.com/confetti3/sf4-ember-netplay/blob/HEAD/docs/TRAINING_LAB.md.

Devopsdaily. "Figma Made Multiplayer Instant by Picking the Dumber
Algorithm." *DEV Community*, 2026,
https://dev.to/devopsdaily/figma-made-multiplayer-instant-by-picking-the-dumber-algorithm-c5k.

Eugenelim. "Command Palette Spec." *inkwell*, GitHub,
https://github.com/eugenelim/inkwell/blob/HEAD/docs/specs/22-command-palette/spec.md.

Fowler, Martin. "Event Sourcing." *martinfowler.com*,
https://martinfowler.com/eaaDev/EventSourcing.html.

Gerfru. "Event Sourcing & CQRS." *dev-best-practices*, GitHub,
https://github.com/gerfru/dev-best-practices/blob/HEAD/plugins/dev/skills/design-data/references/event-sourcing-cqrs.md.

Githoaitandev. "Three.js Performance." *my-agent*, GitHub,
https://github.com/githoaitandev/my-agent/blob/HEAD/.agents/skills/threejs-performance/SKILL.md.

Gregorik. *Rollback-Core*. GitHub,
https://github.com/gregorik/Rollback-Core.

Gregorik. "What Is Rollback Netcode?" *rollback-core*, GitHub,
https://github.com/gregorik/rollback-core/blob/HEAD/README.md.

Gurekamdhillon. "Rollback Netcode Research." *gd-melee-workspace*, GitHub,
https://github.com/gurekamdhillon/gd-melee-workspace/blob/HEAD/_research/rollback-netcode.md.

Jasoniwu. "Fuzzy File Finder UX." *fresh*, GitHub,
https://github.com/jasoniwu/fresh/blob/HEAD/docs/internal/FUZZY_FILE_FINDER_UX.md.

Jh3ady. "Event Sourcing." *claude-plugins*, GitHub,
https://github.com/jh3ady/claude-plugins/blob/HEAD/plugins/event-sourcing/skills/event-sourcing/SKILL.md.

Kingpinged. *rollback-netcode*. GitHub,
https://github.com/kingpinged/rollback-netcode.

Lysandre001. "UI/UX Principles." *skills-registry*, GitHub,
https://github.com/lysandre001/skills-registry/blob/HEAD/jk278--veld--ui-ux-principles/SKILL.md.

Mighty840. "A Pure, Seeded Game Engine Gives You Multiplayer Almost for
Free." *DEV Community*, 2026,
https://dev.to/mighty840/a-pure-seeded-game-engine-gives-you-multiplayer-almost-for-free-4412.

Naimuropu-cell. "Localization and Internationalization Testing."
*sqa-learning-journal*, GitHub,
https://github.com/naimuropu-cell/sqa-learning-journal/blob/HEAD/daily-notes/localization-and-internationalization-testing.md.

Nubisco. "Command Palette." *ui*, GitHub,
https://github.com/nubisco/ui/blob/HEAD/docs/ui/components/command-palette.md.

Osvaldojramos. "Event Sourcing." *dotnet-senior-study-guide*, GitHub,
https://github.com/osvaldojramos/dotnet-senior-study-guide/blob/HEAD/08-architecture-and-patterns/15-event-sourcing.md.

Open-Realm. "Static Grass and Height Atlas." GitHub, Corepunch,
https://github.com/corepunch/open-realm/blob/HEAD/docs/games/world-of-warcraft/static-grass-and-height-atlas.md.

Perezandy. "AGENTS.md — Data File Rules." *opencode-game-studios*, GitHub,
https://github.com/perezandy/opencode-game-studios/blob/HEAD/AGENTS.md.

Reitenji. "Core Combat Redesign." *neon-knockout-3d*, GitHub,
https://github.com/reitenji/neon-knockout-3d/blob/HEAD/docs/superpowers/specs/2026-08-31-core-combat-redesign-design.md.

Saboor-hamedi. "Internationalization." *lumina-notes*, GitHub,
https://github.com/saboor-hamedi/lumina-notes/blob/HEAD/software-engineering/internationalization.md.

Sinanata. *unity-mesh-fracture*. GitHub,
https://github.com/sinanata/unity-mesh-fracture.

Songfeitong. "WebGPU Three.js Migration Guide." *pretty-lattice*, GitHub,
https://github.com/songfeitong/pretty-lattice/blob/HEAD/docs/notes/webgpu-threejs-migration-guide.md.

Sujeet-pro. "Figma Multiplayer Infrastructure." *sujeet.pro*, GitHub,
https://github.com/sujeet-pro/sujeet.pro/blob/HEAD/content/articles/figma-multiplayer-infrastructure/README.md.

The-devops-daily. "Figma Multiplayer: Dumber Algorithm." *devops-daily*,
GitHub,
https://github.com/the-devops-daily/devops-daily/blob/HEAD/content/posts/figma-multiplayer-dumber-algorithm.md.

"Debugging WebGL with SpectorJS." *Real-Time Rendering*,
https://www.realtimerendering.com/blog/?p=4531.

Vanderheijden86. "TUI Design Research 2025–2026." *b9s*, GitHub,
https://github.com/vanderheijden86/b9s/blob/HEAD/docs/tui-design-research-2025-2026.md.

Wallace, Evan. "How Figma's Multiplayer Technology Works." *Figma Blog*,
2019, https://www.figma.com/blog/how-figmas-multiplayer-technology-works/.

Zottiben. "Game Art Pipeline." *software-teams*, GitHub,
https://github.com/zottiben/software-teams/blob/HEAD/packages/cli/agents/software-teams-game-art-pipeline.md.
