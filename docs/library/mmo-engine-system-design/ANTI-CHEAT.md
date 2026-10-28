# Anti-cheat design — Nexus MMO engine

**Status:** Design, not implemented. Written 2026-10-09.
**Parent decisions:** Server-authoritative simulation (core contract); rule-based
fallbacks; cost/benefit gate on every technique.

## Thesis

Anti-cheat is a property of the server architecture, not a product you buy.
The client is untrusted hardware running untrusted software operated by an
untrusted user. Every defense in this doc assumes the attacker has a modified
client, a debugger, and full knowledge of the protocol. What the attacker does
*not* have is the server's state or the server's vote.

This is why the mesh-VPN question (2026-10-09) resolved the way it did: a
private mesh answers "who can reach the server," while every real cheat vector
is "is the client telling the truth." Network access control is not cheat
prevention. It is recorded here as an explicit non-layer so nobody re-litigates
it later.

## Threat model (v1)

Defend against:

- **Movement cheats** — speed hacks, teleports, noclip/fly. All are lies about
  position; the server owns position.
- **Action-rate abuse** — ability spam, GCD/cooldown bypass, instant gathering.
- **Economy exploits** — duping, trade fraud, drop-table manipulation,
  vendor arbitrage. All settlement is server-side already (EC1).
- **Information cheats** — wallhacks, ESP. Mitigated by never sending the
  client what it cannot legitimately know (interest management), not by
  hiding data on a compromised client.
- **Packet manipulation** — replayed, forged, or reordered inputs.
- **Botting** — automated play. Detected behaviorally, never at the
  network layer.

Explicitly out of scope for v1: kernel-level client attestation (no custom
EAC-style driver — an arms race a solo dev cannot win); client-side
obfuscation as a relied-upon defense; hardware bans.

## Layer 0 — already built (the foundation)

- Authoritative 30Hz tick; client renders, server decides.
- Gateway: Zod-validated protocol (v22/v23), per-IP rate limiting.
- M5: GCD, per-ability cooldowns, one-deep queue, server-side casts and
  interrupts, server-authoritative telegraphs, consensual PvP only.
- EC1: integer gold, atomic trade settlement (offer changes reset accepts),
  escrowed auction bids, server-side drop tables and quest rewards.
- CredentialStore: opaque tokens, 24h TTL, per-IP rate limiting.

Layer 0 already kills the entire "client says it happened" class of cheats.
Everything below hardens the "client asks plausibly" class.

## Layer 1 — per-tick input plausibility (in the tick, must be cheap)

Every input is validated against authoritative state before application:

- **Movement:** speed cap from last authoritative position and elapsed ticks;
  distance-over-time check flags teleports. Noclip is meaningless — the
  server's collision is the only collision.
- **Actions:** cooldowns and GCD enforced server-side (extends M5); ability
  range and line-of-sight checked against server state before a cast starts;
  telegraphs are server-authoritative so "I dodged it" is the server's call.
- **Sequencing:** per-connection input sequence numbers; drops replays and
  far-future packets; small reorder window only.
- **Cost gate:** each check is O(1) against already-loaded entity state. Any
  check that needs a new data fetch or exceeds its micro-budget moves to
  Layer 4 (async) or is rejected.

## Layer 2 — rate limits and abuse budgets (gateway/edge)

- Extend the existing per-IP token buckets to per-*account* buckets for game
  actions: movement packets, ability casts, chat messages, trade requests.
- Login-attempt throttling (already in CredentialStore scope; keep).
- Chat/trade spam budgets with decay — the same shape as the sensory-memory
  decay in the NPC stack.
- Hard caps, not ML: deterministic, explainable, cheap.

## Layer 3 — economy invariants (in the transaction path)

- Integer gold, no floats (already). All settlement atomic (already).
- Server-side drop tables and vendor prices are the only ones that exist —
  the client never computes a reward.
- **Velocity flags:** gold earned/spent per account per hour vs. achievable
  bounds from legitimate sources. Exceeding bounds flags the account for
  Layer 4 review; it never auto-punishes (a lucky player is not a cheater).
- Append-only trade/audit log — every settlement records counterparties,
  amounts, and tick. Replayable.

## Layer 4 — behavioral detection (async edge service, never the tick)

Same placement rule as NPC memory: heavy analysis lives in the edge
microserver, the tick stays clean.

- **Impossible travel:** login locations vs. elapsed time.
- **Inhuman consistency:** input-timing entropy below human plausibility
  floors over long sessions (bots are *too* regular).
- **Progression curves:** play-time vs. advancement vs. population norms.
- Output is a **review queue with evidence refs**, not auto-bans. v1 never
  auto-bans: false positives cost players, and a solo dev cannot afford an
  appeals process at scale. Shadow-flag, throttle suspicious gains, human
  reviews.

## Layer 5 — client hygiene (cheap signals, never relied upon)

- WSS/TLS transport (already) — defeats passive sniffing; this is what the
  mesh VPN would redundantly re-provide.
- Optional client integrity hash reported at login: treated as a *signal*
  for Layer 4, never as proof of anything.
- No kernel driver, no rootkit, no attestation theater.

## Explicit non-layers (ruled out)

- **Mesh VPN as anti-cheat (ruled out 2026-10-09):** NetBird/Tailscale/
  Headscale are access control. A cheater enrolls their own device
  legitimately and cheats from inside the mesh. Approved uses: admin/SDN
  plane, and closed-alpha velvet rope (invite-only network, no public
  exposure). Never public player transport — enrollment friction per
  player for zero cheat-prevention gain.
- **Kernel-level anti-cheat:** out of scope; unwinnable arms race for a
  solo dev; violates the user's-machine-is-theirs principle.
- **Security by obscurity:** protocol secrecy buys weeks at most; the
  design assumes full protocol knowledge.

## Enforcement ladder

warn → throttle (rate budgets tighten) → suspend → ban. Every step logs
evidence refs from Layers 1–4. Bans are human-confirmed in v1. Appeal path
is a support ticket, not a form letter.

## Telemetry

Cheat-signal events join the audit log with the same replay discipline as
the decision-substrate telemetry: given the log, a reviewer can reconstruct
why an account was flagged. Signals are tuned against false-positive rate,
not just catch rate.

## Build order

1. Layer 1 movement plausibility (extends existing position authority).
2. Layer 2 per-account action budgets (extends existing gateway limits).
3. Layer 3 velocity flags + audit log (extends EC1 settlement).
4. Layer 4 edge-service detectors + review queue (after NPC edge
   microserver exists — same host, same placement rules).
5. Layer 5 integrity signal (cheap; anytime).

Each layer ships behind its own cost gate: tick-micro-budget for Layer 1,
ops-cost for Layer 4. Nothing enters the tick that hasn't been measured.
