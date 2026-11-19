# Operations

How to run the engine as a set of processes: what listens where, how to tell it is healthy, where its state and logs live, what happens when something fails, and what to protect. Written 2026-11-11 from the code. Where the repository has nothing (backup tooling, TLS handling), this page says so.

For capacity and limits see [PERFORMANCE.md](PERFORMANCE.md). Every setting is in [CONFIGURATION.md](CONFIGURATION.md).

## The processes

| Process | Started by | What it is |
|---|---|---|
| **Core** (a region) | `npm run server`, or `npm start` | The authoritative simulation: tick loop, world, persistence. One per region. |
| **Edge** | `npm run edge`, or `npm start` | The players' front door. Under `npm start` the core is started with `MMO_EDGE=1` and the edge serves the players' port. |
| **World server** | `npm start -- --world` | Region registry, leases, hand-offs and the world-level store. Optional; without it a region runs standalone. |
| **SurrealMX server** | `npm run db -w @mmo-engine/world-server` | The durable ledger for the data plane (`MMO_DATA_PLANE=1`). Needs the `surreal` binary on your PATH. |
| **Client / editor** | `npm start` / `npm start -- --dev` | Dev servers for the player client and the editor. Not part of a deployment. |

**Start order.** `npm start` does it for you: the world server first (with `--world`), then the core, then the edge once the core prints `listening on`, then the client once the edge serves its port. By hand, start the ledger server (if you use the data plane) and the world server before regions, and the core before the edge: the edge's channel needs the core.

## Ports

| Port | What | Set by |
|---:|---|---|
| 7777 | Players' WebSocket and HTTP. Under `npm start` the edge serves it; a core started alone serves it itself | `MMO_PORT` (and `EDGE_GAME_PORT` for the edge) |
| 3000 | The edge's HTTP: `/health`, `/metrics`, `/api/edge/modules` | `EDGE_HTTP_PORT` |
| 3001 | The edge's WebSocket for routed packets | `EDGE_WS_PORT` |
| 4000 | The core's internal channel for the edge. **Loopback only** | `CORE_CHANNEL_PORT` |
| 7780 | The world server's HTTP (webrpc and `/healthz`) | `WORLD_PORT` |
| 8000 | The SurrealMX server (`ws://127.0.0.1:8000/rpc`) | `npm run db` |
| 5173, 5174 | The player client and the editor, in development | Vite |
| a free port each | Dungeon instances, each on its own port, reached at `MMO_INSTANCE_HOST` | automatic |

