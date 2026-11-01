# Channel (`@mmo-engine/channel`)

The private link between the edge (`apps/edge`) and engine-core: framed
JSON (and raw bytes, E5a) over one TCP connection, request/response matched by id, pushes from
the core, heartbeats and reconnect backoff. Slice E2 of
[`docs/EDGE-CORE-SPLIT.md`](../../docs/EDGE-CORE-SPLIT.md). The edge uses
`ChannelClient`; E3 wires the core side (`serveChannel`).

## Frame

```
 0        4                         4 + len
 +--------+-------------------------+
 | len    | UTF-8 JSON (len bytes)  |   len: uint32, big-endian
 +--------+-------------------------+
```

One frame is one packet. A body over 8 MiB (8388608 bytes) throws
`frame exceeds 8 MiB` when encoding, and a declared length over that is
refused when reading. A complete frame that is not valid JSON throws
`invalid frame JSON`; the reader's owner closes that socket (the server
keeps serving everyone else).

### Binary frames (E5a)

A packet that carries bytes (any `Uint8Array`, Buffers included) is sent
as a binary frame, with the bytes raw instead of base64 inside JSON:

```
 len (uint32 BE) | 0x00 | envLen (uint32 BE) | envelope JSON (envLen bytes) | blob 0 | blob 1 | ...
```

The first body byte is `0x00`, which JSON text never starts with, so a
reader tells the two kinds apart. The envelope is `{"o": packet, "b": [sizes]}`. Each blob's place in the packet is a
`{"$bin": i}` reference (`$bin` is reserved for that); the reader puts a
`Buffer` back in its place. A packet with no bytes is an ordinary JSON
frame, so both kinds share one stream.

## Packets

```ts
interface ChannelPacket   { type: string; id: string; payload: unknown; }
interface ChannelResponse { type: string; id: string; payload: unknown; error?: string; }
```

- **Request** (edge → core): the core answers with the same `type` and
  `id`. A handler that throws answers `error: <message>`, and the
  client's `request` rejects with that message.
- **Push** (either way): the `id` starts with `push-`. Pushes are never
  answered. The core sends them with `pushToAll(type, payload)` and the
  edge receives them with `onPush(type, handler)`; the edge can send one
  with `notify(type, payload)`.
- **Heartbeat**: the client sends `{ type: "channel.ping", id: "hb-<n>" }`;
  the server answers `channel.pong` with the same id.

Ids: the caller's request id travels end to end (the router passes the
client packet's id). On the wire it is sent as `req-<n>:<id>` so that two
callers using the same id (every client counts from 1) cannot be confused.
Internal ids (`req-`, `push-`, `hb-`) share one counter starting at 0.
Nothing in the package uses randomness.

## Client behaviour

`new ChannelClient({ port, host = "127.0.0.1", heartbeatMs = 5000, maxMissed = 3 })`

| | |
|---|---|
| `status` | `"unknown"` until the first attempt, then `"up"` or `"down"`; `onStatus(cb)` hears every change |
| `connect()` | resolves on TCP connect; rejects if that first attempt fails, while reconnecting carries on in the background |
| `request(type, payload, id, timeoutMs = 5000)` | rejects `channel down` at once when not up; rejects `channel timeout after <ms>ms for <type>` when unanswered; pending requests reject `channel down` when the connection drops |
| heartbeat | every `heartbeatMs` while up, a ping is sent; an interval with no inbound frame counts as missed, any frame resets the count, `maxMissed` in a row destroys the socket (15 s to detect a dead core at the defaults) |
| reconnect | 1000, 2000, 4000, 8000, 16000 ms, then 30000 ms each time after; reset on a successful connect; no jitter |
| `close()` | stops for good: no reconnect |

## Server

`serveChannel(port, handler, host = "127.0.0.1", observers = {})` resolves to
`{ port, pushToAll(type, payload), close() }`. It binds loopback by
default: the channel is private to the machine.

## Metrics and logs (E6)

`channelMetrics(registry)` registers the channel's metrics on a
`@mmo-engine/nethealth` registry; pass the result as `metrics` to
`new ChannelClient({ ... })` or in `serveChannel`'s `observers`. Every series
carries `side="edge"` (the client) or `side="core"` (the server), so one
scrape can hold both ends.

| Metric | Type | Edge side counts | Core side counts |
|---|---|---|---|
| `mmo_channel_requests_total` | counter | requests sent | requests answered (not pings or notifies) |
| `mmo_channel_timeouts_total` | counter | requests that timed out | — |
| `mmo_channel_errors_total` | counter | error answers, and requests failed by the channel dropping | handler throws |
| `mmo_channel_request_latency_ms` | histogram | round trip of answered requests | handler time |
| `mmo_channel_pushes_total{type}` | counter | pushes received | pushes sent (once per push, whatever the edge count) |
| `mmo_channel_bytes_sent_total` | counter | bytes written, headers included | same |
| `mmo_channel_bytes_received_total` | counter | bytes read | same |
| `mmo_channel_reconnects_total` | counter | reconnect attempts | — |
| `mmo_channel_heartbeat_missed_total` | counter | heartbeat intervals with nothing received | — |

Pass a `log` (`netLogger(...)`) for the lifecycle lines: `channel.up`,
`channel.down`, `channel.reconnect` (with `attempt`), `heartbeat.missed`, and
`frame.oversized` (with `bytes`) for a frame over 8 MiB either way. Oversized
frames throw `FrameTooLargeError`.

## Test

```sh
npm test --workspace=@mmo-engine/channel
```
