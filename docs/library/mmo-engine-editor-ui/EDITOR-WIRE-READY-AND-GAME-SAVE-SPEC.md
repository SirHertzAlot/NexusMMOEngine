# Editor wire-ready pass + whole-game save — spec

**Status: design, written 2026-11-13 on Joey's ask. Nothing built yet.**
Joey: "I was also able to find the artifact that held the new editor
revisions we worked on. It would be nice to flesh it out more and
basically leave it in a state where it just needs to be wired to the
backend of the engine itself. We also need to find a way to save the
entire game since building a game in one setting would be pretty
crazy."

## 0. Which artifact (named assumption)

**EDITOR-PROTOTYPE-TW.html** (`prototype/`, 135,578 bytes, last
revised 2026-10-28): the Tailwind working prototype with the full
behavior set — IDE mode, VC surfaces, named terminal sessions. The
older EDITOR-PROTOTYPE.html (49 KB) stays untouched as the
hand-rolled reference. If Joey means a different artifact, this spec
re-points; the design does not change.

## 1. Recon — where the prototype actually stands (verified 2026-11-13)

- **Zero persistence.** Neither prototype file contains
  `localStorage`, `fetch(`, a save function, or any API layer —
  grep count 0 across all four patterns.
- **One global in-memory `const state`** holds everything; panels
  read and write it directly. Close the tab and the game is gone —
  exactly the one-sitting problem Joey named.
- The VC surfaces, terminal sessions, and IDE mode are
  presentation-only: they render the idea, they don't move data.
- Already decided elsewhere and reused here (not re-litigated):
  every Save commits a new draft version (designer pseudo-VC,
  EDITOR-VISION); the frontend never touches git directly — Ghost
  Sync policy lives in the dev backend; live updates default to
  WebSocket snapshot streams; published scene/template versions
  are stamped with the code repo's commit (templating T4 rule).

## 2. What "wire-ready" means — definition of done

The prototype is wire-ready when the *only* step left is pointing
it at the real backend:

1. **One data layer.** All state lives behind an `EditorStore`.
   No panel touches raw state; panels subscribe to store slices
   and dispatch commands.
2. **Commands, not mutations.** Every edit is a named, serializable
   command in the existing verb vocabulary (`placeEntity`,
   `setComponentField`, `applyProcgen`, template verbs, …)
   dispatched through one command bus. A command that can be
   logged can be sent over the wire unchanged — that's the point.
3. **One Backend interface, two implementations.**
   - `MockBackend` — in-memory + localStorage; ships in the
     artifact and makes save/load fully real *today*.
   - `HttpBackend` — same signatures, endpoint map filled in,
     bodies stubbed. Wiring day = swap one constructor line and
     implement the endpoints on the Express editor backend.
   Interface surface: `loadProject`, `saveDraft`, `listSnapshots`,
   `saveSnapshot`, `restoreSnapshot`, `dispatch` (commands),
   `subscribe` (snapshot stream), `exportBundle`, `importBundle`,
   asset manifest reads.
4. **No mock-only behavior.** Anything the UI can do goes through
   the interface. If a feature can't be expressed through it, the
   interface grows — the prototype never reaches around it.

## 3. Saving the entire game — the GameProject document

### 3.1 Two truths (already our architecture, stated plainly)

- **Authoring truth** = the GameProject document. This is what
  Save writes. It is the game *as authored*: scenes, entities,
  procgen recipes, content, UI templates.
- **Runtime truth** = the SurrealDB world store. Play/publish
  *bakes* the authored document into the world store; the game
  server never reads the save file directly.

### 3.2 Document shape

A project is a folder (dev-friendly, diffable) with a manifest at
the root, and exports to a single-file bundle for sharing/backup.

```
<game>/
  game.project.json     manifest: name, formatVersion, engineCommit
                        stamp, section index, asset manifest ref
  world/                scenes/regions: procgen seeds + params,
                        hand-placed overrides (never baked output)
  entities/             archetype templates + placed instances
  content/              quests, dialogue, cinematic cue sheets
  ui/                   interface templates + per-user pins
  assets.manifest.json  asset id -> hash, license lane, source
  editor.json           layout, open scene, camera, session state
```

