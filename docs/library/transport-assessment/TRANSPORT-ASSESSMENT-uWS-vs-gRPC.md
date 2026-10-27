# Transport Layer Assessment: uWebSockets vs gRPC

**Date:** 2026-10-02
**Scope:** The game client's transport — the 30 Hz bidirectional channel between browser and edge server.
**Verdict:** **uWebSockets wins. Not close.**

---

## 1. What the transport must do

The game's data plane is a hard real-time loop:

| Requirement | Value | Source |
|---|---|---|
| Tick rate | 30 Hz | Locked architecture |
| Delta size (busy area) | 1.2 KB | `transport-bench.ts` |
| Intent size | 48 B | `transport-bench.ts` |
| Direction | Full bidirectional, every tick | Gateway design |
| Per-pod outbound | 288 Mbps at 1000 users | G1 capacity model |
| Client | Browser (three.js + React) | Locked architecture |
| Serialization | FlatBuffers (zero-copy) | `docs/DECISIONS.md` 2026-09-27 |

The transport is a dumb pipe. The intelligence lives in FlatBuffers (data plane) and JSON+Zod (control plane). The transport's job is to move bytes at 30 Hz with minimum CPU and latency.

---

## 2. The contenders

### uWebSockets.js (incumbent)

- C++ WebSocket server (µWebSockets) with Node.js bindings
- Current default via the `Transport` interface (`packages/engine-core/src/net/transport.ts`)
- `ws` (pure JS) as fallback; both behind the same `WireSocket` interface
- Measured 2026-09-30: **25–35% less server CPU** than `ws` at 100–2000 clients; at 2000 clients `ws` saturated a core and fell behind (57k/60k msg/s) while uWS held at 69% of one core

### gRPC (challenger)

- HTTP/2-based RPC framework, protobuf serialization, 4 streaming patterns
- Excellent for service-to-service: strong typing, codegen, multiplexing
- The question is whether it fits the *browser-to-game-server* path

---

## 3. Head-to-head

### 3.1 Browser compatibility — disqualifying for gRPC

This is the kill shot. **Browsers cannot speak native gRPC.**

- gRPC carries its status code in HTTP/2 trailers. The browser `fetch`/`XHR` APIs do not expose trailers. This is not a limitation that can be worked around in JavaScript — it is a platform wall.
- The workaround is **gRPC-Web**: a compatibility layer that requires a translating proxy (typically Envoy) between browser and server.
- gRPC-Web supports **unary and server-streaming only**. Client-streaming and bidirectional streaming are not supported.

The game needs bidirectional streaming at 30 Hz (deltas down, intents up, every tick). gRPC-Web cannot do this. The option would be:

```
Browser → gRPC-Web → Envoy proxy → gRPC → game server
```

That is a new proxy tier, added latency on every tick, and *still* no true bidirectional streaming. The newer Connect RPC (Buf, CNCF 2024) removes the proxy but is still request/response shaped — it does not change the fundamental mismatch.

**Winner: uWebSockets.** WebSocket is native in every browser, no proxy, no translation.

### 3.2 Protocol shape — game loop vs RPC

- **WebSocket** is a persistent bidirectional byte pipe. The game sends a FlatBuffers delta every tick and receives intents whenever the player acts. No request/response framing, no per-message handshake. This is exactly the shape of a game loop.
- **gRPC** is RPC-shaped: call a method, get a response (or a stream). A 30 Hz game loop over gRPC would be either 30 unary calls/second (absurd overhead) or a bidirectional stream — which, per §3.1, browsers cannot do.

The repo already made the right call separating the **data plane** (FlatBuffers over WebSocket, 30 Hz) from the **control plane** (JSON+Zod, request/response). gRPC is a control-plane-shaped tool being asked to do a data-plane job.

**Winner: uWebSockets.**

### 3.3 Performance at the G1 target

Measured in-repo (`npm run bench:transport`, recorded in `docs/DECISIONS.md` 2026-09-30):

