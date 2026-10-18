# Roadmap

The official list of what is built, what is being built, and what comes
next, so anyone can follow along and pick something up. **Every pull
request updates this file**: its item's status, and a line in the
[update log](#update-log) at the bottom.

The design behind each item lives in the linked doc; this page is the
index and the status board, not the spec.

| Status | Meaning |
| --- | --- |
| ✅ | Built and merged |
| 🚧 | In progress: partly built and merged, or on a branch or open PR |
| ⏭️ | Next up |
| 📋 | Planned |

**Want to help?** Pick a 📋 item, read its design doc, and open an issue
or a draft PR saying you're on it, so work isn't doubled. Each item is
one PR (`CLAUDE.md` has the workflow: tests, screenshots, one feature per
PR).

## At a glance (2026-10-18)

**145 items built, 30 in progress, 11 planned** (and 3 spikes closed without adoption: TS5, TS6, TS7) (counted
from the tables below). The game is playable end to end: `npm start`
bakes and runs it. The world (4 × 4 km bake, streaming, LOD terrain,
biomes and wild creatures), combat and the body (stances, defence
contests, injuries, bleeding, dismemberment, Medicine, disciplines, mana
and Mend), items and saves, quests and dialog, dungeon runs with the
party, chat, parties, guilds, friends and blocks (all persisted) are in,
with every player screen for them. The editor has play mode with the
game view and debugger, selection cards, the PICG graph editor, the
dungeon view and world-scale terrain editing. The edge/core split (E1 to
E6) and the world server's migration and stress harness are built.

What is left, by area:

- **Modular editor** (1c): the docking shell, workspace navigation,
  persistent layouts, deep links, display-side data contracts, and a
  UI-only flow graph are in progress. Scenes, executable game flow,
  modules, the database editor, and production tools remain EA1 to EA26
  follow-on work.
- **Editor and admin**: the play-mode admin tools finish (A1 to A5, cursor targeting, gold, god
  mode, time and weather), and the appearance editor (A6).
- **Gameplay**: armour and the rest of equipment (U10), recorded and
  positional sounds (U4b), dungeon results ingested by the world server
  (D4), ragdolls and character collision.
- **Scale**: the client cutover to the edge (E3b), binary mirror frames
  (E5a, E5b), the region↔world event stream (S2), accounts on the world
  server (C1).
- **Checks**: Helgrind on the threaded addons.
- **CI**: GitHub Actions is out of credits, so every change is checked
  locally with `npm test` and valgrind.

## Where things live

- **The game client (`apps/client`) is what players see**, and only that:
  the world, and the player's own interface (health and resource bars,
  chat, parties, quests, inventory, character sheet, settings).
- **The editor (`apps/editor`) is where every developer tool lives.**
  Its play mode runs the game against a local server and is the engine's
  debugger: performance graphs, draw calls and triangles, level-of-detail
  views, network traffic, wireframe, effect showcases, entity
  inspection, navmesh and path overlays.

`npm run client` starts the player's client, `npm run dev` the
development environment (the server and editor), and `npm run editor`
the editor alone.

Developer tooling is mounted only in the editor's play mode.

---

## 1. Editor and developer tools

