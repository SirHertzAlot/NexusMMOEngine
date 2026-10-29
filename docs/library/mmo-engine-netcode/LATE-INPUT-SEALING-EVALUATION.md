# Late-input sealing (Go edge sequencer) — evaluation (2026-10-27)

Source: Sankalp, "My game server never waits for a late player"
(Medium, Oct 2026) — a 60 Hz Go edge server for a 1v1 phone battle
game (Spirit Spin): the edge time-stamps inputs and **seals each
frame at a deadline** (round start + frame × 16.67 ms + 4 ms grace);
a missing input is replaced with that player's **last input**;
clients run the deterministic sim locally (rollback/GGPO lineage),
resend unconfirmed inputs (≤16/packet, edge keeps the first copy),
get timing hints to discipline their input clocks, and send a
**state hash every second** that a Node referee compares against its
own replay of the confirmed inputs. Transport is WebTransport/QUIC.
Reported: 1,000+ simulated matches over six network profiles, 0
desyncs; 500 concurrent matches ≈ 87k frames, 0 missing inputs,
0.19 ms/tick mean on the edge.

## His problem is not our problem — mostly

His clients **run the simulation**, so inputs are the only shared
truth and their ordering is the game state; a late input is a
correctness fault. Our clients are **mirrors**: one authoritative
server sim, state replicated as deltas. Desync in his sense is
impossible by construction — the worst case here is a stale mirror,
healed by the next delta/snapshot. His 0-desync metric has no direct
analog; ours are mirror correction distance and intent drop counts.

And the headline property — the server never waits — **we already
have**: the gateway never blocks the tick on input. Verified against
origin/main (`net/gateway.ts`, `world.ts`, `systems.ts`):

- Intents arrive as events, are sanitized (finite, magnitude-capped),
  foreign-entity-rejected, rate-limited by token bucket, and
  **stale/duplicate `clientTick`s are dropped and counted**.
- `queueIntent` drains at tick start into the persistent
  `PlayerIntent` component, which `IntentSystem` reads **every
  tick** — so under input silence the last movement intent keeps
  applying. His last-input-reuse policy is our structural default.

## What transfers

1. **Measure on real networks — ADOPT THE METHOD (feeds B3).** His
   localhost numbers "swore everything was fine" (0.157 correction)
   while the field showed a 0.69-unit p95 snap-back. Our fan-out test
   (roadmap B3, never yet run) must inject network profiles —
   latency, jitter, loss, spikes — not just localhost bots, or it
   will certify a fiction. His six-profile simulated-match harness is
   the template. Also his cautionary tale: his first harness
   reported a phantom 2.7% input loss that turned out to be Windows
   sleep granularity in the *test feeders*. Validate the harness.
2. **Head-of-line blocking — OUR KNOWN WEAKNESS, NAMED SUCCESSOR.**
   His failure #2 is ours verbatim: one ordered WebSocket/TCP stream
   means one lost packet stalls every delta behind it — and deltas
   are latest-state payloads, the worst thing to queue behind a loss.
   His cure is WebTransport (QUIC datagrams; survives network
   switches). Browsers support WebTransport today; the gap is
   Node-side serving (his answer: a Go sidecar; ours would need the
   same shape or a framed-TCP edge per the recorded E2 precedent).
   **Gate on B3 evidence**: if profile tests show HoL stalls,
   evaluate WebTransport for the data plane. Do not pre-build.
3. **Ack/resend for discrete actions — SMALL ADOPT, design look.**
   His resend-until-acked heals input loss. Our movement self-heals
   (state-based, resent every tick by the client), but a lost
   one-shot input (jump press, button edge) is simply lost today.
   Discrete actions deserve an ack/resend or server-confirm path;
   movement does not.
4. **State-hash heartbeat — PARTIAL ANALOG EXISTS.** His 1 Hz hash
   vs referee replay detects divergence. Our shard snapshots already
   carry a digest at the world tier; the mirror's consistency is
   snapshot-healed rather than hash-checked. No action unless B3
   shows mirror divergence going unnoticed.
5. **Realtime path in its own process — ALREADY OUR TRAJECTORY.**
   Sim worker vs gateway/persistence separation (hybrid data plane);
   saves/shop never share the tick loop (async shipper by design).

## What does not transfer

- **Rollback netcode / input delay / deterministic client sim.**
  Session-game technology (GGPO, Photon Quantum). At persistent-world
  scale — 50k NPCs, procgen, physics — clients cannot run the sim,
  and MMO movement tolerates server RTT by design. Frame-perfect
  sealing solves a problem our genre doesn't have.
- **The Go edge itself.** His reasons were WebTransport libraries and
  event-loop isolation; we get isolation from workers/processes in
  Node. Go re-enters the conversation only if item 2 forces a
  WebTransport sidecar.

## Parked pattern

**Neutral input sequencer + replay referee** — the right shape for
exactly one plausible future feature: cross-region instanced PvP
(duels/arenas) where two players from different regions need a
frame-fair fight neither region server should referee alone. The
combat module already has duels. If an arena mode is ever specced,
start from this article's design (deadline sealing, last-input fill,
hash heartbeat, edge buffers + close-don't-wait backpressure).

## Open check item (from the code read)

`PlayerIntent.jump`/`buttons` persist in the component like the
movement axes. Held-state reuse is correct for axes; edge-triggered
fields need one test proving they cannot re-fire under input silence
(the character system likely consumes them — verify, don't assume).