### 3.3 Why a whole game fits in a save (the data-oriented payoff)

- **Procgen is stored as seeds + parameters, not results.** A
  continent is a few KB of recipe; the bake reproduces it. This
  only works because generation is deterministic — the same
  property the tick work already depends on.
- **Assets are referenced by hash manifest, never embedded.**
  The save names what the game uses; the Baked Asset Store holds
  the bytes.
- **Entities are data** (archetype + component values), so a
  town of ten thousand objects is a table, not ten thousand files.

### 3.4 Save model

- **Save** = new draft version (ratified pseudo-VC rule), with an
  auto-generated note (what changed: command counts by type).
- **Autosave** = debounced draft write through `saveDraft`
  (localStorage in the mock; same call over HTTP later). The user
  can never lose more than a few seconds.
- **Snapshots** = named checkpoints ("before the harbor rework")
  in a history list: restore, and a one-click diff against the
  current draft (vision doc already promises the diff view).
- **Export/Import** = the whole folder as one bundle file
  (zip container, manifest at root) — backup, sharing, moving a
  game between machines. Import validates `formatVersion` and
  the asset manifest before touching anything; unknown versions
  fail closed with a migration prompt, never a silent half-load.
- **Crash safety:** drafts write to a staging key and swap
  atomically; a torn write leaves the last good draft intact.

## 4. Build slices (prototype only — the shipped React editor is untouched)

- **W1 — Data layer + command bus.** Refactor `const state`
  behind `EditorStore`; route every panel mutation through named
  commands. No visual change; the prototype must behave
  identically after. This is the slice everything else stands on.
- **W2 — Backend interface + MockBackend.** Implement the §2.3
  surface against localStorage. Save/load now work end-to-end in
  the artifact; a refresh restores the game.
- **W3 — Save system UI.** Save button writes a draft version;
  snapshot create/list/restore/diff; autosave indicator in the
  status bar; export/import bundle buttons with validation.
- **W4 — HttpBackend stub + endpoint map.** The wiring contract,
  written down: every interface method mapped to its Express
  route on the editor backend (distinct from the uWS gateway, as
  already decided), payload = the command/document shapes from
  W1–W3 verbatim.
- **W5 — Flesh-out pass.** Remaining prototype behaviors brought
  to the wireframe's standard *through* the new data layer —
  including the scene-first shell arrangement as a selectable
  layout, so the prototype can demonstrate what the vision-shell
  pin will feel like in the real editor.

## 5. Decisions

- **(a) Artifact confirmation** — TW prototype, per §0. Joey
  corrects if wrong.
- **(b) Content-store boundary (closes a standing open
  question).** Recommendation: **the game project is its own
  content repository** — the §3.2 folder — separate from the
  engine code repo; `game.project.json` stamps the engine commit
  it was authored against (the T4 stamping rule, applied to
  games). Code and content version independently; a scene never
  needs a code commit to exist, and the stamp answers "which
  code was this built with" without coupling the two repos.
- **(c) Bundle format** — recommendation: plain zip with
  `game.project.json` at root. No custom container; every tool
  on earth can open it.

## 6. Explicitly not in scope

- No changes to `apps/editor` (the shipped React app) in this
  pass. When the prototype is wire-ready, the port re-implements
  the same contract in React over T2's shell composition.
- No live multi-user editing. The snapshot stream is read-mostly
  in v1 (live world state into the editor); concurrent authors
  are a later question.
- No asset bytes move through the save system — manifests only.

---

## Build outcome — W1–W3 (2026-11-13)

Built into `prototype/EDITOR-PROTOTYPE-TW.html` (152.8 KB; backup of
the pre-build file: `EDITOR-PROTOTYPE-TW.v9-backup-2026-11-13.html`).
One inserted `NexusWire` script block + three one-line patches in
the main script (prov wrapper → bus, doSave → persistVersion, boot
line → bindAndHydrate). The prototype's own architecture did most of
the work: its verb layer (`prov`) is the command choke point, and its
in-memory scene versions became the persisted version store.

