# Editor UI 2026 — rebuilding the editor from the Aether mockups

Status: design note, written 2026-11-22 from the two mockups the owner sent.
Scope: `apps/editor` and the `modules/*/editor` panels it mounts. The game
client is a different surface and keeps its own kit
(`apps/client/src/ui/kit/`, PR #737).

## 1. What the two references are

They are two different products, not two skins of one. Both are
single-page mockups built on Arena's Code Arena; neither is runnable
engine code, and nothing is copied from them.

| | **Functionality reference** | **Styling reference** |
|---|---|---|
| Title | Aether Engine — ECS Editor & Game UI SDK | AetherForge Studio — ECS Game Authoring |
| Role | what the editor should **do** | how the editor should **look** |
| Top-level tabs | Scene Editor, UI SDK | Design, Runtime, Code, Git, UI Kit |
| Shape | one screen, everything docked into it | five modes over one shared frame |
| Density | very high, decorated | very high, quiet |

The owner's instruction: take the functionality from the first and the
visual language from the second. The two are compatible, because the
first one's feature set fits inside the second one's frame almost
one-for-one: its eight-tab bottom dock collapses into the styling
reference's four-tab dock, and its floating viewport card is the same
idea as our existing summoned-widget authoring stage.

## 2. Screen-by-screen map

Read as: **what the functionality mockup shows** → **where we stand**.
"Differs" means the capability exists and the rebuild is presentation;
"missing" means there is no code behind it today.

### 2.1 Shell chrome

| Mockup element | Today | Verdict |
|---|---|---|
| Product mark + mode tabs (Scene Editor / UI SDK) | 17 workspace tabs in a Material 3 bar (`App.tsx` `WORKSPACES`) | **Differs** — we have strictly more; the rebuild is grouping and styling, not new routing |
| Transport: play / pause / step / stop + EDIT MODE label | play menu, play setups, play mode and debugger (`play-menu.tsx`, `play-mode.tsx`, `play-setup.ts`) | **Differs** — ours is a menu, theirs is a transport; adopt the transport |
| Branch chip `main ↓0 ↑0` | `/api/editor/vcs` status returns branch and per-file state (`vcs-host.ts`) | **Differs** — data exists, chip does not |
| Blender / server / VS Code status chips | server link exists (`server-gate.ts`); Blender and VS Code do not | **Partly missing** |
| Breadcrumb `SCENES / ARENA_SANCTUM / WORLD_ROOT` (styling ref) | deep links `#/workspace/view/selection` already encode exactly this path | **Differs** — the data is already in the URL, it is simply not drawn |
| Status bar: counts, selection, guard, locality | status strip exists | **Differs** |

### 2.2 Hierarchy / outliner

| Mockup element | Today | Verdict |
|---|---|---|
| Object tree with nested sub-entities | hierarchy dock in the authoring view (`authoring-view.tsx`), scenes tree (`scenes-panel.tsx`) | **Differs** |
| Component chips per row (Health, Wander AI, …) | not drawn on rows | **Missing** (cheap) |
| Per-row component count badge `8C` (styling ref) | not drawn | **Missing** (cheap) |
| Filter box | exists | **Exists** |
| `NEW GAME OBJECT`, delete selected | authoring shelf verbs dispatch live | **Differs** |

### 2.3 Systems & modules list (left, lower)

| Mockup element | Today | Verdict |
|---|---|---|
| Every system with live entity count (`8e`) | `/api/editor/graph` + `ecs-graph-model.ts` index systems and their component access | **Differs** — we hold richer data (reads/writes/excludes, declared vs inferred) and show it only in the H4 footprint panel |
| Per-system component signature chips | same source | **Differs** |
| Per-system enable toggle | module enable/disable exists (`modules-panel.tsx`); per-system does not | **Partly missing** |
| Tick cost per system (`0.000ms`) | not surfaced in the editor | **Missing** — the numbers exist on the server tick, nothing pipes them in |

### 2.4 Viewport

| Mockup element | Today | Verdict |
|---|---|---|
| Gizmo toolbar (select/move/rotate/scale, global/local, snap, layers, pivot) | `scene-viewport.tsx` + `collider-overlay.ts`, no gizmo set | **Mostly missing** |
| Viewport mode segment SCENE / GAME / PREFAB (styling ref) | play mode is a workspace switch, not a viewport segment | **Differs** |
| Stats overlay (FPS · entities · draws · tris) | partly, in debug overlays | **Differs** |
| Axis widget | missing | **Missing** (cheap) |
| Floating selection card with grouped component editors | **this is already our design** — the authoring view summons floating widget stacks on selection (`authoring-view.tsx` header comment, EDITOR-AUTHORING.md) | **Exists** — restyle only |
| "Suggested for this context" recommendation | the add-shelf relevance rules already do this | **Exists** |

### 2.5 Inspector

| Mockup element | Today | Verdict |
|---|---|---|
| Name + tag dropdown | exists | **Differs** |
| State segment ACTIVE / SLEEPING / DISABLED (styling ref) | no entity state concept in the inspector | **Missing** |
| Details / Components / Modules tabs | single scroll | **Differs** |
| Component cards with per-component byte size and archetype bitmask | `ecs-footprint.tsx` has per-component access and live values; byte sizes and the archetype mask are not shown | **Partly missing** |
| Component rows with a letter badge and a field summary | plain rows | **Differs** |
| `ADD COMPONENT` | add shelf exists | **Differs** |
| Utility systems with "Enroll +Rotator" buttons | no enrol affordance | **Missing** |
| Decomposition / sub-entity list | hierarchy covers it | **Differs** |
| FOCUS / CLONE / DELETE actions | partial | **Differs** |

### 2.6 Bottom dock — eight tabs in the functionality reference

| Tab | Today | Verdict |
|---|---|---|
| **Code** — file tree over the project, editor, SAVE, open in VS Code / vscode.dev, collaborator lock banner | `/api/editor/files/:kind` is document-only (scene, playtest, build) by design, and refuses anything else; there is no source editor | **Missing** |
| **Terminal** | none | **Missing** |
| **Source Control** — branch, incoming changes, pull & merge, conflict guard, soft file locks | `vcs-host.ts` already does status / diff / log / stage / commit / pull / push / three-way resolve **and advisory soft locks in `content/locks.json`**; the Changes workspace draws it | **Exists** — the mockup's "Conflict Guard" is our lock API with a better name |
| **Assets** — prefab gallery with entity counts, import .glb, imported meshes, UI texture package | Art & audio workspace: Art Assets, Materials, Scale, asset inspector, model/rig preview | **Differs** — ours is a library, theirs is a spawn palette |
| **Blender** — live link, auto-import on save, send selection, a bridge add-on to copy | none | **Missing** |
| **Runtime** — discover running servers, attach, stream tick timings and bandwidth | `server-gate.ts` + `mirror-connect.ts` attach to a running server; discovery and the streams are not drawn | **Partly exists** |
| **Profiler** — SoA component storage, live vs reserved bytes, arrays and bytes per entity | nothing equivalent | **Missing** |
| **Console** | logs appear in several panels, no single console | **Partly missing** |

The styling reference folds these into four — Console, Code, Source
Control, Integrations — where **Integrations** is a status list (Blender
bridge, VS Code, UI layout, git worktree, runtime node). That grouping
is better than eight tabs and is what the rebuild should use.

### 2.7 UI SDK / UI Kit tab

Both references carry one, and it is **not an editor surface**: it is a
game-HUD component kit (buttons and states, ability bars with cooldown
sweeps, health and mana bars, a motion language of four named easings,
FairyGUI-style controllers and gears). This is the same ground as our
client style kit. See §5.

## 3. The gap list, in the order it should be built

Ranked by value over cost. Items marked (cheap) are presentation over
data we already hold.

1. **Design-language layer** — new tokens, chrome metrics, type scale. Restyles every workspace at once (see §4).
2. **Shell chrome rebuild** — breadcrumb, transport, branch chip, integration chips, status bar. (cheap, data exists)
3. **Inspector rebuild** — Details / Components / Modules tabs, state segment, component rows with letter badges and field summaries, archetype card, focus/clone/delete.
4. **Outliner badges** — component chips and counts per row. (cheap)
5. **Systems list with live counts and signatures** — surface what `/api/editor/graph` already indexes. (cheap)
6. **Per-system tick cost** — needs a server-side per-system timing feed; nothing exists today.
7. **Viewport gizmos and axis widget** — the biggest piece of genuinely new interactive code.
8. **Viewport mode segment** (Scene / Game / Prefab) over the existing play mode.
9. **Dock regrouping to four tabs**, with Source Control moved into it from the Changes workspace.
10. **Profiler panel** — per-component SoA footprint, live vs reserved. Needs a storage-stats endpoint.
11. **Console** — one place for the logs the panels each keep privately.
12. **Runtime discovery** — probe local ports, list, attach; the attach half exists.
13. **Code editor + terminal** — the largest and the most dangerous. See §5.
14. **Blender live-link** — a bridge add-on, a websocket, glTF import. Standalone; can come last.

## 4. The design language, as a token system

Measured from the styling reference's rendered DOM (computed styles, not
guesswork). It is Tailwind v4 with raw values and no custom properties,
so these are our names, not theirs.

