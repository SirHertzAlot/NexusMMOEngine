# NexusMMOEngine — Project Brief for Coordinating Agents

*Written 2026-10-15. Source of truth is the repo and Joey's word, never this document.*

## Mission

Build **NexusMMOEngine**, an authoritative, procedural-generation MMO engine: data-oriented TypeScript/Node backend (bitECS), vendored Jolt physics behind a bulk SoA boundary, three.js mirror client, standalone editor. First game on top will be a low-poly stylized fantasy MMO (working titles "Tales of Yor" / "Adventures in Yor" — name clearance still open). Engine first, game later.

**Defining performance target:** 1,000 concurrent users + 50,000 NPCs/game objects acting on the same shared resources in ONE region, no sharding escape hatch. Every optimization phase has a benchmark gate: improvement or neutral, never regression.

## Repository

- Local: `~/workspace/nexus-engine` — GitHub: `SirHertzAlot/NexusMMOEngine` (private)
- Identity: `Sirhertzalot <dukjoseph@gmail.com>`
- Stack: Node 25 target, TypeScript, bitECS (SoA), SurrealDB, uWS (pub/sub), FlatBuffers (data plane) + JSON/Zod (control plane), WebSocket 30Hz tick
- Client: `apps/client` — React Three Fiber 9 + drei; `apps/editor` — vanilla three.js
- Durable worktrees go under `~/workspace/` only. Never use `/tmp` for anything that must survive.

## Current state (2026-10-15)

**Landed on main:**
- PR #251 — full modular extraction (9 slices; `provided.core` down to reloader + streamer). Protocol v24 (trade/tile opcode collision resolved).
- PR #252 — SAB Phase 1: SAB-backed bitECS component storage (verified on origin/main 2026-10-16; origin/main's tip is the #252 merge commit).

**Open, awaiting Joey's merge word (do NOT merge without it):**
- SAB Phase 2 (physics zero-copy boundary, ~9% faster): complete and verified on branch `arlo/sab-phase2` (Joey confirmed 2026-10-14) but NOT merged to main — exactly one unmerged commit above origin/main (verified 2026-10-16). Same awaiting-merge-word state as the stack below.
- SAB Phases 3–6 as a stacked PR set: P3 wire encoding from SAB views (~13–16% faster, byte-identical), P4 worker sharing + Atomics contention (12/12 zero-drift), P5 uWS sector pub/sub + fast-path v1 codec (13.8–21.9× encode), P6 client SAB asset pipeline (main-thread blocking 6.40ms → 0.42ms). All verified green; PR numbers/URLs need live re-check (connector was flaky).
- Combat M5 (abilities/telegraphs/status/duels, protocol v22) — branch `arlo/combat-abilities`, PR #151 closed; client UX pending.
- Animation: animouse adopted, spike passed, PR #230 open. three.quarks VFX ported (PR #219).

**Known pre-existing breakage (not ours):** engine-core `tsc` has 5 pre-existing errors (2 loot-dropper gold, 3 module extensions/optional); client `tsc` has 1 (`streaming-coordinator` requestTiles). Work around, don't claim.

**Art/prototype library (2026-10-15):** 487 low-poly GLBs in 7 zips under `~/workspace/your_files/`: sea life (84), farm produce (102), farm tools (48), farm animals (39), forest creatures (138), fantasy props (73), bonus fantasy creatures (3). All CC-BY 3.0 with per-pack manifests + CREDITS.md.

## Standing architecture decisions

- **Modularity:** every subsystem behind narrow, swappable interfaces (SimSystem, CredentialStore, AssetProvider, transport-agnostic WorldCore). Nothing is locked; the directive is complete modularity of every game-editing tool.
- **SAB, not replacement:** shared-buffer work EXTENDS the bitECS SoA engine; never fork/replace it.
- **Wire:** FlatBuffers for schema-evolving traffic; versioned frozen-layout fast path for hot position/velocity deltas; validate everything, fail closed. uWS pub/sub fan-out (encode once per sector topic). wRPC for game actions: still on the table, not ruled out.
- **NPC/living sim:** deterministic core; LLM/decision models live ONLY in the async edge NPC-memory microserver, never the tick. Pattern: engine constrains → model scores → engine executes. Agent tiers: background NPCs get no brain; only majors get minds. Rule-based fallback if the edge service is down.
- **GraphQL:** never for game networking. Future use is read-only observability queries in the admin layer only.
- **C++ backend:** under consideration, NOT ordered. If ordered: C++ owns tick/ECS/physics, Node stays web-facing, SAB is the contract. Transpiler-first workflow (typescript2cxx preferred), bit-identical tests gate each port, pilot on one small module first.

## License and content policy (hard gates)

- Code: permissive-only licenses (MIT/Apache-2.0/BSD). No copyleft, no proprietary/NDA material, never ask Joey for internal work docs.
- Shipped art: CC0 core (KayKit, Kenney, Gobkit) + **CC-BY allowed WITH per-pack attribution** (Joey's 2026-10-15 policy: "attribute every contributor/sponsor, they deserve the credit" — keep CREDITS.md per pack).
- Hard stops: Quaternius (license contradiction), Mixamo (Adobe ToS). Style gate: polygonal/low-poly only — verify outside models against the theme before accepting.
- Joey's supplied art is input; do not generate art for him.

## How to work (non-negotiable)

1. **Verify before claiming.** A roadmap row or branch name is not an implementation. Check `git merge-base --is-ancestor` + `git diff --stat` before saying anything landed. Distinguish local / tests / runtime-verified / pushed / PR / merged / accepted.
2. **Tests green before "ready."** Demonstrate pre-existing failures against a baseline; never inherit them silently.
3. **Permissions:** local build/implement is authorized when asked. Push, PR, merge, deploy, public exposure, purchases, credential or access changes need explicit approval naming the action. "Send the PRs" covered PRs, never merges.
4. **Fix breakage directly.** Never ask Joey to locate it or point at things.
5. **Engineering rules:** DRY, TDD, narrow swappable interfaces, server-authoritative, cost/benefit gate on every technique, benchmark gate on every perf change.
6. **Research .md files are append-only** unless he authorizes rewrite/delete. Numbers need sources or honest estimate/unverified labels.
7. **Kill-testing servers:** identify port-owner PIDs via `ss -tlnp`; never broad `pkill -f`. Never run two world servers against one SurrealDB namespace.

## Open decisions (Joey's calls, don't resolve unilaterally)

- Merge SAB Phases 3–6 (in order).
- C++ backend direction.
- img-to-3D Track 2: hosted TRELLIS v1 default vs TRELLIS.2 (question asked 2026-10-15, awaiting answer).
- Ecology tuning: need-curve shape, cadence, prime-aggressor authored-vs-computed.
- Auth provider, email vendor, formal name/domain clearance + purchase.
- Server-backed rebuild of the ECS 3D demo vs keeping it static.

## People and channels

- **Joey** — owner, final authority on merges, scope, and spending. Terse directives ("keep going", "send the PRs") are full authorization within their stated scope — never re-ask.
- **Claude** — the other dev agent on this repo (executes decision-free specs; monitor-and-merge lane).
- Dedicated chat for engine work: "MMO Engine Build". This brief's home: `~/workspace/your_files/mmo-engine-project-brief.md`.
