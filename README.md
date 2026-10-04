# MMO Engine

An authoritative, extensible, data-oriented, ECS-capable procedural-generation
MMO engine. One Node.js process is the authority — it simulates the world,
persists it, and streams it; the three.js client is a mirror, never the
source of truth.

**Decisions (locked):** JS world (bitECS) with C++ systems (physics,
collision, pathfinding, procgen) as in-process N-API addons; SQLite embedded
in the Node process; FlatBuffers contract shared by C++ and JS; 30 Hz fixed
sim tick; multiplayer from the start. Full rationale lives in
[`docs/DECISIONS.md`](docs/DECISIONS.md) and the
[`mmo-engine` skill](../../skills/mmo-engine/SKILL.md).

**Roadmap:** what's built, in progress and next, with a running update
log, is in [`docs/ROADMAP.md`](docs/ROADMAP.md). Pick an item there to
help.

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
packages/dungeon/ species/ compose/ crafting/   # dungeons, creatures, ranks and
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
npm run codegen    # flatc --cpp --ts -> packages/schema/generated/{cpp,ts}
npm test           # builds TS packages, runs all node:test suites + native addon test
```

## Run the game: `npm start`

```sh
npm start                  # everything: setup, the server and the player's client
                           # → http://localhost:5173
npm start -- --dev         # the client with its developer panels (` hides them);
                           # same as npm run dev
npm start -- --server      # the server only
npm run editor             # the editor (inspectors, play mode, art pipeline)
```

`npm start` works from a fresh clone. It does only the setup that's
missing, then starts the server and the client together (Ctrl+C stops
both): it installs dependencies (`npm ci`, also after the lockfile
changes), generates the FlatBuffers bindings, and bakes the world, the
loot pool and 10 dungeons into the data folder. The first start takes a
few minutes; after that it goes straight to the server.

Create an account in the client's "Create account" tab and log in. Every
other command (bakes, tools, benchmarks, servers, the admin console, chat
commands and keys) is in [`docs/CLI.md`](docs/CLI.md).

Server env: `MMO_PORT` (7777), `MMO_DATA_DIR` (packages/engine-core/data),
`MMO_WORLD_SEED` (1234), `MMO_CHUNK_SIZE` (16). The client mirrors authoritative snapshots/deltas with interpolation and
sends WASD/mouse-look intents upstream — no client prediction yet.
Details: [`apps/client/README.md`](apps/client/README.md).

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
