# Miisan's shorts: unified themes, Nexus generics

Filed 2026-11-12 (creator-sweep pass). Looks through @mii_misan's other shorts
for themes that become reusable, data-driven systems. The seed reel, "Juicy
Damage Numbers", is in [`DAMAGE-NUMBERS-PROCESS.md`](DAMAGE-NUMBERS-PROCESS.md)
and is not re-reviewed here.

## Coverage

- 10 reels reviewed (every reel on the profile except the seed).
- 6 story highlights reviewed from captions only (announcements; a
  Celeste-mods CRT post and a shader-practice post, handled below).
- The posts endpoint returned 17 items and a next page with no usable cursor,
  so this covers the visible recent shorts, not a proven complete archive.

## Inventory

| Reel | Topic | Techniques | Feeling |
| --- | --- | --- | --- |
| DeuFlMJBXZO (2026-10-20) | FYP devlog, 3D arena brawler | Commit-by-commit progression from capsules | Pride; not a technique |
| DbS8p3VuhkL (2026-07-27) | Celeste-style hair | 5-point chain, max-distance leash, spring-damper F = -kx - cv, shrinking circles | Life, identity |
| Da-PdjxOT9R (2026-07-19) | Persona-style main menu | Theme colour, striped background, -8 degree slant, cascade layout, staggered pops, invert selection, screen kick, panel wipe | Attitude |
| Dauh04XOYhl (2026-07-13) | RPG dialogue box | Typewriter, punctuation pauses, per-letter pop, shake/wave glyphs, keyword colour, bobbing arrow, mouth flap | Voice |
| DamtFQYxYtn (2026-07-10) | Health bar | Lerp drain, ghost chunk, colour bands, shake, flash, punch, numbers, heal sparkles | Readable consequence |
| DYCKURdRJQn (2026-05-07) | RPG menu | Focus overlay lerp, icon swap, connector lines with pulse dot, idle float, 9-slice box | Orientation |
| DXZ35VuEx0e (2026-04-21) | Game-feel cube | Squash, stretch, anticipation, dust, shake, flash, 0.07 s hitstop | Weight |
| DXJzEuEDkkv (2026-04-15) | RE4 grid inventory | Footprints, snap and validity, rotation, context menu, badges, stacks, combine | Tactile ownership |
| DXETU-NETOc (2026-04-13) | Animated main menu | Eased slide-ins, stagger, sine float, hover treatment, cursor trail | Welcome |
| DW_wiiPDmlU (2026-04-11) | Living cards | Drop shadow, lerp hover, delayed follow, sine wobble, X-squeeze flip, holo foil, staggered deal | Physicality |

## The generics

Each is data (recipes in the art-package schema style), a pooled and
budgeted runtime, and a scale guard for the 1,000-user / 50,000-entity
single-region target. Server decides, client renders: all are client
presentation fed by authoritative events, except GENERIC 6, whose contents
are server-authoritative.

### 1. Motion Grammar (shared feel vocabulary)

From: cube, cards, both menus, hair, dialogue, health bar.
One library of named primitives, pure functions of (progress, params),
composable in sequence or parallel: `pop`, `squashStretch`, `anticipation`,
`lerpFollow`, `sineIdle`, `spring`, `punch`, `flash`, `shake`, `hitstop`,
`stagger`, `wipe`/`flip`. A motion recipe per use site names primitives with
overrides, e.g. `{on: spawn, steps: [pop{overshoot: 1.35, ms: 120}, sineIdle{amp: 2, freq: 0.8}]}`.
One evaluator walks pooled active stacks per frame; an active-stack budget
caps cost and distance/quality tiers shed stacks first. Substrate for 2-5.

### 2. Vitals Readout (bars that tell the truth late, on purpose)