- uWS: 25–35% less server CPU than `ws` at 100–2000 clients
- At 2000 clients, `ws` saturated a desktop core; uWS held at 69%

gRPC's HTTP/2 framing adds per-message overhead (headers, flow control, HPACK) that WebSocket's minimal framing avoids. For 1.2 KB payloads at 30 Hz, that overhead is pure tax. No in-repo gRPC benchmark exists because the browser wall (§3.1) disqualifies it before performance matters — but on paper, HTTP/2 framing is heavier than WS framing for small high-frequency messages.

**Winner: uWebSockets** (measured against `ws`; gRPC not benchmarked because disqualified).

### 3.4 Serialization — already decided

gRPC mandates protobuf. The repo decided 2026-09-27 (recorded in `docs/DECISIONS.md`, re-confirmed when Joey raised protobufs+webrpc): **FlatBuffers stays** — single `.fbs` → C++ and JS/TS bindings, zero-copy on the 30 Hz path. Adopting gRPC would force a protobuf migration against an explicit, recorded decision.

**Winner: uWebSockets** (by prior binding decision).

### 3.5 Operational complexity

| | uWebSockets | gRPC for browsers |
|---|---|---|
| Proxy tier | None | Envoy (or equivalent) required |
| Load balancing | L4-friendly (one TCP conn per client) | HTTP/2 multiplexing pins to one backend behind L4; needs L7 LB |
| Debuggability | `curl` the HTTP port; WS frames inspectable | Binary protobuf; needs grpcurl + proto files |
| Node.js fit | Prebuilt binaries for Linux/macOS/Windows; `ws` fallback | `@grpc/grpc-js` is pure JS (slower) or native (build complexity) |

The repo's `Transport` interface already abstracts the socket library — swapping implementations doesn't touch the gateway. That swappability is the right hedge, but there is no reason to exercise it for gRPC on the client path.

**Winner: uWebSockets.**

### 3.6 Where gRPC *would* win — and already lost

gRPC's natural territory is **service-to-service**: region↔world control traffic, typed contracts, codegen. The repo evaluated this (webrpc, 2026-09-27) and chose hand-authored webrpc-over-HTTP with JSON instead — Go-server-first codegen didn't fit the Node server. That decision stands and is out of scope for this assessment, but it confirms the pattern: **gRPC-shaped tools lose to simpler fits at every layer of this architecture.**

---

## 4. Verdict

**uWebSockets wins, all or nothing.**

The decision is overdetermined — any one of these is sufficient:

1. **Browsers cannot do bidirectional gRPC.** The platform wall (no trailer access) is not negotiable.
2. **The game loop is not RPC-shaped.** 30 Hz full-duplex deltas/intents map to a byte pipe, not method calls.
3. **FlatBuffers is the recorded serialization decision.** gRPC mandates protobuf.
4. **Measured performance** already favors uWS by 25–35% CPU over the fallback.
5. **No proxy tier.** gRPC-Web would add Envoy latency to every tick.

### Recommendation

- **Keep uWebSockets.js as the game transport.** No change.
- **Keep the `Transport`/`WireSocket` interface.** It is the correct hedge — if a better socket library appears, the gateway doesn't care.
- **Do not introduce gRPC on the client path.** Not as a replacement, not as an alternative.
- **Revisit only if:** the client stops being a browser (native client with real HTTP/2), or the transport need shifts to service-to-service (where gRPC already lost to webrpc/JSON on fit).

---

## 5. Sources

- In-repo: `packages/engine-core/src/net/transport.ts`, `packages/engine-core/src/net/transport-bench.ts`, `docs/DECISIONS.md` (2026-09-27, 2026-09-30)
- Browser gRPC wall: websocket.org comparison — "gRPC requires HTTP/2 trailers which browsers do not expose. gRPC-Web... only supports unary and server streaming calls, not bidirectional streaming."
- gRPC-Web proxy requirement: "a proxy (commonly Envoy) that translates between a browser-friendly protocol and native gRPC"
- Industry pattern: "use gRPC **inside** your network edge (between microservices)... Prefer REST over the public perimeter"
