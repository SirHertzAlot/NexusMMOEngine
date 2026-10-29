# @mmo-engine/world-server

The world server: a small, durable, separately-deployable Express service
that acts as the system of record for everything *global* or
*cross-region* — region registry and liveness, (slice B) migration
arbitration, accounts (slice C), global services (later). It never
simulates, never ticks, and never talks to game clients.

Design rule: **the core knows nothing about transports.** `WorldCore`
is a plain TypeScript interface; `src/adapters/webrpc.ts` is the first
transport adapter (webrpc JSON over HTTP, per `world.ridl`). Adding a
queue consumer or an embedded in-process stub later means writing an
adapter, never touching the core.

## Run

```bash
# zero-config dev (in-memory store, NOT durable)
npm run server --workspace=@mmo-engine/world-server

# durable dev: terminal 1 — SurrealMX server (needs the `surreal` binary, SurrealDB ≥3.0, on PATH)
npm run world:db
# terminal 2 — world server against it
WORLD_DB_URL=ws://127.0.0.1:8000/rpc WORLD_DB_USER=root WORLD_DB_PASS=root \
  WORLD_API_KEY=<secret> npm run world
```

Register a region (an engine instance becomes a region when `WORLD_URL`
is set):

```bash
WORLD_URL=http://localhost:7780 WORLD_API_KEY=<secret> REGION_ID=region-1 \
  REGION_CHUNK_RANGE="0,0,4096,4096" npm run server --workspace=@mmo-engine/engine-core
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `WORLD_PORT` | `7780` | HTTP listen port |
| `WORLD_DB_URL` | `surrealkv:<WORLD_DATA_DIR>/surreal` | unset = embedded SurrealKV (durable); `mem:` = plain JS store (dev/stress, not durable); `mem://…` = embedded SurrealMX (not durable); `ws://…` = SurrealDB server — `npm run db` starts a SurrealMX server (AOL + snapshot durable) |
| `WORLD_DB_NS` / `WORLD_DB_DB` | `mmo` / `world` | SurrealDB namespace/database |
| `WORLD_DB_USER` / `WORLD_DB_PASS` | — | SurrealDB credentials |
| `WORLD_API_KEY` | — | Bootstrap key regions register with; unset = registration disabled |
| `WORLD_HEARTBEAT_INTERVAL_MS` | `5000` | Lease heartbeat interval |
| `WORLD_HEARTBEAT_TIMEOUT_MS` | `15000` | Stale-region reaping threshold |
| `WORLD_MIGRATION_TIMEOUT_MS` | `10000` | A migration not committed within this expires; the source keeps the entity |

Region side (`engine-core`): `WORLD_URL`, `WORLD_API_KEY`, `REGION_ID`
(default `region-1`), `REGION_CHUNK_RANGE` (`"x0,z0,x1,z1"`, default
`"0,0,4096,4096"`), `REGION_ENDPOINT` (default
`ws://localhost:<MMO_PORT>`), `REGION_CAPACITY` (default `1000`).

## API

webrpc JSON: `POST /rpc/World/<Method>` with `Content-Type:
application/json`. `RegisterRegion` bootstraps with the `apiKey` in
the body; every other method needs `Authorization: Bearer <token>`
from the lease. Errors are `{code, msg}` with the HTTP status.
`GET /healthz` for probes. See `world.ridl` — the contract source of
truth.

## Migration (slice B)

The world arbitrates border hand-offs (spec §6); it never moves entities
itself.

| Method | Who may call | What it does |
|---|---|---|
| `ListRegions` | any region | Every region's id, chunk range, endpoint and liveness. Regions re-fetch it when `registryVersion` in a heartbeat ack changes. |
| `BeginMigration` | the source | Records the entity state (a JSON object, at most 64 KiB) as `begun`. One open migration per entity; the target must be live. |
| `GetMigration` | source or target | The record, entity state included. The target reads the state from here, which is also its backstop when the source has died. |
| `CommitMigration` | the target | `begun` → `committed`: the target has authority. A repeat is fine; after expiry or abort it is a 409. |
| `AbortMigration` | source or target | `begun` → `aborted`, with a reason. Fine on an aborted or expired one, 409 on a committed one. |

`begun` migrations older than `WORLD_MIGRATION_TIMEOUT_MS` become
`expired` (a timer, which also recovers migrations left by a crash).
Commit and expiry are compare-and-set on `begun`, so exactly one wins.
Every heartbeat ack lists the region's migrations that are `begun` or
resolved within the last minute; regions treat repeats as no-ops.
Mutating calls carry an `opId` and are deduplicated.

The region side is `MigrationCoordinator` in engine-core
(`src/world/migration.ts`). It begins hand-offs for entities standing in
another live region's chunks, aborts them when the entity walks back,
drops the entity when the ack says `committed`, takes incoming entities
(`accept`) and backs up a dead source.

