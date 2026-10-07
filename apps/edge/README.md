# Edge (`@mmo-engine/edge`)

The edge is the players' front door: the API layer in front of
engine-core. It accepts client WebSocket connections and HTTP requests,
routes every packet by its `type` through a data file, and answers.
engine-core stays pure simulation behind it, so a core crash or stall does
not drop player connections. Plan: [`docs/EDGE-CORE-SPLIT.md`](../../docs/EDGE-CORE-SPLIT.md)
(slices E1 and E2).

> **Core channel (E2):** core-bound packets travel over
> [`packages/channel`](../../packages/channel/README.md) to
> `CORE_CHANNEL_PORT`. The edge boots whether or not the core is running
> and keeps reconnecting in the background; while the core is
> unreachable every core-bound packet answers `core.unavailable`, and
> local routes keep working. Since E3 engine-core serves the channel
> beside its player port; players still connect to the core until the
> client moves onto the edge.

## Core streams

- `src/tick-buffer.ts`: the last 3600 ticks of the core's gameplay
  events from the `tick.events` push (`getTickBuffer()`), for content
  systems such as Q9's mythic evaluator.
- `src/mirror-buffer.ts`: the newest `snapshot` (every 300 ticks) and
  `tick.delta` (every tick), base64 FlatBuffers as pushed. A client the
  edge serves will get the latest snapshot first, then live deltas.

## Run

```sh
npm run edge                       # builds, then boots (also started by npm start)
curl localhost:3000/health         # {"ok":true,"core":"down"} until a core serves the channel
```

| Env | Default | What |
|---|---|---|
| `EDGE_HTTP_PORT` | 3000 | HTTP (`GET /health`) |
| `EDGE_WS_PORT` | 3001 | client WebSocket |
| `CORE_CHANNEL_PORT` | 4000 | internal core channel (loopback) |

Each must be an integer 1–65535; a bad value fails boot naming the
variable. SIGTERM/SIGINT stops accepting connections at once, closes the
servers after 5 s and exits 0.

## Packets

Client → edge, one JSON object per WebSocket message:
`{ "type": string, "id": string, "payload": any }`. The answer has the
same shape, the same `id` (`"none"` if the packet had no string id) and,
on success, the same `type`.

| Answer `type` | When |
|---|---|
| the packet's own type | routed and handled; `payload` is the result |
| `error.bad_packet` | not JSON (`"invalid JSON"`), or `type` is not a string |
| `error.unknown_packet` | no row for this `type` in routes.json (`payload.packetType` echoes it) |
| `error.unknown_module` | the row points at `local:<name>` but no module `<name>` is registered |
| `core.unavailable` | a core-bound packet could not reach the core: `{ retry: true, message: "The world is restarting. Your connection is safe — try again shortly." }` |
| `error.internal` | a local module threw |

`GET /health` → `{ "ok": true, "core": "up" | "down" | "unknown" }` (the
channel's status: `"unknown"` only before the first connection attempt
finishes).

## Degraded mode and resync (E4)

`src/lifecycle.ts` follows the channel's status:

- **Core down:** logs `core channel down at <ISO time>`. Nothing else
  changes: local routes (`local:*`) keep answering, and every core-bound
  packet answers `core.unavailable`. That is degraded mode. `/health`
  says `"core": "down"`.
- **Core back** (the channel goes from down to up): the edge asks
  `core.sync` (10 s timeout), drops every session token it learned from
  `auth.login` answers that the core no longer lists, logs
  `core resync complete at <ISO time> tick=<n> sessions=<m>`, and only
  then reports `"core": "up"`. If the sync fails it stays `"down"` with
  its sessions untouched; the reconnect loop brings the transition round
  again.
- Intents sent during an outage are **not** replayed: they are
  ephemeral, and the client re-sends per the contract below.

### Client contract

When the edge cannot reach the core it responds `{ type: "core.unavailable", id: <same id>, payload: { retry: true, message: "The world is restarting. Your connection is safe — try again shortly." } }`. Clients MUST: show a non-dismissible "reconnecting" banner on this packet; automatically retry the original action once after 3 seconds; never drop the WebSocket. (Client implementation is out of scope — this documents the contract the client team builds against.)

## Network health (E6)

`GET /metrics` on the HTTP port is the Prometheus scrape for the whole
engine, `Content-Type: text/plain; version=0.0.4`. It holds the edge's
metrics, the channel's edge side, and the core's metrics. The edge asks the
core for those with `metrics.get` every 15 s and caches the answer. While
that fails, the scrape has edge metrics only and `mmo_edge_core_metrics_stale 1`.

