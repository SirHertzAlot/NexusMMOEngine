# Configuration Reference

Every knob the engine reads, in one place. Everything is configured by
environment variables. There are no config files to edit, except content:
world specs, ecology plans, PCG graphs.

| Process | Start with | Default address |
|---|---|---|
| Game server (a region) | `npm run server` | `ws://localhost:7777` (+ HTTP `/rpc/Pcg` on the same port) |
| Browser client | `npm run client` | `http://localhost:5173` |
| Editor companion | `npm run editor` | `http://localhost:5174` |
| World server | `npm run world` | `http://localhost:7780` |
| SurrealDB (optional, durable world server) | `npm run world:db` | `127.0.0.1:8000` |

> Paths are relative to the process's working directory. `npm run server`
> and `npm run bake:world` run inside `packages/engine-core`, so the default
> data folder is `packages/engine-core/data`.
>
> PowerShell: `$env:MMO_BOTS = "10"` on one line, then `npm run server`.

---

## Game server

### World and data

| Variable | Default | What it does |
|---|---|---|
| `MMO_PORT` | `7777` | WebSocket listen port. The PCG asset service shares it (`/rpc/Pcg`). |
| `MMO_DATA_DIR` | `./data` | The server's state folder (see [Data files](#data-files)). |
| `MMO_SERVER_SETTINGS` | `content/server` | Server settings folder: `persistence.json` holds the save interval, snapshots kept, the save log limit and the database query caps; `world.json` holds the day length, the start time of day and the bots (count, home, roam radius). Both are edited in the editor's Live ops › Server settings. |
| `MMO_WORLD_SEED` | `1234` | Procedural seed. A baked world uses the seed recorded at bake time, and this is ignored. |
| `MMO_CHUNK_SIZE` | `16` | Chunk size in metres. Must match the bake. |
| `MMO_WORLD_RADIUS` | `1` | Spawn-area radius in chunks, always loaded (`1` = 3 × 3). |
| `MMO_STREAM_RADIUS` | `8` | Chunks loaded around each player (`8` = 17 × 17, 272 m, past the client's fog). |
| `MMO_TERRAIN_AMPLITUDE` | `2` | Height scale of the *legacy* (unbaked) terrain, metres. Must match the bake. |
| `MMO_TERRAIN_FREQUENCY` | `0.02` | Noise frequency of the legacy terrain, (0, 1]. Must match the bake. |

### Scenery

| Variable | Default | What it does |
|---|---|---|
| `MMO_SCATTER` | `ecology` if `assets/manifest.json` exists on this machine, else `pcg` | What grows on a chunk the first time it loads. `ecology`: natural placement of the art pack's nature set. `pcg`: the PCG forest graph with the engine's own PICG trees. See [WORLD-BUILDING.md](WORLD-BUILDING.md#scenery). |
| `MMO_ECOLOGY` | `wilds.ecology.json` in `packages/engine-core/content/ecology` | Another ecology plan file. The default is resolved relative to the package, **not** the working directory, so setting this path is only needed to use a different plan. |
| `MMO_PCG_ASSETS` | the repo's `content/pcg` | The PCG asset library the server cooks and serves. |

### Players and characters

| Variable | Default | What it does |
|---|---|---|
| `MMO_PLAYER_ABILITIES` | `swim` | What new players can do: `swim`, `swim,fly`, or `none` (walk only). |
| `MMO_CHARACTER_CATALOG` | the converted pack's `catalog.json` under `assets/` | The modular part catalog new characters' looks are checked against. Without it, looks are checked structurally only. |
| `MMO_ALLOW_REGISTER` | enabled | `0` turns off in-client account creation. **Turn it off before any public deployment.** |

### Life in the world

| Variable | Default | What it does |
|---|---|---|
| `MMO_BOTS` | `0` (or `world.json`) | Computer-driven characters near the spawn point. Two in three spar in pairs, the rest wander. Random looks from the part catalog. |
| `MMO_BOTS_HOME` | beside the spawn point (or `world.json`) | `"x,z"`: where the bots gather. |
| `MMO_BOTS_RADIUS` | `18` (or `world.json`) | How far from home they roam, metres. |
| `MMO_DAY_SECONDS` | `2400` (a 40-minute day; or `world.json`) | Real seconds per game day. `0` = no day cycle: the server sends no day clock at all, and clients fall back to their own default. |
| `MMO_DAY_OFFSET` | `0.35` (mid-morning; or `world.json`) | Time of day at tick 0, in 0..1 (must be `< 1`): `0` midnight, `0.25` dawn, `0.5` noon. |

### Game rules

| Variable | Default | What it does |
|---|---|---|
| `MMO_RULES` | the repo's `content/rules` | The rules folder: skills, disciplines, combat, body parts, death, appearance. Validated **first**, before the world loads; a bad file prints every problem and exits. See [ARCHITECTURE.md](ARCHITECTURE.md#game-rules-are-data). |

### Diagnostics

| Variable | Default | What it does |
|---|---|---|
| `MMO_PROF_SAVE` | unset | Any value: log the collect / encode / persist split of every save. |

### World-server registration

A game server becomes a *region* of a larger world when `WORLD_URL` is set.
It registers, heartbeats and reports snapshots off the tick loop, so a slow
or absent world server never stalls the simulation. Without `WORLD_URL` it
runs standalone, which is the normal development setup.

| Variable | Default | What it does |
|---|---|---|
| `WORLD_URL` | unset (standalone) | World server base URL, e.g. `http://localhost:7780`. |
| `WORLD_API_KEY` | — | Must match the world server's `WORLD_API_KEY`. |
| `REGION_ID` | `region-1` | This region's id. |
| `REGION_CHUNK_RANGE` | `0,0,4096,4096` | `"x0,z0,x1,z1"`: the chunks this region owns. When set, the streamer loads only inside it. |
| `REGION_ENDPOINT` | `ws://localhost:<MMO_PORT>` | The gateway URL advertised to the world. |
| `REGION_CAPACITY` | `1000` | Entity capacity, for load reporting. |

---

## Performance, transport and logging switches

Most of these are opt-in speed or safety switches. The defaults are the safe path; see [Performance and constraints](PERFORMANCE.md) for what each one buys and costs.

| Variable | Default | What it does |
|---|---|---|
| `MMO_DATA_PLANE` | off | `1` or `true` runs the three-thread data plane: gateway, then a lock-free input ring, then the 30 Hz sim worker, then a persistence worker. Unset runs the simulation in-process (the rollback path). |
| `MMO_DATA_PLANE_STORE` | the SurrealMX server | The data plane's ledger. `rocksdb` restores embedded RocksDB. Boot refuses to start if the default server is unreachable (start it with `npm run db -w @mmo-engine/world-server`). |
| `MMO_DATA_PLANE_DB` | `ws://127.0.0.1:8000/rpc` | The ledger's URL. `mem://` is a volatile in-memory store for benchmarks. An explicit value beats `MMO_DATA_PLANE_STORE`. |
| `MMO_DATA_PLANE_USER`, `MMO_DATA_PLANE_PASS` | `root` / `root` for a remote server | Credentials for the ledger server. Override them in anything but local development. |
| `MMO_TRANSPORT` | `auto` | `uws` forces uWebSockets.js, `ws` forces the pure-JavaScript fallback, `auto` uses uWS when its binary loads. |
| `MMO_EDGE` | off for a core started alone; `npm start` sets it | `1` runs the core's gateway on the edge channel, so a separate edge process serves the players. Native fan-out only runs on the core's own gateway, so it is off behind the edge ([NATIVE-FANOUT.md](NATIVE-FANOUT.md)). |
| `MMO_INTEREST` | on | `0` turns interest management off: every client gets the whole region's delta. Dungeon instances always see everything. |
| `MMO_NATIVE_FANOUT` | on | `0` keeps per-session delta assembly in JavaScript. The native path also falls back to JavaScript on its own if the addon is missing or a call throws. |
| `MMO_FANOUT_SHARE` | `assembly` | Sessions with byte-identical envelopes share one. `off` is the rollback; `publish` is experimental. |
| `MMO_UWS_CORK` | off | `1` batches each session's messages for a tick into one write on uWS. Not the default: its gate has not been run. |
| `MMO_SEND_CAP_BYTES` | off | A number of bytes. A session whose envelopes are smaller than that per tick covered is sent every second tick. |
| `MMO_SLOW_SOFT_BYTES` | `2097152` (2 MiB) | A client whose send queue passes this stops being sent to, and gets a fresh baseline once it catches up (slow-consumer policy). `0` turns the policy off. uWebSockets.js would otherwise buffer up to 64 MiB per socket and then drop sends silently. |
| `MMO_SLOW_LOW_BYTES` | `262144` (256 KiB) | A held client resumes, with a baseline, once its queue falls to this. |
| `MMO_SLOW_HOLD_MS` | `15000` | A client held longer than this is closed ("slow consumer"). |
| `MMO_POSITION_ROWS` | on | `0` stops splitting out position-only transform rows (protocol v29). |
| `MMO_LOG` | on | `0` starts no log worker; events are only counted as ring drops. Boot banners and fatal errors always go to the console. |
| `MMO_LOG_DIR` | `<data dir>/logs` | Where the log worker writes. |
| `MMO_HOST_ID` | the hostname | This host's id when the world assigns regions (assignment mode). |
| `MMO_RESIDENTS_MAX` | `800` | The most resident entities (people living in the towns) at once. |
| `MMO_RESIDENTS_FULL` | `300` | How many of them are simulated in full (`maxFull` in the residents system; see [SETTLEMENTS.md](SETTLEMENTS.md)). |

## Content file locations

Each of these points a content file or folder somewhere other than its default under `content/`.

| Variable | Default | What it points at |
|---|---|---|
| `MMO_CHARACTER_RULES` | `content/settlements/character.json` | The settlement character rules. |
| `MMO_LESSONS` | `content/lessons.json` | Lessons a pupil can take. |
| `MMO_SETTLEMENTS` | `content/settlements` | Settlement manifests. |
| `MMO_SPECIES_DIR` | `content/species` | Species definitions. |
| `MMO_STRUCTURES` | `content/structures.json` | Breakable structure kinds. |
| `MMO_VENDORS` | `content/vendors.json` | Shop templates placed in scenes. |

## More world-bake switches

| Variable | What it does |
|---|---|
| `MMO_BAKE_REGION=rx,rz` | Re-bake only one region's tiles (incremental). |
| `MMO_BAKE_SURVEY_ONLY=1` | Re-run the survey and invalidate the tile cache without regenerating tiles. |

The editor's play mode runs the built server directly. `MMO_EDITOR_REBUILD=1` (or no build yet) takes the slower `npm run server` path, which rebuilds every workspace first.

## Input limits: `content/rules/ingress.json`

How much a client may send before the server stops listening. This is the first line of defense against floods and forged input (the full boundary is in [the networking wiki chapter](wiki/05-networking-and-edge.md)).

| Setting | Value | Meaning |
|---|---:|---|
| `maxClientPayloadBytes` | 65536 | The largest message the server accepts from a client |
| `intentsPerSecond`, `intentBurst` | 40, 60 | A token bucket for player intents: refilled at this rate, holding at most the burst |
| `pickupsPerSecond`, `pickupBurst` | 5, 10 | The same for the "pickup" bucket, which also covers duels, trades, treatment and stance changes |
| `abuseWindowSeconds`, `maxViolations` | 10, 100 | A client that is rate-limited or malformed this many times inside the window is **disconnected** ("too many requests"), once per window |

## More server and tool variables

These were documented only in the server's source header and the bake script. Defaults are paths relative to the repo.

### Accounts and admin

| Variable | Default | What it does |
|---|---|---|
| `MMO_USERS_CSV` | `$MMO_DATA_DIR/users.csv` | The accounts file. The editor points play sessions at a scratch file. |
| `MMO_ADMINS` | empty (nobody) | Comma-separated usernames allowed to use the admin console (message `0x10`). |
| `MMO_DEV_SERVER` | off | `1` makes **every account an admin**. Development servers only; never on a public deployment. |
| `MMO_SPAWN_OVERRIDE` | the world's stored spawn point | `x,z` for the player spawn point. The editor's Play menu "Start from" uses it. |

### Content a server loads at boot

| Variable | Default | What it points at |
|---|---|---|
| `MMO_COMBAT` | `content/combat/moves.json` | The combat moves. |
| `MMO_CRAFTING` | `content/crafting/recipes.json` | Crafting rules. A missing file means no crafting; a bad file stops the boot. |
| `MMO_QUESTS` | `content/quests` | Quest and dialog content. A missing folder means no quests, not a boot failure. |
| `MMO_DUNGEONS` | `content/dungeons` | Dungeon instance rules and entrances. A missing folder means no dungeons. |
| `MMO_MODULES` | `content/modules.json` | The enabled module set. The `core` module is always on; a bad set stops the server and names every problem. |
| `MMO_BIOMES` | `content/biomes.json` (not in a fresh checkout) | The biome registry: per-biome scatter multipliers and creature tables. |
| `MMO_SPECIES` | `content/species/species.json` | The species overlay, merged over the built-in roster. A bad file stops the boot. |
| `MMO_SCENE` | none | A scene (`content/scenes/<name>.scene.json`) whose nodes spawn at boot as creatures, props, items and quest posts. A comma-separated list spawns each; `world` spawns every baked town plus places. |
| `MMO_SCENES`, `MMO_SCENES_DIR` | `content/scenes` | The scenes folder (the two names are aliases; `bake:all` uses the second). |
| `MMO_PREFABS` | `content/prefabs` (absent unless you create it) | The prefab files scenes expand. |
| `MMO_INSTANCE_HOST` | `localhost` | The host clients use to reach dungeon instances. Each instance listens on its own free port. |

### Wildlife

| Variable | Default | What it does |
|---|---|---|
| `MMO_WILD_CREATURES` | off | `1` spawns the biome registry's packs as chunks load (on a baked world with biomes). Only kinds with creature rules spawn. |
| `MMO_WILDLIFE` | off | With `MMO_WILD_CREATURES=1`: `1` plans the wildlife table (`content/wildlife/wildlife.json`) or give a file. See [WILDLIFE.md](WILDLIFE.md). |
| `MMO_WILDLIFE_LOG` | off | `1` logs each pack spawned. |

### Bakes and paths

These apply to `npm run bake:all` and the settlement tools. A flag on the command wins over the variable; relative values resolve from where you ran npm.

| Variable | Default | What it does |
|---|---|---|
| `MMO_REPO` | the repo root | The checkout the other paths are relative to. |
| `MMO_CONTENT_DIR` | `<repo>/content` | Where authored content lives. Settlement rules stay with the repo even if this moves. |
| `MMO_ASSETS_DIR` | `<repo>/assets` | The art folder (present only where the licensed art is). |
| `MMO_CATALOG` | `<assets>/catalog.json` | The art catalog. |
| `MMO_SETTLEMENT_OUT` | `<content>/settlements` | Where baked settlements are written and read. |
| `MMO_SETTLEMENT_RULES` | `content/settlements/rules.json` | The town generator's rules file (the editor's Towns screen edits it). |
| `MMO_SCALE_OUT` | `<content>/scale.local.json` | Where `scale-fit` writes the fitted model scales (gitignored). |
| `MMO_SCALE` | none | Run the server with this file (`content/scale.local.json`) to apply the fitted model scales. |
| `MMO_BAKE_SHAPE` | the bake default | The landmass shape: `island`, `peninsula`, `continents` or `pangaea` (same as `--shape`). |
| `MMO_BAKE_SIZE_CHUNKS` | the bake default | The world's side in chunks (same as `--size-chunks`). |
| `MMO_ORDERED_BUILD` | unset | Set by the build orchestrator when it builds in dependency order, so each package's own dependency build does nothing. Not something you set by hand. |

## World bake

`npm run bake:world` (refuses to overwrite) or `npm run bake:world:force`
(stop the server first). The bake shares the server's `MMO_DATA_DIR`,
`MMO_WORLD_SEED`, `MMO_CHUNK_SIZE`, `MMO_TERRAIN_*`, `MMO_SCATTER` and
`MMO_ECOLOGY`, plus:

| Variable | Default | What it does |
|---|---|---|
| `MMO_WORLD_SPEC` | `worlds/default.world.json` | The world spec to bake. `none` bakes the legacy 3 × 3-chunk world. |
| `MMO_BAKE_RADIUS` | `1` | Spawn-area radius (chunks) that is populated at bake time. The rest fills in as players explore. |
| `MMO_BAKE_FORCE` | unset | `1` overwrites an existing `region.db` (same as `bake:world:force`). |
| `MMO_WORLD_CATALOG` | enabled | `0` skips writing the SurrealDB chunk catalog (`<data>/surreal`). |

Preview without baking: `npm run preview:world -- [spec.json] [out.png]`.

---

## Accounts from the command line

```bash
MMO_DEV_PASSWORD='a-long-password' npm run seed:user --workspace=@mmo-engine/engine-core -- <username> [--csv <path>]
```

The password comes only from the environment (never an argument) and is
never printed; only its argon2id hash is stored. 8–128 characters.

---

## World server

| Variable | Default | What it does |
|---|---|---|
| `WORLD_PORT` | `7780` | HTTP listen port. |
| `WORLD_DB_URL` | `surrealkv:<WORLD_DATA_DIR>/surreal` | Unset = embedded SurrealKV (durable). `mem:` = plain JS in-memory store (development, not durable). `mem://…` = embedded SurrealMX (in memory only, not durable). `ws://…` = a SurrealDB server, e.g. the SurrealMX server from `npm run db -w @mmo-engine/world-server` (durable via AOL + snapshots), `ws://127.0.0.1:8000/rpc`. |
| `WORLD_DB_NS` / `WORLD_DB_DB` | `mmo` / `world` | SurrealDB namespace and database. |
| `WORLD_DB_USER` / `WORLD_DB_PASS` | — | SurrealDB credentials (`root` / `root` with `npm run world:db`). |
| `WORLD_API_KEY` | unset | The bootstrap key regions register with. Unset = registration disabled. |
| `WORLD_HEARTBEAT_INTERVAL_MS` | `5000` | Region lease heartbeat interval. |
| `WORLD_HEARTBEAT_TIMEOUT_MS` | `15000` | A region silent this long is reaped. |
| `WORLD_DB_CONNECT_TIMEOUT_MS` | `10000` | Bound on the SurrealDB connect handshake. Unset or not a positive number means the default. |
| `WORLD_MIGRATION_TIMEOUT_MS` | `10000` | A hand-off not committed within this expires, and the source region keeps the entity. |
| `WORLD_TOTAL_CHUNK_SPACE` | `0,0,4096,4096` | `x0,z0,x1,z1`: the total world chunk space the assignment policy carves region ranges from. |
| `WORLD_HOST_REPORT_TIMEOUT_MS` | the heartbeat timeout | How long a host's resource report stays fresh for assigning ranges. |
| `HOST_REPORT_INTERVAL_MS` | `5000` | How often the host sidecar reports its resources to the world server. |
| `WORLD_DEDUP_RETENTION_MS` | 7 days | How long the world server remembers operation ids so a retried write is applied once. |
| `WORLD_LOG` | on | `0` starts no log worker. Boot banners and fatal errors stay on the console. |
| `WORLD_LOG_DIR` | `data/logs` | Where the world server's log worker writes. |

---

## Client and editor

| Setting | Where | What it does |
|---|---|---|
| Server URL | Login screen | Defaults to `ws://localhost:7777` (`wss://` when the page is served over HTTPS). |
| `?preview=character` | Client URL | The character creator with no server, for working on looks and the creation UI. |
| Port | `npm run client -- --port <n>` | Vite's port (default 5173). |
| Screen effects | HUD button | **effects off** renders without post-processing, for weak GPUs. |

The editor's Play Mode and Terrain panels use the same world folder as
`npm run server` (`packages/engine-core/data`).

---

## Art tools

Run from the repo root. `convert:packs` builds the art package itself; for
the other two, run `npm run build -w @mmo-engine/art` first.

| Command | Flags |
|---|---|
| `npm run convert:packs` | `-- --force` (reconvert everything), `-- --only <pack>`, `-- --limit <n>` |
| `npm run convert:modular -w @mmo-engine/art` | `-- --assets <dir>` |
| `npm run convert:animations -w @mmo-engine/art` | `-- --assets <dir>` |
| `npm run surfaces:fetch` | `-- --from <dir>` (use an already downloaded copy) |

See [ART-PIPELINE.md](ART-PIPELINE.md).

---

## Tools, benchmarks and smoke tests

Variables read by the repo's scripts and helper tools, not by a running game.

| Variable | Default | Used by |
|---|---|---|
| `BOT_WS_URL` | `ws://localhost:7777` | The admin bot launcher: the server the bots connect to. |
| `BOT_USERNAME_PREFIX`, `BOT_PASSWORD` | `bot`, `bot-password` | The same: the names and password the bot accounts use. |
| `GLTFPACK_BIN` | `gltfpack` on your PATH | The art pipeline's mesh compression. |
| `GLTF_TRANSFORM_BIN` | `gltf-transform` on your PATH | The art pipeline's glTF transforms. |
| `LOG_CODEGEN_OUT` | the source folder | `dist` makes the logging code generator write to `dist` instead. |
| `OUT_DIR` | the generated folder | `npm run codegen`: write the generated bindings elsewhere, for a reproducibility check. |
| `SURREAL_BIN` | `surreal` on your PATH | The fleet boot smoke test. |
| `BOOT_SMOKE_PORT`, `BOOT_SMOKE_KEEP` | `7917`, off | The boot smoke test: its port, and `1` keeps its scratch folder. |
| `EDITOR_SMOKE_PORT`, `EDITOR_SMOKE_CHROMIUM` | `5176`, a bundled Chromium path | `npm run smoke:editor-load`: the dev server's port and the browser it opens. |
| `VALGRIND_WATCH_WORKTREE` | a `<repo>-watch` folder beside the repo | The valgrind watcher's separate worktree. |
| `VALGRIND_WATCH_SKIP_PIPELINE` | off | `1` skips the pipeline step in the watcher's test. |
| `PERF_JSON` | off | Set by `valgrind:perf` so the workloads print one machine-readable line. |
| `BENCH_DB_URL`, `BENCH_DB_USER`, `BENCH_DB_PASS` | `mem://` | The data-plane benchmark's ledger: embedded in memory, or a SurrealMX server. |
| `WORLD_BENCH_URL` | `mem://` | The world server's atomic-operations benchmark: `ws://127.0.0.1:8000/rpc` runs it against a server. |
| `SYNTHESIS_ARTIFACTS`, `SYNTHESIS_CHROMIUM` | a temp folder, Playwright's | The synthesis package's example and chart renderers. |
| `PAPERCLIP_API_URL` and the other `PAPERCLIP_*` | unset | The improvement crawler can post its report to a task tracker when these are set. |

## Data files

Everything a server writes lives in its `MMO_DATA_DIR`. All of it is
git-ignored.

| File | Written by | What it holds |
|---|---|---|
| `region.db` | bake, server | SQLite (WAL). World snapshots (every 300 ticks and on shutdown), the terrain tiles, the survey maps (biome, water, climate), the contents of unloaded chunks, and world metadata (seed, spawn point, sea level). |
| `navmesh/` | server | The navmesh tile cache: content-addressed blobs (`sha256` names) and their registry, `navmesh.db`. |
| `characters.db` | server | SQLite: each account's characters (name and look). |
| `users.csv` | server, `seed:user` | Accounts: username and argon2id hash. Mode `0600`. |
| `surreal/` | bake | The embedded SurrealDB chunk catalog (region, biome, height range, river per chunk), shared with the world server. |

Sessions are in memory only: a server restart logs everyone out, and
accounts and characters survive.
