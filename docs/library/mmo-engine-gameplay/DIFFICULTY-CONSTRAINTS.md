# Difficulty Constraints — Research Behind the Implementation

**Date:** 2026-10-06 · **Status:** Research + implementation mapping
**Companion to:** the difficulty-budget model (attention, information, numeric,
resource, coordination, punishment, AI sophistication).
**Audience:** AI builders implementing the encounter director and DDA systems.

---

## 0. Thesis

Every difficulty system that survives contact with players does the same
three things: **measures** player state, **compares** it against a target
experience curve, and **actuates** through a small set of constrained
variables. The research below is organized around that loop, with concrete
variables and numbers from primary sources.

---

## 1. The canonical implementation: Left 4 Dead's AI Director

Mike Booth (Valve) documented the Director in "The AI Systems of Left 4 Dead"
(2009) — the most-cited encounter-pacing implementation in games, and the
direct ancestor of the encounter director in this engine's design.

**How it works (from Booth):**
- The Director **monitors pacing**, not just difficulty. If the team has been
  bombarded, it schedules relief; if the team is chewing through enemies, it
  escalates. The controlled variable is *dramatic intensity over time*, not
  a static challenge level.
- Population is **fully procedural**: "no triggers, generators, special
  flags, or other human-placed information in the environment." A tweak to
  one piece of code re-populates every map — the same economy-of-authoring
  argument this engine makes for procgen generally.
- Survivor **stress is measured** from in-game signals (health, incapacitation,
  separation), and spawn decisions follow from it.

**What to steal:** the intensity-curve model. The Director doesn't ask "is
this hard enough?" — it asks "where are we on the tension/release arc, and
what does the next beat need?" Implement the director as a **pacing controller
with difficulty as one of its outputs**, not a difficulty knob with pacing as
a side effect.

**MMO adaptation note:** L4D's Director serves 4 players in a session. An MMO
region serves hundreds. The director therefore runs **per shard/region**,
reading aggregate signals (death rate, average party HP, objective velocity)
rather than individual stress — same loop, coarser grain.

## 2. Concrete difficulty variables (GameDev.net practitioners)

A GameDev.net design thread ("Dynamic difficulty discourages success")
proposes the disciplined version of variable selection: enumerate desired
player experiences first (progress, power, familiarity, leveling, fame), then
define difficulty variables, then design deliberate actions that move each
variable while serving an experience goal. The example variable set:

- **D1** respawn rate of an area
- **D2** monster type spawned in an area
- **D3** monster damage power
- **D4** player mana/health recovery rate
- **D5** inventory/supply carrying limits

Two practitioner insights worth encoding:

1. **Tie adjustments to concrete accomplishments, not invisible rubber-banding.**
   "Kill fast → faster respawns → regional boss appears → boss defeated →
   region calms." The player can *read* the causality. Invisible stat-shifting
   breeds distrust; visible systemic response breeds mastery. This maps
   directly onto the living-sim: the encounter director should actuate
   through **sim-legible channels** (spawn tables, faction aggression,
   resource scarcity) rather than hidden multipliers.
2. **The "difficulty as a place" metaphor** (companion GameDev.net thread):
   easy and hard as *locations*, not settings. Traveling somewhere dangerous
   is a player-chosen difficulty contract — no shame, no menu, full
   immersion. For the MMO: region threat levels are the difficulty UI.

## 3. Skill measurement and the flow channel

The `difficulty-adapter` agent spec (sponticelli/gamedev-claude-plugins)
collects the practitioner-standard signal set — the concrete metrics a
director actually reads:

- **Combat:** deaths per encounter, damage taken vs. dealt, healing-item
  usage, time to complete, hit rate
- **General:** resource surplus/shortage, progression velocity, idle time

**Skill modeling:** running averages
(`skill = α·recent + (1−α)·previous`), windowed histories, or population
percentiles; multi-dimensional tracking (combat vs. exploration skill kept
separate — a player can be a great explorer and a mediocre fighter).

**Micro vs. macro adjustment:** immediate (next few seconds — prevent
frustration spikes) vs. session-level (next minutes/hours — match player
growth). Both loops run; they actuate different variables. Micro adjusts the
current encounter (spawn timing, enemy aggression); macro adjusts the region
(threat level, supply distribution).

**Flow theory** is the target both loops serve: keep challenge proportional
to measured skill. The doc's warning is the one that matters for
implementation — miscalibrated DDA insults the player, so **actuation ranges
must be bounded and the bounds playtested**, never open-ended.

