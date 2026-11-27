# The editor

The editor is a **standalone companion app** (`apps/editor/`, Vite + React + Tailwind): a
dockable shell of workspaces, assembled from modules ([MODULES.md](MODULES.md)). It began as a
customization for the Rogue Engine Editor and can still be bridged to one (see the Rogue scene bridge below).
It started as three inspectors (an ECS inspector, play mode and the art pipeline, still sections 1 to 3
below) and is now an editor in the mould of Unreal and Unity, fitted to this engine. What you can do in it
today (roadmap section 1c, EA1 to EA31):

- **Dock and arrange.** Panels you move, resize, fade and hide, workspaces for each job, a toolbar, a play
  menu, and layouts saved per browser.
- **Edit scenes and the game's flow.** Scene documents with viewport editing, playing a scene, and a flow
  editor that can play from any node; a quest and dialog editor.
- **Edit the data the game runs on.** Rules and gameplay tables (items, creatures, loot, death rules) with
  validation and hot reload, a database workspace with functions and caches, scale factors for models, and
  localization.
- **Author presentation.** Animation, VFX and materials, a HUD layout editor, and audio.
- **Play and debug.** Play mode with the game view, selection cards, the ECS inspector and the debugger
  (performance graphs, network, heap), pause and step, and automated playtests with failure replays.
- **Work with others.** Version control in the editor: semantic diffs, merge, soft locks and
  commit, pull and push over plain git (EA18).
- **Build and ship.** Build and deploy profiles with a stage cache and health check (EA19), and the
  Modules workspace, where you enable modules and press **Apply modules** to restart the play server.

Each workspace is a module with an `editor` entry. The ones that ship:

| Module | What its workspace is |
|---|---|
| `art` | Editor module: Art tooling: asset inspector and materials |
| `audio` | Editor module: the Art & audio workspace's audio panel |
| `authoring` | Editor module: the Design workspace's Authoring panel — view-centered, no-code authoring (hierarchy navigator, selection widgets, … |
| `changes` | Editor module: Version control: the Changes panel |
| `characters` | Editor module: the Characters workspace's Records panel |
| `core` | The engine's own contribution: the server's systems in their fixed tick order |
| `database` | Editor module: Database workspace: data grid, query console, audit log |
| `debug` | Editor module: Debug: play-mode viewport |
| `dungeons` | Dungeon instances (D1): pool, content, InstanceManager as a gateway extension |
| `ecs` | Editor module: ECS inspector viewport for the Scene workspace |
| `flow` | Editor module: the Flow workspace's flow graph editor |
| `gameplay` | Editor module: Gameplay data tooling: data grids, content browser, tables, rules |
| `hud` | Editor module: the Release workspace's HUD layout editor |
| `liveops` | Editor module: Live operations: server & world overview, admin console, telemetry |
| `network` | Editor module: Network: edge routes and connections |
| `release` | Editor module: Release: build pipeline and playtests |
| `scenes` | Editor module: the Scenes workspace's Scene document panel |
| `story` | Editor module: the Story workspace's quest & dialog editor |
| `terrain` | Editor module: Terrain sculpting viewport for the World workspace |
| `vfx` | Editor module: the Art & audio workspace's VFX particle editor |

Developer tools (debug overlays, performance graphs, inspectors) live here, in the editor's play mode, and
never in the player's client.

It is standalone on purpose: Rogue Engine exposes no stable public API
for custom dockable editor panels, so building on private editor
internals would break on the next Rogue update. The scene-side half of
the integration is the public-API package
`rogue-packages/sirhertzalot/mmo-editor/` (see its README). The two meet
over a `BroadcastChannel` (`"mmo-editor-bridge"`) — no shared code with
the Rogue editor, nothing to break on upgrade.

## Launch

```bash
npm run editor          # vite dev server (default http://localhost:5174)
npm run editor:build    # production build of the companion
npm run editor:test     # editor unit tests (view-models, play-mode controller)
```