### Palette

```
--fg-canvas      #05080E   page ground
--fg-panel       #050A12   panel ground
--fg-bar         #080D15   top bar       (95% alpha over canvas)
--fg-toolbar     #0A111B   toolbar       (95%)
--fg-dock        #070C13   dock + status (95%)
--fg-sunken      rgba(0,0,0,.30)   inputs, wells, command line
--fg-raised      rgba(255,255,255,.025)  selected chip, hovered row

--fg-line        #263646   hairline, 1px
--fg-line-soft   rgba(255,255,255,.08)  the common case
--fg-line-accent rgba(125,211,252,.18)  framing an active region

--fg-accent      #22D3EE   primary (cyan 400)
--fg-accent-text #53EAFD   accent used as text
--fg-accent-wash rgba(0,210,239,.10)  active tab fill

--fg-ok          #34D399   clean, connected, active
--fg-warn        #FFD236   sleeping, pending
--fg-bad         #FB7185   error, disabled
--fg-note        #EC6CFF   scripting / contextual
--fg-axis-x      #FB7185
--fg-axis-y      #A3E635
--fg-axis-z      #60A5FA

--fg-text        #D7E3F0   primary text
--fg-text-dim    #8FA3B8   secondary
--fg-text-faint  #5A6B7D   tertiary, mono metadata
```