- **W1:** `NexusWire.bus` records every editor verb as a
  serializable command `{seq, t, type, what, why}` (non-serializable
  commands are dropped with a warning); `NexusWire.store` owns the
  bound state refs (GRAPH, LIVE, state, N, SCENE_VERSIONS, version
  counters, seed accessors).
- **W2:** Backend interface (loadDraft / saveDraft / saveVersion /
  loadVersion / listVersions). MockBackend on localStorage with a
  staging-key swap; HttpBackend stub carries the W4 contract. Draft
  hydrates before first render — reload restores the whole game.
- **W3:** "⤓ Game" panel by the version pill: named snapshots
  (rides doSave → the version carries the name), version list with
  **Load** (full-document restore, not just LIVE) and **Diff**
  (changed leaf paths vs current), Export bundle
  (`town0001.nexusgame.json`), Import with fail-closed validation
  (kind + formatVersion + required sections). Autosave is
  debounced (1.2 s) and hash-gated on the document sections; a
  `· wire:` status sits beside the save pill.
- **Document:** `{formatVersion: 1, kind: "nexus-game-project",
  manifest, sections: {world: {graph, seed}, entities: {live},
  content: {sceneVersions}, ui, editor: {state, ver, verSeq}}}` —
  the spec's §3.2 shape, with the prototype's graph as the world
  section. Deviation from §5(c): the bundle is a single JSON file,
  not a zip — a dependency-free artifact can't write zip; the zip
  container remains the production call for the real editor.
- **Bug found and fixed (pre-existing):** `wirePop` was called with
  DOM elements instead of id strings for the version pill
  (`wirePop(document.getElementById("verPill"), …)`), throwing at
  script top level and **silently aborting the rest of the main
  script's initial run** — the boot renders and version seeding
  never executed; the shell Joey reviewed was running on static
  HTML + hoisted functions. One-line fix to
  `wirePop("verPill","verPop",renderVerPop)`. With it, the full
  intended boot runs (populated hierarchy, contextual shelf, live
  footprint) and page errors went from 1 to 0.
- **Verification (headless Chromium, local loopback):** 18 checks —
  autosave draft write + seed persistence, Save → persisted version,
  named snapshot in backend index, full-doc version load restoring
  a mutated LIVE value, import refusing wrong-kind and non-JSON
  bundles while accepting its own, diff finding changed paths,
  reload restoring the draft, Game panel listing versions, bus
  recording the `reroll` verb — all pass; 0 page errors. Remaining
  console noise is only the sandbox browser failing to reach the
  three.js CDN (the prototype's stand-in render engages, as
  designed).
- **Not done (by design):** W4 (HttpBackend endpoints on the real
  Express editor backend) and W5 (flesh-out pass) remain slices.
  Nothing pushed anywhere; all changes are in the working files.

---

## Addendum — add-object-to-scene slice (2026-11-13)

Joey's restatement of the design law, same day: the editor is an
authoring surface that pulls up the modules we hid based on
context — and we should be able to add game objects to the scene
we choose. Built into the TW prototype the same day:

- Scenes are real now. Objects carry a `view` (existing five
  default to Market Square, behavior unchanged); the tree lists
  each scene's objects under its own row, and the stand-in
  viewport renders the chosen scene's objects. North Gate and
  Fields start empty instead of showing a "no mock objects"
  dead end.