From: the health-bar reel; one system with the damage numbers.
Any state quantity (HP, shield, stamina, boss enrage) renders through one
component with a gap between true (server) and displayed (client) value:
DRAIN (lerp to truth) -> GHOST (delayed chunk shows what the last hit cost)
-> STATE (colour from % bands) -> REACT (flash/shake/punch, GENERIC 1) ->
HEAL (faster, brighter, sparkles). Recipe: drain rates, ghost delay, bands,
reaction scaling, per-class overrides (player/ally/enemy/boss). Plugs into
party and target frames, nameplates, boss bar. Instantiated per visible bar only.

### 3. Text Performance (dialogue engine)

From: the dialogue reel.
Line data (speaker, marked-up text) flows TOKENISE -> TYPE (chars/sec,
punctuation dwell) -> PERFORM (per-glyph pop/shake/wave, GENERIC 1) -> VOICE
(portrait mouth flap, blips) -> AFFORD (bobbing continue arrow). A glossary
auto-colours terms (items, places, omens) everywhere. Plugs into NPC dialogue,
quest turn-ins, tutorials, announcements. Server sends line id and variables;
one performance per client, no scale question.

### 4. Interface Choreography (menus and focus as a system)

From: Persona menu, RPG menu, main menu, cards.
Menu definition (items, layout motif, theme tokens) -> ENTER (staggered
cascade) -> FOCUS (state machine: scale/invert/indicator, others dim) ->
CONNECT (optional connector lines with travelling pulse) -> CONFIRM (punch,
screen kick) -> LEAVE (wipe/flip). Theme tokens: swappable theme colour,
slant, motif (cascade/chevron/grid), focus treatment, idle drift, indicator
style, and rarity sheen (the cards' foil). Rhymes with the editor's
template/token direction (T2). UI-only, negligible cost.

### 5. Follow-Chains (secondary motion)

From: the hair reel; echoes in card follow and the travelling pulse.
Anchor -> SIMULATE (per point leash constraint, spring F = -kx - cv, gravity
and wind) -> RENDER (tapering strip, sprites or skinned strip). Recipe: point
count, leash, k, c, gravity/wind response, width profile, texture, and a `lod`
block. Hair, capes, tails, tabards, ropes, charms, tendrils. Mirror client
only, never networked. The real risk: a chain per entity at 50,000 entities
is unaffordable, so LOD by distance and on-screen count (full near, short mid,
static or hidden far) with a global active-chain budget is mandatory.

### 6. Spatial Inventory (grid containers with footprints)

From: the RE4 inventory reel. A rules system, not juice.
Container (grid WxH) plus items (footprint, rotatable, stackable) -> PLACE
(drag, snap, validity) -> ACT (context verbs: equip, combine, discard, use)
-> MARK (badges: equipped, count, locked). Container and item schemas as
data. Contents are server-authoritative and the server validates every move;
the client renders drag/snap with lerp smoothing. Per-player, negligible
render cost. Overlaps the existing bag grid (U10a).

## What does not generalize

- The FYP devlog: a work habit (build from capsules, iterate in commits).
- The CRT overlay: one post-processing shader, not a system.
- Story highlights: announcements and admin.
- The Persona slant: one token value in GENERIC 4, not a mechanism.

## Pattern of the creator

Plain functional default, then one perceptual variable per numbered step, then
all-together versus plain. Small independent removable layers, which is the
shape of our recipes (VFX, decoration layers, damage numbers). He reuses one
motion vocabulary everywhere (GENERIC 1), uses colour as information (damage
types, HP bands, keywords, themes), and thinks in tunable constants (0.07 s
hitstop, -8 degrees, 5 points) that a recipe field can hold.

## Verdicts

1. Motion Grammar: **adopt first**; the cheapest, and five others call it.
2. Vitals Readout: adopt as one system with the damage numbers.
3. Text Performance: adopt when the dialogue lane is scheduled.
4. Interface Choreography: adopt as the HUD menu layer.
5. Follow-Chains: adopt **with the LOD gate**; the budget is not optional.
6. Spatial Inventory: adopt as a data/rules design when inventory UI is
   scheduled; server-validated moves are the price.
