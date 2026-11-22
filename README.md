# Nexus MMO Engine

A server-authoritative, data-oriented MMO engine. One Node.js process
simulates a region at a fixed 30 Hz over a structure-of-arrays ECS, with the
numerically heavy work in C++ addons compiled into the same process. The
world it simulates — terrain, biomes, settlements, roads, dungeons, loot,
creature ecologies — is procedurally generated and baked before the server
starts. The browser client is a mirror: it renders what the server sends and
decides nothing.

```sh
git clone https://github.com/SirHertzAlot/NexusMMOEngine.git
cd NexusMMOEngine
npm install
npm start          # → http://localhost:5173
```

`npm start` does whatever setup is missing — FlatBuffers codegen, baking a
4 × 4 km world, the loot pool and ten dungeons — then runs the server, the
edge and the client together. The first run takes a few minutes, mostly
compiling the native addons. You need Node 22+, Python 3 and a C++17
compiler; everything else comes with `npm install`.

## Documentation

| Read this | For |
|---|---|
| **[Getting started](docs/GETTING-STARTED.md)** | A fresh clone to walking around a world |
| **[What the engine can do](docs/CAPABILITIES.md)** | An honest inventory, including what it is not |
| **[Building a game on this engine](docs/BUILDING-A-GAME.md)** | The opinionated guide to using it well |
| **[Architecture](docs/ARCHITECTURE.md)** | How it fits together, one tick at a time |
| **[Performance and constraints](docs/PERFORMANCE.md)** | What it costs, measured, and what that buys you |

The full index is [docs/README.md](docs/README.md). The task board is
[docs/ROADMAP.md](docs/ROADMAP.md).

## What is in the box

- **Simulation.** Fixed 30 Hz tick with a spiral guard, bitECS
  structure-of-arrays storage optionally backed by `SharedArrayBuffer`,
  deterministic replay verified bit-for-bit, hot reload of game systems, and
  an opt-in three-thread data plane.
- **Native kernels.** Jolt physics, Recast/Detour navigation, FastNoise2
  terrain, a tectonics and erosion kernel, CSG geometry, PICG mesh cooking,
  scatter, and native per-tick delta fan-out — ten N-API addons, bulk typed
  arrays across the boundary and nothing per-object.
- **World generation, offline.** A climate model drives biomes; WFC and CSG
  build dungeons; settlements are sited, laid out, populated and baked, with
  roads and wayside places between them. `npm run bake:all` runs the chain.
- **Gameplay systems.** Movement and stamina, stances and combos, guarding,
  abilities and telegraphs, body-part injury and treatment, use-based skills,
  magic, creature AI and crowds, town residents on daily schedules, items and
  an economy with trade, vendors and an auction house, chat, parties, guilds,
  quests, and instanced dungeon runs.
- **Networking.** Per-sector interest management on by default, an edge
  process in front of the core, uWebSockets.js with a `ws` fallback,
  FlatBuffers from one schema plus a frozen-layout fast path for hot deltas,
  and documented policy for slow and abusive clients.
- **Scale.** One process per region, around four regions per core, with a
  world server owning the registry, leases, hand-offs and the durable record.
- **Editor.** A standalone docking workspace: world-scale terrain, scene and
  ECS inspection, gameplay tables, dungeon and PICG graph tools, live-ops
  telemetry, a database grid with an audit log, story and quest editing, the
  art pipeline, and play mode with the debugger beside it.

Honest limits, in brief: there is no client-side prediction beyond the local
walker, so this suits MMO pacing rather than twitch combat; one region
finishes about 43% of its ticks at 1,000 players, so plan on regions; and
every benchmark in this repository came off shared hardware. The detail, with
sources, is in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Repository layout

```
packages/schema/        mmo_engine.fbs — the single source of truth for the
                        C++ ↔ JS contract. Generated code is gitignored.
packages/protocol/      WebSocket envelope and message catalog helpers
packages/mirror/        shared mirror driver (connect, fold snapshots and
                        deltas, intents) for the client and the editor
packages/engine-core/   the authoritative server: tick loop, world, net,
                        combat, creatures, items, social, persistence
packages/rules/         game rules as data: schemas, defaults, loader, hooks
packages/addons/        C++ N-API addons (see above)
packages/wfc/ placement/ scatter/ picg/          procedural generation
packages/dungeon/ species/ compose/ crafting/ settlement/ fortify/ synthesis/
                        dungeons, creatures, ranks and loot, towns (bake time)
packages/logging/       lock-free SAB log rings and the log worker
packages/channel/       the framed edge ↔ core channel
packages/world-server/  region registry and the system of record
packages/art/           art manifests, packs and the three.js provider
packages/bench/ playtest/ build/   benchmarks, automated playtests, deploy profiles
apps/client/            the player's three.js + React client
apps/editor/            the editor
apps/edge/              the edge process: player sockets and packet routing
modules/                the engine's extension seam: server, editor, native,
                        sidecar, edge, tools and database modules
content/                the sample game: rules, species, quests, scenes, strings
site/                   the public website and docs site (static)
scripts/                codegen, dev launcher, valgrind harness, docs audit
```

## Developing

```sh
npm test                 # every workspace; the gate for everything
npm run build            # packages, client and editor bundles, native addons
npm run editor           # the editor → http://localhost:5174
npm run bake:all         # the whole content bake, in dependency order
npm run valgrind:memcheck    # memory-check the native addons (Linux)
npm run valgrind:perf        # instruction counts against the stored baseline
```

Changing the wire contract means editing **only**
`packages/schema/mmo_engine.fbs` (additively — never reuse a field id), then
`npm run codegen`. Every other command is in [docs/CLI.md](docs/CLI.md).

[CONTRIBUTING.md](CONTRIBUTING.md) has the branch workflow and code
standards. [CLAUDE.md](CLAUDE.md) has the rules for working in this
repository.

## Licence

This repository does not yet carry a licence, which means the default applies
and all rights are reserved. That decision is deliberately open. You can read
and run the code; you cannot yet build and ship on it.

Licensed art lives in a git-ignored `assets/` folder and is never in the
repository. Without it the engine draws its own procedural scenery and
placeholder characters, and everything else works identically.