Three semantic hues only (ok / warn / bad) plus one accent. Everything
else on screen is a grey. That restraint is most of why the styling
reference reads as calmer than the functionality one, which puts a
different hue on every component group.

### Type

Three families, each with one job:

| Family | Job | Sizes seen |
|---|---|---|
| **Rajdhani** 600 | labels, tab names, section headers; tracking .10–.16em | 9, 10px |
| **Inter** 400/500 | object names, prose, field labels | 10, 11px |
| **JetBrains Mono** 400/700 | values, IDs, counts, log lines, types (`F32 VEC3`), axis letters | 8, 9, 10px |

Nothing on the chrome is larger than 11px. Headers are made to read by
tracking and case, not by size. The only large type is the product mark.

### Geometry and density

```
radius:  0  chrome bars      2  chips      4  cards, controls, inputs
bars:    top 56   toolbar 36   status 28   dock 214 (resizable)
panels:  left 240   right 340   (at 1680 wide)
control: 24 / 28 / 32px tall;  icon button 28×28
spacing: 4px base; 8px between fields; 12px panel padding
border:  1px everywhere; no shadows on panels, no elevation ladder
```

### States

Hover lifts the ground by about 2.5% white. Selection is a 1px accent
hairline plus the accent wash, never a solid fill. The active dock tab
is a 2px accent underline on a 7%-accent fill. Disabled is `--fg-bad` at
low opacity on the label, not a greyed control.

### How this lands in our code

