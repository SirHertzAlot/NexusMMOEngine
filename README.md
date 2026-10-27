# MMO Engine

An authoritative, extensible, data-oriented, ECS-capable procedural-generation
MMO engine. Each region's `engine-core` process owns its simulation and
regional state; the edge/core split and world server support client ingress
and region coordination. The React Three Fiber client mirrors authoritative
state and is never the source of truth.

**Engine Wiki:** the complete hierarchical technical manual and guides live in [`docs/WIKI.md`](docs/WIKI.md) and the [`docs/wiki/`](docs/wiki/README.md) hub.

**Documentation:** the full index is [`docs/README.md`](docs/README.md);
start with [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md). Full
engineering rationale lives in [`docs/DECISIONS.md`](docs/DECISIONS.md).

**Roadmap:** what's built, in progress and next, with a running update
log, is in [`docs/ROADMAP.md`](docs/ROADMAP.md). Pick an item there to
help.

## Implemented features

The engine is playable end to end, from account creation through the
authoritative world and back. The [roadmap](docs/ROADMAP.md) tracks which
features are complete, in progress, or still planned; this section
summarizes the capabilities already present.

- **World simulation and rendering:** a fixed 30 Hz, server-authoritative
  ECS simulation with streamed world chunks, a climate-driven 4 × 4 km
  world, water, sky and weather, terrain LOD, biomes and optional wild
  creature packs. The client uses React Three Fiber and interpolates server
  snapshots and deltas without client-side prediction.
- **Generation and content:** WFC formations, baked and dressed dungeons,
  species and creature spawn tables, ranks and prefab composition, PICG
  asset cooking, loot pools, and material/recipe data.
- **Characters and gameplay:** account and character sign-in/creation,
  movement and stamina, attributes and use-based skills, weapon stances,
  combat and defense, body-part injuries, bleeding, healing, death and
  respawn, creature AI, mana and spells, hunger and thirst, ground loot,
  and a first-cut inventory/equipment flow.
- **Social and progression:** region chat, whispers, friends, blocks,
  parties, guilds, quests and dialog. Character data, skills, items, social
  lists, parties, guilds and quest progress have persistence as tracked in
  the roadmap. Dungeon runs include party entry, a run HUD, results and
  return to the world.
- **Player experience:** login and character screens, health/resource and
  needs meters, character and injury views, inventory, chat/social,
  party/guild features, quest screens, remappable controls, UI scaling and
  configurable audio.
- **Editor and operations:** a standalone editor with a play-mode game
  view and debugger, read-only ECS inspection, rules and gameplay-table
  editing, PICG graph editing, dungeon tools, world-scale terrain editing,
  and an art pipeline. The edge/core split includes framed internal
  transport, outage recovery and network metrics; the world server
  provides a region registry, migration hand-offs and a stress harness.

Some areas remain partial rather than finished: inventory/equipment still
needs the remaining armor and equipment work, and the client cutover to the
edge, world-server accounts/social event stream, and the modular editor are
not complete. See the roadmap for exact scope and dependencies.

## Repo layout

```
packages/schema/        # mmo_engine.fbs — the SINGLE SOURCE OF TRUTH for the
                        # C++ <-> JS contract. Generated code is gitignored.
packages/protocol/      # WS envelope + message catalog helpers (TS)
packages/mirror/        # shared mirror driver (connect, snapshot/delta folding,
                        # intents, debug queries) for the client and the editor
packages/engine-core/   # authoritative server: tick loop, world, net, combat,
                        # creatures, items, chat/parties/guilds, persistence (TS)
packages/rules/         # game rules as data: schemas, defaults, content/rules loader, hooks
packages/addons/        # C++ N-API addons: physics (Jolt), navigation (Recast/Detour),
                        # procgen (FastNoise2), picg (PICG cook, meshoptimizer),
                        # geometry (manifold + Clipper2), scatter, perf-probe,
                        # integrate (bench), template
packages/wfc/ placement/ scatter/ picg/   # procedural generation (bake time)
packages/dungeon/ species/ compose/ crafting/ settlement/   # dungeons, creatures, settlements, ranks and
                        # loot, materials and recipes (bake time)
packages/art/           # art asset pipeline: manifests, packs, three.js provider
packages/world-server/  # world server: region registry, SurrealDB system of record
packages/bench/         # tick-budget validation benchmark (slice 1.5)
apps/client/            # the player's three.js + React client
apps/editor/            # the editor: inspectors, play mode, rules and tables, art
apps/edge/              # edge process: client WebSocket + packet router (edge/core split)
content/                # rules, edge routes and other data the server loads
docs/                   # roadmap, design docs, message catalog, decision log
scripts/                # codegen (flatc vendored), dev launcher, valgrind
```

