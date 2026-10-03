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

**Existing panels map without rewrites.** `EcsInspector` becomes the
controller of the play-mode outliner, `PlayModeController` the toolbar's,
rules and tables keep their stores as models. EA2 moves them behind the
contracts; behaviour does not change.

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

## 8. Packages and folders

| New | What it holds |
|---|---|
| `packages/modules` | the module manifest schema, discovery, validation, dependency and system-order resolution (shared by the editor host, engine-core and the edge) |
| `packages/scene` | scene and flow schemas, the node and component registry types, the flow runner (shared by client, editor and server) |
| `packages/sidecar` | the supervisor and the wasm host, on E2's channel code |
| `modules/core` | the engine's own contributions: today's systems in today's order, the engine's components, the existing editor panels |
| `modules/*` | everything else, one folder each |
| `content/scenes`, `content/flow`, `content/modules.json` | the documents |

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
| Play telemetry graphs | server done, graphs wait on E5 (T2) | `debugger` module |
| PICG selection cards, graph editor | planned (E6, E7) | `picg` module: Details cards and a graph panel |
| Dungeon view | planned (E8) | `dungeon` module: `instance` scene tools |
| World-scale editing | planned (E9) | `world` module: `world` scene tools |
| Appearance and equipment editor | planned (A6) | `characters` module |
| Scene editor, Flow editor, Modules window | this plan | `core` (EA4 to EA8) |
| Module build and valgrind check | `npm` scripts | `core`: Modules window actions |
| Sidecar supervisor and logs | this plan | `core`: Modules window and Output log |

## 10. Slices

One PR each, in order; each leaves the editor working. Names use **EA**
(editor architecture) so they do not collide with the editor's E rows or
the edge split's E slices. They go on the roadmap when this phase starts;
the roadmap thread adds them.

| # | Slice | Depends on | Done when |
|---|---|---|---|
| EA0 | **This document** | | merged |
| EA1 | **Docking shell and panel registry.** `App.tsx`'s tabs become panels in a dockable layout (left, right, bottom, center), persisted per browser; panels registered in code, not imported by the shell. No behaviour change. Reuses E5's panel layout code rather than a second one | E4, E5 | every existing tab opens as a panel; layout survives reload; screenshot |
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

EA1 to EA3 are the frame; EA4 to EA8 are scenes and the flow; EA9 to EA12
are engine modules. The scene track and the module track only meet at EA9,
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