## 4. Academic parameter tables (what actually gets tuned)

"Exploring Dynamic Difficulty Adjustment Methods for Video Games"
(Semantic Scholar) tabulates the concrete parameters researchers actually
vary — the unglamorous truth behind "adaptive AI":

- **Player-side:** reload time, aim-down-sights speed, aim assist strength
- **Enemy-side:** health, fire rate, **aiming error** (intentional inaccuracy
  modeled as a sphere around the player — larger sphere, easier game),
  move/reposition delay

The aiming-error finding generalizes: **the highest-leverage difficulty
variables are usually information/precision variables, not stat variables.**
An enemy that misses by more is *perceived* as fairer than an enemy with less
HP — it preserves the fantasy while lowering the attention tax. Encode this
as a design rule: when the director needs to ease pressure, degrade enemy
*precision and coordination first*, stats last.

## 5. The alternative paradigm: organic (player-set) difficulty

GameDev.net's "A Different Approach to Difficulty" argues the paradigm shift:
instead of the game guessing the right challenge, give players **integrated
in-world tools to set their own difficulty** — the "let players cook to their
palate" model. Design obligation: every tool must have genuine usability;
depth that never matters is wasted.

For this engine, the synthesis is: **director-managed baselines +
player-chosen risk contracts.** Bounties, cursed zones, wager mechanics —
opt-in difficulty with commensurate reward, all legible inside the fiction.
The director keeps the floor fair; players choose their own ceiling.

---

## 6. Implementation mapping: the encounter director

```
SIGNALS (measure)          MODEL (compare)            ACTUATORS (constrained)
─────────────────          ───────────────            ──────────────────────
deaths/encounter     ──▶   intensity vs target arc ──▶ spawn pacing/timing
damage taken/dealt   ──▶   skill estimate (α-blend) ──▶ composition (roles)
healing usage        ──▶   attention load estimate ──▶ enemy precision (aim err)
objective velocity   ──▶   resource state            ──▶ aggression/react delay
party separation           relief scheduling         ──▶ relief scheduling
                                                     ──▶ region threat level
```

**Hard rules for the implementation:**
1. **Actuate through sim-legible channels** (spawn tables, faction
   aggression, supply) — never invisible stat multipliers. (§2.1)
2. **Bound every actuator.** Each variable has a min/max set by design and
   validated by playtest; the director interpolates within bounds. (§3)
3. **Precision before stats.** Ease pressure via aiming error, telegraph
   duration, and reaction delay before touching HP/damage. (§4)
4. **Pacing first.** The director owns the tension/release arc; difficulty
   is one output among several. (§1)
5. **Two loops.** Micro (seconds, current encounter) + macro (minutes,
   region). Different signals, different actuators. (§3)
6. **Player-chosen ceilings.** Opt-in risk contracts for players who want
   more than the director's arc offers. (§5)

---

## Works Cited

Booth, Michael. "The AI Systems of Left 4 Dead." Valve, 2009.
steamcdn-a.akamaihd.net/apps/valve/2009/ai_systems_of_l4d_mike_booth.pdf.
The canonical encounter-director implementation: pacing monitoring,
procedural population, survivor-stress measurement.

"Dynamic Difficulty Adjustment." GameDev.net forums, topic 666665.
gamedev.net/forums/topic/666665-dynamic-difficulty-adjustment/. "Difficulty
as a place" metaphor thread.

"Dynamic difficulty discourages success." GameDev.net forums, topic 515337.
gamedev.net/forums/topic/515337-dynamic-difficulty-discourages-success/.
D1–D5 variable framework; accomplishment-triggered adjustment.

"Exploring Dynamic Difficulty Adjustment Methods for Video Games."
pdfs.semanticscholar.org/fe6b/cd19500db657e3f698b13b83f949d17986c0.pdf.
Academic parameter tables: reload time, ADS speed, aim assist, enemy aiming
error, move delay.

"Game Design: A Different Approach to Difficulty." GameDev.net,
gamedev.net/tutorials/game-design/game-design-and-theory/game-design-a-different-approach-to-difficulty-r4992.
Organic/player-set difficulty paradigm.

Sponticelli. "difficulty-adapter.md." gamedev-claude-plugins, GitHub.
github.com/sponticelli/gamedev-claude-plugins. Practitioner signal set,
skill modeling, micro/macro adjustment loops, flow channel.