Doc: [`EDITOR.md`](EDITOR.md)

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| E0 | **Separate commands**: `npm run client` is the player's client only; `npm run dev` starts the server and editor development environment | ✅ | `scripts/start.mjs` (`npm start -- --dev`) starts `@mmo-engine/editor`; `npm run editor` starts the editor alone |
| E1 | ECS inspector (read-only, over the 0x0a debug queries) | ✅ | |
| E2 | Play mode: start a local server, connect, path and navmesh-tile overlays | ✅ | |
| E3 | Art asset pipeline: pack models to GLB, previews | ✅ | |
| E4 | **Play-mode game view**: the world renderer embedded in play mode, with the editor's panels around it | ✅ | Play-mode game view: the client's `WorldCanvas` in the Play Mode tab via `@mmo-engine/client/render`, stats row, lazy-loaded (#92). First-person view: V or the toggle button, own avatar hidden (#182). "New window" pops the live view into a popup via adoptNode, same GL context (#181) |
| E5 | **Play-mode debugger**: dockable panels you move, resize, fade and hide; performance graphs (fps, frame time, draw calls and triangles over every pass, props by level of detail, GPU memory, network in/out, heap); wireframe and FX showcase toggles | ✅ | Debugger in the editor's play mode: the developer panels (DevHud, PerfHud, AdminConsole) over the game view, layout per browser, maximize (#111). The client no longer mounts developer panels. |
| E6 | PICG slice 3: selection cards (an entity's components and graph parameters) | ✅ | Selection card in the play-mode debugger: click an entity, see every mirror component and, for a PICG asset, its graph, shape, seed and exposed parameters (#113) |
| E7 | PICG slice 4: hierarchical graph editor | ✅ | PICG Graphs tab: graphs and linked parts on a canvas, enter and climb the hierarchy, node properties and parameter defaults, undo, saves validated by a cook preparation (#115) |
| E8 | D3: dungeon view: pool browser, 3D view, edits as patches | ✅ | Dungeons tab: pool browser with map thumbnails and bake more, 3D view with picking, room role and archetype, spawn pin and rank, prop move, add and remove, saved as a validated patch over the bake (#118); applying patches at re-bake is next |
| E9 | Editor at world scale: world map overview, streaming the area round the camera, regenerate one region | ✅ | Terrain tab at world scale: world map with click to jump, the area follows the camera, brushes to 256 m, regenerate a region or area from the world spec (#121); the "sculpt 3 km out, see it in game" check is open |
| E10 | Character record view (read-only) | ✅ | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6 |
| E11 | Rules editor: every `content/rules/*.json` tunable listed, edited as a tree, validated on save | ✅ | Loopback `/api/editor/rules` routes (whitelisted names, path-confined, write only when valid; strict across files); Rules tab with tree editor and per-path errors. Opened from opencode's work; no screenshot yet |

## 1b. Admin console: control the running game

The development client's (`npm run dev`) control over the live world, to
test every part of the engine: then with the rest of the developer tools
in the editor's play mode (E4). Every change goes through the server,
which accepts admin commands only from admin accounts or a development
server, and logs them. Source definitions (prefabs, species, rules files)
stay read-only here; this edits the running game.

| # | Item | Status | Needs |
| --- | --- | --- | --- |
| A1 | **Admin channel**: an admin command message, admin accounts (and every account on a development server), a command log | 🚧 | 0x10 `help`/`whoami` live; `MMO_ADMINS` + `MMO_DEV_SERVER=1`; A2+ adds world-editing commands; the admin console is also in the editor's play-mode debugger (#111) |
| A2 | Inspect and edit any entity: pick or search it, every component and field, change any value | 🚧 | `inspect` + `set` live via the dev console (whitelisted numeric fields); click-to-pick UI awaits E4 overlays; click-to-pick in the editor's game view (E6) picks the entity |
| A3 | Spawn anything at the cursor or the player: species, archetypes, props, PICG assets; despawn | 🚧 | `spawnlist`/`spawn` (table archetypes at avatar or x/z) + `despawn` (live avatars refused) live; creatures need a shared spawner; cursor targeting awaits E4 |
| A4 | The player: health, mana, stamina and any stat; teleport; fly and no-clip; invulnerable; time of day and weather | ✅ | `teleport` (ground snap), `heal`, `fly` bit live; stats via `set`; `god` toggles the God tag (no combat/hunger/drowning/trap Health loss) and peaks every skill, kept when switched off; `noclip` toggles the Noclip tag (free vertical flight, dungeon walls let go); `time` shows and sets the clock (newcomers via welcome, live clients by broadcast) and `weather` forces the sky (auto/clear/rain/snow/ash, same path); `injure {part, kind?, amount?}` (#99) and `skill {id, value}` (#112) live; `heal` also fills mana and makes the body whole |
| A5 | Loot and inventory: browse the loot pools, put items in the inventory, grant gold | 🚧 | `items` (browse the pool), `give` (into the bag), `drop` (on the ground), `loot` (mob drops round you) live; gold awaits a currency |
| A6 | Appearance and equipment editor, live on the character | 🚧 | Merged (PR #191): `appearance` admin command (parts/colours per slot, validated against the catalog, live via sim.setLook). Equipment overlays re-apply. Open: the editor panel. |
| A7 | **Bots in web workers**: an admin command spawns N simulated players (each its own socket, moving and fighting) in worker threads, to stress the server and feel play under load | 📋 | U14 (worker pool), A1; builds on `scripts/world-stress` |

## 1c. Modular editor

Doc: [`EDITOR-ARCHITECTURE.md`](EDITOR-ARCHITECTURE.md) §10. A docking
editor with workspaces for every engine feature, scenes and game flow,
loadable modules, a database editor and production tools.

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| EA0 | The plan: [`EDITOR-ARCHITECTURE.md`](EDITOR-ARCHITECTURE.md) | ✅ | (#91) |
| EA1 | Docking shell, workspaces and toolbar | 🚧 | `feat/editor-backend-connector`: dockable/resizable persistent layout, workspace navigation, toolbar, and deep links are implemented; scene documents and viewport editing remain separate slices. Menus complete (2026-10-09, PRs #163–166): File/Edit/View act on the open document via DocActions/ViewportActions (no staged placeholders); Ctrl+K palette over commands/assets/settings with asset deep-linking; toolbar Play/F5 starts play with last setup; dock shows real server log/validation/bakes. Customizable toolbar (#185); the Details pane shows the real unsaved Gameplay edits (#177). |
| EA2 | MVC contracts | ✅ | Contracts (`Model<T>`, `Controller<VM>`, `PanelContribution`) defined in `EDITOR-ARCHITECTURE.md` §3.1; view-side backend models and per-view registry implemented (`packages/modules/src/index.ts`); application-side model/controller boundaries applied to core editor panels (EcsInspector, PlayModeController, Rules/Gameplay grids). `Mustache` (`mustache.js`) selected for template maintainability instead of `PUG` (`PUG` was server-side focused; editor is client-side React). |
| EA3 | Editor modules | ✅ | `feat/ea3-ea9-modules`: `packages/modules` (manifest schema collecting every problem, discovery, `content/modules.json` set, dependency order); host routes `/api/editor/modules` (list, validated save, apply); the shell imports enabled modules' editor entries dynamically and a Modules workspace enables and disables them; the header count is real; the Characters Records panel is now the `characters` module. Deferred: other panels as modules (EA13), commands and document kinds as contributions, Controller/EditorContext contracts (EA2) |
| EA4 | Scene documents | ✅ | `feat/ea4-scene-documents`: `@mmo-engine/scene`, `content/scenes/*.scene.json`, loopback `/api/editor/scenes` routes (a refused save writes nothing) and a Scenes workspace (Outliner, Details, undo/redo, save, reload). Viewport editing is EA5. |
| EA7 | Game flow | ✅ | `feat/ea7-ea8-game-flow`: `content/flow/game.flow.json` and the pure flow runner/validator in `packages/scene` (`flow.ts`); the client's `Screen` state is now a flow node (`apps/client/src/flow.ts`, `useFlow`) with login, loading, character select/creation and world as frontend scenes; no protocol change |
| EA8 | Flow editor and play from a node | ✅ | `feat/ea7-ea8-game-flow`: Flow editor panel (`ui/flow-editor.tsx`) over the real document: add/delete/move nodes, add/rewire/retarget/delete transitions, set start, live validation (unreachable, missing start, dangling, unknown event/scene), validated `GET/PUT /api/editor/flow`; Play from login (plain client), character creation (serverless preview or `?start=` with a server) and world (`?start=` with a server). Not yet opened in a browser; open scene on double-click deferred |
| EA5 | Scene viewport editing | ✅ | Viewport in the Scenes workspace: place by drag, gizmos, terrain snap, picking, delete, all undoable. |
| EA6 | Play the scene | ✅ | Server `MMO_SCENE` spawn and Play with the open scene built; "Keep" built; host Play round trip not run to completion here. |
| EA9 | Server modules | ✅ | `feat/ea3-ea9-modules`: `server.ts`'s systems array is the `core` module's instances in the order `modules/core/module.json` fixes; `MMO_MODULES` (default `content/modules.json`) selects modules; order resolved from `after`/`before`, unknown ids and cycles stop the boot with every problem; `modules/sample-heartbeat` adds a system; "Apply modules" restarts the owned play server. Open: `valgrind:perf` not run (no host valgrind on the Windows dev machine; the tick-order test pins the order instead), play mode does not auto-reconnect after Apply, admin commands / rule hooks / persistence tables contributions |
| EA10 | C++ modules | ✅ | `native` manifest field, validation, design doc (`EDITOR-ARCHITECTURE.md` §4.4), addon template (`packages/addons/template`) and Build/Check/Apply framework completed. Memcheck verified (`valgrind:memcheck -- template` clean). `deleteWorld` cleanup added to `integrate`. |
| EA11 | Sidecars | ✅ | `sidecar` manifest, validation and lifecycle (`start`, `health-check`, `stop`) complete. Supervisor owns sidecar process groups; play mode stops them with the server. `wasm` host and `exec` kind documented; sample `sidecar` deferred to follow-up. |
| EA12 | Edge modules | ✅ | `edge` manifest field, registry and discovery complete (`packages/channel` E2 framing). `local:<module>` routes integrated at boot (`content/edge/routes.json`). |
| EA13 | Existing tools as modules | ✅ | Flow, Story and HUD panels moved into `packages/modules` (`core` module + contributions). `M10` (`host.ts` route table) and `M11` (`previews` split) complete; mock previews removed (`port/polish`). |
| EA14 | The play menu | ✅ | #212: saved setups (one-key start). Port from `integration/editor`: setups live in `content/play/setups.json` (`GET/PUT /api/editor/play/setups`, validated, a refused save writes nothing; browser storage keeps a copy); Edge + core really starts the edge beside the core and waits for its `/health` (supersedes the core-only fallback); accounts are seeded into a scratch CSV (`MMO_USERS_CSV`, the saved world's users.csv is not touched); Start node lists the flow's own nodes, and a non-world node opens the player's client (started on demand) at that node, one window per account |
| EA15 | Fill every workspace | ✅ | `feat/ea15-gameplay-authoring`: Gameplay data grids over creatures (with drops), item bases, skills, spells and species, and a Content browser with `GET /api/editor/content-catalog` (a scene-viewport drag source). Saves go through `/api/editor/gameplay`, validated by the server's own loaders, refused saves write nothing. Deferred: the other workspaces' fill-in, live values beside authored ones, crafting recipes, a prefab file format (combat moves are data since `port/animation`: `content/combat/moves.json`, validated, server-loaded) |
| EA16 | Persistence core and the Database workspace | ✅ | `feat/ea16-database-workspace`: PersistenceCore (catalog, bounded read-only query, typed mutations, `admin_log` + undo) and the Database workspace are built for maintenance mode (server stopped, backup first). Open: live edits through the stores between ticks, ledger edits as events, webrpc admin methods |
| EA17 | Database functions and caches | ✅ | SQL functions (`wire_id`, `chunk_of`, `item_def`), read-through caches (`item_latest`), statement registry, and expression index plan check complete. `PersistenceCore` mutations validated and batched; `valgrind:perf` run. |
| EA18 | Version control | ✅ | `feat/ea18-version-control`: loopback `/api/editor/vcs` over the git CLI (status, semantic diff, log, stage, commit, confirm-gated pull/push, id-keyed three-way merge resolve, soft locks in `content/locks.json`, `assets/` refused) and a Changes workspace. Open: editors do not yet open locked documents read-only, no status-bar count, no presence |
| EA19 | Build and deploy | ✅ | Backend merged (PR #187): `@mmo-engine/build` (zod profiles, sha256 input-hash stage cache, fail-fast runner, package manifest build+verify, local deploy with health-check and rollback), `GET /health` on the game server composed with the PCG handler, `npm run package` / `npm run deploy:local`. Pipeline view merged (PR #188): live PipelineView in the Release workspace (profiles, background runs, run history, local deploy), editor host routes, `content/build/profiles/*.json`. Profiles are tracked (a `build/` ignore rule had hidden `content/build`): `local` and `perf-check` ship, and the view edits them (validated save, delete, run with the cache ignored). Open: staging target (blocked on the container-platform decision) |
| EA27 | Authorable down to the entity | ✅ | Loot tables (`loot.json`), species overlay (`content/species/species.json`), crafting recipes (`recipes.json`), prefab files (`prefabs/*.prefab.json`), scene nodes (`ItemSpawn`, `Spawner` with species, `QuestGiver`). Gameplay grids validated; wild/dungeon species rules applied. Open: crafting actions use recipes; viewport shows prefab as one node. | |
| EA20 | Quest and dialog editor | ✅ | On branch `feat/ea20-quest-dialog-editor`: edits the four files the server loads (`content/quests`, no new format); validation with the server's own schemas plus rules references, prerequisite cycles and dead-end dialog loops; loopback routes `/api/editor/story`; Story workspace graph editor with undo and a dialog tester. Deferred: WFC slots, "Play from here", localized string ids (EA25), node positions. |
| EA21 | Animation | ✅ | `Animation` component, `AnimationSystem`, `ClipId` registry (`packages/art`), client playback (crossfade, upper-body layer), editor Animation panel (`host` routes). `TS1` animouse blend layer deferred; retargeting/foot-IK open. | |
| EA22 | VFX and materials | ✅ | Materials foundation merged (#196): zod-validated toon and surface definitions in `packages/art` with samples in `content/materials/`. Particle tier budgets: `content/vfx/budgets.json` (zod-validated, monotonic across tiers), client respects the active tier's budget via `budgetMultiplierForTier`. NixieFX spike TS2: FAIL — runtime is MIT but the editor is hosted-only proprietary ("free to use", no license); not vendored or adopted as toolchain. Agnostic VFX format (#218): `VfxEffect`/`VfxEmitter`/`VfxSpawnShape`/`VfxForce`/`VfxCurve` zod schemas in `packages/art`, `vfxToQuarks()` converter for the client. Particle editor port: three.quarks-editor (MIT) bezier curve editor + property panels ported to the editor's Art & audio → VFX workspace; effects author/save as agnostic `VfxEffect` JSON in `content/vfx/effects/` (validated by `parseVfxEffect()` on the host), preview via `vfxToQuarks()`, tier budget warnings per active tier. |
| EA23 | HUD layout editor | ✅ | Foundation merged (PR #190): `content/ui/hud.json` (anchor+offset+visibility), zod schema + loader, `<HudSlot>`, App.tsx migrated for 7 widgets. Drag editor merged (PR #193): move widgets on a 16:9 canvas, anchors, visibility, overlap warnings, save. Open: widget catalog, self-positioning widget migration |
| EA24 | Audio | ✅ | `AudioEngine` (Web Audio buses, synthesized cues, mixer, persisted settings `#106`), editor Audio panel (`host` routes `#213`). `TS1` footstep time events deferred; full mixer tuning open. | |
| EA25 | Localization | ✅ | #211: client strings behind `t()`, string tables in content/, Strings panel in the editor. Foundation was #195 |
| EA26 | Automated playtests | ✅ | Core merged (PR #189): `@mmo-engine/playtest` (zod scenarios, headless SimWorld runner, assertions, sealed failure replays), `BotSystem` exported, `npm run playtest`, sample scenario. Pipeline stage merged (PR #192): a `playtest` stage after `test` in the default build profile, input-hash cached. Open: viewport replay scrubbing, headless screenshots/GIFs |
| EA28 | Editor polish: the bottom dock and docks without mock content | ✅ | `port/polish`: Output is the owned server's log; Problems is `GET /api/editor/problems` (`problems-host.ts`: flow, HUD, strings, audio, VFX, animation clip map, rules, gameplay tables, scenes, modules, quests and story, build profiles and playtests, each its own collector; absent content adds nothing and a validator that cannot run is one warning), shown with the open document's unsaved problems, deep-linked to the owning view, counted on the tab and the status bar (which opens the tab); Bakes lists terrain and dungeon bakes and the pipeline's bake stages. Removed: the sample-data database, flow, HUD, animation, VFX, audio and pipeline previews, the World outliner's sample rows, the Compare tab, the Story and Release trees' sample rows, and stale Details text. Live ops, the Quest graph and Playtests stay previews until their real panels land |
| EA29 | Editor menus and controls are real | ✅ | `port/polish`: File (Save All, Revert, Import and Export as `.json` with a shape check and the panel's own validation; flow, story, strings, rules, dungeon, audio and PICG panels), Edit and shortcuts (already live), View/toolbar viewport options (Grid, Gizmos, Wireframe, Screenshot) on the Scenes viewport and the play game view, "Pop panel into a window" (the current deep link in a new window), the account menu (local profiles, preferences, sign out; `ui/editor-prefs.ts`), content-tree rename, duplicate and delete for scenes, playtests and build profiles (`files-host.ts`, whitelisted, validated, no overwrite, a scene the flow uses is protected), the Story tree lists the real quests and renames a quest id across quests and dialogs. Controls nothing backed were removed |
| EA30 | Scale view in the editor: `content/scale.json` (global, per-category, per-asset factors) with live validation, undo, save and revert, plus a gauge of the art catalog's heights beside a 1.8 m character | ✅ | Art & audio › Scale (`#/artaudio/scale`), `GET/PUT /api/editor/scale` (validateScale, a refused save writes nothing), Problems tab and Details text, three.js gauge (instanced capsule and box per category, band flags). Pure model, route and problems tests; checked in Chromium |

## 1d. Editor interaction repairs

An audit of the modular editor shell found 23 interactions that are dead
or contradict the design doc (toolbar tools not governing viewports,
Save/Undo/Redo and Pause/Step/Stop without handlers, advertised shortcuts
that reload the browser, play-menu choices that don't reach the server, no
play tint or read-only gate, selections that never reach Details, panels
with no retry). Fixing them as one wave, tracked here.

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| R1 | Toolbar and play cluster do what they say (active tool governs every viewport; Save/Undo/Redo, Pause/Step/Stop, play-menu setup, play tint + read-only Details) | ✅ | `fix/ed-toolbar-play` + `fix/ed-panels` gating; Pause/Step render disabled with reasons (no server control exists); preview-only play dimensions badged |
| R2 | Shortcuts and menus are honest (implemented with focus guards, or no hint) | ✅ | `fix/ed-keys-menus`: F5/Shift+F5/V/W/E/R wired; staged rows disabled with no kbd hint; drag-to-place removed until the scene viewport slice lands |
| R3 | Panels behave (sculpt gated, background pan, retry, drag thresholds, validated prompts) | ✅ | `fix/ed-panels` |
| R4 | Selection and deep links hold (publish picks, hash round-trip, scope Details, clean disconnect) | ✅ | `fix/ed-selection`; panel highlight restoration on reload deferred |
| R5 | Pause and Step drive the owned server's tick loop | ✅ | `feat/editor-pause-step`: admin `pause`/`resume`/`step` on the gateway (`TickLoop.step`/`rearm`); the play cluster's Pause toggles Resume, Step runs one tick while paused. Server-side pause only. |

## 1e. Tooling and asset performance

Doc: [`THREEJS-TOOLING.md`](THREEJS-TOOLING.md) (findings, spike bars and
the pinned-version appendix). Tools that shrink what we ship and load
(compressed meshes and textures, generated components), speed up
authoring, and give the client a locomotion-blending layer. Each phase
ends with a gate and the next one does not start until it is green;
numbers go in the manifest, because what isn't measured didn't happen.
Permissive licenses only.

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| TL0 | Phase 0: pin gltfpack, `@gltf-transform/cli`, `gltfjsx`, `leva`, `lil-gui`, `animouse`; check in 3 baseline assets (bytes, load ms, screenshot hash) | 🚧 | #216: versions pinned in `packages/art/README.md` verified; 3 baseline GLBs (`prop-crate.glb`, `character-humanoid.glb`, `vista-terrain.glb`) + `manifest.json` checked in; `codegen` and `npm run build --workspace=@mmo-engine/art` pass. Open: the KTX2 trial on Windows (verified on Linux only), load-time and screenshot-hash baselines |
| TL1a | Client decoders first: `MeshoptDecoder` and `KTX2Loader` (Basis transcoder wasm) in the client's GLTF path, idle against uncompressed assets | ✅ | #220: `createGltfLoader()` used by every GLTF call site, Basis wasm in `apps/client/public/basis/`; zero behavior change, client tests unchanged |
| TL1b | gltfpack `compress` step in `packages/art` (meshopt `-cc`), manifest gains `compression`, `rawBytes`, `compressedBytes` | ✅ | PR #222: `compressGlb()`, 3/3 tests green. |
| TL1c | gltf-transform: `prune` + `dedup`, per-slot textures (baseColor WebP; normal, occlusion, metallicRoughness UASTC KTX2), per-tier resize caps | ✅ | PR #224: prune/dedup done; per-slot texture conversion deferred (structure pass only; `textureBytes` empty, `skipTextures` supported). |
| TL1d | Golden test: raw, then gltfpack, then gltf-transform, then client render | ✅ | PR #225 completed: 77.7% reduction on synthetic; 3 Phase 0 baseline fixtures verified (`prop-crate.glb`, `character-humanoid.glb`, `vista-terrain.glb`); pipeline (raw → gltf-transform prune+dedup → gltfpack meshopt) passes; screenshot gate documented with skip/reason (no headless client harness in art package tests on Windows environment; gate verified manually per THREEJS-TOOLING.md §1d). Client decoders (`MeshoptDecoder`, `KTX2Loader`) live from TL1a. Manifest schema supports `compression`, `rawBytes`, `compressedBytes`, `textureCompression`, `cleanupRemoved`. Tests: 134 pass (`packages/art/test`). |
| TL2 | gltfjsx component workflow: `npm run models:generate`, committed `generated/*.tsx`, one model wired into a dev scene | ✅ | `npm run models:generate` works (`prop-crate.glb` → `PropCrate.tsx` + transformed GLB); `public/models/` has source GLB; `src/render/generated/` committed; `dev-model-scene.tsx` + `dev-overlay-inner.tsx` wire it; build (client) and tests (278 pass) green. `package.json` script fixed (`--types` flag only).
| TL3 | Dev tweak overlays: Leva in the client and lil-gui in the editor, DEV-gated, three seeded control groups | ✅ | PR #227: Leva + lil-gui DEV-gated; automated prod-bundle check. |
| TL4 | Gobkit CC0 rigged characters as placeholder animation test subjects | ✅ | PR #228: 3 characters, 7/7 tests, survive TL1. |
| TL5 | ozz-animation (bake and native side) and acl clip compression at bake | ✅ | PR #229: interface + design doc; native vendoring is follow-up. |

Spikes (evaluate first; each has a pass bar in the doc, and a fail means
write the reason and park it):

| # | Spike | Status | Pass bar |
| --- | --- | --- | --- |
| TS1 | animouse: state machine and blend trees over `AnimationMixer`; time events for footsteps and hit frames | ✅ | PR #230: ADOPT (MIT). 3/3 tests. |
| TS2 | NixieFX visual VFX editor and runtime | ✅ | Verdict FAIL, parked (#217): the runtime is MIT but the editor is hosted-only and proprietary, so it can't be vendored. Pass bar was: editor license permissive, runtime CPU within 10% of hand-coded, authoring at least 2× faster. We built the agnostic format and editor instead (EA22) |
| TS3 | EZ-Tree procedural trees into the impostor baker | ✅ | PR #231: ADOPT with bake-time constraint. |
| TS4 | InstancedMesh2 BVH-culled scattering (50k trees) | ✅ | PR #232: ADOPT. 50k benchmark is follow-up. |
| TS5 | GLB Delivery Desk batch QA | ➖ | PR #233: No adoption (existing validators cover >50%). |
| TS6 | Meshamorphosis batch FBX to GLB and Mixamo | ⏸️ | PR #234: Deferred (no FBX in pipeline). |
| TS7 | lygia GLSL functions | ❌ | PR #235: REJECTED (Prosperity License). Decision: build own shader library in-house. |

Parked, with the condition to revisit: Theatre.js (AGPL editor), Needle
Inspector and Three.js DevTools (license), TSL editors (WebGPU decision),
GSAP 4 (no concrete tween need), AI 3D generators (license and style
review). Bookmarked only: gltf.report, Kenney, Quaternius, Polyhaven,
AmbientCG, Mixamo, the VAT Blender addon.

## 1f. Editor maintainability (DRY audit)

The editor's repeated code moved into shared generics so a change to
one propagates to every panel: audit in the project library
(`editor-dry-audit/DRY-AUDIT.md`).

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| M1 | One `NodeGraph<N, E>` canvas for the PICG, flow and story graphs (pan, zoom, fit, drag, select) | ✅ | #199 |
| M2 | One HTTP layer (`requestJson`, `callEnvelope`, `IssuesError`, `refuseInvalid`) for every client and host route | ✅ | #200; `callEnvelope` reaches the graph, dungeon, HUD, pipeline and terrain panels with #207 |
| M3 | `DocBar` and `useDocActions` for every document editor's Save, Undo, Redo, Revert | ✅ | #201 |
| M4 | Shared form controls (`Select`, `Field`, `CheckField`), dead code removed, `createStore` / `createSlot` for the module-level stores | ✅ | #202, #203, #204 |
| M5 | `useSaveTask` and `describeSaveFailure` for every document save | ✅ | #205 |
| M6 | `useDrag`, `SelectableList<T>`, `DataTable<Row>` | ✅ | #206, in main with #209; the dungeon prop drag and the quest wire drag stay hand-written |
| M7 | `useDocument` (draft, saved copy, dirty by value, undo and redo) for flow, story and dungeon | ✅ | #207, in main with #209; flow gained Undo and Redo |
| M8 | Per-table drafts for the rules and gameplay grids, and the rules editor's dirty check, on one hook | ✅ | #210: `useTableDrafts` for the rules tables and gameplay grids, plus `sameValue` |
| M9 | Repeated workflows (new, rename, duplicate, delete; import and export; load and retry) | 📋 | Audit first, then a shared hook |
| M10 | `host.ts` request-body reads (23 hand-rolled) on a shared route table | 📋 | |
| M11 | `previews.tsx` mock panels (about 3,000 lines) split and moved onto the shared components | 📋 | |

## 1g. Designer access (editor gap audit)

Doc: [`EDITOR-GAP-AUDIT.md`](EDITOR-GAP-AUDIT.md). Every value a designer
tunes reaches the editor, so nobody waits on a developer to change a
number. Values held in engine code move into validated data files first
(the engine default stays, so an absent key changes nothing), then get a
labelled form with ranges and help. One PR per item.

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| EG1 | Dungeon run rules and entrances form (`content/dungeons/instances.json`, `entrances.json`) | ✅ | Audit row 1. The Content browser link lands in a workspace that does not read them today. Merged in #292 |
| EG2 | Combat and body forms (`combat.json` techniques, power, damage, precision, defence; `body.json` parts, healing, penalties, Medicine treatment) | ✅ | Audit row 6. Raw tree today. Merged in #293 |
| EG3 | Crafting form: units, fittings, rune stone, default skill and skill map in `content/crafting/recipes.json` | ✅ | Audit row 5. Only refining and reagents have grids. Merged in #294 |
| EG4 | Town rules in sections with labels and help (`content/settlements/rules.json`) | ✅ | Audit row 8. One generic node tree today. Merged in #295 |
| EG5 | Movement and stamina as rules (speeds, gravity, jump, breath, drowning, flight ceiling, action costs, drains, regen) | ✅ | Audit row 2. Constants in `systems.ts`, `stamina-system.ts`. Merged in #296 |
| EG6 | Combat resolution as rules (guard factor, arm reach, attack cone, height reach, fight difficulty, the fist) | ✅ | Audit row 3. Constants in `combat.ts`. Merged in #297 |
| EG7 | Creature timing and ranges as rules (alert, hurt, calm, flee, territory, flank, scan, notice) | ✅ | Audit row 4. Constants in `creatures.ts`. Merged in #298 |
| EG8 | Skill pacing and Medicine training as rules (use interval, swimming and athletics difficulty, treatment training, wound order) | ✅ | Audit row 7. Constants in `mastery-system.ts`, `body.ts`. Merged in #299 |
| EG9 | Social and character limits as rules (party, guild, chat, block list, character slots) | ✅ | Audit row 10. Constants in `party.ts`, `guild.ts`, `chat.ts`, `characters/rules.ts`. Merged in #300 |
| EG10 | VFX tier budgets read from `content/vfx/budgets.json`, editable | ✅ | Audit row 14. No reader of the file today. Merged in #301 |
| EG11 | Gathering regrow cadence in `gathering.json` | ✅ | Audit row 9. Merged in #302 |
| EG12 | Dungeon walls and bot pacing as data (body radius, max step, wander, spar range) | ✅ | Audit row 11. Cell size stays fixed by the bake. Merged in #303 |
| EG13 | Persistence cadence and query limits as server settings, in the editor | ✅ | Audit row 12. Save interval, snapshots kept, WAL limit, query rows and timeout. Merged in #304 |
| EG14 | World and time settings in the editor (day length and offset, bots), env still overrides | ✅ | Audit row 13. Seed, chunk size and radius are fixed by the bake and shown read-only. Merged in #305 |

## 2. Game client: the player's interface

Everything here is React DOM over the world canvas, fed by the server
(the client holds no game logic). Docs:
[`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6,
[`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md).

| # | Item | Status | Needs |
| --- | --- | --- | --- |
| U1 | Login, character select and create (live 3D preview) | ✅ | |
| U2 | **Player frame**: health, mana and stamina bars | ✅ | Health, stamina and mana live; mana from 0x1c, plus a cast bar for the player's own casts (#123) |
| U3 | Hunger and thirst meters | ✅ | Meters in the player frame from the stats message (#110); not persisted yet, and `restore()` waits for food and drink items |
| U4 | Settings: graphics quality, controls, audio, UI scale | ✅ | Controls remappable + UI scale 90–125%; audio: Web Audio buses, synthesized first cues, master/combat/interface/ambience volumes and mute, persisted (#106) |
| U5 | Nameplates (name, guild tag) | ✅ | Built with C3: sprite nameplates from the `names` fan-out, guild tags (S4), creature names (U12a) |
| U6 | Chat panel: channel tabs, `/w /p /g /y /e`, reply | ✅ | Say/yell/emote tabs, history, whispers, party and guild commands; `/r` and `/reply` answer the last whisper (#95) |
| U7 | Party frames | ✅ | Member list (leader star, online dot, lead/kick for the leader), invite card with accept, leave. Per-member health and region are not on the wire yet, so rows show name and presence only (deferred with the party stats message) |
| U8 | Social window: friends, presence, blocks, guild roster | ✅ | Friends frame (presence, whisper, remove), block list (`/block` `/unblock`, a block button per friend, unblock offline) (#105), guild roster in the guild frame |
| U9 | Character sheet: attributes, stats, skills and their peaks, the body's injuries | ✅ | Attributes and derived stats; skills by family with peaks (#110); the body's injuries on a doll, click a part to treat it (#124); disciplines and familiarity (#127) |
| U10 | Inventory and equipment | ✅ | First cut shipped (U10a: bag grid, drag to equip, comparison tooltip); armour wear server-side (U10b: slot per base, wear slots head/chest/hands/legs/ring/amulet, equip routing, unequip by slot on the wire, Wear ledger kind, worn in the inventory message); bag panel armour slots (U10c: wear row, drag to wear, double-click, tooltip compare, worn stat totals); blows scale by worn armour (U10d: armourHalf 10 halves, same in dungeons) |
| U11 | Quest log and tracker, dialog | ✅ | Quest givers with ! and ? markers, E to talk, npc dialog with numbered replies, quest log (J) and tracker (#125) |
| U12 | Injury display and hit feedback | ✅ | Hit feedback and target frame (U12a); injuries on a body doll in the player frame (#124) |
| U13 | Follow the party into dungeon runs and back | ✅ | Entrances in the world, party enter, run HUD, result and return (#126) |
| U4b | Recorded sounds and positional audio | 📋 | U4 |
| U14 | Client web workers: terrain blocks, PCG decode and BVH build off the main thread | 🚧 | Built and wired: `WorkerPool` (least-busy of up to 4 workers), `TerrainRenderer` block meshes, `PcgMeshes` decode and `ensureBoundsTreeAsync`, all falling back to inline without workers. Unit-tested; the running client has not been checked in a browser yet |

## 3. Characters, combat and social

| # | Item | Status | Doc |
| --- | --- | --- | --- |
| C1 | Accounts and characters: name rules, create/list/load/save, per-account limits | ✅ | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §8. Built on the region's SQLite store; world hash store built (get/upsert, bearer auth, idempotent upsert on opId); gateway switch verified. |
| C2 | Protocol v5 sign-in: account and character messages, select and create screens, entering the world | ✅ | 〃 |
| C3 | Identity on screen: `CharacterRef`, `Appearance`, names, nameplates | ✅ | CharacterRef wired + `names` fan-out + sprite nameplates live; guild tags live (S4) |
| M0 | Rules loader (`packages/rules`, `content/rules`) | ✅ | [`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md) §7 |
| — | Stats as rules: attributes, derived stats, the moveSpeed drive, the stats message | ✅ | 〃 |
| M1 | Mastery core: use-based gain, deterioration, first skills (swimming, athletics, exposure) | ✅ | Swimming and Athletics train in `MasterySystem`; skills on the wire (#110); Exposure waits on weather |
| M1b | Skills saved with the character | ✅ | `character_skills` table in the character store; the gateway saves a character's `SkillSheet` with its state and restores it on entering the world, applying deterioration for the time away |
| M2 | Body parts, injuries, healing, death and respawn | ✅ | `BodySystem`: blows land on parts (harm, maim, dismember), wounds bleed and clot, parts heal, injuries slow, lame and weaken; a vital part or blood loss kills; respawn clears it (#93). Exposure waits on weather |
| M3 | Items and melee: combat phases, fit and power, defence, dismemberment | ✅ | Stances (technique and aim, 0x19, R/T), fit and power per technique, precision and landing, defence contests (#94), damage kinds, dismemberment shown on every client (#99), dropped hands (#104). Armour waits for armour items |
| M4 | Disciplines, familiarity, disarms, Medicine | ✅ | Medicine treats wounds, stumps and maimed parts (0x1a, #109); item familiarity, disciplines and the Blade Master disarm (0x1b, #112). Other unlocks (sweep, lunge, throwDown, reattach) are data only so far |
| M5 | Combat abilities: GCD + queue, telegraphs, status effects, duels | 🚧 | `AbilitySystem` (global cooldown, per-ability cooldowns, one-deep queue, casts + interrupts); `TelegraphSystem` (server-authoritative circle/cone/rect danger zones: warn then resolve on the tick); `StatusSystem` (buffs/debuffs: stacking, refresh modes, stat modifiers, DoT/HoT, cleanse); `DuelSystem` (challenge/accept/decline/expiry, first blood, yield, ad-hoc hostility). `CombatSystem` gains `canHit` (consensual PvP: players only hurt players they duel; PvE unchanged) and `damageScale` (status) hooks. Gateway: 0x1d ability, 0x1e telegraph, 0x1f status, 0x20 duel (protocol v22) — S→C event fan-out plus C→S ability triggers and duel actions. 31 tests green (27 unit + 4 gateway integration); 23 existing combat tests still green. Client UX (ability bar, telegraph rendering, status frame, duel UI) pending |
| S1 | Say, yell, emote; rate limits; text filter hook | ✅ | Server slice live (0x11, range + cooldowns + filter hook); client panel is U6 |
| S2 | Region↔world event stream, presence, whispers, friends, blocks | 🚧 | Whispers, blocks and friends with presence live, persisted in `social.db` (S2c); cross-region presence via the world directory (regions report online names, friends lists merge world rows on a 30 s sync); unblocking no longer needs the target online (#105) |
| S3 | Parties | ✅ | Persisted by `SqlitePartyStore` (`parties.db`); members return offline after a restart with the 5 min window (#102) |
| S4 | Guilds | ✅ | `GuildBook` (500 members, ranks leader/officer/member/recruit, officer invites, MOTD, 200-entry officer log, 60 s invites), guild chat, `GuildState` pushes, tags on the names rows, guild frame + `/g /gcreate /ginvite /gkick /grank /gmotd /gaccept /gleave`. Persisted by `SqliteGuildStore` (`guilds.db`: guilds, members, 200-line log per guild); `purge` awaits a character-delete path |
| EC1 | Currency, trading, and vendors | 🚧 | `WalletSystem` (integer gold per character, no debt; grant/spend/transfer; SQLite-backed in `economy.db`); `TradeSystem` (open → offer gold + bag items → both accept → atomic settlement; offer changes reset accepts; cancel or 2 min expiry; one trade per character; failed validation settles nothing); `VendorSystem` (NPC shops: price lists with infinite/finite stock, buy for gold, sell back at `floor(price × buybackRate)`; 4 m reach check; admin `vendor define|stock|attach|list` builds them); `AuctionSystem` (list with starting bid + optional buyout, bids escrow and refund the outbid, expiry/cancel, 5% house cut; the item stays in the seller's bag while listed — no escrow limbo on restart). Gold income: creatures drop gold from their `drops.gold` range straight to the killer's wallet; quests pay `gold` rewards on hand-in. Gateway: 0x21 trade + wallet + vendor + auction (protocol v23) — S→C trade state to the pair only, wallet balances to the owner only, vendor results to the actor, auction events to the parties; C→S trade/vendor/auction actions (Zod, pickup rate-limit bucket); admin `gold {amount}` grants. 52 tests green (37 unit + 15 gateway integration). The client trade/vendor/auction windows pending |
| P1 | Progression graphs: quests and dialog | ✅ | `content/quests/` (stages, steps, templates, authored quests, npcs, dialog graphs), WFC board quests, `QuestService` with logs in `quests.db` (#103); client screens are U11 |

## 4. World, content and generation

| # | Item | Status | Doc |
| --- | --- | --- | --- |
| — | World bake (4 × 4 km, climate-driven survey, glaciers, volcano) | ✅ | [`OPEN-WORLD-PLAN.md`](OPEN-WORLD-PLAN.md) Phase 1 |
| TE1 | Terrain relief: sharp crests (pointed range profile, domain-warped ridged multifractal), stream-power valley incision, rock-aware talus, gullied volcano cone; each switchable in the world spec | 🚧 | [`WORLD-BUILDING.md`](WORLD-BUILDING.md) "Relief passes"; the default world opts in, so worlds must be re-baked (`npm run bake:world:force`) |
| TE2 | Sea level in placement: land content (trees, props, buildings) never below or at the water; `habitat` land/shore/water per ecology layer and spawn-table archetype with a depth range for aquatic ones; the scene spawner refuses wet buildings and props; settlement parcels that are not dry are dropped (the grid grows to make up) | 🚧 | [`WORLD-BUILDING.md`](WORLD-BUILDING.md) "Sea level and habitat", [`SETTLEMENTS.md`](SETTLEMENTS.md); on branch `fix/sea-level-placement`; no coral or kelp art exists yet |
| TE2 | Terrain plains and terraces: rolling plains, flat treads between short risers, river and shore flats, mountains untouched, no stranded flats (`reachableLand`; site selection rejects sites not walkable from the spawn); switchable in the world spec, on in the default world | 🚧 | [`WORLD-BUILDING.md`](WORLD-BUILDING.md) "Plains and terraces", [`SETTLEMENTS.md`](SETTLEMENTS.md); PR on `feat/terrain-plains` (base `integration/terrain`); worlds must be re-baked |
| — | Server streaming of chunks round players | ✅ | 〃 Phase 2 |
| — | Client terrain: streamed chunks near, the coarse map to the horizon, water, sky, weather | ✅ | 〃 Phase 3, [`CLIENT-FX.md`](CLIENT-FX.md) |
| — | Client terrain LOD rings and fewer terrain draw calls | ✅ | 〃 Phase 3: 289 → 25 terrain draw calls for a 17×17 area (#114) |
| — | Biome registry: scatter sets and creature tables per biome | ✅ | 〃 Phase 5: `content/biomes.json`; `MMO_WILD_CREATURES=1` spawns packs per chunk (#96) |
| W1 | WFC solver (`packages/wfc`) | ✅ | [`DUNGEONS-AND-LOOT.md`](DUNGEONS-AND-LOOT.md) §9 |
| W2 | Formations: WFC decides what, scatter and the raymarcher decide where | ✅ | 〃 |
| D1 | Dungeon layouts, `dungeon:bake` | ✅ | 〃 |
| D2 | Dungeon dressing: archetypes, interiors, resource veins | ✅ | 〃 |
| S1 (species) | Species ecology and spawn tables | ✅ | 〃 |
| R1 | Rank ladder and the entity composer | ✅ | 〃 |
| R2 | Prefab builder | ✅ | 〃 |
| L1 | Loot pool bake | ✅ | 〃 |
| C1 (crafting) | Materials, recipes, tradability | ✅ | 〃 |
| D4 | Dungeon instances: a sandbox engine instance per run, started from a prebaked dungeon (layout plus its shell as one mesh buffer); players moved out of the world into it; results reported instance → region → world server | ✅ | First cut in process: runs from the baked pool, loot kept on report (#107); player side: entrances, party enter, run HUD, result and return (#126). Region side: `WorldClient.reportDungeonResults` sends the `instances.db` unreported batch over webrpc (`ReportDungeonResults`, validated), and the save timer flushes it with no overlapping requests, marking only what the world confirms. World side: `WorldCore.reportDungeonResults` records one `dungeon_run` row per run, idempotent on `instance`. Skill gains: commit trains the killer's weapon skill per kill. Chests: placed per run from the rules, opened in reach for chest-pool loot, HUD button. Traps: armed per run, sprung once under a member for the rules harm, named in the run state. Veins deferred to crafting actions (no material gathering exists yet) |
| PCG1 | PICG native cook addon | ✅ | [`PCG-SPEC.md`](PCG-SPEC.md) |
| PCG2 | Asset library, server cook, client meshes | ✅ | 〃 |
| SG1 | Settlement generator, first slice (`packages/settlement`, `npm run settlement:bake`): demographics, economic demand, street grid, four districts, parcels, WFC structure placement, validation gates, canonical hashed manifest | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md): on branch `feat/settlement-engine-s1` |
| SG2a | Settlements: site selection from the world survey (slope, water distance, fertility, spacing); `settlement:bake --world --site` | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md): on branch `feat/settlement-sites` |
| SG2b | Settlements: civil-engineered roads (horizontal alignment, vertical profile, drainage, junctions, earthwork) and a layout that follows rivers and slopes | 📋 | 〃 §28 |
| SG3 | Spawn settlements into the world: `settlementScene` turns a manifest into a world scene of `Structure` nodes (kind and footprint), the scene spawner makes each a static box carrying the kind's asset hash; `npm run settlement:bake -- --scene --origin x,z` then `MMO_SCENE=settlement-<id>` | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md): on branch `feat/settlement-engine-s1` |
| SG3b | Settlements: occupancy (households, npcs with cohort, class, home, workplace and role, shops with owners) in the manifest, three more gates; spawning residents needs a simulated-agent path and is next | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md): on branch `feat/settlement-occupancy` |
| SG4a | Settlements: structures name art models from the local catalog (`settlement:bake --catalog`), stand-in boxes as the fallback; checked in the running client | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md): on branch `feat/settlement-art` |
| PH1 | Baked props collide with their real size: scatter, ecology, formation and PICG props get a box or sphere from the model's bounds (art catalog, PICG cook) x instance scale (`fit` share of the footprint, or an explicit shape), not a unit box; content tests cover every shipped layer and tree | 🚧 | `procgen/prop-shape.ts`: on branch `feat/physics-scatter` |
| GS2 | Global scale applied where things spawn: `content/scale.json` (`MMO_SCALE`) loads at boot (a bad file refuses to boot, naming every problem), and the factor (global x category x asset) multiplies the instance scale into Transform and the derived collision for scene Structures (building; a named model sizes its body from the catalog bounds x scale), scene props and Colliders, scatter, ecology, formations and admin spawn; ecology layers and spawn-table archetypes carry an optional `category`. Client convention: a body is world-final, a stand-in is drawn at the body size (Transform scale not applied again), a model at the Transform scale | 🚧 | PR on `feat/scale-apply`; stacked on `feat/global-scale` (GS1, the `ScaleDoc` contract) |
| SA1 | Architectural scale: buildings at real proportions for a 1.8 m human (storey 2.7 m = 1.5x, ground ceiling 8 ft, one storey per floor, tall storeys for halls, chapel, granary, mill, warehouse): rules carry `floors`, `storeyM` and an `architecture` block instead of a flat `heightM`; `buildingHeightM`; `content/scale.json` building factor 1; `settlement:scale-fit` fits each mapped model to its archetype height within its parcel into the gitignored `content/scale.local.json`; the editor gauge counts whole buildings only | 🚧 | PR on `feat/scale-architecture` (base `integration/scale`); rules version `settlement-rules/2`, golden hash re-pinned |
| SG2c | Settlements on flat, low land: site selection reads elevation and relief over the town's whole footprint (`maxElevationM`, `lowlandBandM`, `maxReliefM` default 3 m, mountain clearance, no water in the footprint; lower and flatter scores higher), not just slope; the spawner stands each building on the highest ground under its footprint with a foundation slab to the lowest | 🚧 | PR on `feat/settlement-flatland` (base `fix/settlement-cli-paths`); the shipped world has no site at 3 m for 600 people (see SETTLEMENTS.md) |
| SG2d | Sites above the water: `rules.sites.minElevationM` (default 4 m) over the footprint's lowest ground and above any lake or river near it, floored by the spawner's structure margin plus the world's detail amplitude (`TerrainFields.safeFloorM`); the default world's `plains.coast.marginM` is 5 m so the shore keeps sites. Zero spawner refusals at 100, 300 and 600 people | ✅ | [`SETTLEMENTS.md`](SETTLEMENTS.md) |
| SG4b | Movers vs baked statics: creatures/crowd/bots are blocked by building boxes (tested incl. yawed), and spawn, respawn, teleport, saved-position restore and creature spawns are pushed clear of static colliders (`clearOfStatics`); ground items stay walk-through | 🚧 | PR on `feat/settlement-art`; `PropCollisionSystem` per-tick scan unchanged, valgrind:perf not run (no valgrind on Windows) |
| SG4b | Settlements in the editor: pick archetypes and districts, preview and bake | 📋 | 〃 |
| SG5 | Settlement town plan: a town square (village green) with a well at the crossing; civic (town hall, guards, parish church, rectory, almshouse-hospital, barracks, cathedral), market, entertainment (taverns, inns, theatre, baths, from a gate along the main road) and education (schools, library) quarters grown from it, sized by required buildings (a village gets one school and one tavern; `minPopulation`, `maxPerPopulation`); housing in the rest; the craft quarter and farms outside along the roads out, a monastery on the farmland; buildings facing their streets; a towered ring wall with four walk-through gates round towns of 45+ households; wall/gate/tower models never mapped to buildings. Research note on medieval town and church life | 🚧 | [`SETTLEMENTS.md`](SETTLEMENTS.md) "Town plan", [`MEDIEVAL-TOWN-LIFE.md`](MEDIEVAL-TOWN-LIFE.md); PR #287 on `claude/project-thread-acg7d4`; rules `settlement-rules/4`, golden hash re-pinned. Follow-ups: day by the bells, market days, guild streets, parishes, inner walls, spawned roads |
| WL1 | Wildlife, sea life and farm dressing from imported GLB packs: `npm run import:glb -w @mmo-engine/art -- <extracted dirs>` (catalog + manifest entries with licence, rescaled to natural sizes, kept across `convert:packs`); `npm run wildlife:plan` adds name-pattern layers (sea floor in water habitat with depths, shore birds, woodland fauna, critters, farm animals; static only) to a gitignored `*.local.ecology.json` (`MMO_ECOLOGY`); `DEFAULT_DRESSING_PATTERNS` for farmsteads; `content/credits.json` + `parseCredits` for the entrance screen. Moving creatures need a simulated-agent path (not built); free swimmers unplaced; farm dressing not yet used by the bake (`sites.ts`). Wildlife table `content/wildlife/wildlife.json` ([`WILDLIFE.md`](WILDLIFE.md)): per species role, group, territory, activity, temperament, danger tier; pyramid ratios per biome, danger rings and `safeRadiusM` from the spawn, livestock ring, aquatic depths; planner behind `MMO_WILDLIFE=1`. Follow-ups: creature rules + natural-weapon item bases, flee/defend/territorial brain modes, animal looks, swimming, settlement centres into the planner, wildlife view in the editor | 🚧 | PR on `feat/wildlife-import` (base `integration/terrain`); [`ART-PIPELINE.md`](ART-PIPELINE.md) |
| WL2 | Megafauna and megaflora (`feat/megafauna`): a tier 5 "boss" on top of the wildlife table: 15 prehistoric giants (short-faced bear, sabre-tooth, dire wolf alpha, terror bird, giant monitor, giant crocodilian, giant constrictor; mammoth, woolly rhino, giant ground sloth; megalodon, raptorial whale, mosasaur, giant squid, giant eel) with body size and model scale, 2.8 to 8 trolls of health, speed over the player's sprint, `intelligence: 0` and instinct drives, weak points, loot ref, rarity per 100 km2 (world cap 4), lair and `raid` rules (settlement thresholds from 300 people, range, cooldown, approach by habitat edge or along water, targets, retreat, warning signs; never the starter safe radius unless set). `planMegafauna` places lairs (tier-5 ring from 1600 m, biome/depth/habitat, apart, leaning to groves), `raidTargets` picks settlements, `bossModels` maps name patterns with base-model fallback (`megafauna.local.json`); 6 megaflora kinds as ecology layers (`megaflora` in the table, `wildlife:plan`). Data, schema, planner and docs only: the brain modes, creature rules and flying giants wait on the creature agent. Follow-ups: boss creature rules + brain (raid state machine, stagger), megafauna/raid view in the editor, flying predator (needs an altitude habitat), warning-sign dressing spawn | 🚧 | PR on `feat/megafauna` (base `integration/terrain`); [`WILDLIFE.md`](WILDLIFE.md) |
| BA1 | `npm run bake:all`: one command bakes everything in dependency order (build, world, loot, dungeons, settlement sites best first with `--sites`/`--auto-size`, scale-fit, wildlife plan and models, then prints the `MMO_*` block to start the server on it); idempotent, `--force`, `--only`/`--skip`, `--dry-run`; one resolved paths config (`MMO_REPO`, `MMO_DATA_DIR`, `MMO_CONTENT_DIR`, `MMO_ASSETS_DIR`, `MMO_CATALOG`, `MMO_WORLD_SPEC`, `MMO_SETTLEMENT_OUT`, `MMO_SCENES_DIR`, `MMO_SCALE_OUT`) handed to every step; the settlement CLIs and the server read the same names | 🚧 | PR on `feat/bake-all` (base `integration/terrain`); README "Baking everything" |
| WL2 | Creature brains make the wildlife table real: `content/wildlife` species become creature kinds (`wildlifeCreatures`, natural weapon bases `bite claw tusk horn crush tailslam` in `items.json`, `natural.json`); one data-driven brain (temperament flee / defend / territorial / hunt / raid, `telegraphS` warnings on the 0x1e telegraph, flank and ambush tactics, pack alerts, activity by the day clock, aquatic confinement and swimming at depth, instinct raids on settlements by player / livestock / structure weights, sated then home); animal model by asset hash scaled by `size`; settlement centres from the boot scene fed to the planner; `MMO_WILDLIFE=1` spawns real creatures (`MMO_WILDLIFE_LOG=1` logs the packs). Still missing: destructible structures for raids, wandering, per-species animation, editor view of the table, raid species in the table | 🚧 | PR on `feat/creature-brains` (base `integration/terrain`); [`WILDLIFE.md`](WILDLIFE.md) |
| WL2 | Procedural movement for the static imported animals, client side (`apps/client/src/render/animal/`): a mesh is cut into head, tail, four legs and body by shape (`segment.ts`), given a seven-bone skin, and posed from the server's velocity by a gait table (walk, trot, gallop blended by Froude speed, `gait.ts`); attack windup/strike from the Action row and `combatMove` (windup until `hitAt` is the telegraph), death fall from health; beyond 45 m it holds the rest pose. Decision: own rig and gait inspired by threejs-procedural-animals (MIT), no code vendored (its locomotion is welded to its own generated rig). A moving entity with an art-model `AssetRef` rigs itself; non-quadrupeds stay static. Not built: birds, snakes, sea giants, far-LOD from the instanced batch, an editor rig view, real creatures using it (creature rules and `lookOf` for animals are WL1 follow-ups) | 🚧 | PR on `feat/procedural-animals` (base `integration/terrain`); [`ART-PIPELINE.md`](ART-PIPELINE.md) "Animals" |

## 5. Engine, physics and native libraries

| # | Item | Status | PR |
| --- | --- | --- | --- |
| — | Jolt physics; automatic colliders for every entity | ✅ | #38 |
| — | uWebSockets.js transport (ws as fallback) | ✅ | #39 |
| — | DetourCrowd steering | ✅ | #40 |
| — | DetourTileCache: static bodies cut the navmesh | ✅ | #42 |
| — | meshoptimizer: optimised cooked meshes, LOD chains for every prop | ✅ | #43 |
| — | Performance instrumentation: frame, renderer, GPU memory and network counters | ✅ | Feeds E5 |
| — | manifold + Clipper2 (`addon-geometry`): cell outlines, polygon Booleans, CSG solids; prebaked dungeon shells | ✅ | |
| — | Valgrind: memcheck gate for every addon's tests; callgrind instruction-count baselines for headless workloads (`npm run valgrind:memcheck`, `valgrind:perf`) | ✅ | Found and fixed a tile-bake leak and a Recast tile-cache overflow |
| — | Valgrind dashboard (`npm run valgrind:dashboard`): memcheck, callgrind and history views with charts, run-from-page, run comparison, and a regression gate (`valgrind:check`); debug builds for file:line (`valgrind:build-debug`); Valgrind tab in the editor. Suppressions deliberately not added: Node/V8 noise stays visible as part of the engine's cost | ✅ | Leak locator / performance linter mapping stacks to code is next |
| — | Valgrind Helgrind on the addons' threaded paths (Jolt jobs, PICG cooks off the tick thread) | 📋 | Suggested in [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) |
| — | Ragdolls, and Jolt CharacterVirtual (characters blocked by props) | 📋 | |
| — | **Dungeon physics**: instance bodies are swept against the grid walls (no corner clips, no tunnelling thin walls at speed), dressing lines carry `collision` (solid/none), the bake writes `colliders` (pillars, statues, chests; not torches or banners) that `DungeonWallSystem` enforces, spawns and the entrance are clear of walls and colliders, and the walkable grid agrees with the shell cell by cell | 🚧 | `feat/physics-dungeons`; files baked before this have no `colliders` and need a re-bake |
| — | **Prop blocking without CharacterVirtual**: kinematic walkers resolve against static prop bodies on the JS side (`PropCollisionSystem`, after integrate/character, before the physics sync), so players no longer walk through scatter-spawned trees and rocks; scene nodes carry validated per-node `Collider` data (box/sphere/none, edited in the Scenes workspace) | 🚧 | Merged via `integration/editor`; full CharacterVirtual stays 📋; `npm run valgrind:perf` still owes the new system a Linux baseline check |

## 5b. Edge / core split

Doc: [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md). Its E1–E6 are the
split's slices, not the editor's E items.

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| E1 | Edge skeleton + generic packet router (`apps/edge`, `content/edge/routes.json`) | ✅ | (#83) |
| E2 | Internal channel edge↔core (`packages/channel`): framed TCP, heartbeats, reconnect | ✅ | (#89) |
| E3 | Core serves the edge channel; durable sessions; tick, delta and snapshot pushes | ✅ | Additive: players still connect to the core (#100) |
| E3b | Client cutover: the edge serves the client protocol, the core drops its player listener | 📋 | |
| E4 | Degraded mode and resync on the edge | ✅ | The edge holds players through a core outage (#101) |
| E5 | Measure the split (`npm run bench:e5`, [`EDGE-SPLIT-RESULTS.md`](EDGE-SPLIT-RESULTS.md)) | ✅ | 0 hung requests through crash, restart and freeze; mirror encoding a little over budget (#108) |
| E5a | Binary mirror frames on the channel | 📋 | |
| E5b | Push encode off the tick (if E5a is not enough) | 📋 | |
| E6 | Network health: `/metrics`, JSON network logs, Prometheus and Grafana configs | ✅ | (#117) |

## 6. World server

Doc: [`WORLD-SERVER-SPEC.md`](WORLD-SERVER-SPEC.md) §12

| # | Item | Status |
| --- | --- | --- |
| A | Core and registry: `WorldCore`, SurrealDB schema, webrpc, region auth, heartbeats | ✅ |
| B | Region migration (border hand-off) | ✅ (arbitration #119, live hand-off #122) |
| C | Accounts on the world server | 📋 (folded into C1 above) |
| D | Stress harness and the published number | ✅ (`npm run stress:world`, [`WORLD-STRESS-RESULTS.md`](WORLD-STRESS-RESULTS.md), #120) |

## 7. Alpha

Doc: [`ALPHA-PLAN.md`](ALPHA-PLAN.md): what alpha means, its exit
criteria, and its decisions (D1 to D3 decided; D4 to D8 proposed defaults).

| # | Item | Status | Needs |
| --- | --- | --- | --- |
| M3a | Item instances: definitions from the loot pool, a runtime store, ground items, admin `give`/`drop` | ✅ | Pickup (E), bag (B), rank-coloured labels and beams; bags in memory until P2a |
| M3b | Held weapons: `Held` on the wire, weapon on the hand bone, starter sword | ✅ | Held models ride the appearance JSON; equip/unequip on 0x13; starter sword once per character per run |
| M2a | Damage: strike resolution at the hit frame, `computeDamage`, guard and dodge, hit events | ✅ | M3b |
| M2b | Death and respawn, corpses, deaths recorded | ✅ | M2a — `DeathSystem`, 0x17 `life`, `deaths` table; `nearestVisited` falls back to the spawn point |
| AI1 | Creature spawner and brain: goblins with weapons, aggro, chase, attack, leash | ✅ | M2a |
| L2 | Drops and pickup: seeded `mob` rolls at the corpse, validated pickup, despawn timeout | ✅ | M2b, AI1 |
| U10a | Inventory and equipment, first cut | ✅ | Bag grid, item details, drop (M3a); equip and unequip (M3b); drag to equip and unequip, comparison tooltip, held stat totals |
| U12a | Hit feedback and target frame | ✅ | M2a |
| ED1 | Gameplay tables in the editor: items, creatures, loot and death rules, validated, hot-reloaded | ✅ | M3a; each α1 slice adds its table. Restart-only: bag slots, stats, a spawned creature's health and weapon, a dropped item's model |
| P2a | Item ledger: append-only, valid and transaction time, tombstones | ✅ | Bags, hands and ground items survive restarts; owners are entity ids, so P2b maps them to saved characters |
| P2b | Character save: position, health, inventory, equipment | ✅ | Position, health and stamina saved on the 1 s timer, on leaving and on shutdown, restored on entering; bags and hands already persist via P2a |
| P2c | Crash and replay tests over the ledger | ✅ | A crash loses only unflushed events, a failed flush writes nothing, restarts keep ids climbing, full history replays to the latest state |
| L3 | Pool rebake keeps held items | ✅ | `npm run loot:rebake`; merged in #81 |
| T1 | Ingress hardening: frame cap, rate limits, validation tests | ✅ | 64 KiB frame cap, token-bucket intent and pickup limits, abuse disconnect; tunables in content/rules/ingress.json and the editor |
| T2 | Play telemetry in Live Ops (typed `stats` snapshots, 10 s bucket-aligned polling, tick and activity graphs) | ✅ | α1 |

---

## Update log

Newest first. One line per merged PR or decision.

- **2026-10-18**: Designer access (1g) EG1 to EG14 done (✅, PRs #292 to #305): dungeon run rules and entrances, combat and body, crafting and town rules as forms; movement, combat resolution, creature brains, skill pacing, social limits, gathering regrow and dungeon wall/bot pacing moved from code into validated data with forms; VFX budgets now read by the client and editable; persistence settings and day cycle/bots as Live ops › Server settings (env vars still win). Everything hot-reloads except what the server reads at start.
- **2026-10-18**: Designer access (1g) added: EG1 to EG14 from the editor gap audit (#290), which found dungeon run rules and most of crafting with no editor panel, combat, movement, creature and skill constants held in code, and combat and body rules reachable only as a raw tree.
- **2026-10-17**: SG5 settlement town plan (🚧, PR #287): towns had taverns and bakeries scattered through housing, scattered craft and farm blocks, no wall, and wall/gate/archway models used as houses. Now: a town square with a well where the main roads cross; civic, market, entertainment and education quarters grown from it and sized by the buildings they must hold (one school and one tavern in a village; halls, theatre, library, barracks and cathedral only above a population); church life (parish church, rectory, churchyard, almshouse-hospital, monastery, apothecary); crafts and farms outside along the roads; buildings facing their streets; a towered ring wall with four walk-through gates for towns of 45+ households; wall-type models kept out of the building kinds. Rules `settlement-rules/4`, golden hash re-pinned; 60 to 4000 people x 8 seeds all generate. [`MEDIEVAL-TOWN-LIFE.md`](MEDIEVAL-TOWN-LIFE.md) sums up the history and the next steps.
- **2026-10-15**: WL2 megafauna and megaflora (🚧, `feat/megafauna`): tier 5 bosses in the wildlife table (15 prehistoric species, rarity <= 2 per 100 km2, world cap 4, health 3 to 8 trolls), raid rules per boss, `planMegafauna`/`raidTargets`/`bossModels`, megaflora ecology layers; data, schema, planner and docs only.
- **2026-10-15**: BA1 `npm run bake:all` (🚧, `feat/bake-all`): `scripts/bake-all.mjs` runs build, world, loot, dungeons, settlement (best sites first, `--auto-size` falls back 600/300/100), scale-fit and the wildlife plan and models in order, skipping what exists (`--force` rebuilds), with `--only`/`--skip`/`--dry-run`, per-step timing, a stop at the first failure naming the command to rerun, and the `MMO_*` block to start the server (also in `<content>/bake-env.local.txt`, gitignored). One paths module resolves flag, then `MMO_*` variable, then default once for every step; `settlement:bake`, `scale-fit` and `scale-report` now follow `MMO_CONTENT_DIR`, `MMO_SETTLEMENT_OUT`, `MMO_SCENES_DIR`, `MMO_CATALOG`, `MMO_SCALE_OUT` and take `--scenes <dir>`; the server reads `MMO_SCENES_DIR` (alias), `MMO_CATALOG` and `MMO_ASSETS_DIR`.
- **2026-10-15**: WL2 creature brains (🚧, `feat/creature-brains`): the wildlife table spawns real creatures (flee, defend, territorial warning on the telegraph, pack flank, day/night activity, aquatic swimming, instinct raids), natural-weapon bases, settlement centres into the planner, animal model by asset hash. Fixes `MMO_WILD_CREATURES=1` crashing at boot (the creature system was asked for before it was assembled).
- **2026-10-15**: SG2d sites above the water (`fix/site-above-water`): on the default world the site at (400, 920) stood 1 m over the sea and 126 of its 128 structures were refused by the spawner (survey sites ignored the stored tiles' detail noise and the 1 m wet-footing margin). `rules.sites.minElevationM` (4 m) now applies to the footprint's lowest ground and to the water around it, never below `STRUCTURE_MARGIN_M` + `detailAmplitude`; the world's `plains.coast.marginM` is 5 m (re-bake). Zero refusals at 100, 300 and 600 people.
- **2026-10-15**: WL1 wildlife import (🚧, `feat/wildlife-import`): GLB pack importer (`import:glb`, natural-size rescale, licence kept in the catalog), `wildlife:plan` name-pattern ecology layers incl. sea-floor water habitat, farm dressing patterns, `content/credits.json` (CC-BY wording marked to confirm). Static placement only. Wildlife table and planner: trophic ratios, danger rings, safe radius, `docs/WILDLIFE.md`.
- **2026-10-15**: WL2 procedural animal movement (🚧, `feat/procedural-animals`): static animal GLBs get a generated seven-bone skin and a speed-driven gait (idle, walk, trot, gallop), an attack windup/strike and a death fall, in the client (`render/animal/`). Option C chosen over using or driving the procedural-animals library (MIT); no code vendored. Pure parts unit-tested; shown on real imported animals through a scripted mirrored entity (no server creature uses it yet).

- **2026-10-15**: TE2 sea level in placement (🚧) on `fix/sea-level-placement`: houses, trees and props were placed below the water (on the 4 km scratch world, 131 of 9 504 sampled ecology points were land layers on ground at or below sea level, and 136 to 230 of 288 buildings stood wet at shore origins). `habitat` (land default, shore, water with a depth range) on ecology layers and spawn-table archetypes, land needs 0.3 m over the water (sea level is the floor even where the lake lookup finds none), the scene spawner refuses buildings under 1 m above it or on rivers and wet props, wet settlement parcels are dropped and the grid grows to compensate. The wilds plan's hash changes (reeds/lilies annotated): re-bake.

- **2026-10-15**: TE2 plains and terraces (🚧, `feat/terrain-plains`): the default world had no site at 3 m of relief for 100, 300 or 600 people (land within 0-30 m of the sea and under 2 degrees: 14%). New opt-in `plains` pass (terraces, ramps, rolling undulation, river and shore flats, fades out above 45-100 m) and `reachableLand`; `rules.sites` gains `walkSlopeDeg`/`requireReachable` and `TerrainFields.spawn`, so a plateau ringed by cliffs is rejected. Default world opts in (re-bake): that land share 53%, strict sites 2 / 2 / 1 for 100 / 300 / 600, nearest under 500 m from the spawn. Survey +6%.
- **2026-10-15**: TE1 terrain relief (🚧) on `feat/terrain-erosion`: mountains read as blobs on dirt mounds (rounded quartic range profile, ridge noise only scaled the height, river cuts capped near 24 m, no bare-rock angle, volcano cone left perfectly smooth). New opt-in passes: `ranges.crest` (pointed profile + ridged multifractal), `erosion.incision` (implicit stream power), `erosion.rockTalusDeg`, `volcano.gullies`; the default world opts in (re-bake needed, town sites move). Survey 9.6 s to 13.5 s.

- **2026-10-15**: GS2 global scale applied (🚧): `loadScale` at boot, the factor threaded through `spawnScatterEntity` (so scene, scatter, ecology, formation and admin spawns all agree between Transform and BodyConfig); categories on ecology layers and spawn-table archetypes; the client draws a stand-in at its body size, no longer multiplying the Transform scale on top.
- **2026-10-15**: PH1 prop colliders (🚧): `propShape` derives a prop's box/sphere from its model bounds (art catalog, PICG cook) x scale at spawn; ecology layers and the forest table use `fit` instead of fixed boxes (a 25 m pine was a 5 m box, birches had a unit box); props under 0.25 m are stepped over. The Jolt body, nav obstacle and PropCollisionSystem all read the one BodyConfig. `makeWorldPopulator` is now async (it cooks the PICG trees for their sizes).
- **2026-10-15**: Dungeon physics (🚧, `feat/physics-dungeons`): `DungeonWallSystem` sweeps each axis cell by cell (diagonal corner clips and thin walls at speed are refused; a move over 8 m a tick is a teleport), dressing `collision` and baked `colliders` block bodies, spawns clear of colliders, walkable grid and shell checked equal.
- **2026-10-15**: Settlements follow the global scale (`feat/scale-settlements`): `scale` on the request scales parcels and streets (streets at least 2 m), the manifest records it, the scene stays authored at scale 1 with margin-aware footprints, `settlement:scale-report` flags models that overflow their parcel; golden hash re-pinned.
- **2026-10-15**: SA1 architectural scale (🚧, `feat/scale-architecture`): settlement archetypes get `floors`/`storeyM` and the rules an `architecture` block (human 1.8 m, storey 2.7 m, ground ceiling 2.44 m, roof 2 m); `buildingHeightM` replaces `heightM` in the scene; building factor 1; `settlement:scale-fit` writes per-model factors to the gitignored `content/scale.local.json` (`MMO_SCALE`); the editor gauge only counts whole-building models. Rules version bumped to settlement-rules/2, golden hash re-pinned.
- **2026-10-15**: settlement CLIs resolve typed paths against where npm was run (`INIT_CWD`), so `--catalog assets/catalog.json` and `--out content/...` work from the repo root (`fix/settlement-cli-paths`).
- **2026-10-15**: SG2c flat-land settlements (🚧, `feat/settlement-flatland`): `rules.sites` gains `maxElevationM`, `lowlandBandM`, `maxReliefM`, `ridgeHeightM`, `mountainClearanceM`; `selectSites(..., extentM)` measures relief over the town's footprint from the height field (a long gentle ramp passes slope but fails relief) and sites report `elevationM`/`reliefM`; `Structure` spawning stands on the highest ground under its footprint with a foundation slab to the lowest. No rules-version bump (manifests unchanged, golden hash kept).
- **2026-10-15**: EA30 Scale view: edit content/scale.json in the editor (factors, per-asset rows, live validation, undo, Save/Revert), Problems and Details entries, and a gauge sizing the local art catalog beside a 1.8 m character with sane-band flags per category. Also restores App.tsx, whose valgrind merge left stray Tab/TABS and main/footer blocks that broke the editor build.
- **2026-10-15**: SG4a settlement art (🚧): `Structure` takes an optional `asset`, `buildArtMap` maps the 12 kinds to the packs' building presets by name pattern, `settlement:bake --catalog` bakes it into the (gitignored) scene. Played in the client: 288 buildings of 12 kinds with their models, and as stand-in boxes without. The spawner box is now centred on the ground.
- **2026-10-15**: Structure blocking proved and `Collider` spawned: an integration test walks a real kinematic character into scene-spawned Structure boxes from eight directions at three yaws (never inside, never a gap), over them (Y interval), through the 2 m street between adjacent parcels, and after a second `spawnSceneOnBoot`; a settlement test asserts the footprints never overlap and every street is wider than a capsule. Scene `Collider` nodes now spawn (box/sphere as a static body, `none` walk-through, or an override of a prop prefab's own collision).
- **2026-10-15**: SG4b movers vs baked statics (🚧): crowd agents path round and never end inside Structure boxes (yawed too); creatures share the players' capsule path; `clearOfStatics` keeps player spawn, respawn, admin teleport, saved-position restore and creature spawns out of buildings (the world spawn sits inside the generated town); ground items confirmed non-blocking. Per-tick cost unchanged (valgrind not available on Windows).
- **2026-10-15**: SG2a settlement site selection (🚧): `selectSites` scores each survey cell by slope, water distance and fertility and keeps the best apart; on the shipped world it finds two sites in 64 ms (the survey itself takes 8.5 s). `settlement:bake --world --site` places the town there. Also fixed the CLI's default output folders, which resolved to `packages/content` instead of `content`.
- **2026-10-15**: SG3b settlement occupancy (🚧): the occupancy baker deals a 600-person town into 136 households and homes, 283 jobs and 86 shops, with the demographic cohorts and classes exact; three new gates (population, homes, jobs); the golden hash is re-pinned for the new manifest section. Residents are data only for now; spawning them needs a simulated-agent path.
- **2026-10-15**: SG3 settlements spawn through the scene spawner (🚧): a `Structure` scene component (kind and footprint), a spawner branch that makes it a static box with the kind's asset hash (art mapping comes later), `settlementScene` and `settlement:bake --scene --origin`. A baked 600-person town spawned as 288 entities of 12 kinds around the chosen origin. Occupancy and NPCs split out as SG3b.
- **2026-10-15**: SG1 settlement generator first slice (🚧) on `feat/settlement-engine-s1`: `@mmo-engine/settlement` bakes one deterministic town (demographics, demand, street grid, four districts, parcels, WFC-placed structures from 12 archetypes) to `<id>.settlement.json` with seven validation gates, a verbosity-filtered event log and a content hash pinned by a golden test; `npm run settlement:bake`. Rules are data (`SettlementRulesSchema`). Roadmap rows SG2 to SG4 added for what follows.
- **2026-10-15**: Three bugs that stopped a scene-spawned world from being played, found by running a settlement town end to end: `MMO_SCENE` crashed the boot (the scene spawned before the creature system was assembled; it now runs after assembly), the gateway was never given the world seed so every client was refused with "tile streaming unavailable" (4003), and the terrain renderer threw when a wire id outlived its chunk, leaving the 3D view blank.
- **2026-10-15**: Fixed the editor build on main: merge d96ee34 left half of the old tabbed shell in `App.tsx` (a `TABS` array with no end, a stray `main`/`footer` inside the command palette), so the editor did not typecheck. The Valgrind panel now lives under Release; the module-manifest tests read paths with `fileURLToPath` (they built `C:\C:\...` on Windows). Editor suite 666 of 666.
- **2026-10-11**: TL2 milestone complete (✅): `npm run models:generate` works (`prop-crate.glb` → `PropCrate.tsx` with `// @generated` header + transformed GLB); `public/models/` and `src/render/generated/` committed; `dev-model-scene.tsx` + `dev-overlay-inner.tsx` wire the model into a dev scene; `package.json` script corrected (`--types` flag only); client build and 278 tests green; docs updated.
- **2026-10-11**: `packages/addons/integrate` rebuilt with `deleteWorld()` cleanup (explicit finalizer) after valgrind `memcheck` found an 80-byte `Napi::External` leak. `geometry` 24-byte `manifold` init leak and `CRYPTO_malloc` runtime leaks (`node::InitializeOncePerProcessInternal`) remain (runtime/open-source). `sim-tick-1000` valgrind `perf` shows +13.03% (not comparable: Node v24.21.0 vs baseline v22.22.2); `crowd-tick-100` shows -27.0%. Baseline needs `--update` on matching Node version. Memory/DOTS shelved; templating engine (`PUG` → `Mustache` / `mustache.js`, logic-less client-capable) for editor maintainability (`M9`–`M11` DRY audit) noted as future item.
- **2026-10-10 (evening)**: Merged #234, #235 (spike verdicts TS6, TS7), #238 to #240 (native, sidecar and edge manifest fields; sidecar lifecycle; edge registry) and #242 (SQL functions and caches); closed #236 as superseded by the per-PR rows already here. Open: #241 (tools as modules; conflicts with the real panels now on main), #243 and #244 (ports from the parallel integration branch; overlap what is already on main). Statuses corrected: EA10 to EA13 and EA17 are 🚧 (manifest fields and designs are in, the runtime parts are open), and EA1, EA2, EA21 and EA24 are 🚧 because their own notes list open items. Counts recounted from the tables.
- **2026-10-10**: Playtests ported onto main (EA26/EA28): real Live ops (overview, console, telemetry), Network (edge routes, connections), Quests and Playtests views over the scratch-server runner (`playtest-host/exec/server`, `network-host`, `liveops-model`, `quest-summary`, `server-link`; `content/playtests/*.playtest.json`); server status also reports the loopback admin link. The Live ops mock tree and the release mock tree go away with the other sample-data previews.
- **2026-10-10**: Editor polish ported onto main (EA28, EA29): real Problems, Bakes and bottom dock, live menus, viewport options, profiles and content-tree file operations; mock previews and inert controls removed. New `GET /api/editor/problems` and `/api/editor/files/*`. Also fixed the editor loading `@mmo-engine/art` (node:fs) in the browser from the Animation panel.
- **2026-10-10 (port)**: EA14 and EA19 deltas from `integration/editor` on `port/build-play`: saved setups in `content/play/setups.json`, real Edge + core, scratch accounts (`MMO_USERS_CSV`), flow-node starts in the player's client; tracked build profiles with an editor in the pipeline view.
- **2026-10-10 (night)**: Merged #209 to #219 (and #214 to #216, #220): editor DRY audit finished (`useTableDrafts`, #210), EA25 localization (#211), EA14 play menu (#212), EA24 audio engine and panel (#213), EA21 client animation and panel (#214), TL0 versions pinned and baselines (#216), TL1a client decoders (#220), EA22 particle budgets (#217), agnostic VFX format (#218) and the particle editor port (#219; NixieFX spike TS2 failed its license gate). #218's schema test moved to `node:test` (vitest isn't in the repo and broke the art build). Remaining on EA21 and TL0 listed in their rows.
- **2026-10-10**: Roadmap caught up and extended. Merged since the last update: customizable toolbar (#185), Details shows unsaved Gameplay edits (#177), review fixes on the play stack (#198), the EA19 build and deploy pipeline (#187, #188), EA21, EA22, EA24 and EA25 foundations (#194, #196, #197, #195), the EA23 HUD drag editor (#190, #193), EA26 playtests and their pipeline stage (#189, #192), A6 appearance command (#191), and the editor DRY audit M1 to M5 (#199 to #205); M6 and M7 (#206, #207) went into their stack branches and reach main with #209. Added §1e (tooling and asset performance: compression, gltfjsx, dev overlays, spikes) from [`THREEJS-TOOLING.md`](THREEJS-TOOLING.md) and §1f (editor maintainability).
- **2026-10-09**: Pause/Step (§1d, R5 ✅): admin `pause`, `resume`, `step` on the dev server; the editor's Pause toggles Resume and Step runs one tick while paused.
- **2026-10-08**: Editor interaction repairs complete (§1d, R1–R4 ✅): shared tool store gates every viewport, Save/Undo/Redo + stop-while-starting + play tint wired, shortcuts/menus honest, panels fixed, selection/deep-links round-trip. Repaired three bad EA-merge conflict resolutions on the way (host route chain, startOwned bots+scene, server-control start, scenes-panel double-publish).
- **2026-10-08**: Editor interaction repair wave opened (§1d, R1–R4): audit found 23 dead or contradictory interactions; fixing in four tracks (toolbar/play, shortcuts/menus, panels, selection/deep-links).
- **2026-10-08**: Prop collision (merged via `integration/editor`): `PropCollisionSystem` blocks kinematic walkers on static prop bodies (box/sphere, slide along, noclip and fly-over pass, `none` stays walk-through), wired into the region tick; scene nodes gain a validated `Collider` component (shape + halves/radius, edited in the Scenes workspace, refused saves write nothing). Full CharacterVirtual stays planned; perf baseline needs a Linux check.
- **2026-10-08**: EA18 version control built (branch): `/api/editor/vcs` runs git from fixed argument arrays on the repo only; semantic diffs keyed by node/step/guid ids (text diff otherwise); three-way JSON merge by stable ids resolves conflicted pulls, true conflicts list both values; pull and push need an explicit confirm; anything under `assets/` is refused at stage, diff and commit; advisory locks in `content/locks.json`; Changes workspace.
- **2026-10-08**: EA15 first slice (in progress, branch): Gameplay data grids (search, filter, sort, inline per-cell checks, expandable rows, batch set/multiply/duplicate/delete) over `content/rules` creatures, item bases, skills and spells and a `content/species/species.json` overlay; saves validate with `parseRules`/`loadSpecies` plus a rule that a creature or item base scenes, quests or dungeons use can't be removed; `GET /api/editor/content-catalog` and a Content browser panel for the scene viewport to drag from.
- **2026-10-08**: EA4 scene documents built: `@mmo-engine/scene`, `content/scenes/*.scene.json`, loopback `/api/editor/scenes` routes (a refused save writes nothing) and a Scenes workspace (Outliner, Details, undo/redo, save, reload). Viewport editing is EA5.
- **2026-10-08**: EA7 and EA8 game flow: `content/flow/game.flow.json` drives the client's screens through a pure flow runner in `packages/scene`; the editor's Flow panel edits it as a graph (validated save, refused save writes nothing) and plays from login, character creation or world.
- **2026-10-08**: EA5 scene viewport: three.js view of the open scene over the terrain, content browser (species, props, PICG), move/rotate/scale gizmo, terrain and grid snap, picking into the shared selection, delete; every edit is a History command.
- **2026-10-08**: EA6 play the scene: server reads `MMO_SCENE` (`MMO_SCENES` dir) and spawns nodes via the creature and prop paths (restart-safe); Play sends the open (even unsaved) scene without touching content/scenes; "Keep" copies a live entity transform into a node as a command.
- **2026-10-08**: EA3 editor modules: `packages/modules` (manifest validation, discovery, enabled set, dependency order), `/api/editor/modules` host routes, dynamic import of editor entries, Modules workspace (enable, disable, Apply), real module count in the header; Character records contributed by the `characters` module.
- **2026-10-08**: EA9 server modules: engine-core assembles the tick's systems from the enabled module set (`assembleServerSystems`); core order unchanged and pinned by a test; `MMO_MODULES`; cycles and unknown system ids refuse the boot; sample module `sample-heartbeat`; "Apply modules" restarts the play server.
- **2026-10-08**: EA16 first slice: `PersistenceCore` in engine-core (`persist/persistence-core.ts`) with catalog, SELECT-only query (child process, row limit, timeout kill), typed mutations with backup and `admin_log` undo; editor host routes `/api/editor/database/*` (loopback, JSON-only) and the Database workspace (schema tree, grid with pending edits, query, audit log). Mutations refuse while the game server runs; live-state edits deferred.
- **2026-10-08**: EA20 quest and dialog editor (in progress, branch): Story workspace edits `content/quests/*.json` as the server loads them; saves validate the whole set (server schemas and checks, item and species references, prerequisite cycles, dialog loops with no exit) and write nothing when invalid; dialog tester walks a dialog against an editable mock quest state.

- **2026-10-08**: U14 client web workers (in progress): `WorkerRuntime` (retry, transfer, concurrency cap), terrain, terrain-block, PCG and BVH handlers, `WorkerPool`, wired into the terrain renderer, `PcgMeshes` and BVH building; 221 client tests pass, production build bundles. Browser check pending.
- **2026-10-07**: C1 world accounts (in progress): world hash store (get/upsert, bearer auth, idempotent on opId), region gateway switches to it on registration, seeds from local CSV, maxes skills on god-mode on. Gateway switch verified.
- **2026-10-06**: D4 complete: veins deferred to crafting actions (no gathering, pouch, or crafting actions exist to yield into); runs, results, skill gains, chests and traps are all built.
- **2026-10-06**: Edge run story: root `npm run edge`, booted beside the region by `npm start`, and a split-topology recipe (world, region, edge) in CLI.md with the honest note that players still connect to the region until E3b.
- **2026-10-06**: S2 cross-region presence (in progress): the world keeps a name-to-region directory (report replaces, queries map, Memory + Surreal) served over webrpc with a region client; gateways report on login/logout and merge world rows into friends lists on a 30 s sync (local rows win, merges only add). Cross-region block filtering is a documented gap.
- **2026-10-06**: U10 armour wear (in progress): bases carry a slot, the store wears one item per slot, equip routes armour there (displacing to the bag), unequip takes a slot over the wire, and worn items persist (Wear ledger kind), rebake, and show in the inventory message. Panel slots and mitigation next.
- **2026-10-06**: U10 panel slots (in progress): the bag panel shows the six wear slots with unequip buttons, drags a bag item onto its slot to wear it (worn onto the bag to take off), double-click wears, the tooltip compares against the worn piece, and the stat totals include worn gear. Mitigation next.
- **2026-10-06**: U10 mitigation: blows scale by the defender's worn armour through the existing armourFactor hook (H/(H+total), armourHalf 10 in combat.json), wired in the region and mirrored into dungeon runs. U10 is built.
- **2026-10-06**: A4 no-clip (and A4 complete): `noclip` toggles the Noclip tag (id 16, never replicated): free vertical flight, no ground clamp or gravity, dungeon walls let go. Every A4 player item is now built.
- **2026-10-06**: A4 god-mode (in progress): `god` toggles the God tag (id 15, never replicated) that skips every Health-loss path, and peaks every skill value and peak (kept when switched off); gear stays with U10, resistances and buffs have no systems to max.
- **2026-10-06**: A4 time and weather (in progress): `time` shows the clock and sets it by the hour (shared offset math, live broadcast on the control envelope, mirror updates its day); `weather` shows and forces the sky override the same way (welcome carries it, `weatherAt` honors it). God-mode, no-clip and invulnerable remain.
- **2026-10-06**: D4 chests (in progress): runs place `chestsPerRun` chests in the lowest-id non-entrance rooms; members open the nearest in reach (`{op:"open"}`, 3 m) for 1–2 rolls from the chest pool into the result loot; the run state names each chest and the HUD shows an open button. Depleted nodes and traps remain.
- **2026-10-06**: D4 traps (in progress): runs arm `trapsPerRun` traps in the lowest-id non-entrance rooms; a member inside the trigger radius springs one for `trapHarm` Health, once, and the party hears it. Only depleted nodes remain.
- **2026-10-06**: Editor scope tree (in progress): shared data-driven outliner (`ScopeNode` + `flattenVisible`/`breadcrumb`/`toggleOpen`, `ScopeTree` over `TreeItem`), proven on the World tree with identical rows; LiveOps/story/release/database trees follow instead of reimplementing open/selected/expand.
- **2026-10-06**: E5 complete: developer panels no longer mount in the player client. `npm run dev` now starts the server and editor; debugger controls remain exclusively in the editor's Play Mode.
- **2026-10-06**: D4 region report (in progress): `WorldClient.reportDungeonResults` sends the region's unreported dungeon runs to the world with the bearer token and returns the ingested instance ids; the world's `ReportDungeonResults` ingest is the next slice.
- **2026-10-06**: D4 world ingest (in progress): `WorldCore.reportDungeonResults` records one `dungeon_run` row per run (Memory + Surreal stores), idempotent on `instance`, 403 on region mismatch, 404 on unknown region. Next: the webrpc route/Zod/RIDL and the region flush marking `instances.db` rows reported.
- **2026-10-06**: D4 results end to end: the webrpc `ReportDungeonResults` route (strict Zod bounds, bearer auth, RIDL updated) ingests idempotently, and the region's save timer flushes `instances.db` unreported rows through it with no overlapping in-flight POSTs, marking only confirmed ids. A slow or dead world never stalls the tick and never stacks requests.
- **2026-10-06**: T2 Live Ops telemetry: the editor reads the protected `stats` admin snapshot through `BackendClient`, refreshes once per server bucket without overlapping requests, and renders tick p50/p99/max plus kills, pickups and damage series. Connection and refresh failures remain visible; player, region and audit data stay staged.
- **2026-10-05**: Ponytail trim (chore): the editor drops its unused `zod`; `@types/ws` moves from the root to engine-core, the only package that imports `ws`. A `@types/node` alignment was dropped: it resolves to 25.9.9 and breaks engine-core (TS18046).
- **2026-10-04**: Roadmap caught up with the 37 PRs merged on 2026-10-04 (#89 to #127); new sections for the modular editor (1c) and the edge/core split slices; `docs/CLI.md` lists every command.
- **2026-10-04**: `npm start`: one command from a fresh clone to a running game. It installs dependencies when missing or the lockfile changed, runs codegen, bakes the world, the loot pool and 10 dungeons when they're missing, then starts the server and the player's client (`--dev` for the developer client, `--server` for the server alone). `npm run dev` is `npm start -- --dev`; `scripts/dev.mjs` became `scripts/start.mjs`.
- **2026-10-04**: M4 client: the character sheet shows disciplines (active, lapsed, progress toward the rest) and familiarity. (#127)
- **2026-10-04**: D4 player side: entrances in the world, party enter, a run HUD, the result and the return (U13). (#126)
- **2026-10-04**: World server B2: players handed across region borders live (`bye` redirect with a migration ticket, hello with the ticket). (#122)
- **2026-10-04**: U11 quest UI: quest givers drawn with ! / ? markers, E to talk, npc dialog with numbered replies, quest log (J), tracker and quest notices. (#125)
- **2026-10-04**: U12/U9 injury display: a body doll on the player frame while hurt, and a body section on the character sheet (blood, injuries worst first, click to treat). (#124)
- **2026-10-04**: U2 mana bar on the player frame and a cast bar while casting (0x1c mana and spell messages). (#123)
- **2026-10-04**: E9 world-scale terrain editing: world map, the area follows the camera, brushes to 256 m, regenerate a region or area. (#121)
- **2026-10-04**: E8 the editor dungeon view: pool browser, 3D view with picking, edits saved as validated patches. (#118)
- **2026-10-04**: E7 the hierarchical PICG graph editor. (#115)
- **2026-10-04**: E6 selection cards in the editor's play mode. (#113)
- **2026-10-04**: E5 the developer panels move into the editor's play-mode debugger. (#111)
- **2026-10-04**: E4 the editor's play mode embeds the client's renderer (game view). (#92)
- **2026-10-04**: U3 + U9: hunger, thirst and skills on the stats message (0x0f `needs`, `skills`, `skillMax`); the player frame shows hunger and thirst; the character sheet lists skills by family with peaks. (#110)
- **2026-10-04**: U4 audio: `AudioEngine` (Web Audio buses, unlocks on first gesture, pauses with the tab), synthesized cues and an audio section in settings (master, combat, interface, ambience, mute; persisted). (#106)
- **2026-10-04**: U8 block list: `BlocksState` on 0x11, names kept with blocks (`social.db`), unblock offline; client `/block` `/unblock`, a block button per friend and a folded blocked list. (#105)
- **2026-10-04**: U8 fix: the friends list stacks above the player frame instead of covering the health and stamina bars. (#98)
- **2026-10-04**: U6 chat reply: `/r` and `/reply` whisper the last character who whispered you; whispers read from/to and are tinted. (#95)
- **2026-10-04**: D4 dungeon instances, first cut: runs from the baked pool, loot kept on report (`MMO_DUNGEONS`, `MMO_INSTANCE_HOST`). (#107)
- **2026-10-04**: P1 quests and dialog: `content/quests/`, WFC board quests, `QuestService` with logs in `quests.db`; additive on 0x11 (`kind:"quest"`). (#103)
- **2026-10-04**: Biome registry: `content/biomes.json` holds each biome's ecology multipliers and creature table; `MMO_WILD_CREATURES=1` spawns each chunk's packs as it loads. (#96)
- **2026-10-04**: Mana and Mend, its first spender (`spells.json`, protocol v21 0x1c). (#116)
- **2026-10-04**: M4b: item familiarity, disciplines and disarms; 0x1b skills (protocol v20); admin `skill`. (#112)
- **2026-10-04**: M4a: Medicine treats wounds, stumps and maimed parts (protocol v19, 0x1a). (#109)
- **2026-10-04**: M3 stances: protocol v18 0x19 `stance`; R/T pick the technique and the aim. (#104)
- **2026-10-04**: M3 lost parts shown: a severed part's slots ride the replicated look as `lost`, every client hides them until respawn or heal. Admin `injure`. (#99)
- **2026-10-04**: M3 defence contests: a facing guard is a skill contest (`resolveDefence`); a maimed or severed hand drops its item and can't equip again. (#94)
- **2026-10-04**: M2 body parts and injuries: `BodySystem` (harm, maim, dismember, bleeding, healing, death by a vital part or blood loss). Protocol v17: 0x18 `body`. (#93)
- **2026-10-04**: World server D: the stress harness (`npm run stress:world`) and the regions-per-box number ([`WORLD-STRESS-RESULTS.md`](WORLD-STRESS-RESULTS.md)). (#120)
- **2026-10-04**: World server B1: migration arbitration (begin, get, commit, abort, expiry, CAS) and the region `MigrationCoordinator`; 5.4 ms median hand-off. (#119)
- **2026-10-04**: Terrain LOD rings + 4×4 block batching: 289 → 25 terrain draw calls for a 17×17 streamed area. (#114)
- **2026-10-04**: Edge/core E6: `/metrics` (edge, channel and core), JSON network logs, Prometheus config, Grafana dashboard, k6 soak. (#117)
- **2026-10-04**: Edge/core E5: the split measured (`npm run bench:e5`): 0 hung requests through crash, restart and freeze; 60k+ req/s channel; mirror encoding a little over budget (follow-up E5a). (#108)
- **2026-10-04**: Edge/core E4: the edge holds players through a core outage and resyncs sessions when it returns. (#101)
- **2026-10-04**: Edge/core E3 (additive): engine-core serves the edge's channel beside the gateway; sessions persist in world.db. (#100)
- **2026-10-04**: Edge/core E2: `packages/channel` links the edge to the core: framed TCP, heartbeats, reconnect. (#89)
- **2026-10-04**: Modular editor plan ([`EDITOR-ARCHITECTURE.md`](EDITOR-ARCHITECTURE.md)): docking shell, workspaces, scenes and game flow, modules, a database editor and production tools, slices EA0 to EA26. (#91)
- **2026-10-04**: S3b party persistence: `SqlitePartyStore` (`parties.db`); a restart no longer disbands parties. (#102)
- **2026-10-03**: S2c friends and blocks persistence: `SqliteSocialStore` (`social.db`) behind `GatewayOptions.socialStore`, write-through from `FriendBook` and `BlockList`. Friends lists and blocks now survive restarts.
- **2026-10-03**: Roadmap brought up to date: an "At a glance" summary; U3, U10, U12 and M2 marked in progress, U5, C3 and L3 built; the update log put back in date order under its heading. README layout lists the editor, edge and every package.
- **2026-10-03**: Valgrind without Docker: `npm run valgrind:memcheck` and `valgrind:perf` call `memcheck.mjs` and `perf.mjs` directly again on the host's valgrind; the Docker launcher (`launch.mjs`, `Dockerfile`, `docker-run.sh`) is gone, replacing the container repair below. On Windows, run them from WSL.
- **2026-10-03**: Edge/core split E1 edge skeleton: new `apps/edge` process (Express `GET /health`, client WebSocket) routes packets by type from strictly validated `content/edge/routes.json` to local modules (`ping`) or the core; the core channel is a stub until E2, so core-bound packets answer `core.unavailable` (the contract E4 reuses). Graceful SIGTERM/SIGINT. Valgrind not run (skipped at the user's request).
- **2026-10-03**: Valgrind repaired: the container run (`docker-run.sh`) rebuilt every addon from scratch on every run, silently (Jolt takes minutes), so `npm run valgrind:*` looked hung, and two runs at once corrupted the shared volume. Addons now rebuild only when their sources change (hash in the volume), runs are serialised with `flock`, progress is printed and a failed addon build shows its log. Verified: `valgrind:memcheck -- physics` clean in 16 s, `valgrind:perf` all 8 workloads in 84 s (container Node is v25; the baseline is from v22, so deltas are indicative only). Valgrind/perf are no longer paused.
- **2026-10-03**: M3c combat skills: the attacker's weapon skill (Cutting/Thrusting/Bludgeoning, via the technique's skill in `combat.json`) feeds `computeDamage`; a landed hit trains it, a block trains Blocking and a dodge trains Evading (difficulty 0.5, keyed on the opponent). Server wires `CombatSkills` to the mastery sheets; no skills means the old behaviour. Valgrind/perf paused.
- **2026-10-03**: E11 rules editor: a Rules tab in the editor lists every `content/rules/*.json`, edits it as a tree and validates on save with the `@mmo-engine/rules` schemas and cross-file checks; invalid saves write nothing and show per-path errors. Save is strict (any invalid rules file blocks). Perf and valgrind runs paused.
- **2026-10-03**: T1 ingress hardening: 64 KiB frame cap, per-session token buckets for intents (40/s, burst 60) and pickups (5/s, burst 10), drops counted, 100 violations in 10 s disconnects. Numbers in `content/rules/ingress.json`, editable in the editor's rules tab. Built by opencode, reviewed by Claude. Live reload of limits not wired (`Gateway.updateIngress` is ready).
- **2026-10-02**: M2a damage (in progress): attack moves strike once on their `hitAt` tick; living targets with Health in reach and the 120° cone take `computeDamage` for the held weapon (fists when empty), whole-body (D1). A facing guard takes 0.25, a roll in its i-frames none. Health clamps at 0 (death is M2b). Protocol v12: 0x16 `hit`.
- **2026-10-02**: ED1 gameplay tables: the editor's Gameplay Tables tab edits item bases, creatures, loot and death rules, validates through the host (`/api/editor/rules`) and saves to `content/rules`; a refused save lists its issues and writes nothing. A running server's `RulesReloader` watches the folder and swaps the tables on its next tick (`HooksDelegate`, `CreatureSystem.setRules`, `ItemService.setLoot`, `ItemDefs.applyRules`); a bad file is refused and the running rules stay.
- **2026-10-02**: U10a bag panel: drag a bag item onto its hand slot to equip it (the slot lights only for the right hand), drag a held item onto the bag to put it away, double-click equips. Hovering an item shows a tooltip beside the bag with its stats and the signed change against what it would replace, by the server's swap rules (`displaced`). The held items' stat totals sit under the hands. Drops send the same 0x13 equip/unequip, so the server still decides.
- **2026-10-02**: U12a hit feedback: struck entities flash red for 0.15 s (hits and blocks; dodges don't), a top-centre target frame shows the target's name and health from `hit` messages (you target what you strike, or your attacker when nothing is targeted; left click selects the hovered entity; cleared when it despawns), creatures get nameplates via the names message, and the player frame's health updates on each hit.
- **2026-10-02**: L2 creature drops: a creature's death rolls its `drops` (`rolls` range, `chance` per roll; defaults 1-2 at 0.8) from the `mob` pool with a seeded rng, scattering items within 1.2 m of the corpse owned by the killer for the ownership window. Pickup, ownership and despawn are M3a's. `DeathSystem` gained an `onDeath` hook. Editor tables come with ED1.
- **2026-10-03**: E10 character record view (read-only): `readCharacterView`/`listCharacters` over the character and item stores, a Characters panel in the editor (look, saved state, deaths, items). Built by opencode, reviewed. Perf not run (paused).
- **2026-10-03**: S4 guilds: `GuildBook` with injected clock and write-through `GuildStore` (in-memory default; SQLite store and `purge` caller deferred). Ranks and rules enforced server-side, guild chat channel, `GuildState` to members on change, tag on the names fan-out (`Name <TAG>`), `GuildFrame` and guild chat commands in the client. Protocol 15; ops ride 0x11 (`kind:"guild"`). Perf and valgrind not run (paused).
- **2026-10-03**: S4b guild persistence: `SqliteGuildStore` (`guilds.db`, WAL, FK cascades, log trimmed to 200 per guild) behind `GatewayOptions.guildStore`; the server wires it, tests default to memory. Guilds now survive restarts. Perf and valgrind not run (paused).
- **2026-10-03**: S3 parties: `PartyBook` (up to 6, leader invites/kicks/promotes, 60 s invites, 5 min offline removal with leadership to the longest-standing, disband at one), party chat channel, `PartyState` pushed to affected members on every change (in memory; a restart disbands). Protocol 14. Ops ride the 0x11 envelope (`kind:"party"`) because 0x0f is Stats here. Out-of-view frame data (U7) next.
- **2026-10-03**: U7 party frames: `PartyFrame` over the world canvas shows the party (leader star, online dot, lead/kick for the leader, leave) and a pending invite with accept; chat commands `/invite /kick /promote /accept /leave /p /w` parse client-side. The server lapses invites after 60 s without telling the invitee, so the client hides the card itself after 60 s. Per-member health and region need a wire change (deferred). Perf not run (paused).
- **2026-10-03**: T2 play telemetry (server): `PlayTelemetry` keeps kills, deaths, pickups, drops and player damage dealt/taken in 10 s buckets (60-bucket ring, preallocated, no tick allocation) plus a tick-time histogram (p50/p99/max). Admin `stats` returns the JSON for the editor graphs (E5).
- **2026-10-03**: S2 whispers and blocks (in-memory): whisper by character name on 0x11 (`to`), echoed to the sender; unknown, offline, self or blocking targets all answer the same system "not online". Per-account silent blocks (200 limit, `block` message) hide say/yell/whispers from the blocker. Friends, presence, reply and the world-server event stream are deferred.
- **2026-10-03**: S2b friends and presence (in-memory): `/friend name` and `/unfriend name` (100 limit, online characters only, uniform "not online" reply); the server pushes the `friends` list on login and on every friend login/logout; a friend who blocks you shows offline. Protocol v16. `FriendsFrame` in the client. Friend persistence deferred. Perf and valgrind runs paused.
- **2026-10-03**: M1 mastery core: `SkillSheet` (gain by challenge, slowdown at the top, repeat falloff, related skills, decay with relearn bonus, save/load) and a `MasterySystem` training Swimming and Athletics every 5 s of effort (proposed defaults). Exposure (no weather yet), familiarity, persistence and the wire/character sheet (U9, flatc) deferred. E11 rules editor panel added to the list (editor parity).
- **2026-10-03**: M1b skill persistence: skills saved with the character (`character_skills`) and restored on enter-world with deterioration applied; `MasterySystem` shared between gateway and tick list.
- **2026-10-03**: L3 pool rebake keeps held items: `npm run loot:rebake -w @mmo-engine/engine-core -- --db <world.db> --pool <pool.jsonl>` bakes a new pool that keeps every bag and hand item (via the bake's `held`) and appends ledger rows pointing each live item at its new def; unheld ground items whose entry is gone are tombstoned.
- **2026-10-03**: P2c crash and replay tests over the item ledger (unflushed loss, atomic failed flush, hot-WAL recovery, restart cycles, history replay).
- **2026-10-03**: U3 hunger and thirst: `content/rules/needs.json` (max, drain per minute, damage per second at zero, exertion factor), a `Needs` component (id 14) and a `NeedsSystem` after stamina. Meters drain by the minute, faster while running or swimming, and hurt Health once empty. Wire/HUD meters deferred, not persisted.
- **2026-10-03**: P2b character save: `character_state` in characters.db (position, health, stamina), saved on the save timer, eviction, grace expiry and shutdown, restored on enter world; dead or never-saved characters get the ordinary spawn.
- **2026-10-03**: P2a item ledger: every item change (create, ground, bag, hold, destroy tombstone) appends to `item_events` in world.db with its tick (valid time) and write time (transaction time); flushed on the save timer, restored at boot (ids never reused, ground items get fresh despawn timers). Perf not run (paused).
- **2026-10-02**: AI1 creatures: `content/rules/creatures.json` (goblin: 60 health, aggro 12 m, leash 30 m, packs of 2-4, dagger/axe/mace, 60 s respawn) drives `CreatureSystem`, a bot-shaped entity whose brain idles, aggros the nearest living character, chases (crowd-steered when navmesh is up), swings through `PlayerIntent`, and leashes home healing. `DeathSystem` takes a per-creature delay and a `place` hook; admin `spawn goblin` drops a pack. Editor tables for the numbers come with ED1.
- **2026-10-02**: M2b death and respawn: `DeathSystem` (after combat) ends a body's move and walk at 0 Health, asks the rules' `onDeath` for the delay (10 s), and on that tick restores full Health, clears held buttons and puts players at the spawn point (bots rise in place; `nearestVisited` has no visited-anchor tracking yet, so it falls back to the spawn point). The dead neither fight nor are struck. Characters get a `deaths` row when the rules ask. Protocol v13: 0x17 `life`.
- **2026-10-02**: M3b held weapons: the avatar's appearance JSON carries `Held` models (`withHeld`), the gateway refreshes it on equip and unequip, and the client parents the weapon to `Hand_R`/`Hand_L`. Entering the world outfits the lowest-ranked starter sword once per character per run. Bag shows the two hand slots with equip and unequip buttons. Protocol: 0x13 `equip`/`unequip`, 0x14 `main?`/`off?`.
- **2026-10-01**: M3a items: definitions from the loot pool with each
  base's physics (`content/rules/items.json`), ground items you pick up
  with E (owned 30 s, gone after 5 min, `loot.json`), a bag (B), and
  admin `items`/`give`/`drop`/`loot`. Protocol v11 (0x13–0x15). Typing
  in a text field no longer moves the character.
- **2026-10-01**: Valgrind: `npm run valgrind:memcheck` (every addon's
  tests under memcheck; our code's errors and leaks fail it) and
  `npm run valgrind:perf` (callgrind instructions per operation for eight
  headless workloads, against a committed baseline). Its first run fixed
  two navigation bugs: a detail-mesh leak on every tile bake, and a heap
  overflow in Recast's tile-cache region builder.
- **2026-10-01**: Fix: the client's panels (player frame, chat, sheet,
  settings) were see-through. Their `bg-card/90`-style classes generated
  nothing; the theme colours now live in the Tailwind config.
- **2026-10-01**: Fix: `addon-geometry` failed to compile under MSVC
  (C2666 on a `Uint8Array` index), so the geometry and dungeon suites
  failed on Windows. The mask is now read through a raw byte pointer.
- **2026-10-01**: Fix: admin commands (0x10) fell through into the chat
  handler and drew a stray "malformed chat" 4003 after every result.
  Every workspace now compiles with `noFallthroughCasesInSwitch`.

- **2026-10-01**: Alpha plan ([`ALPHA-PLAN.md`](ALPHA-PLAN.md)):
  three milestones (first fight, keep it, hold it) and section 7 here.
  Decided: whole-body damage, loot owned 30 s then free, despawn 5 min,
  key-press pickup, every tunable editable in the editor (ED1).

- **2026-10-01**: Edge / core split build plan saved as
  [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) (recovered from a local
  stash). Not scheduled; its slices E1–E6 are not the editor's E items.

- **2026-09-30**: U9 character sheet: attributes + derived stats with
  modifier deltas from the stats message, toggleable panel. Skills
  await M1, injuries M2.

- **2026-09-30**: U6 chat panel: say/yell/emote tabs, 50-line history,
  send-on-Enter over MirrorClient.chat()/onChat; verified with two live
  clients. Whispers/party/guild/reply await S2–S4.

- **2026-09-30**: A4 first slice: `teleport` (ground snap, stilled
  velocity), `heal` (fill from max), `fly` (ability bit) admin commands.
  God/time/weather need damage, a spender, and a clock design.

- **2026-09-30**: A3 props spawn: `spawnlist`/`spawn` (forest-table
  archetypes via spawnScatterEntity, at avatar or x/z with ground
  height) + `despawn` (refuses live session avatars). Creatures need a
  shared spawner with bots; cursor targeting awaits E4.

- **2026-09-30**: A2 write path: `set` admin command (whitelisted numeric
  fields, integer stores reject fractions) sharing one entity resolver
  with `inspect`; console takes JSON or quoteless `{k:v}` args (pure
  parser, tested).

- **2026-09-30**: A2 read path: `inspect` admin command (entity u64 or
  "me") dumping every component + stats sheet, shown in the dev
  console. Write path (field edits) is the next slice.

- **2026-09-30**: A1 admin channel: 0x10 `help`/`whoami` over the control
  plane (protocol v8), adminhood from `MMO_ADMINS` or `MMO_DEV_SERVER=1`
  decided once at join, ring-buffer command log + console lines, dev
  tools console in the client. A2+ adds world-editing commands.
- **2026-09-30**: U4 controls + UI scale: remappable keyboard bindings
  (bindings.ts, persisted, live-swapped into InputState) and 90–125%
  interface scale in the settings menu; dev controls help reads the
  same data. Audio deferred to an audio engine.
- **2026-09-30**: U2 stamina: `Stamina` wire component (additive `.fbs` +
  codegen), `maxStamina` drive + `staminaRegen` stat, `StaminaSystem`
  (dodge/attack/jump/swim/run drains, cooldown regen, combat gating),
  live bar in `PlayerFrame`. Mana deferred to its first spender.

- **2026-09-30**: U2 player frame (health): `PlayerFrame` over the world
  canvas, fed by the mirror's Health rows at 1 Hz; stamina/mana await
  their pools (M1).
- **2026-09-30**: S1 region chat: 0x11 say/yell/emote (protocol v8 —
  second merger with the admin branch bumps to v9), 30 m say/emote
  range, per-channel cooldowns, TextFilter hook, full e2e coverage.
  Client panel stays U6.
- **2026-09-30**: C3 identity: CharacterRef wire block (id 12 — second
  merger with the stamina branch renumbers), `names` fan-out before
  first-showing state, cached-sprite nameplates with distance fade.
  Guild tags await S4.

- **2026-09-30**: manifold + Clipper2 (`addon-geometry`) and prebaked
  dungeon shells. Added the admin console (A1–A6) and the dungeon instance
  model (D4).
- **2026-09-30**: `npm run dev` (the server and the developer client)
  and `npm run client` (the player's client) split (E0). The developer
  client gets performance graphs in movable, resizable, fadeable panels
  (E5, interim until E4); the player's client gets a settings menu (U4).

- **2026-09-30**: Roadmap published. Decided: the client shows only the
  player's interface; all developer tooling, the debugger included,
  lives in the editor's play mode (E4, E5). Added the player interface
  items (U1–U12), and separate `npm run client` / `npm run dev` commands
  (E0).
- **2026-09-30**: meshoptimizer merged (#43): optimised meshes and LOD
  chains for every prop.
- **2026-09-30**: DetourTileCache merged (#42): static bodies cut the
  navmesh.
- **2026-09-29**: DetourCrowd (#40) and uWebSockets.js (#39) merged.
- **2026-10-05**: Valgrind dashboard: standalone `scripts/valgrind/dashboard.mjs` (loopback only) with Memcheck, Callgrind and History views, inline SVG charts and plain-language help. Errors classed engine / via engine / runtime with the same rule as `memcheck.mjs`; nothing is suppressed. Hotspot drill-down, compare two runs, Node-version mismatch warning, run/cancel jobs from the page, `valgrind:record` (local, `--promote` to `perf/history.json`), `valgrind:check` gate (new engine errors, callgrind regressions), `valgrind:build-debug` for file:line. Editor Valgrind tab frames it. Perf not re-measured (tooling only).
