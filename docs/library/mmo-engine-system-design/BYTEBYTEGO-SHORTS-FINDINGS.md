# ByteByteGo Shorts — Findings (scan 2026-10-01)

**Method.** Live-browser scan of the ByteByteGo channel's Shorts tab
("Latest" sort): **27 shorts**, the full set the grid would load — no
signin wall, and the count stopped growing after repeated scrolls.
**Titles only** — no video content was opened or transcribed; the mapping
below is concept-level, from titles plus the channel's known subject canon
(ByteByteGo is the System Design Interview authors' channel). If a keeper
needs content-level verification, open that short individually.

**Context — "our situation at large."** NexusMMOEngine: authoritative
Node.js region servers; edge/core split (player connections and HTTP on the
edge, pure-simulation core); framed-TCP internal channel; FlatBuffers data
plane, JSON+Zod control plane; SQLite region persistence + SurrealDB world
tier; 30 Hz tick deltas fan out from the edge; C++ addons (Jolt, Recast,
FastNoise2) carry the tick-hot systems.

## Keepers — mapped into running docs

| Short | Concept | Maps to | Verdict |
|---|---|---|---|
| Latency vs Throughput | two different budgets | E5 benchmarks (hop p99 <1ms latency vs fan-out throughput) | **Filed** in edge/core plan appendix — the framing for the whole split |
| gRPC, WebSocket and WebHook! | API styles for service-to-service | E2 internal channel (edge↔core) | Considered, not taken — framed TCP + FlatBuffers stays; filed as preemptive rationale |
| Why gRPC is Popular | typed RPC ergonomics | E2 fallback door | Same as above |
| Kafka Basics / Why is Kafka so Fast? P1+P2 | append-only log, per-consumer offsets, sequential IO | sim event distribution, rumor/gossip layer, world-tier heartbeats | **Patterns only** — no Kafka adoption (ops weight vs Node-only services); the door stays behind seams |
| Why is Redis so FAST / Top Redis Use Cases | in-memory store, pub/sub, sorted sets, sessions | edge sessions/presence, leaderboards, rate limiting | **Future-scale candidate** behind the existing session-store seam; SQLite sessions (E3) stay until a bench says otherwise |
| 1 TRILLION messages | message fan-out at scale | edge `tick.delta` fan-out (uWebSockets transport) | Reference for E5 fan-out throughput math |
| Stack Overflow's Shocking Architecture | boring, mostly-monolithic tech that scales | whole-project posture | **Philosophy alignment**: edge/core split = fault isolation, not a microservices program |
| How Rust Fixed Discord's Latency Issues | GC pauses vs latency-sensitive loops | C++ addons for tick-hot paths; C# "never in the tick" verdict | Supports locked decisions; explicitly **not** a Rust reopening (Rust R&D declined 2026-10-01) |
| REST APIs Explained / What is GraphQL? / Top 6 API Architecture Styles / Top 5 API Performance Tips | control-plane API shape | edge HTTP routes (JSON+Zod control plane) | Aligns with the locked protocol decision; GraphQL not needed; perf tips apply to content services |
| OAuth in 3…2…1 / HTTPS & TLS | account linking, transport security | auth roadmap, edge TLS termination at deploy | Reference only — no change to CSV/Argon2id + opaque session tokens now |

## Reference-only (not filed as decisions)

- **Netflix Tech Stack** — the extreme-microservices scale we are
  deliberately *not* building yet; useful as a contrast point.
- **Data Pipeline Overview** — loose analogy for our bake pipeline
  (scatter cooking, town generation) and the E6 observability pipeline.
- **How Big Tech Ships Code to Production** — dev-process reference.
- **Top Architectural Patterns** — event-driven architecture is already
  our backbone; no new information.

## Dropped

- **Kubernetes ×4** (What's Behind Kubernetes?, Why Kubernetes ROCKS,
  What the heck is k8s?, Dark Days Before Docker) — container
  orchestration is not our deploy story today: Node processes, with
  Prometheus/Grafana as Go binaries alongside per E6. Revisit only if
  multi-host deployment becomes a real decision (still an open question).
- **What is Prompt Injection? / MCP in Claude Code** — AI-workflow
  topics, not engine architecture.

## Honest limits

Titles + known-canon mapping only; no short was watched. The two claims
most worth a content check before ever being cited as numbers (not just
concepts) are the Kafka speed pair and the Discord latency story — both
are well-documented in ByteByteGo's longer-form material, and the Discord
post is a primary source.