The dev server also hosts the **dev-only** play-mode control API
(`apps/editor/src/host.ts`), used by the Play Mode tab:

- `POST /api/editor/server/start` → spawns the owned server, returns
  `{ ok, pid, port, url, username, password }`
- `POST /api/editor/server/stop` → stops it, returns `{ ok, stopped }`
- `GET /api/editor/server/status` → `{ running, pid?, port? }`
- `GET /api/editor/assets` → scans the repo `assets/` pack
- `/assets/*` → serves pack files (path-guarded, no traversal)

These routes exist only under `vite dev`. They are localhost-only
tooling, never production surface.

> **A note on the sections below.** Sections 1 to 3 were written when the editor was a row of tabs. Those tabs are now **panels** inside the workspaces (for example the ECS inspector in the Scene workspace, Play Mode in the toolbar's play menu and the Debug workspace, and the Art tooling in the Art & audio workspace). The behaviour described is current (every file named below exists); where a section says "tab", read "panel". The dev host has more routes than the list above shows (`GET /api/editor/server/log`, `/api/editor/assets/resolve`, and one set per workspace such as `/api/editor/pcg/`, `/api/editor/dungeons/`, `/api/editor/audio` and `/api/editor/tables`); each is in its `*-host.ts` file under `apps/editor/src/`.

## 1. ECS Inspector (read-only)

Open the **ECS Inspector** tab, enter the server URL
(`ws://127.0.0.1:7777` when play mode runs it) plus credentials, and
connect. You get:

- Live tick + entity count.
- Entity list with **search** (wire-id substring) and **component
  filter** (entity must carry ALL selected components).
- Per-entity component detail with three-decimal number formatting.

**Why read-only.** The inspector's view-model
(`src/inspectors/ecs.ts`) exposes no mutation APIs and the panel shows
an explicit notice: direct edits would bypass validation, ownership,
event ordering, and the authoritative simulation. The server stays
authoritative — the editor inspects mirror state and may send the same
intents a game client sends, but it never writes ECS state directly.

**Two presentations, one session.** The Scene workspace also carries
**Inspector (Forge)**, the same entity inspector drawn in the editor's
2026 design language: Details / Components / Systems tabs, a liveness
read-out, one row per component with its field summary, and the
entity's archetype. It mounts the same `useEcsInspectorSession()` hook
as the panel above, so the two cannot show different numbers, and it is
read-only for the same reason. Field types and the systems that read or
write each component come from the committed ECS graph
(`/api/editor/graph`); when that is unavailable the panel simply omits
them.

## 1b. Appearance

The editor ships two themes. `m3` is the Material 3 dark scheme in
`src/app.css` and stays the default. `forge` is the 2026 design
language in `src/forge.css`: near-black grounds, one cyan accent, three
semantic hues, 1px hairlines instead of tonal elevation, and labels that
read by tracking and case rather than by size. Both are token sets on
`[data-theme]`, so switching costs nothing at runtime.

Pick one with `?theme=forge` (or `?theme=m3`) in the URL for a single
load, or set it for good with `setTheme()` in `src/theme.ts`, which
remembers the choice in local storage. The design note behind the forge
theme, and the plan for the rest of the rebuild, is
[`EDITOR-UI-2026.md`](EDITOR-UI-2026.md).

## 2. Play Mode

The **Play Mode** tab drives a full local loop:

1. **Start** — the dev host spawns exactly one `npm run server`
   (30 Hz authoritative sim: Intent/Integrate + Jolt physics + Recast
   navigation, procgen chunk, SQLite persistence).
2. **Seed** — before the server boots, the host seeds a one-session dev
   user (`editor-<rand>`) with a random 256-bit password into the
   server's data dir (`<repo>/data`, via `MMO_DATA_DIR`; only the
   argon2id hash is stored, the plaintext is never logged or persisted).
   Seeding happens first because the gateway's credential store loads
   the CSV once at startup.
