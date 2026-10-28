# Combat & Ability System — Research, Verdicts, and Backbone Mapping

**Date:** 2026-10-09 · **Status:** Research + architecture (deep dive)
**Audience:** AI builders implementing or validating the combat backbone.
**One-line thesis:** The server decides every hit, every number, and every
timing window; the client makes it *feel* like thunder. Never the reverse.

**Relationship to M5:** the `arlo/combat-abilities` branch (PR #151) already
implements the core — AbilitySystem (GCD, per-ability cooldowns, one-deep
queue, casts + interrupts), TelegraphSystem (server-authoritative danger
zones), StatusSystem (buffs/debuffs: stacking, refresh modes, DoT/HoT,
cleanse), DuelSystem (challenge/accept/decline/expiry, first blood, yield),
protocol v22 (0x1d–0x20) with gateway wiring. This document is the research
*behind* that implementation and the map of what comes next. It replaces
nothing; it validates, extends, and records the verdicts.

---

## 0. What already exists (do not rebuild)

- `packages/engine-core/src/abilities.ts` — GCD, per-ability cooldowns,
  one-deep input queue, cast times, interrupt rules.
- `packages/engine-core/src/telegraph.ts` — server-authoritative danger
  zones with timing windows.
- `packages/engine-core/src/status.ts` — status effects with stacking
  policies, refresh modes, DoT/HoT ticks, cleanse.
- `packages/engine-core/src/duel.ts` — consensual PvP: challenge, accept,
  decline, expiry, first blood, yield.
- `packages/engine-core/src/combat.ts` — hit resolution surface.
- Protocol v22 (`packages/protocol/src/`): message types 0x1d–0x20,
  gateway wiring Zod-validated and rate-limited.
- Animation authority rule (from ANIMATION-RUNTIME.md): hit detection uses
  **server capsules + authored windows, never sampled client bones**.
- Known gap: client UX is pending — ability bar, telegraph rendering,
  status frame, duel UI. The feel layer (§5) lands there.

---

## 1. The server/client combat split (architectural rule)

This is the load-bearing decision. Everything else follows.

| Concern | Server | Client |
|---|---|---|
| Hit detection | Authoritative: capsule sweeps inside authored hit windows | Never decides hits |
| Damage numbers | Authoritative: data-driven exec calc (base × crit × mitigation) | Renders damage numbers |
| Cooldowns, GCD, cast state | Authoritative | Mirrors as UI (bars, sweeps) |
| Status effect ticks | Authoritative: DoT/HoT, stacking, refresh, cleanse | Renders icons, timers |
| Telegraph zones + timing | Authoritative | Renders decals/markers |
| Input buffering | Validates: accepts/rejects queued intents against state | Queues inputs for responsiveness |
| Knockback displacement | Authoritative: position/velocity change | Renders the motion + juice |
| Hitstop, screen shake, hit flash, particles, SFX | Never — these are presentation | All of it, render-layer only |
| Duel state | Authoritative | Renders prompts/results |

**Anti-cheat corollary:** the client is an untrusted renderer with a
convenient input queue. Anything the client "decides" is a suggestion the
server re-validates. Cooldowns enforced client-side alone are decoration.

**Determinism note:** combat resolution must be deterministic in the tick —
same inputs + same state = same outcome. The feel layer (§5) is explicitly
non-deterministic-safe: it may vary by frame rate and quality tier without
affecting gameplay, the same separation the animation and destruction
pipelines use.

---

## 2. Ranked primary sources

Ranked by direct applicability to a server-authoritative action-MMO combat
system. Builders should read in this order.

1. **For Honor, "Modify Everything! Data-Driven Dynamic Gameplay Effects"**
   (Aurélie Le Chevalier, GDC 2017) — the Modifiers system: a data-driven
   pipeline for buffs/debuffs, stat changes, AoE, and attack properties,
   with frank discussion of what broke. This is the closest shipped
   precedent for the M5 StatusSystem/TelegraphSystem shape.
   https://www.gamedeveloper.com/design/video-delivering-data-driven-dynamic-gameplay-effects-in-i-for-honor-i-
2. **For Honor, "The Art of Battle" design talks** — directional melee
   combat decomposed to its emotional essence: attack direction choice,
   bluffing, readable commitment. Take the *design vocabulary* (startup /
   active / recovery, readable telegraphs); leave the netcode — For Honor
   runs deterministic lockstep P2P, which is explicitly not this engine's
   model.
3. **Steve Swink, *Game Feel: A Game Designer's Guide to Virtual Sensation***
   (Morgan Kaufmann, 2008) — the canon on real-time control, simulated
   space, and the polish stack. The rule this doc enforces: polish is a
   *stack*, never one effect in isolation.
4. **Jan Willem Nijman, "The Art of Screenshake"** (Vlambeer, 2013) — the
   juice checklist in order: impact effects → screen shake → hit-stop →
   camera kick → hit flashes → knockback → SFX pitch. "Every action needs
   reaction. Bigger reactions for bigger actions."
5. **"Juice It or Lose It"** (Martin Jonasson & Petri Purho, 2012) — the
   canonical demo that the same Breakout becomes compelling purely through
   layered feedback. Nothing about the rules changed.
6. **Valve Developer Wiki — lag compensation** — the server-rewind model:
   validate hits against the world state at the shooter's view time
   (`now − RTT/2 − interp`). Reference architecture for §4.4; see verdict
   on why melee v1 does not need it.
7. **Celia Wagar, CritPoints — hitstop breakdown** — hitlag mechanics across
   Street Fighter (hitstop as cancel window: the 2-in-1 exists *because* of
   hitstop) and Smash (SDI during hitlag, vibration). Direct input to §5.1.
   https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit/
8. **Unreal Gameplay Ability System (GAS) architecture docs** — the three
   pillars (Abilities / Effects / Attributes) with GameplayTags threading
   through. **Design reference only**: GAS ships under the Unreal Engine
   license, not a permissive license — adopt the *pattern*, never the code.
9. **dreamteam-hq/brigid `server-authoritative-combat/SKILL.md`** — the
   pragmatic melee finding: large hitboxes (2+ units) and long attack
   windows (300–500ms) absorb <200ms RTT without server rewind; continuous
   collision suffices for PvE melee. Direct input to the §4.4 verdict.
   https://github.com/dreamteam-hq/brigid/blob/HEAD/server-authoritative-combat/SKILL.md
10. **"Designing Game Feel: A Survey"** (arXiv 2011.09201) — academic
    grounding for the polish-stack model: tuning physicality vs. juice
    amplification, and the finding that faked physicality (tweens, easing)
    reads as well as simulated. Useful when the feel budget is tight.
11. **Godot community combat-design pattern collections** (MIT-licensed
    community code) — input-buffer and hitbox/hurtbox reference
    implementations. Adoptable as *patterns*; any vendored code stays
    behind the bulk boundary per the Jolt precedent.

---

## 3. Candidate verdicts

Every verdict carries the mandatory cost/benefit gate: frame-ms, GPU
memory, quality-tier fallback, server operating cost. Verdicts: **ADOPT**,
**PARK** (valid, not now), **REJECT** (wrong for this engine, with reason).

### 3.1 Capsule-sweep hit detection (server) → ADOPT

**What:** melee hits resolve as swept-capsule vs. capsule tests executed on
the server inside authored hit windows. No bone data, no mesh data — the
animation authority rule.

**Server-contract mapping:** server owns the sweep, the window timing, and
the hit/miss boolean. Client receives hit events and renders consequences.

**Cost gate:** CPU per tick is O(active attacks × entities in range); with
a spatial hash broad phase it is negligible at MMO densities (<0.1ms per
tick at hundreds of concurrent attackers). No GPU cost. No quality-tier
fallback needed — this is simulation, not presentation. Server op cost:
zero marginal — it rides the existing tick.

### 3.2 Authored hit windows: startup / active / recovery → ADOPT

**What:** every attack is data: startup frames (before the hitbox is live),
active frames (hitbox live), recovery frames (vulnerable cooldown), plus
on-hit/on-block frame advantage. This is the fighting-game frame-data
model, and it is what makes telegraphs honest.

**Server-contract mapping:** windows are server data (authored, baked);
M5's TelegraphSystem already carries timing — extend it with the
three-phase split.

**Cost gate:** data, not code — near-zero runtime cost. The real cost is
authoring: every attack needs tuned numbers. Mitigation: start with 3–5
archetype timings and vary by multiplier.

### 3.3 Input buffering (client queue + server validation) → ADOPT

**What:** inputs pressed during uncommitted states are queued and executed
at the first legal moment, instead of being dropped. Industry windows:
fighting games 3–10 frames (50–167ms), action games 6–15 frames
(100–250ms). M5's one-deep queue is the v1 of this.

**Server-contract mapping:** the client buffers for *responsiveness*; the
server re-validates every buffered intent against current state (cooldowns,
interrupts, stun) before executing. A buffered input is a request, not a
fact.

**Extension (PARK for v1, design now):** priority buffering — dodge/escape
inputs outrank attack inputs in the queue.

**Cost gate:** O(1) insert, O(k) consume with k ≤ 3. No GPU cost. Server op
cost: validation is a few integer comparisons per intent.

### 3.4 GCD + cooldowns + casts + interrupts → ADOPT (M5 implements; validate)

**What:** the M5 AbilitySystem. Cross-check against the GAS pattern: cost
and cooldown applied atomically on commit; `CanActivate` checks before
execution; interrupt rules as data (which tags cancel which casts).

**Cost gate:** trivial per-tick cost. The risk is *design* debt, not perf:
inconsistent interrupt rules feel arbitrary. Keep the interrupt matrix in
data, reviewed like frame data.

### 3.5 Status effects: stacking, refresh, DoT/HoT, cleanse → ADOPT (M5 implements; validate)

**What:** the M5 StatusSystem, validated against the GAS GameplayEffect
model: every stat change flows through an effect object; stacking policies
explicit per effect; duration/infinite/instant kinds; removal conditions
documented.

**Cost gate:** tick cost is O(active effects); cap effects per entity
(e.g., 32) to bound worst case. No GPU cost. Server op cost: the tick loop
already walks entities — effects ride it.

### 3.6 Damage formula: data-driven exec calc → ADOPT

**What:** damage = base × crit × mitigation, with damage-type →
resistance mapping, computed server-side from data. Mirrors the GAS
Execution Calculation pattern without the engine.

**Server-contract mapping:** server computes the final integer; client
renders the number. Randomness (crits) uses the server's seeded RNG —
never `Math.random()` on the client for gameplay outcomes.

**Cost gate:** a few float ops per hit. No GPU cost. Keep the formula in
data so designers tune without code changes.

### 3.7 Block / parry / poise → ADOPT (design now, build after M5 lands)

**What:** guard as a state with a parry window on raise: block reduces a
frontal hit to chip and drains poise; enough chip breaks guard into
stagger; a hit inside the parry window negates damage and dumps poise onto
the attacker (punish opening). Guard protects the frontal arc only.

**Server-contract mapping:** all resolution server-side; windows
tick-measured and chunky enough to survive 30Hz quantization (no
sub-tick windows).

**Cost gate:** same as hit detection — rides the existing sweep. Design
cost is the tuning: poise numbers per archetype.

### 3.8 Combo system with cancel windows → ADOPT (design now)

**What:** attacks chain via a data-driven cancel tree: "attack_1 cancels
into attack_2 on frames 18–24, into dodge on frames 1–30." The buffer
stores attack type + timing + directional modifiers, not just "pressed
attack." Hitstop (§5.1) extends the practical cancel window — the
Street Fighter 2-in-1 lesson: the cancel exists *because* of hitstop.

**Cost gate:** combo-tree traversal is O(depth), depth ≤ 8. Data cost
again, not runtime.

### 3.9 Duel system (consensual PvP) → ADOPT (M5 implements)

**What:** the M5 DuelSystem. No verdict change needed; recorded here so the
backbone map (§6) is complete. PvP stays consensual — no open-world ganking
in v1 by design, not by omission.

### 3.10 Lag compensation: server rewind for melee → PARK

**What:** rewinding entity positions to the attacker's view time before
validating a hit (the Valve model).

**Why parked:** per source #9, PvE melee does not need it — 2+ unit
hitboxes and 300–500ms windows absorb <200ms RTT via continuous collision.
Rewind earns its complexity only for competitive PvP melee or sustained
>150ms-latency complaints.

**Revisit trigger:** PvP duel telemetry shows hit-registration complaints
correlated with ping. If parked work is revived, cap the rewind window
(e.g., 300ms) and store position history as a ring buffer per entity.

**Cost gate (if revived):** memory = entities × history ticks × position
bytes (bounded, small); CPU per validated hit is one extra sweep against
historical state. The real cost is complexity and the new cheat surface
(exaggerated lag claims) — hence PARK, not ADOPT.

### 3.11 Client-side attack prediction → ADOPT (limited)

**What:** on input, the client immediately plays the attack animation and
local VFX (the intent is *felt* now); the server's authoritative result
arrives ~RTT later and reconciles (hit confirmed, whiffed, interrupted).

**Boundary:** prediction covers *presentation of the attempt*, never the
outcome. No predicted damage numbers, no predicted kills.

**Cost gate:** reconciliation code is the cost — keep it simple: if the
server disagrees, snap to server state (no fancy rewind on the client).

### 3.12 Rollback netcode (GGPO-style) → REJECT

**What:** the fighting-game model: all peers simulate, mispredictions roll
back.

**Why rejected:** it is designed for P2P sessions of 2–8 players with
deterministic lockstep. It is structurally incompatible with a
server-authoritative MMO at scale — no central authority, full-state
snapshots per frame per client, and a cheat surface the server model
exists to close. Documented here so a future builder doesn't re-propose it.

### 3.13 Unreal GAS as a library → REJECT (as code) / ADOPT (as pattern)

**What:** GAS is the best-documented ability-system architecture in the
industry: AbilitySystemComponent owning three pillars (Abilities, Effects,
Attributes) with GameplayTags as requirements/grants/blockers.

**Why the split verdict:** the code ships under the Unreal Engine license
— not permissive, fails the license constraint. But the *pattern* maps
1:1 onto M5: AbilitySystem ≈ ASC + abilities, StatusSystem ≈ Gameplay
Effects, attributes ≈ the stat block, tags ≈ a future tag enum. New
builders should read GAS docs as the design spec and M5 as the
implementation.

**Cost gate:** zero — it is a reading assignment, not a dependency.

### 3.14 Community MIT ability frameworks → PARK

**What:** the Godot-community combat pattern collections (source #11) carry
usable input-buffer and hitbox/hurtbox reference code under MIT.

**Why parked:** M5 already implements the substance; vendoring reference
code now would be churn. Revisit if a second implementation (e.g., a
native client) needs the same patterns — vendor then, behind the bulk
boundary, per the Jolt precedent.

---

## 4. Netcode rules for combat

1. **Intents, not outcomes, cross the wire.** Client sends
   `AttackIntent{abilityId, tick, facing}`; server sends
   `HitEvent{targetId, damage, effects, knockback}`. (Protocol v22 already
   follows this shape — keep it.)
2. **Melee v1 needs no rewind** (§3.10). Ship without it; add on telemetry,
   not on theory.
3. **Cooldowns are server truth.** Client-side cooldown display is a
   courtesy; the server rejects early intents.
4. **All gameplay randomness is server-seeded.** Crits, proc chances,
   effect durations — the client's RNG is for particles only.
5. **Rate-limit combat intents** at the gateway (M5 already does) — the
   cheapest anti-cheat is refusing to process 200 intents/second.

---

## 5. The feel layer (client only — never the tick)

The animation authority rule extends here: **feel is presentation**. Every
technique in this section lives in the client render layer and must be
incapable of changing a gameplay outcome. This is the pending client UX
work from M5 — ability bar, telegraph rendering, status frame, duel UI —
done *right*.

### 5.1 Hitstop / hitpause → ADOPT

Freeze the world for a few frames at the moment of impact. The single
biggest contributor to hits feeling *crunchy*. Scale by impact grade:
light hits 25–35ms (barely perceptible), medium 50–70ms, heavy/finisher
90–120ms. Never reward a miss with weight — whiffs get 0ms.

Implementation notes: freeze via a single time-scale gate (reentrant calls
extend to the later end-time, never stack); UI and damage numbers keep
running on unscaled time. And per the fighting-game lesson, hitstop doubles
as the combo cancel window — cancels resolve at the end of the stop so
combos stay consistent.

**Cost gate:** zero GPU memory; ~zero frame-ms (it *removes* frames).
Quality-tier fallback: reduce durations on low tier, never below the
cancel-window minimum — or the combo system breaks.

### 5.2 Screen shake + camera kick → ADOPT

Trauma-based shake: hits add trauma, trauma decays over real time, shake
amplitude follows trauma. Decaying on *real* time so it moves through
hitstop correctly. Keep it small and directional — kick *away* from the
impact, never random.

**Cost gate:** trivial CPU. Quality-tier fallback: low tier gets reduced
amplitude; a "reduce motion" accessibility toggle zeroes it.

### 5.3 Hit flash, particles, knockback visuals → ADOPT

Enemy hit-flash (brief emissive/white flash), a particle burst at the
contact point, knockback rendered from the server's displacement vector.
The server moves the capsule; the client sells the violence.

**Cost gate:** particle pool is the budget — cap concurrent combat
particles (e.g., 512) and let the pool degrade gracefully. GPU memory:
one shared particle texture atlas, not per-effect textures.

### 5.4 Sound on every action → ADOPT

Every swing, hit, block, and whiff gets a layered sound; pitch-shift
repeated hits on a musical scale so combos *escalate* instead of
repeating. Audio is the cheapest juice per byte.

### 5.5 The polish-stack rule

No single effect ships alone. Every meaningful combat event gets **at
least three** of: hitstop, shake, particles, flash, knockback, sound,
damage number. One channel alone is never enough — and none of it lives
anywhere near the simulation.

---

## 6. Backbone mapping (M5 → server contract)

| M5 system | Server owns | Client renders | Wire (v22) |
|---|---|---|---|
| AbilitySystem | GCD, cooldowns, queue validation, cast/interrupt state | Bar, cooldown sweeps, cast bars | Intent → confirm/reject |
| TelegraphSystem | Zone shape, timing windows, active frames | Decals, edge glow, countdown | Zone spawn/update/expire |
| StatusSystem | Ticks, stacking, refresh, cleanse | Icons, timers, floating ticks | Apply/refresh/remove |
| Hit resolution | Capsule sweep in window, damage calc | Hitstop, flash, particles, numbers | HitEvent |
| DuelSystem | Challenge/accept/expire, first blood, yield | Prompts, banners | Duel messages |

**Next build order after M5 merges:** (1) client UX for the five rows
above — this is where §5 lands; (2) frame-data authoring for 3–5 attack
archetypes (§3.2); (3) block/parry/poise slice (§3.7); (4) combo cancel
trees (§3.8).

---

## 7. Decision register

- **D1 — No server rewind for melee v1.** Continuous collision + generous
  windows cover PvE. Revisit on PvP telemetry (§3.10).
- **D2 — Hitstop is client-only, forever.** It must be structurally
  incapable of touching the tick. A builder who puts hitstop in the sim
  has misunderstood the architecture.
- **D3 — GAS is a pattern, not a library.** Read the docs; ship M5.
  License constraint is non-negotiable.
- **D4 — Rollback netcode is rejected for the MMO.** P2P fighting-game
  tech does not scale to server-authoritative worlds.
- **D5 — Frame data and cancel windows are data, not code.** Designers
  tune numbers; the engine reads tables.
- **D6 — Buffered inputs are requests.** The server re-validates every
  one. Responsiveness without trust.

---

## 8. Field notes — ArcheAge Chronicles demo (2026-10-19 → 2026-10-26)

*Reserved section. Demo window: Oct 19, 1:00 PM EDT – Oct 26 (Steam Next
Fest). First public PvP build; Diamond Shores region; Warrior, Ranger,
Berserker, Mage; no housing/trade; progress does not carry to Early Access.*

*No notes yet. If the demo is played, record one melee and one ranged
class against the prompts below and fold the findings into §3/§5 as field
evidence.*

- **Combat feedback:** which hits felt crunchy vs. floaty? What sold the
  impact — hitstop, sound, shake, flash? Estimate the hitstop grade.
- **Camera framing:** how does the camera behave during combat — lock-on,
  kick on hit, framing of telegraphs? What would we steal?
- **Hit feel:** do attacks connect exactly when the animation says they
  do? Any perceptible input delay? How does the buffer feel?
- **Telegraph readability:** are danger zones readable at a glance?
  Timing honest? What would we change in our TelegraphSystem rendering?
- **Ability queue feel:** does the queue forgive early presses? Compare
  against our one-deep queue + planned priority buffering.
- **What to steal (max 3):** concrete techniques worth porting, mapped to
  a section of this doc.

*If the demo passes with no notes, this research stands complete on its
own — the section stays as a dated record of the opportunity.*

### Pre-demo checklist (added 2026-10-15 — details surfaced since the prompts)

- **Two weapons per class** (Warrior/Ranger/Berserker/Mage): how does
  weapon-swap feel — instant, GCD-gated, or stance-like? Is the second
  weapon a sidegrade or a different role? Compare against our one-deep
  queue assumptions.
- **PvP opt-in flow:** find the Nui Statue, note how the game presents
  the choice, whether channel population is shown before opting in, and
  how the **10–15% monster XP bonus** in PvP channels is communicated.
  This is the live reference for our consensual-PvP incentive design.
- **Zone channels (~100 players):** how crowded does a full channel
  feel? Channel-select UI, cross-channel grouping, any visible
  sharding seams.
- **Business model:** buy-to-play confirmed, no in-game store at EA
  launch — note any store/monetization UI (or its absence) and how the
  demo frames the EA pitch.
- **Logistics:** no preload — the Download Demo button appears on the
  Steam page when the Next Fest window opens Oct 19, 1:00 PM EDT.

---

## Sources (MLA-style Works Cited)

- Le Chevalier, Aurélie. "Modify Everything! Data-Driven Dynamic Gameplay
  Effects on *For Honor*." GDC 2017. Via GameDeveloper.
  https://www.gamedeveloper.com/design/video-delivering-data-driven-dynamic-gameplay-effects-in-i-for-honor-i-
- Henry, Jennifer. "Back to the Future! Working with Deterministic
  Simulation in *For Honor*." GDC 2019. (Netcode contrast reference —
  documents the P2P model this engine does *not* use.)
- Swink, Steve. *Game Feel: A Game Designer's Guide to Virtual Sensation*.
  Morgan Kaufmann, 2008.
- Nijman, Jan Willem. "The Art of Screenshake." INDIGO Classes, 2013.
  (Vlambeer talk; ~30 min.)
- Jonasson, Martin, and Petri Purho. "Juice It or Lose It." 2012.
- Valve Developer Community. "Lag Compensation." (Server-rewind reference
  architecture.)
- Wagar, Celia. "Hitstop/Hitfreeze/Hitlag/Hitpause/Hitshit." CritPoints,
  2017. https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit/
- Epic Games. "Gameplay Ability System" documentation. (Design reference
  only — Unreal Engine license; not adopted as code.)
- dreamteam-hq. "server-authoritative-combat/SKILL.md." GitHub (brigid).
  https://github.com/dreamteam-hq/brigid/blob/HEAD/server-authoritative-combat/SKILL.md
- "Designing Game Feel: A Survey." arXiv:2011.09201.
- MelonJS. "feat: add state.freeze() for hit-stop / hit-pause effects."
  PR #1421. (MIT-licensed reference implementation of the freeze
  primitive.) https://github.com/melonjs/melonJS/pull/1421
- Godot community combat-design pattern collections (omer-metin,
  chasexu168340-rgb). (MIT-licensed community code; patterns only.)
  https://github.com/omer-metin/skills-for-antigravity/blob/HEAD/skills/combat-design/references/patterns.md