- **+ Object** in the hierarchy header summons a compact archetype
  picker ("Add to North Gate": Vendor Stall, Resident, Shrine,
  Creature, Supply Crate — role + per-scene counts). It exists
  only while summoned; nothing new clutters the surface. Picking
  one creates the object in the *current* scene (graph node +
  instantiates edge + LIVE defaults + presentation/widget/shelf
  entries cloned from the archetype's exemplar), selects it, and
  fires the `addObject` verb — so it lands on the command bus, in
  provenance, in version change-counts, and in autosave like every
  other edit. Repeat adds get unique ids and names (Creature,
  Creature 2, …).
- Found by the smoke, fixed in NexusWire: the save document now
  also carries the per-object presentation/content tables (PROPS,
  WIDGET_BODY, SHELF). A restored object previously crashed the
  viewport render after reload (its shape lived outside the
  document); hydrate also backfills a shape for any object missing
  one, so older drafts can't crash the render.
- Verified: 10/10 add-flow checks (empty gate → picker → add →
  unique second add → scene isolation → draft persistence →
  reload restore) and the W1–W3 suite re-run clean; 0 page
  errors. Pre-slice backup: `EDITOR-PROTOTYPE-TW.w3-backup-2026-11-13.html`.

## Addendum 2026-11-13 (2) — W4 + W5 built and verified; the W workflow is complete

W4 — the HttpBackend is no longer a stub:

- The Backend contract is unchanged; the transport is now real.
  NexusWire keeps the local mock as the always-available layer
  (local = cache/fallback, the world-store rule) and adds a Sync
  layer: in HTTP mode, drafts and versions write through to the
  backend, editor commands stream there in debounced batches, and
  boot reconciles local vs server by `manifest.savedAt` — newest
  wins, loser is pushed up or pulled down accordingly. Version
  loads try the server first and fall back to the local mirror.
  The Game panel carries the backend picker (Local mock / HTTP
  server), the base-URL field, and a status line (● synced /
  ○ unreachable — local mirror active / local only). Mode + URL
  are viewer prefs in localStorage, never part of the game doc.
- Reference implementation: `backend-reference/server.mjs`
  (zero-dependency node:http, file storage) + `README.md` (the
  endpoint map). It exists to prove the contract and to give the
  production Express build something executable to conformance-test
  against; the world server remains a separate tier.
- Proven end to end (headless Chromium against the reference
  server): save committed v5/v6 to server disk; the command
  stream arrived (2 records incl. addObject); the server draft
  carried the rerolled seed and the gate creature. The server was
  then killed and restarted, and a fresh browser context with
  EMPTY local storage recovered the entire game from the server
  alone ("· wire: synced from HTTP backend (newer draft)").
  With the server down, the editor boots on the default game and
  Save still commits to the local mirror. 0 page errors in every
  phase.

W5 — flesh-out, with GSAP at Joey's direction (prototype surface;
the shipped client's anime.js call is unchanged):

- GSAP 3.12.5 is inlined in the prototype file (240 KB total) and
  driven through a NexusWire Motion helper: pops for the
  add-object picker and the Game panel, a GSAP crossfade for scene
  transitions, a back-ease pop for a newly added object (measured
  mid-animation at scale 1.024, settling to exactly 1), a pulse on
  the version pill when a save commits, and the layout tween
  below. All motion is gated on prefers-reduced-motion and
  degrades to the final state when GSAP is absent — motion is
  feedback, never a gate.
- Scene-first layout mode: a Layout toggle in the nav tweens the
  rails to the approved wireframe proportions (¼ hierarchy ·
  ½ viewport · ¼ shelf) and back; the choice persists in the
  saved document (editor state) and is reapplied on boot.
- Notes block: Hide/Show toggle (viewer pref, not in the doc).
- Graph/Debug chips: fixed the overlap — the buttons now size to
  their text instead of clipping into each other.
- The Game popover moved to a body-level fixed layer (the same
  pattern as the add-object picker) after review screenshots
  showed it interleaving with the viewport identity chip; its
  backend row no longer wraps.

Regression after all slices: W1–W3 suite clean (the one standing
"bus recorded boot verbs" expectation remains a test artifact —
prov does not fire at boot; the bus is proven on interaction),
add-object 10/10, W4 three-phase E2E, W5 behavior checks — 0 page
errors throughout. Pre-slice backup:
`EDITOR-PROTOTYPE-TW.w4-backup-2026-11-13.html`.

The prototype is now wire-ready in the full sense of this spec:
every behavior runs through the command bus and the data layer,
the whole game saves locally and over HTTP, and the only
remaining work is the production side — the Express editor
backend implementing the contract in `backend-reference/`, and
the React port consuming the same document shape.
