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
npm run server --workspace=@mmo-engine/edge   # builds, then boots
curl localhost:3000/health                    # {"ok":true,"core":"down"} until a core serves the channel
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