3. **Connect** — the companion logs in with those credentials and shows
   live tick, entity count, and the debug overlays:
   - **Navmesh tiles** — bounds of tiles actually loaded into the nav
     backend (protocol v3 `0x0a` `tiles` query).
   - **Waypoints** — per-entity path status (`active`/`idle`/`failed`/
     `unknown`) and live waypoint list (`0x0a` `waypoints` query).
   - **Game view** (ROADMAP E4) — the world drawn by the game client's
     own renderer (`WorldCanvas`, imported from `apps/client/src/render`
     through `@mmo-engine/client/render`: a Vite alias to the source, and
     tsconfig paths to the built client's types), on the same mirror
     client the overlays query. Click the view to steer the avatar with
     the default bindings (Esc frees the mouse); fps, tick, entities,
     position, time of day and weather show under it. The view loads on
     first use, so the other tabs never download the renderer. Terrain
     surfaces come from the client's `public/` folder (the editor's
     `publicDir`), when fetched.
   - **Debugger** (ROADMAP E5) — the editor's dockable panels
     (`DevHud`, `PerfHud`, `AdminConsole`, through
     `@mmo-engine/client/debug`) drawn over the game view: drag a panel
     by its title, resize it from its corner, fade, fold or close it; the
     "dev" menu reopens panels or resets the layout, and ` hides them all.
     *status* (tick, time, weather, fps, entities, position, movement,
     the GPU, a warning on software rendering), *performance* (the last
     minute of fps, frame time, draw calls and triangles over every pass,
     props by level of detail, GPU memory, network in and out, JS heap),
     *play telemetry* (T2: authoritative kills, deaths, pickups, drops,
     damage dealt/taken in 10-second buckets over the last 10 minutes,
     plus tick p50/p99/max),
     *tools* (wireframe terrain, quality preset, FX showcase, maximize the
     view to the window — Esc restores it — and the admin console) and
     *controls* (the key bindings). The panels sit inside the view and
     follow its size; the layout is kept per browser. The play server
     lists the editor's play user in `MMO_ADMINS`, so the admin console
     works on the server the editor owns.
   - **Selection card** (ROADMAP E6, PICG slice 3) — the debugger's
     *selection* panel: left-click an entity in the game view (or "my
     avatar") and it lists every component the mirror holds for it, field
     by field. When its AssetRef names a PICG library asset
     (`content/pcg/index.json`), the card adds the asset: its graph, which
     cooked shape the entity's variant picks and that shape's seed (the
     server cook's own mapping), and the graph's exposed parameters with
     their values, ranges and an ● where the asset overrides the graph
     default. The view-model is `src/inspectors/selection.ts` (pure TS);
     the library comes from `GET /api/editor/pcg/library` (`src/pcg-host.ts`,
     read-only, confined to `content/pcg`).
4. **Stop** — disconnects the client, kills the owned server process
   group, and restores the pre-play editor state (form fields, auto-
   refresh, entity selection).

**Ownership & cleanup.** The host spawns the server `detached` (its own
process group: `npm → sh → node`) and stops it with a group kill
(negative pid) — killing only the npm wrapper would orphan the real
server. The host tracks the child handle immediately after spawn so a
startup timeout can still kill it; readiness watches stdout for the
listen line (60 s budget) and surfaces the server's own fatal output on
failure. Stop is best-effort across every step (client disconnect, group
SIGTERM → SIGKILL after 5 s, state restore) so one failing step never
skips the rest. Only the process the host launched is ever signaled —
nothing is killed by port. If the dev server itself exits, its exit hook
kills the owned group.

## 2b. PICG Graphs (hierarchical graph editor, ROADMAP E7)

The **PICG Graphs** tab edits the PICG library (`content/pcg`): the asset
graphs (`trees/*.pcg`) and the parts they link (`parts/*.pcgsubgraph`).

- **Canvas** — the graph flows downwards: inputs on a node's top edge,
  outputs on its bottom. Drag a node to move it, drag the background to
  pan, wheel to zoom.
- **Hierarchy** — double-click a `SubgraphAsset` node (⤵ open) to open the
  part it links, or a `Subgraph` node to enter its embedded definition;
  the breadcrumb (`Oak › Trunk`) climbs back out. A part whose GUID isn't
  in the index is outlined red.
- **Details** — the selected node's properties (numbers, booleans, text,
  JSON) and, at a graph's root, its parameters' defaults with their
  target (`trunk/sweep.radiusScale`) and range. A field commits on Enter
  or blur; a value that doesn't parse turns red and isn't applied.
- **Undo / Redo / Revert / Save** — every open document keeps its own
  edits and undo (a drag is one step), so a tree and its trunk can be
  changed together; Save sends every edited document to the dev host.

**Saving is validated the way the server cooks.** `PUT /api/editor/pcg/doc`
(`src/pcg-host.ts`) checks node and edge structure, then runs
`prepareForCook` (linked parts inlined, parameters applied) on every
library graph the document reaches, with the candidate in place: renaming
the trunk part's `sweep` node is refused because oak, birch and pine all
target `trunk/sweep`. Only files `content/pcg/index.json` names are read
or written, confined to `content/pcg`, written back with 2-space JSON. The
region server loads the library when it starts, so a saved edit shows in play
mode on its next start.

The model and view-model are `src/inspectors/graph-editor.ts` (pure TS,
tested with `node:test`); `src/ui/graph-editor.tsx` only draws them.

## 2c. Dungeons (pool, 3D view, patches, ROADMAP E8)

The **Dungeons** tab is DUNGEONS-AND-LOOT.md §3.5 for the baked pool in
`<dataDir>/dungeons` (`npm run dungeon:bake`).

- **Pool:** every baked dungeon with the map thumbnail its bake wrote, its
  theme, rooms, rank, boss and how many edits its patch carries (red when the
  patch is stale). **Bake into the pool** runs the same CLI (count 1 to 50,
  seed or `random`, rank) and always writes the maps.
- **3D view:** one block per floor cell, tinted by its room's role, walls,
  torches, spawn spheres coloured by tier (larger when pinned), and props
  (grey layout, lilac dressing, cyan edited or added). Drag to orbit, wheel to
  zoom, right-drag to pan. Click a room's floor, a spawn or a prop to select
  it; drag a selected prop to move it (one undo step per drag).
- **Details:** a room's role and dressing archetype; a spawn's pin and rank
  (1 to 5); a prop's position, or remove it. **Place prop** adds one where you
  click. Anything set back to its baked value drops out of the patch, and
  "Back to the bake" clears a room's or a spawn's edits.

**Edits are a patch, never a change to the bake.** Save writes
`<id>.patch.json` (`mmo-dungeon-patch/1`) beside the baked file, after
`PUT /api/editor/dungeons/<id>/patch` (`src/dungeon-host.ts`) checks it
against the layout: the layout's hash (a patch made for another bake is
stale), room ids and roles (exactly one entrance and one boss), the dressing's
archetypes, spawn ranks, and that every moved or added prop stands on a floor
cell. Saving an empty patch removes the file. Only ids the pool's index lists
are read, so no path comes from a request.

The model and view-model are `src/inspectors/dungeon-view.ts` (pure TS,
tested with `node:test`); `src/ui/dungeon-scene.ts` draws them with three.js
and `src/ui/dungeon-view.tsx` is the panel.

## 2d. Terrain at world scale (ROADMAP E9)

The **Terrain** tab sculpts one area of the stored world at a time (its
outer edge pinned to the unloaded neighbours). For a baked world
(OPEN-WORLD-PLAN.md Phase 4) it also has:

- **World map:** the whole world at the welcome's ~16 m resolution (the
  client's biome ground colours, lit by a hillshade, sea and lakes over
  them), the region grid, the loaded area (cyan), the camera (white) and
  the spawn (gold). Hover shows a cell's biome and height; click loads the
  area there, at the radius in the Area box.
- **Follow camera:** pan the view (middle-drag) and once the camera is half
  the area's radius from its centre the area round it loads, keeping the
  camera where it is. It pauses while anything is unsaved, since loading
  another area would drop the edits.
- **Mountain-scale brushes:** the radius slider runs 1 to 256 m on a log
  scale, and raise or lower up to 40 m/s. Load an area wider than the brush:
  a brush that reaches the pinned edge rises as a plateau.
- **Regenerate from the world spec:** the loaded area or one region of the
  spec's region grid goes back to what the bake makes of the spec, and
  nothing else changes. `terrain-tool regenerate` re-runs the survey
  (~10 s for 4 km), rebuilds that range's tiles and survey-map cells, and
  blends a 48 m band along each edge from the stored neighbour (exactly, at
  the edge) to the fresh ground, so no seam opens. Props there are re-seated
  as a save does, and a running server is refused (play mode is stopped
  first). It refuses a spec that isn't the one this world was baked from
  (name, seed, size or biome list). The SurrealDB chunk catalog isn't
  updated.

The map and follow logic are `src/inspectors/world-map.ts` (pure TS,
tested); the tool side is `packages/engine-core/src/terrain/region-regen.ts`.

## 2e. What the scene viewport draws (ROADMAP EB1)

The viewport used to draw one 1 m cube per node, which made a wolf, a pine
and a longhouse the same object on screen. It now draws each node at the
size the engine would actually spawn it at, and the editor does not decide
what that size is:

- **A creature** is its physics capsule: `CHARACTER_CAPSULE` from the engine,
  times the body scale `CreatureService.spawnOne` resolves — the creature's
  own `behavior.size` when it sets one that is not 1, else the species'
  `SPECIES_NATURAL_SCALE`, else 1. An unlisted humanoid therefore stands
  1.80 m, like a player.
- **A prop, tree, rock, plant or building** is a stand-in box for its
  category, multiplied by `content/scale.json` through the same
  `resolveScale` the server applies where baked objects spawn. The stand-in
  size is the editor's (art is what measures an object, and there may be
  none), so it is labelled as one: `basis: "stand-in"`, and the toolbar says
  "Stand-in sizes (no art pack)" when the pack resolved no model at all.
- **A model**, where `assets/manifest.json` names one for the id, is loaded
  once per URL, cloned per node and drawn at the server's scale factor. It is
  never stretched to fit the stand-in, because the point is to see what the
  server will spawn.
- **Spawn points and groups** keep their marker shapes. They are not things
  in the world, so they have no size to be accurate about.

`scene-visuals.ts` holds the rules and is pure; `scene-visuals-host.ts` does
the reading and serves `GET /api/editor/scene/visuals`; `ui/scene-view.ts`
draws it. A checkout without `assets/` loses only the models: every size
above still comes out right.

## 2f. The Scenes workspace layout (ROADMAP EB4, EB4b)

The canvas is the workspace, not a figure inside a form:

- The viewport's tools float on the canvas in a translucent bar, and its
  notes — "No terrain (grid only)", "Stand-in sizes (no art pack)" — sit in
  a status strip at its foot. Nothing above or below pushes the canvas down
  the page.
- What you can drop into the scene is a column of its own beside the
  Outliner (`ui/scene-palette.tsx`): searchable, grouped (Creatures, Props,
  PICG) and scrolling. Drag an item onto the ground, or click it to place it
  at the point the camera is looking at. `placeables-filter.ts` holds the
  search so the ordering and the "no match" case are testable on their own.
- The palette and the viewport read one hook for the list
  (`ui/placeables-store.ts`), which is the rule in
  [How the editor is layered](#how-the-editor-is-layered): one hook per data
  source, mounted by every presentation of it.

Selecting more than one node (`scene-selection.ts`) works the way every
editor's does: a plain click replaces the set, ctrl or cmd toggles one node
in or out, shift ranges over the rows the outliner draws. The *primary* —
the last node added — is what the gizmo rides and what Details shows; the
rest of the set lights up more faintly, follows a gizmo drag by the same
delta, and goes with Delete, each in one undo step. Align and distribute
(`scene-align.ts`, controls in `ui/align-bar.tsx`) act on each node's own
transform position, so what they do can be read off the inspector.

The forge theme reaches these controls through variables, not components.
Every primitive in `ui/components.tsx` reads the legacy shadcn aliases
(`--primary`, `--background`, `--input` and the rest), so `forge.css`
redefines all of them alongside the `--m3-*` roles; until it did, every
Button, Input and Select in the editor stayed Material 3 purple under the
theme. `test/forge-aliases.test.ts` fails if a variable one theme declares
is missing from the other.

## 2g. Turning a module off (ROADMAP EB9)

`dependsOn` makes the module set a graph, and the server fails the boot
closed, so a switch flipped in the editor used to be answered at the next
restart. The panel now says it first: `module-blast.ts` walks the graph
transitively from the module being turned off and reports the enabled
modules that go with it, the systems leaving the tick order, the editor
panels that disappear and the sidecars that stop. Every enabled card
carries the one-line cost, and a switch that takes other modules with it
asks before acting.

The same closure is what gets saved. Closing the set one level deep — the
modules that name the disabled one, but not the ones that name those —
produces a set `resolveModuleSet` refuses, which is what used to happen
with `economy → items → civic`.

**New module** (EB8) writes the four things that have to agree: the
manifest, a server entry whose keys match the system names it declares, an
optional editor entry, and the name you then enable. `module-scaffold.ts`
holds the generator and its refusals and is browser-safe, so the form and
`POST /api/editor/modules/scaffold` apply one set of rules; the route
writes all of the files or none of them, and never over a folder that is
already there.

## 2h. Previewing a flow's screens (ROADMAP EB6)

The Flow panel edits the path a player takes — login, character creation,
character select, the world — and **Play from** has always been able to
open any node, because the client takes `?start=<node>` and the dev
account rides in the query string beside it. What it did was open a tab,
which put the graph and the screen it describes on two different windows.

The preview pane under **Play from** frames that same URL in an iframe, at
Fit or one of three fixed sizes (1280 × 720, 1024 × 640, 390 × 844), so a
screen can be judged at the size it will be played at without leaving the
graph. It needs the client's own dev server running (`npm run dev
--workspace=@mmo-engine/client`); the URL field above the buttons is where
that address comes from, and the pane says so when it is empty. **Open in
a tab** stays, because devtools, a second window and pointer lock still
want a window of their own.

One detail is not cosmetic. The play URL carries the dev account's name
and password as query parameters, which is tolerable while the URL only
goes to `window.open` and is not tolerable on a line of text in the
editor, so the line under the toolbar is `maskUrl`'s version: every
`user=`, `pass=`, `password=` and `token=` value is replaced with `…`.
Anything that prints a play URL — a log line, a status message — should
print that form, not the real one.

## 2i. What a player may choose at creation (ROADMAP EB7)

**Characters › Creation** edits `content/character-creation.json`: the
part categories the character screen offers, the colours and their
swatches, the genders, and whether a new character's body is locked to
the starter armour.

It had been three lists that had to agree. The client's character screen
held the categories and the swatch palettes; the server's creation check
held a denylist of the ten armour attachments, which was the complement
of the five categories the client drew; and nothing connected them. Now
one file answers for all three: `loadCreationRules` reads it at boot and
the gateway checks every new character against it, the client fetches it
(`/content/character-creation.json`) before drawing the pickers, and this
panel writes it, validated by the art package's own reader so the form
cannot save a document the server would refuse.

A game with no file is the normal case and means the engine's defaults,
which are exactly what it did before the file existed. The panel says so
and offers to write the defaults out, rather than starting you from an
empty document that would mean something quite different.

Two things deliberately stay outside it. How many characters an account
may hold is `content/rules/social.json`'s `characters.slots`, which the
gateway can already change live — one number, one owner. And whether a
part *exists* is still the catalog's question: a game may offer the
`helmet` slot here, and on a machine without the licensed pack the
server will check the name's shape rather than the pack.

## 2j. The game's manifest and its module settings (ROADMAP EB10)

**Modules › Game** edits `game.json`: the game's name, and the settings
each module reads from it (`modules.<name>.<key>`, which reaches the
module as `ctx.config[name][key]`).

Two things had to exist before a settings editor could. Modules had no
way to say what they read, so the panel declares nothing on their
behalf: a module lists its settings in its own `module.json` ([Settings
a game can change](MODULES.md#settings-a-game-can-change)) and gets a
labelled, typed field per declaration. A key this game sets that no
module declared is shown anyway, as a free text box, because the engine
fixes no key list and a game's own module reads whatever it likes.

And the engine checkout has no `game.json` at all. Writing one turns a
checkout into a game project and changes how every path resolves at
boot, so the panel never writes one as a side effect of being opened:
it says there is none, explains what a manifest does, and offers a
button. The host refuses to write over a manifest that is already there
— `POST` answers 409 and the panel edits the file instead. Every save
goes through `GameManifestSchema` from `@mmo-engine/sdk`, the same
strict schema the server boots with, so the editor cannot write a
manifest the engine would refuse.

An empty field means the module's own default, and a module whose
settings all go back to their defaults drops out of the file rather
than leaving `{}` behind. A run's `MMO_*` variable still wins over
both.

## 3. Art Asset Pipeline

Folder convention (repo root):

```text
assets/
  manifest.json
  models/
  textures/
```

**Refresh scan** validates the pack with `@mmo-engine/art`: Zod schema
(name, version, models[], textures[]), pack-relative paths (traversal
rejected), per-entry diagnostics. **Load pack in browser** instantiates
`ManifestAssetProvider` against `/assets/*` and reports per-asset
`loaded` / `fallback` status with diagnostics — a failed model never
breaks the pack; it stays on the deterministic placeholder mesh.

The owner supplies the real art later; until then everything renders the
placeholder pipeline (the same one the game client uses — both consume
`@mmo-engine/art`, one contract).

To import a finished pack into a Rogue project:

```bash
node rogue-packages/sirhertzalot/mmo-editor/src/import-art-pack.mjs \
  --project /path/to/rogue-project --pack /path/to/mmo-engine/assets
```

Models land in `Assets/Models/mmo/`, textures in
`Assets/Textures/mmo/`, with an index manifest for `RE.Model.fetch()`.

## Rogue scene bridge

In your Rogue project, copy
`rogue-packages/sirhertzalot/mmo-editor/` to
`rogue-packages/sirhertzalot/mmo-editor`, register the
`MmoEditorBridge` component, and attach it to any Object3D. Configure:

- `editorUrl` — companion URL (default `http://localhost:5174`)
- `autoOpenOnPlay` — open the companion when Rogue play starts
- `announcePlayState` — broadcast play/stop on the bridge channel

The companion listens on the same `BroadcastChannel` and reflects Rogue
play state. Full install + compatibility notes (pinned Rogue docs
commit, upgrade checklist) are in the package's `README.md` and
`COMPATIBILITY.md`.

## Manual UI test procedure

1. `npm run editor`; open http://localhost:5174.
2. **Play Mode** → Start. Expect: status running, tick advancing,
   entity count > 0, tile overlay shows the loaded chunk bounds,
   waypoint query for your entity shows `idle`.
3. **ECS Inspector** → connect with the same URL (credentials are shown
   in Play Mode while running). Expect: tick/entity count live, search
   filters the list, component filter narrows it, selecting an entity
   shows Transform/Velocity/etc. with 3-decimal numbers, and the
   read-only notice is visible.
4. **Art Assets** → Refresh scan. Expect: "no pack" diagnostic until
   you create `assets/manifest.json`; with a pack, per-asset loaded /
   fallback rows.
5. **Play Mode** → Stop. Expect: status idle, server port closed
   (`ss -tln | grep 7777` empty), no orphan `server.js` process, form
   state restored.
6. Start → immediately Stop during the 60 s readiness window is also
   safe: the owned group is still killed.

## How the editor is layered

Four layers, each named by where the file sits. The shape was already
there; this says it out loud, and `apps/editor/test/layering.test.ts`
holds the two rules that keep it.

| Layer | Where | What it may do |
|---|---|---|
| **Host** | `src/*-host.ts` (and `src/host.ts`) | Node. Reads and writes the repository, validates a document the same way the game loads it, refuses with every issue and writes nothing. Never imports React. |
| **Client** | `src/*-client.ts` | The browser's side of one host. One place per route family, built on `api.ts`'s `requestJson`, so a refusal turns back into the document's own error type. |
| **Model** | `src/store.ts`, `src/ui/*-store.ts` | State a panel reads and more than one surface writes. `createStore` plus `useSyncExternalStore`. Never imports a renderer. |
| **View** | `src/ui/*.tsx`, `modules/*/editor` | Draws, and nothing else. Reads through a client or a store. |

Two rules the test enforces, because both have been broken by accident:

- **A view does not call `fetch`.** It goes through a client. Seven
  panels still do their own fetching; they are listed by name in the
  test, and the list may only shrink — removing one is the fix, and the
  test fails if a name in the list no longer fetches, so the list cannot
  go stale.
- **A model does not import a renderer.** Reading the play state used
  to pull `@mmo-engine/client/render` in behind it, which is why
  `playUiStore` and `getPlayController` were pulled out of
  `ui/play-mode.tsx` into files of their own.

A view may import a host's **types** (`import type { PoolEntry } from
"../dungeon-host.js"`) — the import is erased at build, and the
alternative is declaring the same shape twice. It may not import a
host's code.

One more convention, from the 2026 UI rebuild
([EDITOR-UI-2026.md](EDITOR-UI-2026.md)): **one hook per data source,
mounted by every presentation of it.** `useEcsInspectorSession()` and
`useTickTimings()` are each mounted by both the Material 3 panel and its
forge counterpart, so the two cannot drift on what they show or how
often they ask. A second presentation that polls for itself is the bug
this prevents.

## Code map

```text
apps/editor/
  src/host.ts                 dev-only server/assets control API (vite plugin)
  src/scene-visuals.ts        the size the engine spawns each placeable at (EB1)
  src/play-mode.ts            PlayModeController (idle→starting→running→stopping→idle→error)
  src/inspectors/ecs.ts       read-only ECS view-model (no React, unit-tested)
  src/ui/App.tsx              tab shell — one tab per inspector
  src/ui/ecs-inspector.tsx    ECS panel (search, filters, details, read-only notice)
  src/ui/play-mode.tsx        Play Mode panel (start/stop, overlays, debug queries)
  src/ui/asset-inspector.tsx  Art panel (scan, validation, browser load test)
  src/ui/mirror-connect.ts    MirrorClient adapter (connect/login/debug/close)
  src/ui/components.tsx       shared shadcn-style primitives
packages/mirror/              shared mirror client (game client + editor)
packages/art/                 shared art contract (manifest, scanner, provider)
rogue-packages/sirhertzalot/mmo-editor/
                              public-API Rogue bridge package
```
