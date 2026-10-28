# Encounter Director — Implementation Spec (Slice S13)

**Date:** 2026-10-06 · **Status:** Draft spec (decision-free; awaiting Joey's review)
**Research basis:** `DIFFICULTY-CONSTRAINTS.md` (2026-10-06) — the six hard
implementation rules and the signal → model → actuator mapping.
**Slice dependency:** S10 (edge bridge: gameplay events → `quest_facts` →
mythic `sim` keys) and S12 (enemy brains: perception + tiered BT/utility +
GOAP-lite). This slice consumes both; it builds on neither's internals.

---

## 1. What this is

A per-region pacing controller that measures aggregate player state,
compares it against a target tension/release arc, and actuates through a
small set of **bounded, sim-legible** variables. It owns **pacing**; difficulty
is one of its outputs. This is the L4D AI Director lesson (Booth 2009),
adapted to an MMO region: aggregate signals, not individual stress.

## 2. Placement and non-goals

**Placement (per the edge-vs-core rule):** the director is a **content system
in the edge layer**, not a tick system. It runs as a per-region Node service
instance on (or beside) the world server, evaluating on its own cadence
(§5). It never runs inside the 30Hz tick. It reads from sim/event state and
writes a bounded actuator set into per-region state that tick-side systems
read. Tick determinism is untouched: the same tick input + same actuator set
= same world.

**Non-goals:**
- Not a replacement for hand-authored encounters, quests, or boss scripts.
  The director modulates the space *between* authored beats.
- Not a global balancer. It does not touch XP rates, loot rarity, economy
  prices, or progression curves.
- Not in the wire protocol. Clients never see director state; they see its
  effects (spawn cadence, enemy behavior), per the server-authoritative
  contract: server decides event + seed, client renders.

## 3. Data model

One `DirectorState` record per region (region = the unit the director serves;
see §10, decision D2):

```ts
interface DirectorState {
  regionId: string;
  // --- model (compare) ---
  intensity: number;        // 0..1 measured dramatic intensity
  targetArc: ArcPhase;      // where the region should be on the tension curve
  skill: SkillEstimate;     // α-blended, per-dimension (§4)
  attentionLoad: number;    // 0..1 estimated player attention tax
  reliefDue: boolean;       // sustained peak → schedule relief
  threatLevel: number;      // macro state: current region threat, 0..1
  threatCeiling: number;    // player-chosen ceiling via risk contracts (§8)
  // --- actuators (constrained outputs) ---
  actuators: DirectorActuatorSet;
  // --- audit ---
  decisions: DecisionLog[]; // append-only; see §9
}

interface DirectorActuatorSet {
  spawnIntervalScale: number;  // multiplier on spawn-table pacing, bounds [0.5, 3.0]
  aimErrorRadius: number;      // enemy precision degradation, world units, bounds [0, 4]
  telegraphScale: number;      // telegraph duration multiplier, bounds [1.0, 2.0]
  reactDelayMs: number;        // enemy reaction delay added, bounds [0, 600]
  compositionBias: number;     // spawn-table role mix shift, bounds [-1, 1]
  aggression: number;          // faction aggression read by NPC systems, bounds [0, 1]
  supplyScarcity: number;      // resource/supply throttle, bounds [0, 1]
}
```

Bounds are **design-authored and playtest-validated**, never open-ended. The
values above are starting defaults; the director interpolates within them.
See §6 for the bound table and the easing ladder.

## 4. Signals (measure)

Sampled per region at 1 Hz, aggregated over rolling windows. Raw inputs come
from combat events (already on the tick/event path) and the S10 sim keys.

| Signal | Source | Window | Used by |
|---|---|---|---|
| deaths per encounter | combat event log | 10 min rolling | skill, intensity |
| damage taken / damage dealt | combat event log | 5 min rolling | skill, attention load |
| healing-item usage rate | combat event log | 5 min rolling | attention load, skill |
| objective velocity | quest/progress events | 15 min rolling | intensity target |
| party separation (avg spread) | position snapshots | 1 min | attention load |
| idle time share | activity events | 15 min | relief scheduling |
| `factionWar`, `rumorHeat`, `prosperity` | S10 sim keys (spec-only; not yet in repo) | current | aggression, composition, macro threat |

**Skill model:** α-blend per dimension, combat and exploration tracked
separately:
`skill_d = α · recent_d + (1 − α) · previous_d`, α = 0.3 default, updated on
each 1 Hz sample. Population percentiles are a later refinement; α-blend
ships first.

**Attention load estimate:** weighted from healing usage, damage-taken
spikes, and party separation — the proxy for "players are overwhelmed" that
triggers the precision-first easing ladder (§6).

## 5. The two loops

**Micro loop (seconds, current encounter).** Evaluates at 1 Hz. Reads:
intensity, skill, attention load. Actuates: `spawnIntervalScale` (timing of
the *next* spawns only), `aimErrorRadius`, `telegraphScale`, `reactDelayMs`.
Never despawns or weakens entities already engaged — actuation is
forward-looking only.

**Macro loop (minutes, region).** Evaluates every 60 s. Reads: rolling
windows, S10 sim keys, `reliefDue`. Actuates: `threatLevel`,
`compositionBias`, `aggression`, `supplyScarcity`, relief scheduling.

Both loops run; they actuate different variables. Micro prevents frustration
spikes; macro matches player growth over a session.

## 6. Actuation: the precision-before-stats ladder

When the director must **ease** pressure (attention load high, deaths
spiking), it walks this ladder in order, degrading enemy *precision and
coordination first*, stats last:

1. `aimErrorRadius` ↑ (enemies miss by more — perceived as fair)
2. `telegraphScale` ↑, `reactDelayMs` ↑ (more readable, slower to commit)
3. `spawnIntervalScale` ↑ (fewer concurrent threats)
4. `compositionBias` → toward weaker/support roles
5. `aggression` ↓ (factions press less hard)

**Escalation** reverses the ladder, then raises `threatLevel` (macro):
tougher composition, higher aggression. Stat changes (HP/damage) are the
*last* resort and stay within bounds — an enemy with less HP feels cheap;
an enemy that misses feels fair.

**Hard actuation rules** (from the research, non-negotiable):
- Actuate through **sim-legible channels** — spawn tables
  (`packages/scatter/src/spawn-table.ts`), faction aggression (S10 keys),
  supply — never invisible stat multipliers.
- **Bound every actuator.** Table above; values interpolated within bounds.
- **Pacing first.** The director owns the tension/release arc; after a
  sustained peak (`reliefDue`), it schedules relief — longer spawn
  intervals, easier composition — before the next buildup.
- **No hidden rubber-banding.** Every adjustment must be readable in the
  fiction: faster kills → faster respawns → regional boss → region calms.
  Players should be able to *tell the story* of why the region got harder.

## 7. The tension arc

Per region, the director tracks a target arc through phases:
`calm → buildup → peak → relief → calm`. Transitions:
- `calm → buildup`: player activity above threshold for 2+ minutes.
- `buildup → peak`: intensity crosses 0.7 while objective velocity is high.
- `peak → relief`: peak sustained 3–5 minutes, or `reliefDue` set by deaths
  spike. Relief is scheduled, not random.
- `relief → calm`: attention load back under 0.4 for 2 minutes.

The controlled variable is *dramatic intensity over time*, not a static
challenge level.

## 8. Player-chosen ceilings (risk contracts)

The director manages the **floor**; players choose their own **ceiling**
through in-world opt-in risk contracts: bounties, cursed zones, wagers.
Mechanics:
- A contract sets `threatCeiling` for the contracting party (default 1.0 =
  no contract).
- The director may escalate `threatLevel` up to `threatCeiling`, never
  above it without a contract.
- Contracts are legible in the fiction and carry commensurate reward — the
  "difficulty as a place" metaphor: dangerous *places*, not difficulty
  *settings*.

## 9. Determinism, audit, replay

- The director consumes a **seeded RNG per region** (seed from region config
  + epoch). Same seed + same signal history = same decisions.
- Every actuation change is appended to `decisions` (timestamp, loop,
  trigger signal, old → new actuator values). This is the tuning audit
  trail and the replay source: a session can be re-simulated from the
  decision log.
- Tick-side systems read the actuator set as **input data**, like any other
  sim input — determinism of the tick is preserved.

## 10. Integration points (repo-grounded)

- **Reads:** combat event stream (tick-side), position/activity snapshots,
  S10 sim keys (`factionWar`, `rumorHeat`, `prosperity` — spec-only as of
  2026-10-06; this slice depends on S10 landing them).
- **Writes:** per-region `DirectorActuatorSet`, consumed by:
  - spawn resolution reading `packages/scatter/src/spawn-table.ts`
    (`spawnIntervalScale`, `compositionBias`),
  - S12 enemy brains (`aimErrorRadius`, `telegraphScale`, `reactDelayMs`,
    `aggression`),
  - supply/economy hooks (`supplyScarcity`).
- **Service shape:** a `DirectorService` class behind a narrow interface
  (`sample(regionId)`, `decide(regionId): DirectorActuatorSet`), swappable
  per the modularity principle. Suggested home: alongside the world
  server (`packages/world-server`), or its own edge service — D3 below.
- **Telemetry:** decision counts and actuator histograms exported through
  the existing metrics path (`packages/nethealth`), so playtests produce
  tuning data, not anecdotes.

## 11. Acceptance criteria (slice S13)

1. Headless harness: scripted player-pressure scenarios (steamroll, wipe,
   idle, mixed) → assert the arc moves calm → buildup → peak → relief,
   and that easing walks the ladder in order (precision before stats).
2. Bounds test: fuzz signals for 24 simulated hours; assert no actuator
   leaves its bounds, ever.
3. Legibility test: every escalation in the decision log is traceable to a
   sim-legible cause (spawn pacing, composition, aggression) — no hidden
   multipliers anywhere in the path.
4. No-despawn test: actuation never removes or weakens an engaged entity.
5. Replay test: re-run a scenario from the decision log; assert identical
   actuator sequence.
6. Contract test: `threatCeiling` respected — uncontracted parties never see
   above-ceiling escalation.

## 12. Decisions for Joey (yours to make)

- **D1 — Default arc parameters.** The phase thresholds and durations in
  §7 are starting points. Confirm, or set your own before Claude builds.
- **D2 — Region granularity.** One director per shard, per zone, or per
  named region? Recommendation: per named region (matches "difficulty as a
  place"); shard-level is the fallback if region count explodes.
- **D3 — Service home.** Inside `packages/world-server` as a module, or a
  standalone edge service like the NPC-memory microserver? Recommendation:
  start as a world-server module behind the narrow interface; split out if
  it ever needs independent scaling.
- **D4 — Micro-loop cadence.** 1 Hz is the default. Event-driven (decide on
  combat events only) is cheaper; 1 Hz is simpler and the cost is trivial
  against aggregate signals. Recommendation: 1 Hz.

---

## Works cited

All primary sources are in `DIFFICULTY-CONSTRAINTS.md` (Works Cited):
Booth 2009 (L4D AI Director); GameDev.net topics 666665, 515337
(D1–D5 variables, accomplishment-triggered adjustment, difficulty as a
place); "Exploring Dynamic Difficulty Adjustment Methods for Video Games"
(academic parameter tables, aiming error); GameDev.net R4992 (organic
difficulty); sponticelli `difficulty-adapter.md` (signal set, α-blend skill
model, micro/macro loops).