## Setup (clean clone)

```sh
npm install        # workspaces + native toolchain (node-gyp builds template addon)
npm run codegen    # flatc --cpp --ts -> packages/schema/generated/{cpp,ts} (scripts/codegen.mjs)
npm test           # builds TS packages, runs all node:test suites + native addon test
```

## Run the game: `npm start`

```sh
npm start                  # everything: setup, the server and the player's client
                           # → http://localhost:5173
npm start -- --dev         # the server and editor development environment
                           # → http://localhost:5174; same as npm run dev
npm start -- --server      # the server only
npm start -- --build       # run the full build first, then start
npm run build              # build everything: packages, client and editor bundles, native addons and modules
npm run editor             # the editor (inspectors, play mode, art pipeline)
```

`npm start` works from a fresh clone. It does only the setup that's
missing, then starts the server and the client together (Ctrl+C stops
both): it installs dependencies (`npm ci`, also after the lockfile
changes), generates the FlatBuffers bindings, and bakes the world, the
loot pool and 10 dungeons into the data folder. The first start takes a
few minutes; after that it goes straight to the server.

It runs the same on Linux, macOS and Windows (PowerShell or cmd, no bash
or WSL). It needs Node 22 or newer, Python 3, and a C++17 compiler for the
native addons: on Windows the Visual Studio Build Tools with "Desktop
development with C++", on macOS Xcode's command line tools
(`xcode-select --install`), on Linux `build-essential`. flatc is vendored
for all three.

Create an account in the client's "Create account" tab and log in. Every
other command (bakes, tools, benchmarks, servers, the admin console, chat
commands and keys) is in [`docs/CLI.md`](docs/CLI.md).

Server env: `MMO_PORT` (7777), `MMO_DATA_DIR` (packages/engine-core/data),
`MMO_WORLD_SEED` (1234), `MMO_CHUNK_SIZE` (16). The client mirrors authoritative snapshots/deltas with interpolation and
sends WASD/mouse-look intents upstream — no client prediction yet.
Details: [`apps/client/README.md`](apps/client/README.md).

## Baking everything: `npm run bake:all`

One command bakes what a playable world needs, in dependency order. Steps
whose outputs exist are skipped, so it is safe to run again.

| # | Step | Reads | Writes |
|---|---|---|---|
| 1 | `build` | sources | `dist/` of engine-core, settlement, dungeon |
| 2 | `world` | world spec | `<data>/world.db` (terrain tiles, surveys, spawn area) |
| 3 | `loot` | rank ladder | `<data>/loot/pool.jsonl` |
| 4 | `dungeons` | themes, species | `<data>/dungeons/*.dungeon.json` |
| 5 | `settlement` | world spec (survey, site selection), scale, catalog | `<settlements>/<id>.settlement.json`, `<scenes>/settlement-<id>.scene.json` |
| 6 | `places` | world spec, the towns' scenes | `<settlements>/places.json` (routes between the towns; guard outposts, inns, shacks, camp sites along them; homesteads between) |
| 7 | `scale-fit` | catalog, scale | `<scale-out>` (`scale.local.json`) |
| 8 | `wildlife-plan` | catalog, ecology plan | `<content>/ecology/wildlife.local.ecology.json` |
| 9 | `wildlife-models` | catalog, wildlife table | `<content>/wildlife/models.local.json` |
| 10 | `env` | the above | prints the `MMO_*` block, writes `<content>/bake-env.local.txt` |

Steps 7 to 9 need the art catalog (`assets/catalog.json`, built by
`convert:packs` / `import:glb` from the licensed packs, which this command
does not run). Without it they are skipped with a warning and the town is
stand-in boxes. Everything that names a licensed model is gitignored.

```sh
npm run bake:all                                   # everything, as many towns of 600 as the world supports
npm run bake:all -- --dry-run                      # the plan and the commands, nothing run
npm run bake:all -- --sites 3 --auto-size          # three towns, best sites first; 600, else 300, else 100 people
npm run bake:all -- --sites max                    # the default: counts the sites (one survey), then bakes them all
npm run bake:all -- --only settlement,scale-fit    # just those (the build comes along)
npm run bake:all -- --skip dungeons,loot --force   # rebuild the rest (the world too: stop the server first)
```

Options: `--force`, `--only a,b`, `--skip a,b`, `--dry-run`, `--sites N|max` (default `max`: every site the world supports with all the constraints, up to 200),
`--population N` (600), `--auto-size`, `--seed N` (1234, +1 per extra town),
`--settlement-id ID` (`0001`, then `0002`, ...). It stops at the first failure,
names the step and prints the command to rerun.

### Path variables