`apps/editor/src/app.css` already defines the whole Material 3 palette as
custom properties and the editor source uses them 453 times. Only 126
hardcoded hex values remain, across 21 files (chart and 3D colours
mostly). So the design-language layer is a **token remap plus a chrome
pass**, not a component rewrite — and the 21 files are a known cleanup
list, not a blocker.

## 5. Conflicts, and how they are resolved

1. **The UI SDK tab is the client's kit, not the editor's.** Our client
   already has one (`apps/client/src/ui/kit/`, generated textures, three
   rules, contrast-checked). The editor must not adopt it and the client
   must not adopt the editor's. The rebuild therefore **drops the UI SDK
   tab from the editor** and keeps that work in the client. If the owner
   wants a HUD composer inside the editor, it belongs in the Release
   workspace beside the existing HUD layout editor, drawn in the editor's
   language and previewing the client's kit.

2. **FairyGUI appears in both references and we rejected it.** The
   styling reference's UI Kit tab is explicitly a "FairyGUI Composer";
   the functionality reference's SDK advertises FairyGUI controllers and
   gears. We evaluated FairyGUI on 2026-11-21 and rejected it as a
   runtime: it renders nothing on three r186, which we pin. The
   *patterns* it names — a controller driving named pages, gears binding
   properties to those pages — are good and are worth copying as plain
   React. The library is not.

3. **A code editor and a terminal in the editor cross a line we drew on
   purpose.** `files-host.ts` only serves whitelisted document kinds and
   validates every path; `vcs-host.ts` refuses to touch `assets/` whatever
   git says, because that art is licensed and confidential. An embedded
   editor over arbitrary source and a terminal would undo both. If we
   build them they need their own threat model, and "open in VS Code" —
   which both mockups also offer — gets most of the value for none of the
   risk. **Recommendation: build the handoff, not the IDE.**

4. **Engine core versus game IP.** The editor is an engine tool that
   authors game-side data, so it stays on the engine side of the split.
   Nothing in this rebuild should name our bestiary, our settlements or
   our quests; the mockups' sample content (Patrol Drone, Arena_Sanctum)
   is a reminder that the shell should be content-agnostic.

## 6. Slices

- **EU1** — token layer and chrome metrics; both themes selectable so the old one stays for comparison.
- **EU2** — shell chrome: breadcrumb and context chips, in
  `apps/editor/src/ui/forge-chrome.tsx`. The transport stays on the
  toolbar: it is a control, and duplicating it would give the editor two
  Play buttons. The chips are read-outs only, over the shared tool store,
  `editorSelection`, `playUiStore`, `/api/editor/vcs/status` and the
  shell's problem total. A conflict outranks a change in the branch chip,
  which is what the reference's "Conflict Guard" signal amounts to over
  the data `vcs-host.ts` already returns.
- **EU3** — inspector rebuild over the existing view-model.
- **EU4** — outliner badges; systems list with counts and signatures.
- **EU5** — dock regrouped to four tabs; Source Control moves in.
- **EU6** — viewport gizmos, axis widget, mode segment.
- **EU7** — profiler panel; per-system tick cost (needs a server feed).
- **EU8** — console; runtime discovery.
- **EU9** — VS Code handoff (not an embedded IDE).
- **EU10** — Blender live-link, if still wanted.

EU1–EU5 are presentation over data we already hold. EU6 onward is new
capability and each needs its own PR with captures.

## 7. Proof

See the PR this note lands in: EU1, EU2 and EU3 built on real screens,
importing the existing panels and stores so behaviour cannot drift.

Two harnesses photograph them, both running the editor's own Tailwind
over the editor's own `app.css` so the Material 3 side of a comparison is
the shipped thing and not an approximation:

- `src/ui/forge/capture.mjs` — the inspector, before and after, over one
  fixture snapshot fed through the shipped `EcsInspector` view-model.
- `src/ui/forge/capture-shell.mjs` — the context bar as a still, and as a
  GIF. Each GIF frame is the real component reacting to a write to the
  real store (`setTool`, `editorSelection.select`, `playUiStore.set`),
  not a storyboard of mock states.

Set `CHROMIUM_PATH` where Playwright's own browser download is absent.
