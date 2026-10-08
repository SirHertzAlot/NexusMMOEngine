# Editor Architecture — the modular editor

The plan for the phase after the current roadmap: turn `apps/editor` from a
row of inspector tabs into a proper editor in the mould of Unreal and Unity,
fitted to how this engine works. It covers four asks:

1. **A real editor shell**: dockable panels, a viewport, an outliner, a
   details panel, a content browser, play and stop on a toolbar.
2. **Scenes** that represent the parts of the game (the login screen,
   character creation, a world region, a dungeon, a test arena), and a
   **game flow** that runs login → character creation → in game.
3. **Modules**: everything modular and loadable, so modules are developed
   separately and attached to the engine while editing: editor panels, C++
   addons, and WebAssembly applications through a sidecar.
4. **MVC**: models for the data, controllers instantiated at runtime that
   assemble view data, views that only render.

It also plans the database editor ([§7b](#7b-the-database-editor-and-the-persistence-core))
and nine production tools ([§7c](#7c-production-tools)): version control,
build and deploy, quests and dialog, animation, VFX and materials, the HUD
layout, audio, localization and automated playtests.

This is a design doc. The slices in [§10](#10-slices) are what goes on the
roadmap; nothing here changes code by itself.

**About the tool implementation list.** The request mentions a tool
implementation list that comes after the roadmap. No such list is in the
repository today (not in `docs/`, the README, `ROADMAP.md` or any branch's
docs). [§9](#9-tool-inventory) is an inventory of every developer tool that
exists or is planned, mapped onto the module structure below, so it can
seed that list.

## 1. Where we start

What the plan builds on, as the code stands on 2026-10-03.

**The editor** (`apps/editor`, Vite + React + Tailwind, port 5174) is a
standalone companion app ([`EDITOR.md`](EDITOR.md),
[`DECISIONS.md`](DECISIONS.md) 2026-09-27). `src/ui/App.tsx` switches
between seven hard-coded tabs: ECS Inspector, Play Mode, Terrain, Gameplay
Tables, Art Assets, Rules, Characters. Everything privileged goes through
`src/host.ts`, a dev-only Vite plugin serving loopback `/api/editor/*`
routes: start and stop the owned server, terrain export and import, rules
and tables read and validated write, asset scan, character records.

The editor is already halfway to MVC, just without the names:

| Today | Role | Notes |
|---|---|---|
| `inspectors/ecs.ts` (`EcsInspector`) | view-model | Pure TS, no React; takes a `() => EntitySnapshot` provider; read-only by construction |
| `play-mode.ts` (`PlayModeController`) | controller | State machine `idle → starting → running → stopping`; server and client are injected seams |
| `rules-store.ts` / `rules-host.ts` | model (Node side) | Reads and validates `content/rules`, writes only when valid |
| `rules-control.ts`, `server-control.ts` | model adapters (browser side) | HTTP over the host routes; split from the Node side so rollup never bundles fs code |
| `terrain/terrain-view.ts` | view (three.js) | Draws the heightmap exactly like the client's terrain |
| `ui/*.tsx` | views | One React panel per tab |

What is missing is the frame: a registry the shell builds panels from, one
contract for controllers, and a way to add a panel without editing `App.tsx`.

**The engine** is one authoritative Node process (`packages/engine-core`,
`src/server.ts`) running a 30 Hz `TickLoop` over a bitECS `SimWorld`.
Systems implement `SimSystem { name; step(sim, dt) }` and are listed in one
hard-coded array in `server.ts` (reloader, stats, streamer, bots,
creatures, crowd, intent, combat, death, stamina, needs, mastery,
integrate, character, collider, obstacles, physics, navigation, items).
Heavy systems are C++ N-API addons (`packages/addons/*`: physics, navigation,
procgen, picg, geometry, scatter, perf-probe) behind narrow injected
backends with bulk SoA calls. Game rules are data plus hooks
(`packages/rules`, `content/rules/*.json`, hot reloaded by `RulesReloader`).
The world is baked from a spec (`engine-core/worlds/default.world.json`).
The server is configured through `MMO_*` environment variables.

**The edge** (`apps/edge`, [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md))
already has a module idea: `content/edge/routes.json` maps a packet type to
`core` or `local:<module>`, a handler registered on the edge. E2 (PR #89)
adds a length-prefixed JSON channel between processes with request,
response, push and heartbeat.

**The client** (`apps/client`) hard-codes the game flow in `App.tsx`:
`type Screen = "login" | "connecting" | "characters" | "world"`, switched by
protocol events (welcome, account, join reply). Character creation is
`ui/character-screen.tsx`, which already runs without a server
(`?preview=character`). The world is a React Three Fiber canvas
(`render/world-canvas.tsx`).

**In flight** (the Editor thread, roadmap E4 to E9): E4 embeds the client's
world renderer in play mode through a shared package, E5 brings the
dockable debugger panels (today `apps/client/src/ui/dev-panels.tsx` and
`dev-layout.ts`) into the editor, then PICG graph editing (E6, E7), the
dungeon view (E8) and world-scale editing (E9). This plan assumes those
land first and builds on them rather than around them; see
[§11](#11-coordination-with-work-in-flight).

## 2. Principles

These come from decisions already made; the architecture has to keep them.

- **The server stays authoritative.** The editor never writes a running
  simulation's ECS state. It edits *documents* (scenes, flows, rules,
  terrain, modules), which are validated and then loaded by the server, and
  in play mode it sends the same intents and admin commands a client sends.
  This is the ECS inspector's rule, generalised.
- **Client for players, editor for developers.** Scenes and flows the
  editor authors ship to the client as data; the editor's own tools never
  ship in the client ([`DECISIONS.md`](DECISIONS.md) 2026-09-30).
- **Data plus hooks.** A scene, a flow and a module manifest are JSON
  validated by a Zod schema in a package, like `content/rules`. The engine
  ships defaults; our game is one set of documents.
- **One implementation, shared.** The editor's viewport is the client's
  renderer (E4), its network is `@mmo-engine/mirror`, its art is
  `@mmo-engine/art`. A module never forks one of these.
- **Nothing new on the hot path.** Modules attach at boot or between ticks,
  never through per-entity indirection inside a tick. Sidecars are never on
  the tick's critical path.
- **Privileged work goes through the host.** File writes, process spawns
  and native builds happen in the loopback host, never in the browser.

## 3. The shape of the editor

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Toolbar:  scene ▾  │ ▶ Play  ▶ Play from here  ■ Stop │ modules ▾     │
├──────────────┬─────────────────────────────────────┬─────────────────┤
│ Outliner     │ Viewport (shared renderer, E4)      │ Details         │
│ scene tree   │ edit camera or play camera,         │ selected node's │
│              │ gizmos, overlays                    │ components,     │
│              │                                     │ validated edits │
├──────────────┴─────────────────────────────────────┴─────────────────┤
│ Content browser │ Output log │ Flow graph │ Debugger panels (E5) ...  │
└──────────────────────────────────────────────────────────────────────┘
```

| Unreal / Unity | Here | Backed by |
|---|---|---|
| Level / Scene | **Scene document** (§5) | `content/scenes/*.scene.json` |
| World Outliner / Hierarchy | **Outliner** | the open scene's node tree; in play mode, live entities from the mirror (today's ECS inspector) |
| Details / Inspector | **Details** | the selected node's fields, written back through the scene model with schema validation |
| Content Browser / Project | **Content browser** | `content/`, the art pack, PCG parts and trees, prefabs |
| Viewport / Scene view | **Viewport** | the client's world renderer (E4) with an edit camera |
| Play In Editor / Play mode | **Play mode** | `PlayModeController` and the owned server, now booted with the open scene (§7) |
| GameMode / scene flow | **Game flow** (§6) | `content/flow/*.flow.json` |
| Plugins / Packages | **Modules** (§4) | `modules/<name>/module.json` |
| Project Settings | **Project settings** | the `MMO_*` server settings and editor preferences, as a document |
| Output Log / Console | **Output log** | owned server stdout, module and sidecar logs, admin console |

### 3.1 MVC, concretely

```text
           documents on disk                 live sources
   (scenes, flows, rules, terrain,     (mirror state, debug 0x0a,
    module manifests, art pack)         admin 0x10, telemetry)
                 │                               │
                 ▼                               ▼
   ┌──────────────────────────────────────────────────────┐
   │ MODEL   typed, validated stores. Each document type  │
   │         has a schema, a load, and a save that writes │
   │         only when valid (the rules-store pattern).   │
   │         Changes are commands → undo/redo.            │
   └──────────────────────────────────────────────────────┘
                 │ read / command                ▲ change events
                 ▼                               │
   ┌──────────────────────────────────────────────────────┐
   │ CONTROLLER  instantiated at runtime from the         │
   │             registry; assembles a view-model from    │
   │             one or more models; turns user actions   │
   │             into model commands or intents.          │
   └──────────────────────────────────────────────────────┘
                 │ view-model (plain data)       ▲ user actions
                 ▼                               │
   ┌──────────────────────────────────────────────────────┐
   │ VIEW    React panel or three.js viewport layer.      │
   │         Renders the view-model, never a model.       │
   └──────────────────────────────────────────────────────┘
```

The contracts, in the style of `SimSystem` (small, injected, testable):

```ts
/** A typed document store. One per document kind and open document. */
interface Model<T> {
  readonly kind: string;                    // "scene", "flow", "rules", ...
  get(): Readonly<T>;
  apply(cmd: Command<T>): ValidationResult; // in-memory edit, undoable
  save(): Promise<ValidationResult>;        // through the host; writes only when valid
  subscribe(fn: (t: Readonly<T>) => void): () => void;
}

/** Assembles view data from models and live sources; no React, no DOM. */
interface Controller<VM> {
  readonly id: string;
  attach(ctx: EditorContext): void;         // models, mirror, host, selection, log
  viewModel(): VM;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

/** What a module contributes; the shell builds itself from these. */
interface PanelContribution {
  id: string;                               // "core.outliner", "picg.graph"
  title: string;
  dock: "left" | "right" | "bottom" | "center";
  controller: (ctx: EditorContext) => Controller<unknown>;
  view: React.ComponentType<{ controller: Controller<unknown> }>;
}
```

"Runtime instantiation" means the shell does not import panels: it reads
the registry, and for each panel the layout opens it calls the
contribution's `controller` factory, attaches it to the shared
`EditorContext`, and mounts the view with it. Closing the panel disposes
the controller. Two Details panels on two selections are two controller
instances over the same models. Controllers stay pure TS like
`EcsInspector`, so they are unit-tested with fakes and `node:test`, as the
editor's tests are today.

**Selection and undo are shared models**, not panel state: picking in the
viewport, the outliner or the ECS list sets one selection model every
controller reads. Every document edit is a `Command` with `do` and `undo`,
so undo spans panels the way it does in Unity.

The shell implements this selection path with `EditorSelectionModel`.
The World outliner, ECS entity list and Play Mode viewport publish a
selection's source, identity and component fields; the Details dock reads
that one model and decomposes the selected object. More panel controllers
can join the same model without adding selection-specific shell state.

**Existing panels map without rewrites.** `EcsInspector` becomes the
controller of the play-mode outliner, `PlayModeController` the toolbar's,
rules and tables keep their stores as models. EA2 moves them behind the
contracts; behaviour does not change.

### 3.2 Look and feel: Material Design 3

The editor's visual language follows Google's
[Material Design 3](https://m3.material.io/), dark scheme first, adapted
for a dense desktop tool. Concept mockups of scene editing, play mode, the
flow editor and the Modules window live in
[`editor-update-refs/`](editor-update-refs/). They are documentation assets
only: the editor loads no runtime data from them.

- **Colour roles, not colours.** One seed colour generates the scheme
  (primary, secondary, tertiary, error, and the surface-container ladder)
  as CSS tokens. Panels sit on tonal surfaces (`surface-container-low` for
  side panels, `-high` for the details panel), never on borders and
  shadows. Tertiary is reserved for play: the Play FAB and play-only
  overlays, so play state is recognisable at a glance; Stop uses the error
  container.
- **Navigation rail** for the editor's top-level places (Scene, Flow,
  Content, Modules, Rules, Debug, Settings). Modules can add a destination.
- **One primary action per screen** as an extended FAB in the viewport
  ("Play from here", "Stop"). Edit / Simulate / Play is a segmented button
  in the top app bar.
- **Components from the M3 set**: outlined text fields with inline
  validation, sliders with value labels, filter chips for layers and
  module kinds, switches for enabling modules, linear progress for native
  builds, snackbars for undo and for "Apply modules", tabs inside panels.
- **Desktop density.** M3's compact density (40 px list items and buttons)
  everywhere except the viewport overlays, which keep 40 px touch-size
  targets because they float over a moving picture.
- **Feedback states are first-class**: a schema-valid banner on Details,
  "needs a play restart" on a module card, live/idle chips on the play
  server, empty states that say what to do next ("Drag a prefab from
  Content to place it").
- **Type and icons**: Roboto Flex for UI, Roboto Mono for ids, events and
  logs, Material Symbols Rounded for icons (all open licence, bundled with
  the editor rather than loaded from a CDN, so it works offline).
- **Accessibility**: M3 tone pairs keep text at 4.5:1 contrast or better;
  every viewport tool has a keyboard shortcut shown in its tooltip; focus
  rings use the primary colour.

EA1 introduces the tokens and the rail; existing panels are restyled as
they move behind the panel registry, not in a separate pass. The tokens
live in one place so a module's panels match without importing a
component library; adopting `@material/web` components is an option for
EA1, not a requirement.

### 3.3 Every engine feature in the editor: workspaces

Every feature the engine has, or the roadmap plans, is reachable from the
editor. They are grouped into **workspaces**, as in Blender: a workspace
is a named, saved layout of dockable panels for one kind of work, picked
from tabs in the top bar. Modules add panels to existing workspaces and
can add workspaces of their own.

| Workspace | What it covers |
|---|---|
| **World** | terrain sculpting and the world bake; regions and the world map (E9); ecology and scatter; WFC formations; coast, water, sky, day and weather; navmesh tiles and the tile cache; chunk streaming radius |
| **Scene** | outliner, viewport, details; prefabs and the prefab builder (R2); spawners and spawn points; lighting; play from here |
| **Flow & UI** | the game flow graph (§6); login, register, character select and creation scenes; the HUD layout editor (frames, chat, bag, character sheet) at every UI scale and quality tier (§7c.6) |
| **Characters** | appearance catalog and body parts; skills, mastery and disciplines; needs and stamina; character records (E10); the appearance and equipment editor (A6) |
| **Gameplay** | data grids over every `content/rules` table (items, creatures, loot, death, combat, body, skills, needs, materials and recipes, species, ranks, ingress) and the rules tree (E11, ED1) |
| **Dungeons & PCG** | dungeon pool, layouts, shells and dressing (E8); instances (D4); the PICG graph editor and selection cards (E6, E7); the asset library and cooks |
| **Live ops** | the admin console (A1 to A5); players, accounts, parties, guilds, friends; chat and event log; the item ledger and checkpoints; play telemetry (T2) |
| **Network** | edge routes and modules; edge-core channel health; `/metrics` with links out to Prometheus and Grafana (edge E6); the world server and regions; ingress limits |
| **Debug** | the debugger's panels and performance graphs (E5); tick and per-system timings; wireframe and FX showcase; valgrind perf baseline and memcheck results |
| **Database** | every SQLite table, edited through the persistence core; read-only queries and plans; statement timings, caches and pragmas; the audit log (§7b) |
| **Story** | quest and dialog graphs, the dialog tester and quest state (§7c.3); localization string tables (§7c.8) |
| **Art & audio** | animation clips, state machines and the combat timeline (§7c.4); particles, materials, post and quality tiers (§7c.5); sound events and the mixer (§7c.7) |
| **Release** | build profiles, the pipeline and packages, deploy targets and rollback (§7c.2); playtest scenarios, replays and results (§7c.9) |

Modules and content (the Modules window, the content browser, the art pack
scan and import) and version control (the Changes panel, §7c.1) are
reachable from every workspace.

**Data-rich views follow established patterns** rather than inventing
them:

- **Tables** follow IBM Carbon's data table guidance
  ([usage](https://carbondesignsystem.com/components/data-table/usage/)):
  selectable row density (24, 32, 40 px; the editor defaults to 32), a
  toolbar of the same height with search, filters and at most five
  actions, a batch-action bar when rows are selected, sort icons shown on
  the sorted column and on hover, inline edit with per-cell validation,
  and expandable rows for nested data (a creature's drops, an item's
  physics).
- **Panes** follow Material 3's canonical layouts
  ([list-detail and supporting pane](https://m3.material.io/foundations/adaptive-design/canonical-layouts)):
  a list (tables, outliner) beside its detail (Details, Compare), with
  resizable dividers.
- **Dashboards** (Live ops, Network, Debug) put a row of stat tiles over
  time-series charts over tables, like Grafana: the number first, the
  trend second, the rows last.
- **Live values sit beside authored ones**: the Gameplay grid shows each
  creature's kills over the last ten minutes of play beside its health
  and aggro, so tuning uses what actually happened.

### 3.4 Layout customization

Layouts work the way they do in Unreal
([layout customization](https://dev.epicgames.com/documentation/en-us/unreal-engine/layout-customization?application_version=4.27))
and Blender
([workspaces](https://studio.blender.org/training/blender-fundamentals-45-lts/blender_4-5_lts_workspaces/)):

- **Every panel is a tab** that can be dragged by its title. While dragging,
  dock targets appear over the panel underneath (top, bottom, left, right,
  or as a tab in the same stack), with a preview of where it lands.
  Dividers between stacks are resizable; double-clicking a tab maximises
  it.
- **Panels pop out** into their own browser window and dock back, so a
  second monitor can hold the debugger or a data grid. Popped-out panels
  stay in sync because they share the same models (§3.1).
- **Layouts are saved by name** (`Ctrl Shift S`), per workspace, and can be
  switched, reset to the workspace default, exported and shared as a JSON
  file. The layout records each panel's contribution id, stack, size and
  open state; a panel whose module is disabled is skipped and comes back
  when the module returns.
- **Persistence**: layouts are per user in the browser by default, and a
  project can commit default layouts under `content/editor/layouts/` so
  the team starts from the same arrangement.
- **Play mode keeps the layout.** Entering play swaps only what the panels
  show (the outliner turns live, Details turns read-only), never where
  they are; a workspace can name a separate play layout if wanted.

The layout engine is the docking system E5 builds for the debugger,
grown into the shell in EA1, not a second implementation.

### 3.5 The toolbar and the play button

**Two bars.** The top bar holds the menus (File, Edit, View, Window,
Help), the workspace tabs and the command search (`Ctrl K`, which finds
any command, panel, asset or setting, including those modules add). The
toolbar under it holds the tools for the current workspace and the play
controls.

**The toolbar is customizable.** Commands are contributions like panels:
the core module ships save, undo and redo, the transform tools, snapping
and build; modules add theirs (regenerate region, reload sidecar, build
native module, run memcheck, spawn at cursor). Right-click → Customize
lets you drag commands on and off, group them, and choose icons only or
icons and labels. The toolbar is saved with the layout.

**The play cluster** sits in the middle of the toolbar, always in the
same place:

- **Play** is a split button. The main part plays with the last settings
  (`F5`); the arrow opens the play menu.
- **Pause** and **Step** (one 30 Hz tick at a time) work on the owned
  server's tick loop, like Unity's pause and step. **Stop** ends play
  (`Shift F5`).
- A chip beside it shows the current setup ("In viewport · 1 client ·
  edge + core"), so what Play will do is never a surprise.
- While playing, the play cluster and the window edge take the tertiary
  colour, like Unity's play-mode tint, so nobody edits a live world by
  mistake.

**The play menu** gathers every way to run the game:

| Choice | Options |
|---|---|
| Where | in the viewport (panels stay around it), in a new window (the player's client), or simulate (the world runs, no player joins) |
| Start from | any flow node (login, character creation, world) or the camera's position |
| Clients | 1, 2, 4 or 8 clients, each with its own seeded editor account, for testing parties, trade and combat between players |
| Bots | computer-driven characters near the spawn point (the server's `MMO_BOTS`) |
| Network | core only, or edge and core (once the edge split lands) |
| Latency | none, 80 ms or 200 ms of simulated delay on the client connections |
| State | a fresh world from the scene, or continue the saved one; keep or discard play changes on stop (§7) |

Play setups can be saved by name ("Raid test: 8 clients, 200 bots") and
bound to a shortcut. Concept mockups of the workspaces, the dock targets
and layout menu, the toolbar customization and the play menu go with the
PR.

### 3.6 Frontend stack: React and React Three Fiber

The overhaul is a frontend redesign, built on the stack the client
already uses ([`DECISIONS.md`](DECISIONS.md) 2026-09-29): React 19 for
every panel and React Three Fiber 9 (with drei and postprocessing, as in
`apps/client`) on three 0.186 for every 3D view.

- **Today** the editor is React DOM with plain three.js viewports
  (`terrain/terrain-view.ts`, `ui/model-preview.tsx`) and no R3F
  dependency. The overhaul adds `@react-three/fiber` and `@react-three/drei`
  at the client's versions, so both apps share one 3D stack.
- **One `<Canvas>` per viewport panel.** The scene viewport, the play view,
  the character preview, the dungeon view and the PICG preview are R3F
  canvases inside dockable panels. The world itself is the shared renderer
  E4 extracts from the client, mounted as R3F components, never a copy.
- **Editor-only 3D is R3F components too**: gizmos (drei's
  `TransformControls` / `PivotControls`), grid, selection outlines,
  overlays for navmesh tiles, paths and spawn areas, the edit camera
  (`OrbitControls`). Modules add viewport tools the same way, as R3F
  components in a panel contribution.
- **The MVC split holds.** Mirror and model state is read in `useFrame`,
  never pushed through React state each frame (the client's rule);
  controllers stay pure TS, and React re-renders only on view-model
  changes. The existing terrain view's classes are wrapped in R3F rather
  than rewritten, as the client did with its renderers.
- **Material 3 tokens** (§3.2) are CSS variables in Tailwind's theme, so
  panels, the docking layout and HTML overlays inside canvases (drei's
  `Html` for nameplates, labels and gizmo readouts) share one look.

The redesign lands as EA1 and is built against the mockups that go with
this PR (`ux-01` to `ux-08`).

## 4. Modules

A module is a folder with a manifest. It is the unit you develop, enable,
disable and ship. One manifest can contribute to several sides of the
engine, so a feature like "dungeons" ships its editor panel, its server
system and its native generator together.

```text
modules/
  dungeon-tools/
    module.json          manifest (schema in @mmo-engine/modules)
    editor/index.ts      editor contributions (panels, document kinds, tools)
    server/index.ts      server contributions (systems, admin commands, rules)
    native/              a C++ N-API addon (binding.gyp, src/)
    sidecar/             a sidecar program (a .wasm, or any executable)
    content/             default documents the module brings
```

```jsonc
{
  "name": "dungeon-tools",
  "version": "0.1.0",
  "engine": ">=0.1.0",
  "dependsOn": ["core"],
  "editor":  { "entry": "editor/index.ts" },
  "server":  { "entry": "server/index.ts", "systems": [
                 { "name": "dungeon-instances", "after": "creatures", "before": "intent" } ] },
  "native":  { "addon": "native", "valgrind": true },
  "sidecar": { "kind": "wasm", "entry": "sidecar/layout.wasm",
               "channel": "dungeon.layout", "restart": "on-crash" },
  "edge":    { "routes": [ { "packetType": "dungeon.query", "handler": "server/edge.ts" } ] },
  "content": ["content/"]
}
```

### 4.1 The five kinds of contribution

| Kind | What it adds | Loaded by | Attach while editing |
|---|---|---|---|
| **Editor** | panels, document kinds, viewport tools, content-browser importers | the editor shell, by dynamic `import()` | **Hot**: enable, disable and reload without restarting anything (Vite HMR in dev) |
| **Server** | `SimSystem`s with an ordering, admin commands, rule hooks, persistence tables | engine-core at boot, from the enabled module set | **On play restart**: play mode restarts its owned server with the new set (§4.3) |
| **Native** | a C++ N-API addon behind a JS backend, used by the module's server code | the module's server code, via `require` | **On play restart**, after the host rebuilds it (`node-gyp rebuild`) |
| **Sidecar** | a separate process (a WebAssembly app or any binary) the engine talks to over a channel | the sidecar supervisor, owned by play mode like the server | **Hot**: start, stop and replace it while the server runs |
| **Edge** | `local:<module>` packet handlers and routes | `apps/edge` at boot, merged into `routes.json` | On edge restart |

### 4.2 Lifecycle

```text
discover → validate → resolve → load → activate ⇄ deactivate → unload
```

- **discover**: the host lists `modules/*/module.json` (loopback route,
  path-confined like the rules routes).
- **validate**: Zod schema, engine version range, unknown keys refused, the
  same strict collect-every-problem style as `loadRoutes` in the edge.
- **resolve**: dependency order, and the server systems' `after` / `before`
  constraints merged into one tick order. A cycle or an unknown system name
  fails the whole set with every problem listed; the running set stays.
- **load / activate**: each side's entry is imported and called with a
  narrow context (the editor side gets `EditorContext`, the server side a
  `ServerModuleContext` with the world, the rules and a system registrar).
  No module reaches into another's internals; they talk through components,
  events and documents, the way systems do today.
- **deactivate / unload**: the reverse. Editor modules dispose their
  controllers; sidecars are stopped; server and native modules leave with
  the next play restart.

The enabled set is a document too (`content/modules.json`, edited in the
Modules window), so the same set runs in the editor's play mode, in
`npm run server` and in production.

### 4.3 Why server and native modules attach on a restart

Two facts about the engine decide this:

1. **One world per process.** bitECS entity globals are process-wide
   ([`DECISIONS.md`](DECISIONS.md), "Single-world-per-process"), and the
   tick order is fixed for a run so the simulation stays deterministic.
2. **Node cannot unload a native addon.** A `.node` file stays mapped until
   the process exits, so "reload a C++ module" always means a new process.

So server-side attach is a fast restart of the play-mode server, which
`PlayModeController` already owns end to end: save the world (the server
already persists on shutdown), stop the owned process group, start it with
the new module set, reconnect the mirror, restore the editor's camera and
selection. The user presses one button ("Apply modules") and stays in play
mode. The server reads the set from `MMO_MODULES` (a path to the set
document), so this is one more `MMO_*` setting, not a new boot path.

`server.ts`'s hard-coded systems array becomes the `core` module's
contribution plus the resolved order of the others. The core order is kept
exactly, so the valgrind perf baseline does not move in that slice.

### 4.4 C++ modules

A C++ module is today's addon pattern with a manifest: `binding.gyp`,
`node-addon-api`, a thin `index.js`, a JS backend interface in the module's
server code, bulk SoA calls, no per-entity N-API on the hot path. The
template is `packages/addons/template` moved under `modules/` with a
manifest. The editor adds:

- **Build** in the Modules window: the host runs `npx node-gyp rebuild` in
  the module and streams the compiler output to the Output log.
- **Check**: `npm run valgrind:memcheck -- <module>` from the same window,
  since every native change has to run clean ([`CLAUDE.md`](../CLAUDE.md)).
  Never two valgrind runs at once.
- **Apply**: a successful build offers "Apply modules" (the restart above).

The engine's own addons stay in `packages/addons` and are wrapped by the
`core` module; moving them is not part of this plan.

### 4.5 WebAssembly and other sidecars

A sidecar is a separate process next to the engine, supervised by it and
spoken to over a channel. It suits code that is not ours to put in the
tick: a WebAssembly app compiled from Rust or C, a tool in another
language, a long-running solver.

```text
  engine-core (tick)                 sidecar supervisor             sidecar process
  ──────────────────                 ──────────────────             ───────────────
  module server code ── request ──▶  channel (E2 framing:     ──▶   wasm host (Node,
        ▲                            4-byte length + JSON,          WebAssembly + WASI)
        │                            request / push / heartbeat)    or any executable
        └─ result arrives as an event / intent between ticks ◀──
```

- **The channel is E2's.** Length-prefixed JSON frames, request and
  response by id, pushes, heartbeats and the reconnect backoff are already
  specified for edge ↔ core ([`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md)
  slice E2). Sidecars reuse that code; there is no second protocol. Bulk
  binary payloads can move to a FlatBuffers frame later if a sidecar needs
  them.
- **Never on the tick.** A request is sent from a system and its answer is
  queued and applied at the start of a later tick, like intents. A
  sidecar that is slow or down makes a feature late, never the tick.
- **The wasm host is a Node program.** The engine's runtime services stay
  Node ([`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) E6 note), and Node runs
  WebAssembly and WASI itself, so a `kind: "wasm"` sidecar is a small Node
  host that loads the module, exposes its exports as channel methods and
  gives it no file or network access unless the manifest grants a
  directory. `kind: "exec"` runs any binary for tools that are not wasm.
- **Supervised like the server.** The supervisor spawns each sidecar as its
  own process group, restarts it on crash by the manifest's policy, kills
  only processes it started, and pipes its output to the Output log. In
  the editor, play mode owns the supervisor the same way it owns the
  server, so stopping play stops every sidecar.
- **Hot while editing.** Rebuilding a `.wasm` and pressing "Reload sidecar"
  restarts that one process; the server keeps ticking.

Pure, small wasm functions could later run in-process (in a worker thread)
to skip the process hop. That is an optimisation for when a profile asks
for it, not the starting point.

## 5. Scenes

A **scene** is a document that describes one part of the game: what is in
it, what it needs, and how it starts. The engine already has pieces of
this spread around (the world spec, `MMO_*` settings, the client's screens,
the character preview); a scene puts them in one validated file.

```jsonc
// content/scenes/character-creation.scene.json
{
  "name": "character-creation",
  "kind": "frontend",            // frontend | world | instance | arena
  "modules": ["core", "characters"],
  "ui": { "layout": "character-creation" },   // a client screen, by name
  "stage": {                                  // 3D backdrop, client-only
    "camera": { "position": [0, 1.6, 3.2], "target": [0, 1.1, 0] },
    "lighting": "studio",
    "nodes": [
      { "id": "pedestal", "prefab": "props/pedestal", "transform": { "position": [0, 0, 0] } },
      { "id": "preview",  "component": "CharacterPreview", "props": { "framing": "body" } }
    ]
  }
}
```

```jsonc
// content/scenes/starter-coast.scene.json
{
  "name": "starter-coast",
  "kind": "world",
  "modules": ["core", "creatures", "items"],
  "world": { "spec": "worlds/default.world.json", "region": { "x": 0, "z": 0, "radiusChunks": 8 } },
  "settings": { "dayOffset": 0.3, "bots": 0 },        // the MMO_* knobs, as data
  "nodes": [
    { "id": "spawn", "kind": "spawn-point", "transform": { "position": [12, 0, -40] } },
    { "id": "camp",  "prefab": "camps/goblin", "transform": { "position": [80, 0, -60] },
      "components": { "Spawner": { "creature": "goblin", "pack": [2, 4], "respawnSeconds": 60 } } }
  ]
}
```

| Kind | Who runs it | Examples |
|---|---|---|
| `frontend` | the client only; no world state | login, account creation, character select, character creation, loading, settings |
| `world` | the server (authoritative content) and the client (its view) | the open world, a region, a hub city |
| `instance` | the server, one copy per group | a dungeon (D4), an arena match |
| `arena` | the server, editor-only | a test map for one system: physics, crowds, a fight |

**Authority.** A world scene's nodes are seed content: the server reads the
scene and spawns its nodes as ordinary entities through the same spawn
paths admin `spawn` and the creature system use. The client never reads a
world scene's nodes; it sees the entities on the wire as always. A frontend
scene is client-only data. So no scene ever lets the client decide what
exists in the world.

**Nodes** are a prefab reference or a component bag, with an id, a
transform and children. Component names and fields come from a registry
that modules contribute to (the core module registers the engine's
components), so Details can render a form for any component with
validation, and a module adding a component adds its editor form with it.

**Editing.** The outliner shows the scene's node tree, the viewport draws
it with the shared renderer, Details edits the selection, and save goes
through the host with validation (a refused save writes nothing and lists
its errors, like the rules editor). The viewport places prefabs dragged
from the content browser, with move, rotate and scale gizmos and snapping
to the terrain.

**Relation to E9 and E8.** World-scale editing (E9) and the dungeon view
(E8) become scene kinds with their own tools, not separate editors: E9
edits the `world` scene's terrain and regions, E8 an `instance` scene's
layout. Their panels become module contributions in EA3.

## 6. Game flow

The game flow is a graph of scenes and the transitions between them. Today
it is `type Screen = "login" | "connecting" | "characters" | "world"` in
the client's `App.tsx`; the plan makes it a document the client runs and
the editor edits.

```jsonc
// content/flow/game.flow.json
{
  "start": "login",
  "nodes": {
    "login":              { "scene": "login" },
    "register":           { "scene": "register" },
    "connecting":         { "scene": "loading" },
    "character-select":   { "scene": "character-select" },
    "character-creation": { "scene": "character-creation" },
    "world":              { "scene": "@assigned" }      // the server says which world scene
  },
  "edges": [
    { "from": "login",              "on": "ui.register",      "to": "register" },
    { "from": "register",           "on": "net.account",      "to": "character-select" },
    { "from": "login",              "on": "ui.submit",        "to": "connecting" },
    { "from": "connecting",         "on": "net.welcome",      "to": "character-select" },
    { "from": "connecting",         "on": "net.error",        "to": "login" },
    { "from": "character-select",   "on": "ui.create",        "to": "character-creation" },
    { "from": "character-select",   "on": "net.joinReply.ok", "to": "world" },
    { "from": "character-creation", "on": "net.joinReply.ok", "to": "world" },
    { "from": "world",              "on": "net.closed",       "to": "login" }
  ]
}
```

- **Events, not code.** Transitions fire on named events: `net.*` from the
  protocol messages the client already handles (welcome, account, join
  reply, close) and `ui.*` from the screens' own buttons. The protocol does
  not change; the flow only decides what screen follows what.
- **The client runs it.** A small flow runner (a state machine, pure TS,
  unit-tested) replaces the `Screen` state in `App.tsx`. Each node mounts
  its scene: a frontend scene's `ui.layout` names a client screen component
  (today's login form and `CharacterScreen`), a world scene mounts the
  world canvas.
- **The server stays in charge of entry.** `@assigned` means the world
  scene is whatever the server's welcome or join reply names (one today;
  regions and instances later). The client cannot pick a world scene the
  server did not give it.
- **The editor edits it as a graph.** A Flow panel draws the nodes and
  edges, validates that every node is reachable, every edge's event is
  known and every scene exists, and opens a node's scene on double-click.
- **Play from any node.** Play mode can start at the login screen (the full
  path a player takes) or skip to `character-creation` or `world` with the
  seeded editor account, the way Unreal plays from the current level.
  `character-creation` already runs serverless through its preview mode,
  so a frontend node can preview with no server at all.

## 7. Edit mode and play mode

| | Edit mode | Play mode |
|---|---|---|
| What you change | documents (scenes, flows, rules, modules) | nothing persistent by default |
| Viewport | edit camera over the open document | the game camera over the live mirror, or eject to a free camera |
| Outliner | the scene's nodes | live entities (today's ECS inspector), read-only |
| Server | none, or a preview | the owned server, booted with the open scene and the enabled modules |
| Edits | validated writes through the host | intents and admin commands only, like a client |

**Play** boots the owned server with `MMO_SCENE=<the open scene>` and
`MMO_MODULES=<the set>`, then connects and enters the flow at the chosen
node. **Stop** tears it down as today (group kill, state restore).

**Changes made during play are thrown away on stop**, as in Unreal and
Unity, because they happened in the authoritative world, not the document.
An explicit "Keep" on a selected entity copies its current transform and
fields back into the scene document as a command (undoable), which is the
only path from the live world into a document.

**Hot paths that already exist stay hot:** saved rules and tables reach a
running server through `RulesReloader` without a restart; editor modules
and sidecars reload in place; only server and native module changes need
the play restart.

## 7b. The database editor and the persistence core

The engine persists to SQLite through `better-sqlite3`, every file in WAL
mode under `MMO_DATA_DIR`:

| File | Tables | Owner |
|---|---|---|
| `world.db` | `meta`, `snapshots`, `events`, `chunk_entities`, `formation_tiles_v2`, `item_events` (the item ledger), `terrain_tiles`, `world_maps` | `SnapshotStore`, `ChunkEntityStore`, `FormationTileStore`, `ItemLedger`, `TerrainTileStore` |
| `characters.db` | `characters`, `deaths`, `character_state`, `character_skills` | `SqliteCharacterStore` |
| `guilds.db`, `social.db` | guilds, members, guild log; friends, blocks | the guild and social stores |
| `navmesh.db` (in the navmesh directory) | `navmesh_tiles` | the navmesh store |

The editor's **Database** workspace (§3.3) browses and edits all of it.

### 7b.1 Writes go through the persistence core

The running server is the only writer. Its stores hold prepared
statements and in-memory state that mirrors the rows (the ItemService's
columns, loaded characters, guild books), the ledger is append-only, and
WAL allows one writer at a time. An editor that wrote the files directly
would be overwritten on the next flush or leave the server believing
something the disk no longer says. So the editor never opens a game
database for writing. It sends requests to a **persistence core**:

- **`PersistenceCore`** is a facade in engine-core that holds every store
  the server opens and answers five request types: `catalog` (databases,
  tables, columns, indexes, row counts, sizes), `query` (read), `mutate`
  (write), `explain` (query plans) and `stats` (statements, caches,
  pragmas).
- **Transport**: admin-only methods on the server's existing webrpc HTTP
  endpoint (`net/rpc-http.ts`, Bearer session token), e.g.
  `POST /rpc/Persistence/Mutate`. Only admin accounts (A1) may call them.
  The editor's host proxies them for the play server; after the edge split
  they ride the edge-core channel like any other core packet.
- **Reads never touch the tick.** `query` runs on a separate read-only
  connection (`readonly: true`, `PRAGMA query_only`) in a worker thread,
  with a row limit and a cancel, so a heavy query cannot stall the 30 Hz
  loop. WAL lets it read a consistent snapshot while the server writes.
- **Writes are typed mutations, not SQL.** A mutation names a table, a key
  and the new values (`{ db: "characters", table: "character_state",
  key: { character_id: 12 }, set: { health: 100 } }`). The core validates
  it against the owning store's schema, queues it, and applies it between
  ticks on the tick thread *through the store's own methods*, so the
  in-memory state and the row change together. The reply says which tick
  applied it.
- **Append-only tables stay append-only.** An edit to an item becomes a
  new ledger event (a move, a durability change, a destroy tombstone),
  never an `UPDATE`. Snapshots and `events` are read-only in the editor.
- **Every write is audited and undoable.** The core records each mutation
  with its before-image, the admin and the tick in an `admin_log` table;
  undo in the editor sends the inverse mutation.
- **Offline**: with no server running, the editor's host opens the files
  read-only (as the Characters panel already does with `openReadOnlyDb` in
  `host.ts`), and the grid says "start the server to edit". A separate
  **maintenance mode** (server stopped, host holds the files exclusively)
  allows migrations, `VACUUM` and `ANALYZE`, and always takes a backup
  first with SQLite's online backup (`db.backup()`).

### 7b.2 Database functions for caching and fast execution

The core also owns the functions that make reads cheap and writes batch:

- **A named statement registry.** Every query the stores run is prepared
  once at boot under a name (`characters.byId`, `ledger.latestForItem`)
  instead of being prepared ad hoc. The registry counts calls and times
  them (p50, p99), and the editor lists them with their query plans, so a
  slow statement shows up before it hurts a tick.
- **Application-defined SQL functions**, registered on every connection
  with `db.function(name, { deterministic: true }, fn)`: `wire_id(gen,
  slot)`, `chunk_of(x, z)`, `dist2(x, z, x0, z0)`, `item_def(def)` (the
  definition's name), and `fb_field(blob, path)` to read one field out of
  a FlatBuffers blob. Being deterministic, they can back **expression
  indexes and generated columns**, e.g. an index on
  `item_events(chunk_of(x, z))` for "what lies in this chunk" without a
  scan. They also make the editor's read queries readable.
- **Cache tables kept by the core.** `item_latest` (each item's newest
  ledger row) is maintained at each flush, so a restart and the editor
  read one row per item instead of scanning history; it can always be
  rebuilt from the ledger. Other derived tables (a character's equipped
  items, a guild's online count) follow the same rule: derived, rebuilt on
  demand, never the source of truth.
- **Read-through memory caches** for hot lookups (a character by id, a
  guild roster, an item definition) with explicit invalidation: because
  every write goes through the core, the core knows exactly which keys a
  mutation touched. Hit rate, size and evictions show in the editor.
- **Batched writes**, the pattern the ledger and the character saves
  already use: mutations and game writes queue in preallocated buffers and
  flush in one transaction on the save timer, off the tick. The editor
  shows flush sizes and times.
- **Pragmas as data.** `cache_size`, `mmap_size`, `temp_store`, the WAL
  size limit and checkpoint cadence are per-database settings in a rules
  file, validated like the others, shown live in the editor with the WAL
  size and checkpoint history. `PRAGMA optimize` runs at shutdown and on a
  timer.
- **Modules contribute** functions, statements, cache tables and their
  migrations through a `persistence` key in their manifest (§4), so a
  module's tables appear in the Database workspace with no editor code.

Any of these that run on the tick thread (cache lookups, statement calls
from systems) fall under the valgrind perf rule: the slice that adds them
runs `npm run valgrind:perf` and states what moved.

### 7b.3 The Database workspace

- **Schema tree**: databases → tables → columns and indexes, with row
  counts, sizes and the owning store.
- **Data grid** (the §3.3 table pattern): paged rows with filters and
  sort; inline edits collect as **pending mutations** in a bar
  ("3 changes · Send to core"), and each shows the tick that applied it or
  why the core refused it.
- **Query tab**: a read-only SQL editor with the registered functions in
  autocomplete, results in the grid, and `EXPLAIN QUERY PLAN` as a tree
  that flags full scans.
- **Performance panel**: the statement registry with timings, cache hit
  rates, pragmas, WAL size and checkpoints.
- **Audit log**: every mutation, who sent it, its tick, with undo.

## 7c. Production tools

Nine tools the editor needs beyond what the roadmap lists, each planned
against what exists today. Each is a module (§4) and a slice (EA18 to
EA26, §10). Three of them get workspaces of their own (**Story**, **Art &
audio**, **Release**, §3.3); version control lives in the shell, so every
workspace has it.

### 7c.1 Version control and collaboration

**Today.** The editor saves through its host: `rules-store.ts` and
`rules-host.ts` write `content/rules` atomically and only when valid, and
`RulesReloader` hot-reloads the running server. There is no git
integration, no locking, and nothing for two people editing at once.

**Plan.** Git stays the source of truth; the editor makes it visible and
safe instead of replacing it.

- **Changes panel** (left dock in every workspace, and a count in the
  status bar): the files the editor has changed, grouped by document
  (scene, flow, rules table, module), with a per-document **semantic
  diff** rather than a text diff: "goblin: health 60 → 75, aggro 12 → 14",
  "scene `arena-01`: 3 nodes moved, 1 added". The host runs `git` on the
  repo (`status`, `diff`, `add`, `commit`, `pull`, `push`) through a new
  `/api/editor/vcs` route, loopback only like the others.
- **Commit from the editor** with a message, onto a branch the panel
  shows; `pull` merges documents with a **three-way JSON merge** keyed by
  stable ids (scene node ids, table row ids), so two people editing
  different creatures never conflict; a true conflict opens both values
  side by side in the Details panel.
- **`/assets/` can never be staged.** The host refuses any path under
  `/assets/` and any file the art pipeline produced from it, whatever the
  `.gitignore` says, and the panel shows them as "local only". Scenes and
  prefabs reference art by asset id, never by copying it.
- **Soft locks** for binary-like or hard-to-merge documents (terrain
  tiles, baked navmesh, world maps): taking a lock writes
  `content/locks.json` on a pushed commit, other editors show the owner
  and open the document read-only. No server is needed; it is git all the
  way down.
- **Presence** (later, optional): when two editors are connected to the
  same dev server, each shows who has which document open.

### 7c.2 Build and deploy

**Today.** Root scripts build every workspace (`npm run build`), bake
the world (`bake:world`), dungeons (`dungeon:bake`), loot (`loot:bake`)
and art packs (`convert:packs`), and generate FlatBuffers (`codegen`).
The client builds with `vite build`; nothing serves it in production.
The server runs as `node dist/src/server.js`, configured by `MMO_*`
environment variables. There is no Dockerfile or deploy config, and CI
(`ci.yml`) is out of credits.

**Plan: a Release workspace** that runs the same scripts the terminal
does, in order, with their output.

- **Build profiles** (`content/build/*.json`): which bakes to run, client
  quality defaults, which modules are in (§4), the server's `MMO_*`
  settings (port, data dir, world seed, `MMO_ALLOW_REGISTER=0` for
  anything public), and the target. A profile is a document, validated
  and diffable like any other.
- **Pipeline view**: codegen → build → bakes → tests → valgrind
  (memcheck on changed addons, perf against the baseline) → package, each
  step a card with its log, time and result, cached by input hash so an
  unchanged bake is skipped. It replaces CI while CI cannot run, and runs
  what CI would.
- **Package**: a folder (later an image) with the built server, the
  client's static build, the baked data and the chosen modules, plus a
  manifest of what went in and from which commit. Licensed art from
  `/assets/` goes only into packages for private targets, never into the
  repo.
- **Targets**: *local* (start the package on this machine, the default),
  *staging* (copy to a host over SSH and restart the service), with a
  health check against `GET /health` (edge) and the server's port. Deploy
  to anything public always asks for confirmation and shows the profile's
  diff against the last deploy.
- **Rollback** keeps the last few packages per target.

### 7c.3 Quest and dialog editor

**Built (EA20).** The editor edits the files the server loads today (`content/quests/{quests,dialogs,npcs,steps}.json`), not the per-document `*.quest.json` and `*.dialog.json` files planned below, which the server cannot run. Code: `story-validate.ts`, `story-host.ts`, `story-model.ts`, `ui/story-editor.tsx`. Not yet: WFC slots, "Play from here", string ids.

**Was.** Nothing was built. The roadmap has P1 (progression graphs:
quests and dialog, `DUNGEONS-AND-LOOT.md` §9) and U11 (quest log,
tracker, dialog). That doc puts quests and dialog in the "progression"
domain, with dialog as beats and replies, generated on the WFC like
dungeons.

**Plan: a Story workspace** with one graph editor for both.

- **Quest graph** (`content/quests/*.quest.json`): nodes are steps
  (talk to, kill N of a species, collect items, reach a place, enter an
  instance, wait), edges are conditions; rewards reference loot tables and
  items by id, so the Gameplay grid's validation applies.
- **Dialog graph** (`content/dialog/*.dialog.json`): beats (a line, a
  speaker, an expression) and replies, with conditions (quest state,
  skill level, standing) and effects (start a quest, give an item, open a
  shop). Lines are string ids into the localization tables (§7c.8), not
  literal text.
- **Authored and generated together**: a node can be fixed text or a
  WFC slot ("any goblin camp within 2 chunks"); the graph shows which, and
  the preview resolves slots with a seed, as P1 asks.
- **Test without playing**: a side panel walks the dialog as the player,
  with a state inspector for quest flags; "Play from here" (§3.5) starts
  the world with the quest at the selected step.
- **Validation**: unreachable steps, dead-end dialog, rewards that don't
  exist, and lines missing a translation are flagged before save.

It shares its node graph component with the flow editor (§6) and the PICG
graph editor (E7).

### 7c.4 Animation

**Today.** `character-animator.ts` loads `animations.json` (manifest v2)
and one GLB per source; a base locomotion layer (idle, walk, jog, sprint,
swim, air) crossfades on server speed, and an action layer (full or upper
body) starts combat moves at the server's tick. `convert-animations.ts`
retargets clips onto the Synty rig. `CHARACTER-PLAN.md` phase D leaves
blend spaces, foot locking, inertial blending and hit reactions open.

**Plan: an Animation panel** in Characters and Art & audio.

- **Clip browser** over `animations.json`: preview any clip on any body
  from the appearance catalog, scrub, set loop and speed, and see root
  motion as the `travel` the server applies.
- **State machine editor** for the locomotion layer, in the same graph
  component: states, transitions with crossfade times and conditions on
  speed and mode, saved back into `animations.json` (a v3 manifest that
  keeps v2 loading). Blend spaces (strafing) are a state type.
- **Combat timeline**: each move in `COMBAT_MOVES` against its clip, with
  hit frames, cancel windows and the action mask, so combat timing and
  animation are tuned in one place. The server stays authoritative; the
  editor writes the data both read.
- **Retarget panel** wraps `convert:animations` with the source, the
  target rig and a before/after preview.

### 7c.5 VFX and materials

**Today.** A lot exists (`CLIENT-FX.md`): the GLSL noise library,
terrain, entity and element FX, water, sky and time of day,
`particles.json` (three-nebula) and `quarks-fx.ts` (three.quarks
signals and weapon trails), the toon material (`toon-material.ts`, ramp
textures) and outlines, postprocessing, and quality tiers
(`quality.ts`: low to ultra). Effects are tuned in code.

**Plan: VFX and Material panels** in Art & audio.

- **Particle editor** over `particles.json` and the quarks signals:
  emitters, curves and colour over life, with a live R3F preview
  scrubbable in time, and a per-quality-tier budget (particle count,
  overdraw) that turns red when a tier is over.
- **Material editor** for the toon material and the terrain surfaces:
  ramp textures, outline width, rim and shadow parameters as data
  (`content/materials/*.json`) instead of constants, previewed on a body,
  a weapon and the terrain under the day sky at any time of day.
- **Post and tiers**: bloom, vignette, tonemap and each tier's preset in
  `quality.ts` as editable data, with a side-by-side tier comparison.
- Shader *code* stays code; the editor edits parameters. A node-based
  shader graph is out of scope until something needs it.

### 7c.6 HUD layout editor

**Today.** The player HUD is React DOM over the canvas (frames, chat,
bag, character sheet, settings) with a UI scale setting (90 to 125%).
Only the dev HUD has layout data (`dev-layout.ts`, in localStorage). The
plan so far only previews the HUD (§3.3).

**Plan: a HUD panel** in Flow & UI.

- **HUD layout document** (`content/ui/hud.json`): each frame's anchor
  (corner or edge), offset, size, visibility per screen, and default
  scale; the client reads it instead of hard-coded positions, and
  players' own moves stay in their settings on top of it.
- **Edit on a live preview** of the frontend or world scene: drag
  frames, snap to anchors and a grid, and check every UI scale and
  common resolutions (1280×720 to 3440×1440) for overlaps.
- **Widget catalog**: the existing components (`meter.tsx`,
  `player-frame.tsx`, `chat-panel.tsx`, ...) listed with their props, so
  a module can add a frame (a quest tracker for U11) and place it.
- **Theme tokens** for the player UI (colours, fonts, radii), separate
  from the editor's Material 3 tokens.

### 7c.7 Audio

**Today.** None. U4 defers audio "to an audio engine".

**Plan.** The client gets a small audio engine on the Web Audio API
(mixer buses: master, music, effects, voice, ambience, UI; 3D panning
from the camera; a voice limit per bus) that U4's volume sliders drive.
The editor gets an **Audio panel** in Art & audio:

- **Sound events** (`content/audio/events.json`): an event (`hit.sword`,
  `step.grass`, `ui.click`) names one or more clips, random pitch and
  volume ranges, a bus and a max distance. Game code fires events, never
  files, so sounds are swapped without code.
- **Hooks to existing data**: combat moves' hit frames (§7c.4), surface
  types (footsteps per terrain surface), weather and time of day
  (ambience), and game-flow scenes (music per scene).
- **Preview** in the viewport at a position, with the bus meters, and a
  **mixer** view for levels and ducking (music under dialog).
- Audio files follow the art rule: licensed packs stay under `/assets/`.

### 7c.8 Localization

**Today.** None. UI strings are hard-coded in the client's TSX; item
and creature names are in the rules JSON.

**Plan.**

- **String tables** (`content/strings/<lang>.json`): ids to text, with
  ICU message format for plurals and variables. English is the source.
- **Extraction**: a script finds literal UI strings in `apps/client`
  and moves them behind `t("id")`; rules tables and dialog lines refer to
  string ids for names and text.
- **Strings panel** in Story: a grid of id, source, each language and
  status (missing, stale because the source changed, done), with
  in-context preview in the HUD panel and dialog tester, and a
  pseudo-locale (longer, accented text) to catch layouts that break.
- The client picks the language from settings and loads one table.

### 7c.9 Automated playtests

**Today.** `npm run sim` runs 1,000 entities for 300 ticks and checks
snapshot and delta replay; `BotSystem` (`MMO_BOTS`) spawns bots; P2c
replays the item ledger after crashes; `packages/bench`, the latency
budget test and the valgrind perf baseline measure cost. There is no
gameplay replay and no headless client in tests. `ALPHA-PLAN` plans
recorded playtests (X1) and a bots-versus-creatures stress harness (X2,
X3).

**Plan: Playtests** in Release and Debug.

- **Scenarios** (`content/tests/*.scenario.json`): a scene, a seed, bots
  with simple scripts (walk a path, fight the nearest creature, loot,
  run a quest), a duration, and **assertions** (no tick over budget,
  ledger invariant holds, quest completes, no bot stuck for more than N
  seconds). They run headless in the server, so they're fast and
  deterministic.
- **Replays**: the server records inputs and the seed for a session;
  replaying reproduces it tick for tick (the sim's snapshot and delta
  check, applied to a real play session), and the viewport scrubs it.
  A failing scenario saves its replay.
- **Client capture**: a headless Chromium run of the client against a
  scenario takes screenshots and a GIF (the X1 playtest set, and PR
  media), using the same Playwright setup the PR media already uses.
- **Results** in the Release pipeline (§7c.2) and a history chart per
  scenario, so a slowdown or a new failure shows with its commit.

## 8. Packages and folders

| New | What it holds |
|---|---|
| `packages/modules` | the module manifest schema, discovery, validation, dependency and system-order resolution (shared by the editor host, engine-core and the edge) |
| `packages/scene` | scene and flow schemas, the node and component registry types, the flow runner (shared by client, editor and server) |
| `packages/sidecar` | the supervisor and the wasm host, on E2's channel code |
| `modules/core` | the engine's own contributions: today's systems in today's order, the engine's components, the existing editor panels |
| `modules/*` | everything else, one folder each |
| `content/scenes`, `content/flow`, `content/modules.json` | the documents |
| `content/quests`, `content/dialog`, `content/strings`, `content/ui`, `content/audio`, `content/materials`, `content/build`, `content/tests`, `content/locks.json` | the production tools' documents (§7c) |

The editor's host grows routes in the same style as the rules routes
(loopback only, path-confined, write only when valid): `/api/editor/modules`
(list, enable, build, check), `/api/editor/scenes`, `/api/editor/flow`,
`/api/editor/sidecars` (start, stop, logs). These, like every host route,
exist only under `vite dev`.

**The Rogue Engine bridge.** The companion was built standalone because
Rogue has no stable panel API. With the editor becoming the editor, the
`rogue-packages/sirhertzalot/mmo-editor` bridge has less to do. This plan
keeps it working and untouched; retiring it is a separate decision
([§12](#12-open-questions)).

## 9. Tool inventory

Every developer tool that exists or is on the roadmap, and where it lives
in the new structure. This is the seed for the tool implementation list.

| Tool | Today | Becomes |
|---|---|---|
| ECS inspector | editor tab (E1) | `core`: play-mode Outliner and Details |
| Play mode, server control | editor tab (E2) | `core`: toolbar Play / Stop / Play from here |
| Navmesh tile and waypoint overlays | play-mode panel (E2) | `core`: viewport overlays, toggled per layer |
| Art asset pipeline | editor tab (E3) | `core`: content browser importer and pack validator |
| Play-mode game view | in progress (E4) | the Viewport |
| Debugger: perf graphs, wireframe, FX showcase | client dev panels (E5) | `debugger` module: bottom-dock panels and viewport toggles |
| Terrain sculpting | editor tab | `world` module: a tool in the world scene's viewport |
| Gameplay tables | editor tab (ED1) | `core`: document panels over `content/rules` |
| Rules editor | editor tab (E11) | `core`: document panel |
| Character records | editor tab (E10) | `characters` module: panel |
| Admin console | client (A1 to A4) | `core`: Output log console in play mode; click-to-pick from the viewport |
| Play telemetry graphs | Live Ops reads typed `stats` snapshots at the server's bucket cadence (T2) | `liveops` workspace |
| PICG selection cards, graph editor | planned (E6, E7) | `picg` module: Details cards and a graph panel |
| Dungeon view | planned (E8) | `dungeon` module: `instance` scene tools |
| World-scale editing | planned (E9) | `world` module: `world` scene tools |
| Appearance and equipment editor | planned (A6) | `characters` module |
| Scene editor, Flow editor, Modules window | this plan | `core` (EA4 to EA8) |
| Module build and valgrind check | `npm` scripts | `core`: Modules window actions |
| Sidecar supervisor and logs | this plan | `core`: Modules window and Output log |
| Database editor, statement and cache panels | this plan (§7b) | `persistence` module: Database workspace |
| Version control: Changes panel, merge, locks | this plan (§7c.1) | `core`: every workspace |
| Build pipeline, packages, deploy | `npm` scripts | `release` module: Release workspace |
| Quest and dialog editor | planned (P1, U11) | `story` module: Story workspace |
| Animation clips, state machine, combat timeline | code and `convert:animations` | `animation` module: Art & audio |
| Particle, material and post editors | code and `particles.json` | `vfx` module: Art & audio |
| HUD layout editor | none (HUD hard-coded) | `ui` module: Flow & UI |
| Audio events and mixer | none (U4 deferred) | `audio` module: Art & audio |
| Localization strings | none | `story` module: Story workspace |
| Playtest scenarios, replays, client capture | `sim`, bots, P2c | `release` module: Release and Debug |

## 10. Slices

One PR each, in order; each leaves the editor working. Names use **EA**
(editor architecture) so they do not collide with the editor's E rows or
the edge split's E slices. They go on the roadmap when this phase starts;
the roadmap thread adds them.

| # | Slice | Depends on | Done when |
|---|---|---|---|
| EA0 | **This document** | | merged |
| EA1 | **Docking shell, workspaces and toolbar.** `App.tsx`'s tabs become panels in a dockable layout (drag a tab, dock targets, resizable dividers, pop out to a window); named layouts saved per workspace with reset and export; the top bar (menus, workspace tabs, command search) and the toolbar with the play cluster (Play, Pause, Step, Stop); Material 3 tokens (§3.2 to §3.5); the frontend redesign onto React Three Fiber for every viewport (§3.6), built against the mockups. Panels registered in code, not imported by the shell. Reuses E5's docking code rather than a second one | E4, E5 | every existing tab opens as a panel in a workspace; a saved layout survives reload; Pause and Step hold and advance the owned server; screenshots and a GIF of docking |
| EA2 | **MVC contracts.** `Model`, `Controller`, `PanelContribution`, `EditorContext`; shared selection and an undo stack. Port ECS, play mode, rules, tables and terrain behind them | EA1 | existing editor tests pass unchanged; new controller tests with fakes |
| EA3 | **Editor modules.** `packages/modules` (manifest schema, discovery, validation); the host's `/api/editor/modules`; the shell loads editor entries by dynamic import; Modules window to enable and disable. `modules/core` holds today's panels; Character records moves to its own module as the proof | EA2 | disabling the characters module removes its panel without a restart; a bad manifest lists every problem |
| EA4 | **Scene documents.** `packages/scene` (schema, node and component registry); `content/scenes`; Outliner and Details over an open scene; validated save through `/api/editor/scenes`; undo | EA2 | open, edit, save and reload a scene; a refused save writes nothing |
| EA5 | **Scene viewport editing.** The shared renderer draws the open scene; drag prefabs from the content browser; gizmos; terrain snapping; picking sets the shared selection | EA4, E4 | place, move and delete nodes in the viewport; GIF |
| EA6 | **Play the scene.** Server reads `MMO_SCENE` and spawns a world scene's nodes through the existing spawn paths; Play uses the open scene; "Keep" copies a live entity back as a command | EA4 | play a test arena scene, see its nodes live, stop, document unchanged |
| EA7 | **Game flow.** `content/flow/game.flow.json`; the flow runner in `packages/scene`; the client's `Screen` state replaced by it with today's screens as frontend scenes; no protocol change | EA4 | login → character select → creation → world works exactly as before, driven by the flow document |
| EA8 | **Flow editor and play from a node.** Flow panel (graph, validation, open scene); Play from login, character creation or world | EA7 | play from each node; an unreachable node is flagged |
| EA9 | **Server modules.** `server.ts`'s systems array becomes the `core` module's contribution; `MMO_MODULES`; system order resolved from `after` / `before`; "Apply modules" restarts the play server with the new set | EA3 | core order identical (valgrind perf unchanged); a sample module adds a system; a cycle is refused |
| EA10 | **C++ modules.** The addon template as a module; Build, Check (memcheck) and Apply from the Modules window, output in the log | EA9 | edit the sample addon, rebuild, apply, see the change in play; memcheck clean |
| EA11 | **Sidecars.** `packages/sidecar` on E2's channel; supervisor owned by play mode; `kind: "wasm"` Node host with WASI and no default file access; `kind: "exec"`; results applied between ticks; a sample wasm module | EA9, edge E2 | the sample wasm sidecar answers from a system; killing it restarts it and the tick never stalls; reload while playing |
| EA12 | **Edge modules.** Manifests contribute `local:<module>` routes and handlers, merged into the edge's routes at boot with the same strict validation | EA9, edge E3 | a module's packet reaches its edge handler |
| EA13 | **Existing tools as modules.** Debugger, PICG, dungeon and world tools (E5 to E9) move to their own modules | EA3 and each tool | each can be disabled on its own |
| EA14 | **The play menu.** Where (viewport, new window, simulate), start node, 1 to 8 clients with seeded accounts, bots, network (core or edge + core), simulated latency, fresh or saved state; saved play setups with shortcuts; play-mode tint | EA8 | each option works from the menu; a saved "8 clients, 50 bots" setup starts with one key |
| EA15 | **Fill every workspace.** Each workspace in §3.3 gets its default layout and panels: the Gameplay data grids (Carbon density, batch actions, inline validation, live values), the Live ops and Network dashboards, the Characters panels; a workspace whose feature is not built yet shows what it will hold and which roadmap item brings it | EA3, EA13 | every engine feature in §3.3 is reachable from a workspace; screenshots of each |
| EA16 | **Persistence core and the Database workspace.** `PersistenceCore` with catalog, query (read-only worker connection), typed mutations applied between ticks through the stores, ledger edits as events, `admin_log` with undo; admin-only webrpc methods; offline read-only and maintenance mode with backup; schema tree, grid with pending mutations, query tab, audit log | A1, EA15 | edit a character's health from the grid and see it in play on the stated tick; an item edit lands as a ledger event; a heavy query does not move tick time |
| EA17 | **Database functions and caches.** Named statement registry with timings; deterministic SQL functions and an expression index; `item_latest` cache table; read-through caches with invalidation; pragmas as a rules file; module `persistence` contributions; performance panel | EA16 | restore reads `item_latest`; the chunk lookup uses the expression index (plan shows no scan); valgrind perf states what moved |
| EA18 | **Version control.** `/api/editor/vcs`; Changes panel with semantic diffs per document; commit, pull and push; three-way JSON merge by stable ids; soft locks in `content/locks.json`; `/assets/` refused at staging | EA2 | two branches editing different creatures merge with no conflict; staging anything under `/assets/` is refused |
| EA19 | **Build and deploy.** Build profiles; pipeline view (codegen, build, bakes, tests, valgrind, package) cached by input hash; package manifest; local and staging targets with health check and rollback | EA15 | a profile builds a package that starts locally and passes its health check; an unchanged bake is skipped |
| EA20 | **Quest and dialog editor.** Quest and dialog documents and schemas; Story workspace graph editor (shared graph component); dialog tester; validation; WFC slots resolved with a seed (with P1) | EA8, P1 | author a quest with a dialog, test it in the panel, play from its first step |
| EA21 | **Animation.** Clip browser; locomotion state machine editor writing a v3 `animations.json` that keeps v2 loading; combat timeline over `COMBAT_MOVES`; retarget panel | EA15 | change a crossfade and a hit frame in the editor and see both in play; v2 manifests still load |
| EA22 | **VFX and materials.** Particle editor with tier budgets; toon and surface materials as `content/materials` data; post and tier presets as data with a side-by-side compare | EA15 | tune an effect and a material without code and see them in play at each tier |
| EA23 | **HUD layout editor.** `content/ui/hud.json` read by the client; drag-and-anchor editing over a live preview; overlap checks at every UI scale and common resolutions; widget catalog; player theme tokens | EA7 | move a frame in the editor and see it in the client; overlaps flagged at 125% |
| EA24 | **Audio.** Client audio engine on Web Audio (buses, 3D panning, voice limits) driven by U4's sliders; `content/audio/events.json`; hooks to combat, surfaces, weather and scenes; Audio panel with preview and mixer | EA21 | footsteps change with the surface, hits sound on the hit frame, music changes with the scene |
| EA25 | **Localization.** `content/strings/<lang>.json` with ICU messages; extraction of client strings behind `t()`; rules and dialog by string id; Strings panel with status and a pseudo-locale | EA20 | the client runs fully in the pseudo-locale with no hard-coded string left |
| EA26 | **Automated playtests.** Scenario documents with bot scripts and assertions, run headless; input-and-seed replays scrubbable in the viewport; headless client capture for screenshots and GIFs; results in the pipeline with history (with X1 to X3) | EA19 | a failing scenario saves a replay that reproduces the failure tick for tick |

EA1 to EA3 are the frame; EA4 to EA8 are scenes and the flow; EA9 to EA12
are engine modules; EA14 and EA15 finish the play menu and the workspaces; EA16 and EA17 add the database editor and its functions; EA18 to EA26 add the production tools (§7c). The scene track and the module track only meet at EA9,
so they can run in parallel after EA3.

## 11. Coordination with work in flight

- **E4 and E5 first.** EA1 needs E4's shared renderer and E5's dockable
  panels. EA1 adopts what E5 builds; it does not build a second docking
  system.
- **E6 to E9 keep going as they are.** They land as tabs or panels in the
  current shell; EA13 moves them into modules later, which is a move, not a
  rewrite, once EA2's contracts exist. New editor panels written from now
  on can make that move cheaper by keeping a pure-TS view-model beside the
  React panel, as `inspectors/ecs.ts` does.
- **Edge E2 and E3.** EA11 reuses E2's channel and EA12 extends E3's edge;
  both wait for those slices to merge.
- **Valgrind.** EA9 changes how the tick's systems are assembled, so it runs
  `npm run valgrind:perf` and must show no movement; EA10 adds memcheck to
  module builds.

## 12. Open questions

Decisions for the owner before the slices they block:

1. **Rogue Engine bridge**: keep maintaining
   `rogue-packages/sirhertzalot/mmo-editor`, or retire it once EA5 lands?
   (Blocks nothing; affects EA13.)
2. **Where modules live**: a top-level `modules/` workspace (proposed), or
   under `packages/`? (Blocks EA3.)
3. **wasm host**: a Node host using Node's own WebAssembly and WASI
   (proposed, keeps runtime services Node-only), or a dedicated runtime
   such as wasmtime as a binary sidecar? (Blocks EA11.)
4. **Shipping modules**: are modules only source folders in this repo, or
   do they also need a packaged form (an archive with a built addon) to
   share between projects? (Not needed until after EA13.)
5. **Edits during play**: throw away on stop with an explicit "Keep"
   (proposed, Unreal-style), or keep by default? (Blocks EA6.)
6. **Version control host**: plain git with soft locks in the repo
   (proposed), or git LFS and its locking for terrain and navmesh data?
   (Blocks EA18.)
7. **Staging target**: one VPS reached over SSH (proposed), or a
   container platform? (Blocks EA19's staging target.)
8. **Audio**: a small engine on the Web Audio API (proposed), or a
   middleware such as FMOD's web build? (Blocks EA24.)
9. **Languages**: which languages after English, and when? (Blocks
   nothing; EA25 builds the tables and a pseudo-locale.)