Resolved once and handed to every step. A flag beats the variable, which
beats the default; relative values resolve from where you ran npm. Nothing
the bake writes may be inside the assets folder (the bake refuses), and it
never reads `users.csv`.

| Variable | Flag | Default | Is |
|---|---|---|---|
| `MMO_REPO` | `--repo` | this checkout | the repo root |
| `MMO_DATA_DIR` | `--data-dir` | `packages/engine-core/data` | world.db, loot, dungeons (the server's data folder) |
| `MMO_CONTENT_DIR` | `--content-dir` | `content` | where bakes write scenes, settlements, scale, wildlife files |
| `MMO_ASSETS_DIR` | `--assets-dir` | `assets` | the licensed art folder, read only |
| `MMO_CATALOG` | `--catalog` | `<assets>/catalog.json` | the art catalog |
| `MMO_WORLD_SPEC` | `--world-spec` | `packages/engine-core/worlds/default.world.json` | the world to bake and to site towns in |
| `MMO_SETTLEMENT_OUT` | `--settlement-out` | `<content>/settlements` | settlement manifests |
| `MMO_SCENES_DIR` | `--scenes-dir` | `<content>/scenes` | town scenes (the server's `MMO_SCENES` is an alias) |
| `MMO_SCALE_OUT` | `--scale-out` | `<content>/scale.local.json` | the per-model scale fit |

The same names work on the settlement CLIs (`settlement:bake`,
`settlement:scale-fit`, `settlement:scale-report`; their own flags still win,
`settlement:bake` also takes `--scenes <dir>`) and the server reads
`MMO_SCENES_DIR`, `MMO_CATALOG` and `MMO_ASSETS_DIR`. The other content the
server loads (rules, quests, prefabs, ...) stays the repo's.

PowerShell:

```powershell
$env:MMO_DATA_DIR = "D:\bake\data"; $env:MMO_CONTENT_DIR = "D:\bake\content"
$env:MMO_ASSETS_DIR = "C:\src\mmo-engine-full\assets"
npm run bake:all -- --sites 2 --auto-size
```

Git Bash:

```sh
MMO_DATA_DIR=/d/bake/data MMO_CONTENT_DIR=/d/bake/content npm run bake:all -- --sites 2 --auto-size
```

When it ends it prints the block that starts the server on what it baked
(`MMO_DATA_DIR`, `MMO_SCENES`, `MMO_SCENE=world`: every baked town plus the
places between them, `MMO_SPAWN_OVERRIDE` at the best town's centre, `MMO_SCALE`, `MMO_ECOLOGY`), for PowerShell and for
Git Bash, and writes it to `<content>/bake-env.local.txt`. `MMO_SCENE` also takes a
comma-separated list (`settlement-0001,places`), and `npm start` sets
`MMO_SCENE=world` itself when the scenes folder has baked towns.

## Memory and performance checks (valgrind)

Valgrind (3.x, Linux) checks the native addons and measures the engine. It runs straight on the host, no container: install it with your package manager (`apt install valgrind`); on Windows, run the commands from WSL with the addons built there.

```sh
npm run valgrind:memcheck            # every addon's tests under memcheck
npm run valgrind:memcheck -- navigation physics    # some of them
npm run valgrind:perf                # instruction counts vs the baseline
npm run valgrind:perf -- --check     # fail if anything is > 3 % slower
npm run valgrind:perf -- --update    # re-measure and write the baseline
```

- **memcheck** fails on memory errors and definite leaks in our code
  (the addons' own binaries); Node's and V8's own reports are left out.
  About 3 minutes for all addons. Rebuild an addon with
  `CXXFLAGS=-g npx node-gyp rebuild` for file and line numbers.
- **perf** runs the headless workloads in `scripts/valgrind/workloads.mjs`
  (the engine's tick on 1,000 entities, a crowd of 100, a batch of paths,
  physics, a terrain chunk, a PICG cook, meshoptimizer, a dungeon shell)
  under callgrind. Each is measured from the perf probe's `begin()` to its
  `end()` (`@mmo-engine/addon-perf-probe`), so a count is exactly the
  workload's instructions, JS and native. Counts are stable between runs,
  unlike wall time, so `perf/callgrind-baseline.json` is a baseline to
  hold architecture changes to. The dumps in `valgrind-out/callgrind/`
  open in `callgrind_annotate` or KCachegrind.

## Contract changes

1. Edit **only** `packages/schema/mmo_engine.fbs` (additive changes: new
   tables/fields; never reuse field ids).
2. Run `npm run codegen`.
3. Keep the Phase 0 C++↔JS round-trip green — any schema change must keep
   both sides reading the same bytes field-for-field.

## CI

`.github/workflows/ci.yml`: install → codegen → codegen reproducibility
check (generate twice, diff) → full test run.