Only 7777 (and the world server's port between your own hosts) should be reachable from outside. The channel on 4000 is bound to `127.0.0.1` by design.

## Is it healthy?

- **Edge:** `GET :3000/health`. If the core is unreachable the edge answers the players `core.unavailable`, refuses new sockets with close code 1013, closes open ones with 1012 and answers HTTP with 503.
- **World server:** `GET :7780/healthz` returns `{ "ok": true }`.
- **Metrics:** `GET :3000/metrics` is the Prometheus scrape for the whole engine: the edge's own (`mmo_edge_*`, such as router requests, errors and latency, and WebSocket connects and disconnects), the channel's (`mmo_channel_*`), and the core's, relayed. `mmo_edge_core_metrics_stale` says the core's numbers are old. Prometheus and Grafana configuration is in `docs/prometheus/` and `docs/grafana/dashboard.json`.
- **The tick itself:** the sim keeps atomic telemetry (last and maximum tick time, budget overruns, spiral events, dropped milliseconds). A region that falls behind does not spiral: it drops what it cannot catch up on and counts it. Watch the dropped-milliseconds and spiral-event counters.
- **Slow clients and abuse:** the gateway counts slow-consumer holds, releases and closes, and abuse disconnects. See [CONFIGURATION.md](CONFIGURATION.md) for the limits.

## Where state lives

Each core keeps its state in its data folder (`MMO_DATA_DIR`, default `./data` from where it was started):

| File | Holds |
|---|---|
| `region.db` | The region's hot cache: baked terrain, chunk entities, formation tiles, sessions and tokens, and the item ledger. SQLite in WAL mode; a full snapshot every 300 ticks, saved on shutdown and restored on boot |
| `characters.db` | Characters and their saved state |
| `economy.db` | Gold balances |
| `social.db`, `parties.db`, `guilds.db` | Friends and blocks, parties, guilds |
| `quests.db` | Quest logs |
| `gathering.db` | Resource node stocks and materials pouches |
| `places.db` | Place state, including the record of fallen residents |
| `instances.db` | Dungeon runs, including results not yet reported to the world server |
| `admin.db` | The log of edits made through the editor's Database workspace, with before-images (`admin_log`). It is never a game file |
| `users.csv` | Accounts. Passwords are stored only as argon2id hashes; `MMO_USERS_CSV` moves it |
| `navmesh/`, `dungeons/`, `logs/` | Navigation meshes, the baked dungeon pool, and the logs |

The world server keeps the world-level store in its own data folder (`WORLD_DATA_DIR`): embedded SurrealKV by default, or a server through `WORLD_DB_URL`. A region is a **hot cache** when a world server is configured: the world is the source of truth for world-level records.

**Backups.** The repository has no backup tooling. The files above are what to protect. Copy SQLite files with the process stopped, or with SQLite's own backup mechanism, not by copying a live WAL database. Keep `users.csv` and the world store with at least the care you give anything holding credentials.

## Logs

- Steady-state events go through a lock-free ring to a dedicated **log worker**, which writes batched lines to `<data dir>/logs/engine.log` (the world server writes to `data/logs`; `MMO_LOG_DIR` and `WORLD_LOG_DIR` move them). Files rotate at 10 MiB and the five newest are kept (`engine.log`, `engine.1.log`, and so on). A failing disk drops the batch and counts the error; it can never slow the tick.
- **Boot banners and fatal errors go to the console on purpose**, so they are visible even if the log worker is not up. `MMO_LOG=0` (`WORLD_LOG=0`) starts no worker, and events are then only counted.
- **Levels can be changed while running** with the admin command `loglevel`, per producer or for all (see [ADMIN-COOKBOOK.md](ADMIN-COOKBOOK.md)).
- The design is in [SAB-LOGGING-LAYER-SPEC.md](SAB-LOGGING-LAYER-SPEC.md).

## When something fails

| Failure | What happens |
|---|---|
| The core crashes or restarts | The edge refuses new sockets (1013) and closes open ones (1012); clients reconnect. Open sockets are not held through a core restart yet. State comes back from `region.db` |
| The edge crashes or restarts | The core keeps simulating. In the edge drills a crash, restart or freeze on either side left no request hung |
| The sim worker dies (`MMO_DATA_PLANE=1`) | Client sockets stay open, and the worker can be restarted without losing state |
| The ledger server is unreachable at boot (data plane) | The core **refuses to start**. A write that fails mid-run does not slow a tick, because the sim only enqueues |
| The world server is unreachable | Regions keep ticking. Hand-offs and world calls that need it are refused and nothing moves; a trade across the world tier is refused. Regions retry registering with backoff |
| A client stops reading | The gateway stops sending to it above a size limit, resumes with a fresh baseline when it catches up, and closes it after a timeout (the slow-consumer policy) |
| A client floods | Rate limits drop the excess, and a client that trips them too often is disconnected |
| A hand-off does not commit in 10 s | It expires and the source region keeps the player (`WORLD_MIGRATION_TIMEOUT_MS`) |

A hung core is caught by the edge's heartbeat in about 19 seconds at the defaults (`heartbeatMs` times `maxMissed`, plus a partial first interval).

## Security checklist

- **Never set `MMO_DEV_SERVER=1` on a public server.** It makes every account an admin. List real admins in `MMO_ADMINS`.
- **Set `WORLD_API_KEY`** on the world server and give every region the same key. Unset, registration is disabled.
- **Change the ledger credentials.** The data plane connects to a remote SurrealMX server as `root` / `root` unless `MMO_DATA_PLANE_USER` and `MMO_DATA_PLANE_PASS` say otherwise.
- **TLS.** I found no TLS handling in `apps/edge`: it serves plain `ws` and HTTP. Terminate TLS in front of it with your usual proxy.
- **Keep 4000 and 8000 off the network.** The channel is loopback-only; the SurrealMX server should only be reachable by the core.
- **Input limits** (`content/rules/ingress.json`): a maximum message size, token buckets for intents and pickups, and disconnect after repeated violations. Tune them if your clients legitimately send more.

## Related

- [GETTING-STARTED.md](GETTING-STARTED.md): a first run.
- [wiki chapter 5](wiki/05-networking-and-edge.md) and [EDGE-CORE-SPLIT.md](EDGE-CORE-SPLIT.md): the networking design.
- [WORLD-SERVER-SPEC.md](WORLD-SERVER-SPEC.md) and [WORLD-STRESS-RESULTS.md](WORLD-STRESS-RESULTS.md): regions and their limits.
