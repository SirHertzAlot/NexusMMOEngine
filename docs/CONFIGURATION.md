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
| `MMO_BOTS` | `0` | Computer-driven characters near the spawn point. Two in three spar in pairs, the rest wander. Random looks from the part catalog. |
| `MMO_BOTS_HOME` | beside the spawn point | `"x,z"`: where the bots gather. |
| `MMO_BOTS_RADIUS` | `18` | How far from home they roam, metres. |
| `MMO_DAY_SECONDS` | `2400` (a 40-minute day) | Real seconds per game day. `0` = no day cycle: the server sends no day clock at all, and clients fall back to their own default. |
| `MMO_DAY_OFFSET` | `0.35` (mid-morning) | Time of day at tick 0, in 0..1 (must be `< 1`): `0` midnight, `0.25` dawn, `0.5` noon. |

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

## World bake

`npm run bake:world` (refuses to overwrite) or `npm run bake:world:force`
(stop the server first). The bake shares the server's `MMO_DATA_DIR`,
`MMO_WORLD_SEED`, `MMO_CHUNK_SIZE`, `MMO_TERRAIN_*`, `MMO_SCATTER` and
`MMO_ECOLOGY`, plus:

| Variable | Default | What it does |
|---|---|---|
| `MMO_WORLD_SPEC` | `worlds/default.world.json` | The world spec to bake. `none` bakes the legacy 3 × 3-chunk world. |
| `MMO_BAKE_RADIUS` | `1` | Spawn-area radius (chunks) that is populated at bake time. The rest fills in as players explore. |
| `MMO_BAKE_FORCE` | unset | `1` overwrites an existing `world.db` (same as `bake:world:force`). |
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
| `WORLD_DB_URL` | `mem:` | `mem:` = in-memory store (development, not durable). `ws://…` = a SurrealDB server (durable), e.g. `ws://127.0.0.1:8000/rpc`. |
| `WORLD_DB_NS` / `WORLD_DB_DB` | `mmo` / `world` | SurrealDB namespace and database. |
| `WORLD_DB_USER` / `WORLD_DB_PASS` | — | SurrealDB credentials (`root` / `root` with `npm run world:db`). |
| `WORLD_API_KEY` | unset | The bootstrap key regions register with. Unset = registration disabled. |
| `WORLD_HEARTBEAT_INTERVAL_MS` | `5000` | Region lease heartbeat interval. |
| `WORLD_HEARTBEAT_TIMEOUT_MS` | `15000` | A region silent this long is reaped. |

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

## Data files

Everything a server writes lives in its `MMO_DATA_DIR`. All of it is
git-ignored.

| File | Written by | What it holds |
|---|---|---|
| `world.db` | bake, server | SQLite (WAL). World snapshots (every 300 ticks and on shutdown), the terrain tiles, the survey maps (biome, water, climate), the contents of unloaded chunks, and world metadata (seed, spawn point, sea level). |
| `navmesh/` | server | The navmesh tile cache: content-addressed blobs (`sha256` names) and their registry, `navmesh.db`. |
| `characters.db` | server | SQLite: each account's characters (name and look). |
| `users.csv` | server, `seed:user` | Accounts: username and argon2id hash. Mode `0600`. |
| `surreal/` | bake | The embedded SurrealDB chunk catalog (region, biome, height range, river per chunk), shared with the world server. |

Sessions are in memory only: a server restart logs everyone out, and
accounts and characters survive.
