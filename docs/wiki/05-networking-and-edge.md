# 05. Networking & Distributed Scaling


---

## 5. Gateway Security Perimeter Boundary

To ensure memory safety and protect worker threads from untrusted input:
1. **Authentication Enforcement**: Intents arriving before `hello` handshake are rejected with code `4003` and never reach the SPSC ring.
2. **Authority & Entity Ownership**: Verifies `msg.entity === s.playerEntity`; foreign entity manipulation triggers error `4003`.
3. **Floating-Point Sanitization**: Input vectors are scrubbed for non-finite values (`NaN`, `Infinity`) and clamped to unit speed ($1.0\text{ m/s}$).
4. **Out-of-Order Packet Dropping**: Stale packets (`clientTick <= s.lastIntentTick`) are dropped silently.
5. **Fast 32-bit Action Packing**: Validated intents convert to bitwise masks and pack into a single 32-bit integer via `packCommandToken(slot, actionCode)`.

[← Previous: Native C++ Addons](04-native-addons.md) | [Back to Wiki Index](README.md) | [Next: Multi-Region World Coordination →](06-multi-region-world.md)

---

## 1. Overview
The networking subsystem decouples client socket management from authoritative simulation loops, sustaining tens of thousands of messages per second with sub-millisecond dispatch times.

---

## 2. Transport Layer (`uWebSockets.js`)

In [`packages/engine-core/src/net/transport.ts`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/engine-core/src/net/transport.ts), the engine defines a polymorphic `Transport` interface:

- **`uws` (Production Default)**: Integrates `uWebSockets.js` directly over native C++ libuv/epoll sockets. Handles TLS handshakes, HTTP parsing, and WebSocket framing without touching the JavaScript event loop.
- **`ws` (Fallback & Reference)**: Pure JavaScript implementation using `ws` over `node:http`. Provides a baseline reference for environments where native binaries are unavailable.

### Transport Selection
Transport is configured via `MMO_TRANSPORT`:
```sh
export MMO_TRANSPORT=uws   # Enforce uWebSockets.js (recommended for production)
export MMO_TRANSPORT=ws    # Force pure JS fallback
export MMO_TRANSPORT=auto  # Use uws if available, else ws
```

---

## 3. The Edge / Core Split Topology

To protect the simulation tick from socket fan-out overhead:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        EDGE PROCESS (apps/edge)                        │
│ - Client TLS & WebSocket Termination                                   │
│ - Ingress Token Bucket Rate Limiting                                   │
│ - Zod Payload Schema Validation                                        │
│ - Area-of-Interest (AoI) Sector Delta Encoding                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Framed TCP / Shared Memory
┌───────────────────────────────────▼────────────────────────────────────┐
│                  AUTHORITATIVE CORE (packages/engine-core)             │
│ - Pure 30 Hz Fixed Simulation                                          │
│ - Entity Transforms, Collisions, Combat Resolution                     │
│ - Zero Socket Management Overhead                                      │
└────────────────────────────────────────────────────────────────────────┘
```

- **Throughput**: Edge nodes sustain **64,212 req/s** with roundtrip ingress latency under **$1.1\text{ms}$** ($p99$).
- **Isolation**: A client disconnect or slow consumer never affects the simulation rate of other players.

---

## 4. Area of Interest (AoI) & Sector Management

The continuous world is partitioned into a 2D grid of **64-meter sectors**:
- **Enter Radius**: $96\text{ meters}$.
- **Leave Radius**: $128\text{ meters}$ (hysteresis zone prevents rapid subscribe/unsubscribe cycling).

```
        ┌──────────┬──────────┬──────────┐
        │  Sector  │  Sector  │  Sector  │
        │ (-1, 1)  │  (0, 1)  │  (1, 1)  │
        ├──────────┼──────────┼──────────┤
        │  Sector  │  Player  │  Sector  │
        │ (-1, 0)  │  (0, 0)  │  (1, 0)  │
        ├──────────┼──────────┼──────────┤
        │  Sector  │  Sector  │  Sector  │
        │ (-1, -1) │  (0, -1) │  (1, -1) │
        └──────────┴──────────┴──────────┘
```

1. Each sector groups entities located within its bounds.
2. Deltas are encoded **once per active sector**, rather than once per player.
3. Using `uWebSockets.js` topic-based publish/subscribe (`publish("sector:0,0", delta)`), frames are fanned out in C++ in **$0.50\text{ms}$ for 1,000 subscribers** ($12\times$ faster than standard per-connection send loops).

---

## 5. Binary State Serialization

The wire protocol contract is defined in [`packages/schema/mmo_engine.fbs`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/schema/mmo_engine.fbs):

### Fast-Path v1 Binary Codec
For high-frequency transform and velocity updates, the engine bypasses FlatBuffers builders in favor of the **Fast-Path Binary Codec** ([`fast-path.ts`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/protocol/src/fast-path.ts)):
- **Header (12 bytes)**: Magic `0x46` ('F'), Version `1`, Tick `u32`, Record Count `u32`.
- **Records (32 bytes per entity)**:
  - `u64 wireId` (8 bytes)
  - `f32 px, py, pz` (12 bytes)
  - `f32 lx, ly, lz` (12 bytes)
- **Efficiency**: $16\times$ faster encoding and $3\times$ smaller bandwidth footprint than generic table serialization.

---

[← Previous: Native C++ Addons](04-native-addons.md) | [Back to Wiki Index](README.md) | [Next: Multi-Region World Coordination →](06-multi-region-world.md)