| Metric | Type | Meaning |
|---|---|---|
| `mmo_edge_ws_connections` | gauge | Open client WebSocket connections. |
| `mmo_edge_ws_connects_total` | counter | Client connections opened. |
| `mmo_edge_ws_disconnects_total` | counter | Client connections closed. |
| `mmo_edge_router_requests_total{packet_type}` | counter | Packets routed. Types not in `routes.json` count as `unknown`, and packets with no type as `none`, so clients cannot grow the label set. |
| `mmo_edge_router_errors_total{packet_type,error}` | counter | Error answers: `unknown_packet`, `bad_packet`, `unknown_module`, `core_unavailable`, or `internal` (a local module threw). |
| `mmo_edge_router_latency_ms{packet_type}` | histogram | From receiving a packet to having its answer, in ms. |
| `mmo_edge_mirror_deltas_fanned_out_total` | counter | Tick deltas the mirror buffer took in and handed on. Until the client cutover no players read them, so this counts deltas, not deltas × clients. |
| `mmo_edge_mirror_snapshot_age_ticks` | gauge | Newest delta's tick minus newest snapshot's tick (0–299 when healthy). |
| `mmo_edge_core_metrics_stale` | gauge | 1 while the core's metrics cannot be fetched. |
| `mmo_channel_*{side="edge"}` | | The channel's edge side (see `packages/channel/README.md`). |
| `mmo_core_tick` | gauge | The core's last tick. |
| `mmo_core_tick_duration_ms` | histogram | Each server tick's wall time (budget 33.3 ms). |
| `mmo_core_tick_events_pushed_total` | counter | `tick.events` pushes sent to the edge. |
| `mmo_core_intents_accepted_total` | counter | `player.intent` packets accepted over the channel. |
| `mmo_channel_*{side="core"}` | | The channel's core side. |

Histograms use fixed ms buckets (0.1 to 10 000, including 33.3). The plan
named `hdrhistogram-js`, but no such package is on npm, and Prometheus wants
fixed buckets anyway.

Network lifecycle events log one JSON object per line to stdout:
`{ "ts", "level", "component": "edge|channel|core", "event", ...fields }`.
The events are `ws.open`, `ws.close` (with `code`), `channel.up`,
`channel.down`, `channel.reconnect` (with `attempt`), `heartbeat.missed`
and `frame.oversized` (with `bytes`). The logger drops any field named like a
token, payload, password, secret, hash or username.

### Prometheus, Grafana, k6

Prometheus and Grafana run as their own binaries beside the engine.

```sh
# Prometheus scrapes the edge every 15 s.
prometheus --config.file=docs/prometheus/prometheus.yml
# Grafana: start it, add a Prometheus data source (http://localhost:9090),
# then Dashboards → Import → docs/grafana/dashboard.json.
grafana server --homepath /usr/share/grafana   # or: grafana-server on older installs
```

The one scrape target, `localhost:3000`, covers the edge and the core.
If you set `EDGE_HTTP_PORT`, change the target's port in
`docs/prometheus/prometheus.yml` to match. A future service follows the
same convention: expose the Prometheus format and add a scrape job.

The dashboard's alerts are documented on its panels, not provisioned:
- router p99 over 50 ms for 5 minutes;
- `mmo_channel_heartbeat_missed_total` increasing;
- snapshot age over 600 ticks.

The k6 WebSocket soak ramps 0→50 virtual users over 1 minute, holds for 3
minutes, then ramps down over 30 s. Each user pings every 200 ms and sends
one `player.intent` a second. It fails if ping p99 is 100 ms or more, or if
any `core.unavailable` comes back (set `CORE_DOWN=1` when the core is down
on purpose).

```sh
k6 run apps/edge/test/load/ws-soak.js            # EDGE_WS_URL=ws://host:3001 to aim elsewhere
```

Installing k6:
- Linux: `sudo apt install k6` after adding the Grafana apt repo (https://grafana.com/docs/k6/latest/set-up/install-k6/), or `snap install k6`.
- macOS: `brew install k6`.
- Windows: `winget install k6 --source winget` or `choco install k6`.

## `content/edge/routes.json`

```json
{ "routes": [
  { "packetType": "ping", "destination": "local:ping" },
  { "packetType": "player.intent", "destination": "core" },
  { "packetType": "auth.login", "destination": "core" }
] }
```

- `packetType`: non-empty string, unique across the file.
- `destination`: `"core"` (forward over the core channel) or
  `local:<module>` matching `^local:[a-z0-9_]+$` (a handler on the edge).
- No other keys. Loading is strict: one bad row fails boot, and the error
  lists every bad row.
- A row may point at a module that is not built yet; that packet answers
  `error.unknown_module` until the module is registered.

## Adding a module

1. Implement the handler in `src/modules/<name>.ts`:
   `(payload: unknown) => Promise<unknown> | unknown` (see `ping.ts`).
2. Register it in `src/index.ts`: add it to the `modules` map,
   `{ ping: pingHandler, <name>: <handler> }`.
3. Add a row to `content/edge/routes.json`:
   `{ "packetType": "<type>", "destination": "local:<name>" }`.

## Test

```sh
npm test --workspace=@mmo-engine/edge
```
