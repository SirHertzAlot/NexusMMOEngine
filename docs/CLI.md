# Command reference

Every command you can run, in one place. Run them from the repo root.
If you only want to play or develop, you need one command:

```sh
npm start
```

It sets up whatever is missing (dependencies, codegen, the world, loot
and dungeon bakes), then starts the server and the player's client at
http://localhost:5173. Ctrl+C stops both.

## Contents

- [Start and run](#start-and-run)
- [Bake content](#bake-content)
- [Art and assets](#art-and-assets)
- [Test and check](#test-and-check)
- [Benchmarks and stress](#benchmarks-and-stress)
- [Other servers](#other-servers)
- [Server environment](#server-environment)
- [In game: the admin console](#in-game-the-admin-console)
- [In game: chat commands](#in-game-chat-commands)
- [In game: keys](#in-game-keys)

npm passes flags to a script only after `--`, as in
`npm start -- --server`. Without the `--`, npm keeps the flag for itself.

## Start and run

| Command | What it does |
|---|---|
| `npm start` | Setup, then the server and the player's client |
| `npm start -- --dev` | Setup, then the server and editor development environment |
| `npm start -- --server` | Setup and the server only |
| `npm start -- --no-setup` | Skip the setup checks |
| `npm start -- --build` | Run the full `npm run build` first, then start |
| `npm run build` | Build everything: the bindings, every package, the client and editor bundles, the native addons and the modules' native entries |
| `npm run build -- --no-native` | The same without the native steps (TypeScript and bundles only) |
| `npm run dev` | Same as `npm start -- --dev` |
| `npm run server` | The game server alone (ws://localhost:7777), no setup |
| `npm run client` | The player's client alone (http://localhost:5173) |
| `npm run editor` | The editor: inspectors, play mode with the game view and debugger, rules and gameplay tables, dungeon view, world map, art pipeline |
| `npm run editor:build` | Build the editor |
| `MMO_DEV_PASSWORD=<pw> npm run seed:user -w @mmo-engine/engine-core -- <name>` | Create an account without the client. The password comes only from the environment (8 to 128 characters) |

The setup that `npm start` does, each step only when it is missing:
`npm ci` (also when the lockfile changed since the last start),
`npm run codegen`, `npm run bake:world`, `npm run loot:bake` and
`npm run dungeon:bake -- --n 10`, and `npm run build:native` (the native
entries of the modules under `modules/`; built ones are skipped). Data goes in `MMO_DATA_DIR`, else
`packages/engine-core/data`.

## Bake content

Bakes write into the data folder (`MMO_DATA_DIR`, else
`packages/engine-core/data`). `npm start` runs the first three when their
output is missing; run them yourself to rebake with other settings.

| Command | What it does |
|---|---|
| `npm run bake:world` | Bake the world (4 × 4 km terrain survey, chunk tiles, the spawn area's entities and scatter) into `world.db`. Refuses if one exists |
| `npm run bake:world:force` | Replace the existing world (stop the server first) |
| `npm run preview:world -- [spec.json] [out.png]` | Draw a world spec's biomes, rainfall, temperature and UV index to a PNG, without baking |
| `npm run loot:bake -- [--size 10000] [--seed 1] [--ranks f] [--catalog f] [--held f] [--out dir]` | Bake the loot pool (`loot/pool.jsonl` plus reports) |
| `npm run loot:rebake -w @mmo-engine/engine-core -- --db <world.db> --pool <pool.jsonl> [--size N] [--seed N]` | Rebake the loot pool, keeping every item players hold (stop the server first) |
| `npm run craft:report -- [--loot <dir>]` | Check crafting balance against the loot pool. Exits 1 on problems |
| `npm run dungeon:bake -- --n 10` | Add dungeons to the pool. Options: `--seed`, `--theme`, `--rooms 20-48`, `--loops`, `--decor`, `--rank 1-5`, `--fresh`, `--png`, `--empty`, `--bare`, `--no-shell`, `--out` |
| `npm run codegen` | Regenerate the FlatBuffers bindings from `packages/schema/mmo_engine.fbs` |

## Art and assets

The licensed art lives in `/assets/`, which is never committed.

| Command | What it does |
|---|---|
| `npm run convert:packs -- [--force] [--only <pack>] [--limit N]` | Convert source art packs (FBX) into GLB models, a manifest and a catalog |
| `npm run convert:modular -w @mmo-engine/art` | Build the modular hero rig and its parts |
| `npm run convert:animations -w @mmo-engine/art` | Retarget animation libraries onto the hero rig |
| `npm run surfaces:fetch -- [--from <dir>]` | Download the CC0 terrain surface textures for the client |

## Test and check

| Command | What it does |
|---|---|
| `npm test` | Every workspace's tests |
| `npm run build` | Build every workspace |
| `npm run editor:test` | The editor's tests |
| `npm run test:gateway -w @mmo-engine/engine-core` | The gateway and network tests |
| `npm run test:perf -w @mmo-engine/engine-core` | The save-latency budget test |
| `npm run test:addon-<name>` | One native addon's tests: `geometry`, `navigation`, `physics`, `picg`, `procgen` |
| `npm run valgrind:memcheck [-- <addon> ...]` | Every addon's tests under valgrind memcheck. Fails on our memory errors and leaks |
| `npm run valgrind:perf [-- --check \| --update]` | Instruction counts for the headless workloads against `perf/callgrind-baseline.json` |

A native addon change needs the addon rebuilt (`npx node-gyp rebuild` in
its folder) before engine-core's tests use it.

## Benchmarks and stress

| Command | What it does |
|---|---|
| `npm run sim` | The headless tick benchmark: 1,000 entities × 300 ticks, with a replication check |
| `npm run bench` | Tick-budget validation (bitECS plus C++ against pure C++) |
| `npm run bench:transport -w @mmo-engine/engine-core -- [clients…] [--seconds 8]` | uWebSockets.js against ws under game load |
| `npm run bench:e5 [-- B1 B4]` | The edge/core split benchmarks B1 to B6 (about 15 minutes). Writes `docs/EDGE-SPLIT-RESULTS.md` |
| `npm run stress:world [-- --window 30 --sweep 1,2,4,6,8 --entities 500 --players 40]` | World-server stress: regions per box until a stop condition breaks |

## Other servers

`npm start` boots the region server and the edge together (plus the
client, or the editor with `--dev`). These run each piece alone.

| Command | What it does |
|---|---|
| `npm run server` | The region (port 7777): the gateway players connect to, plus the simulation |
| `npm run edge` | The edge: client WebSocket (:3001) and HTTP (:3000), packet routing, `GET /metrics` |
| `npm run world` | The world server (port 7780): region registry, migration, system of record |
| `npm run world:db` | A local SurrealDB for the world server (needs `surreal` installed) |

The split topology, three terminals from the repo root:

```sh
npm run world                                  # the world server on :7780
WORLD_URL=http://127.0.0.1:7780 WORLD_API_KEY=dev-secret npm run server   # the region, registered
npm run edge                                   # the edge, linked over the core channel
```

Players still connect to the region (`ws://localhost:7777`, the login
screen's server URL) until the client cutover (E3b); the edge answers
`core.unavailable` for core-bound packets while no core serves the
channel. `curl localhost:3000/health` reports the link
(`{"ok":true,"core":"up"|"down"}`).

Prometheus and Grafana configs for `/metrics` are in `docs/prometheus/`
and `docs/grafana/`.

## Server environment

Set these before `npm start` or `npm run server`.

| Variable | Default | What it sets |
|---|---|---|
| `MMO_PORT` | 7777 | The game server's WebSocket port |
| `MMO_DATA_DIR` | `./data` (`packages/engine-core/data`) | World, characters, items, guilds, parties, quests, dungeon runs |
| `MMO_DEV_SERVER=1` | off | Every account is an admin (development only) |
| `MMO_ADMINS` | none | Comma-separated admin usernames |
| `MMO_ALLOW_REGISTER=0` | on | Turn off account creation from the client |
| `MMO_BOTS` | 0 | Computer-driven characters near the spawn (`MMO_BOTS_HOME`, `MMO_BOTS_RADIUS`) |
| `MMO_WILD_CREATURES=1` | off | Spawn the biome registry's creature packs as chunks load |
| `MMO_PLAYER_ABILITIES` | `swim` | `swim`, `swim,fly` or `none` |
| `MMO_DAY_SECONDS`, `MMO_DAY_OFFSET` | 2400, 0.35 | Day length (0 = always midday) and the time of day at start |
| `MMO_STREAM_RADIUS` | 8 | Chunks loaded round each player |
| `MMO_WORLD_RADIUS` | 1 | Spawn-area chunk radius, always loaded |
| `MMO_WORLD_SEED`, `MMO_CHUNK_SIZE` | 1234, 16 | World seed and chunk size (a baked world keeps its own seed) |
| `MMO_RULES`, `MMO_QUESTS`, `MMO_DUNGEONS`, `MMO_BIOMES`, `MMO_PCG_ASSETS` | the repo's `content/` | Content folders and files |
| `MMO_SCATTER`, `MMO_ECOLOGY` | ecology with the art, else pcg | What grows on new chunks |
| `MMO_TRANSPORT` | auto | `uws` or `ws` |
| `MMO_INSTANCE_HOST` | localhost | Host clients reach dungeon instances at |
| `WORLD_URL`, `WORLD_API_KEY`, `REGION_ID`, `REGION_CHUNK_RANGE`, `REGION_ENDPOINT`, `REGION_CAPACITY` | standalone | Register as a region with a world server |
| `CORE_CHANNEL_PORT` | 4000 | The edge's internal channel to the core |
| `EDGE_HTTP_PORT`, `EDGE_WS_PORT` | 3000, 3001 | The edge's HTTP and client WebSocket ports |

The full list with explanations is at the top of
`packages/engine-core/src/server.ts` and `packages/engine-core/src/bake-world.ts`.

## In game: the admin console

The editor's Play Mode debugger has an admin console. Commands work for
admin accounts: everyone on a server started with
`MMO_DEV_SERVER=1`, or the names in `MMO_ADMINS`. Type a command, then its
arguments as JSON (`teleport {"x":10,"z":-4}`), or `me` for yourself
(`inspect me`).

| Command | Arguments | What it does |
|---|---|---|
| `help` | | List the commands |
| `whoami` | | Your account and whether this is a dev server |
| `stats` | | Play telemetry: kills, deaths, pickups, damage, tick times |
| `inspect` | `{entity}` or `me` | Every component of an entity |
| `set` | `{entity, component, field, value}` | Change a numeric field |
| `spawnlist` | | What `spawn` can make |
| `spawn` | `{asset, x?, z?, yaw?}` | Spawn at you or at x, z |
| `despawn` | `{entity}` | Remove an entity (not a live player) |
| `teleport` | `{x, z, entity?}` | Move to x, z on the ground |
| `heal` | `{entity?}` | Fill health |
| `injure` | `{part, kind?, amount?, entity?}` | Wound a body part (`cut`, `blunt` or `thrust`) |
| `skill` | `{id, value, entity?}` | Set a skill |
| `fly` | `{on, entity?}` | Flight on or off |
| `items` | `{base?, rank?, source?}` | Count and sample item definitions |
| `give` | `{def? \| base?, rank?}` | A new item into your bag |
| `drop` | `{def? \| base?, rank?}` | A new item on the ground at you |
| `loot` | `{count?}` | Mob drops scattered round you |

## In game: chat commands

| Command | What it does |
|---|---|
| `/w <name> <message>` | Whisper (`/whisper`) |
| `/r <message>` | Reply to the last whisper (`/reply`) |
| `/p <message>` | Party chat (`/party`) |
| `/invite <name>`, `/kick <name>`, `/promote <name>`, `/accept`, `/leave` | Party |
| `/g <message>` | Guild chat (`/guild`) |
| `/gcreate <name> <tag>`, `/ginvite <name>`, `/gkick <name>`, `/grank <name> <rank>`, `/gmotd <text>`, `/gaccept`, `/gleave` | Guild |
| `/friend <name>`, `/unfriend <name>` | Friends |
| `/block <name>`, `/unblock <name>` | Blocks |

Say, yell and emote are the chat panel's tabs.

## In game: keys

The defaults. Every key except the mouse can be remapped in settings.

| Key | Action |
|---|---|
| W A S D (or arrows) | Move forward and back, strafe |
| Space, C | Jump or swim up, swim or fly down |
| F | Flight (when the server allows it) |
| Q | Dodge |
| Left mouse, right mouse (hold) | Attack, guard |
| R, T | Next technique (cut, thrust, bludgeon), next aim (torso, head, legs, arms) |
| E | Pick up, or talk to a quest giver |
| B | Bag |
| J | Quest log |
| H | Treat your worst wound |
| G | Cast Mend on yourself |
