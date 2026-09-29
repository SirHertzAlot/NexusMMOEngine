# Mastery and Combat

Status: **design** (not yet built). Companion to
`docs/CHARACTERS-AND-SOCIAL.md`, whose characters this gives skills,
bodies and fights.

## 1. The idea

There are no classes and no levels. A character gets better at what it
does, by doing it. A player's "path" is whatever they practise.

Skill belongs to the **technique**, not the item. Cutting is a technique;
a sword is just a good tool for it. So anything can be used in any way a
player can swing it: a stick can cut, thrust or bludgeon. A master of
cutting with a stick beats a novice with a sword. An equal master with
the sword still does more, so items keep their value.

Characters are built from body parts (the same parts the character
creator assembles them from, `CHARACTERS-AND-SOCIAL.md` §4.7), and blows
land on one part. Depending on how hard and how it was struck, a part is
**harmed**, **maimed** or **dismembered**.

Death is not the end: characters **respawn**, and why they do is part of
the world's lore (§5).

### 1.1 Everything is a rule the game can change

This is an engine, and each game built on it decides its own rules. So
none of the numbers or lists here are code:

- **Rules are data.** Skills, gain curves, deterioration, body parts,
  injury thresholds, damage formula coefficients, and death and respawn
  are all read from a rules folder (`content/rules/*.json`), validated
  with Zod on load. The server refuses to start on a rules file that
  fails validation, and says which field is wrong.
- **Hooks for what data can't express.** A game can register functions
  at named points: `computeDamage`, `resolveLanding`, `skillGain`,
  `onInjury`, `onDeath`, `onRespawn`. The engine ships a default for
  each; a game replaces only what it needs.
- **Features can be switched off.** A game without limb damage uses a
  one-part body; a game without deterioration sets its rate to 0.
- **Two layers.** The engine's defaults (plain, neutral), and **our
  game's rules** on top. Where this doc says "our game" it means our
  rule set, not something the engine hard-codes.

The editor gets a rules view (after the PICG selection cards), so rules
are edited and checked in the same place as everything else.

## 2. Mastery

### 2.1 Skills

Every skill runs from 0 to 100 (stored in tenths). Write `m = skill/100`.

| Family | Skills (our game) |
|---|---|
| Weapon techniques | Cutting, Thrusting, Bludgeoning, Throwing, Striking (unarmed), Grappling |
| Defence | Parrying, Blocking, Evading |
| Body | Athletics (sprint, jump, climb), Swimming, Endurance |
| Survival | Foraging, Exposure (heat and cold from the climate), Medicine |
| Work | Woodcutting, Mining, Fishing, plus crafts as they arrive |

The list, families, gain curves and related skills live in
`content/rules/skills.json`.

### 2.2 Getting better

A skill gains experience only when it is **used for real**: a blow that
lands on someone fighting back, a parry that stops one, a tree that
falls, a swim that gets somewhere.

- **Challenge.** The gain depends on how hard the task was for you:
  `d = difficulty − m`. Near or above your level (`d ≥ 0`) teaches the
  most. Far below it (`d < −0.3`) teaches nothing, so hitting novices or
  chopping twigs does not make a master.
- **Slower at the top.** Each gain is scaled by `(1 − m)²`: the first 50
  points come quickly, the last 10 take a long time.
- **Anti-farming.** Using a skill on the same target again and again
  (a friend, a training dummy) gives less each time, recovering over an
  hour.
- **Related skills.** A small share (10–20 %) of a gain also goes to
  related skills (Cutting ↔ Woodcutting, Parrying ↔ Blocking), so a
  woodcutter starts out a little handier with an axe in a fight.
- **Item familiarity.** Using one family of items (sticks, swords,
  axes) also builds familiarity with it, worth up to +10 % item fit
  (§3.2). The technique matters far more than the tool.

### 2.3 Deterioration

There is no hard cap. Skills that go unused **deteriorate, slowly**, so
practice time is the real limit and players still specialise.

Our game's settings (`content/rules/skills.json`, `decay`):

| Setting | Value |
|---|---|
| Grace before decay starts | 14 days without using the skill |
| Rate | 1 % of the current value per week |
| Floor | 60 % of the skill's peak; it never falls lower |
| Relearning | 3× faster than learning, up to the old peak |

At that rate a master (100) who stops entirely is at about 94 after two
months and reaches the floor only after roughly a year. Decay is applied
when the character enters the world (from the last-use times on the
record), so no background job is needed.

### 2.4 Paths without classes

**Disciplines.** When a set of skills reaches given levels, the character
earns a named discipline (for example, *Staff Master*: Bludgeoning 80,
Parrying 70, Evading 50). A discipline is a title and can unlock a
special technique (a disarm, a sweep). Disciplines are data
(`content/rules/disciplines.json`), and they are how a player "chooses a
path" without a class. A discipline whose skills later decay below its
levels is kept as a title but its technique is unavailable until the
skills are back.

## 3. Using anything as a weapon

### 3.1 Items are physical

Every item that can be held has physical properties, not a damage number:

| Property | Meaning |
|---|---|
| `mass` (kg) | Heavier hits harder and swings slower |
| `length` (m) | Reach |
| `edge` 0–1 | How well it cuts |
| `point` 0–1 | How well it pierces |
| `hardness` 0–1 | How well it transfers a blunt blow, and how fast it breaks |
| `balance` 0–1 | How quickly it recovers between blows |
| `durability` | Wears with use; broken items are useless |

Examples: a stick has edge 0.05, point 0.2, hardness 0.4, mass 0.8 kg.
A sword has edge 0.9, point 0.8, hardness 0.9, mass 1.3 kg.

Because items are just properties, anything in the world can become one:
a branch knocked off a PICG-generated tree gets its mass and length from
the mesh that was cooked for it.

### 3.2 How hard a blow lands

The attacker picks a technique (cut, thrust or bludgeon). Each technique
reads one property as the item's **fit** for it: cut → `edge`, thrust →
`point`, bludgeon → `hardness`.

- **Mastery overcomes a poor tool:**
  `fit_eff = fit + (1 − fit) × 0.8 × m²`. A master can make a stick cut
  like a blade; a novice gets only what the item offers.
- **Mastery adds power:** `power = 0.4 + 1.6 × m^1.5` (0.4 for a
  novice, 2.0 for a master).
- **Damage:**
  `damage = 10 × √mass × fit_eff × power × part multiplier × armour factor`
  (part multipliers are in the body rules, §4.1).
- **Precision** (§4.4) decides where the blow lands, which is the other
  half of what mastery buys.

Worked example (no armour, head multiplier 2.0, torso 1.0):

| Attacker | Tool, technique | fit_eff | power | Lands on | Damage |
|---|---|---|---|---|---|
| Novice (m = 0.05) | Sword, cut | 0.90 | 0.42 | Wherever the swing drifts: torso | ≈ 4.3 |
| Master (m = 1.0) | Stick, cut | 0.81 | 2.0 | Aimed at the head: head | ≈ 29 |
| Master (m = 1.0) | Sword, cut | 0.98 | 2.0 | Head | ≈ 45 |

The master with a stick does about 7× what the novice with a sword does,
and chooses where; the same master with a sword does half as much again.
Every coefficient is a rule (`content/rules/combat.json`); these are
starting points for tuning, not balance.

### 3.3 The attack

1. **Wind-up.** The player starts an attack with a technique and an aim
   (a body part, or a region: head, torso, arms, legs, and a side).
   Wind-up time grows with the item's mass and falls with mastery and
   balance. Other players see the wind-up (it is replicated), so they
   can react.
2. **Strike.** At the end of the wind-up the server checks reach (item
   length plus arm reach) and a facing cone against the target.
3. **Defence.** If the defender is defending and facing the blow, their
   Parrying, Blocking or Evading is contested against the attacker's
   technique. Winning stops or deflects the blow; a parry by a much
   better defender can disarm.
4. **Landing.** The blow lands on a body part (§4.4), does damage, and
   may harm, maim or dismember it (§4.2).
5. **Recovery.** A short pause, set by balance and mastery, before the
   next attack.

Every roll uses a deterministic random stream seeded by the tick and the
two entities, so fights can be replayed in tests.

## 4. Body parts: harm, maim, dismember

### 4.1 Parts

The body is a tree of parts, defined in `content/rules/body.json`. Our
game uses the modular character's body pieces (`CHARACTERS-AND-SOCIAL.md`
§4.7), so what is damaged is exactly what is drawn:

| Part | Parent | Share of health | Hit multiplier | At 0 health |
|---|---|---|---|---|
| Head | Torso | 12 % | 2.0 | Death |
| Torso | — | 26 % | 1.0 | Death |
| Hips | Torso | 12 % | 1.0 | Legs useless |
| Upper arm (L, R) | Torso | 6 % each | 0.8 | Arm useless |
| Lower arm (L, R) | Upper arm | 5 % each | 0.8 | Forearm and hand useless |
| Hand (L, R) | Lower arm | 3 % each | 0.7 | Drops what it holds |
| Leg (L, R) | Hips | 11 % each | 0.8 | Cannot bear weight |

The overall health bar is the parts combined. Cosmetic pieces (hair,
eyebrows, facial hair, attachments) are not parts; armour attachments
cover the part they are worn on. A game can define any tree of parts
(a quadruped, a one-part body) in its own `body.json`.

### 4.2 Severity: harmed, maimed, dismembered

Each part is **healthy**, **harmed**, **maimed** or **dismembered**.
Which one a blow causes depends on how severe it was (the blow's damage
as a share of the part's maximum health, plus the part's state already)
and on the kind of damage:

| Kind | Harmed | Maimed | Dismembered |
|---|---|---|---|
| Cut | Any hit | One blow ≥ 50 % of the part, or the part at 0 | One blow ≥ 90 % of the part, or ≥ 40 % on a maimed part |
| Blunt | Any hit | One blow ≥ 40 % (a broken bone), or the part at 0 | Never (a head or torso at 0 is still death) |
| Thrust | Any hit | One blow ≥ 60 % (deep wound), or the part at 0 | Never |
| Fire, cold (climate) | Exposure | Frostbite or burns past a threshold | Frostbitten hands only, if the game allows it |

These thresholds are our game's rules; each is a number in `body.json`,
and the `onInjury` hook can replace the decision entirely.

**What each state means:**

- **Harmed.** Lost health, bleeding for cuts and thrusts. Heals on its
  own once bleeding stops. Penalties while below 40 % health:
  - arm, lower arm or hand: power and precision with that hand −25 %
  - leg or hips: speed −25 %, no sprint
  - head: blunt hits stagger; vision blurs on the client
  - torso: stamina recovers more slowly
- **Maimed.** A lasting impairment (a broken bone, a severed tendon, a
  crushed hand). The part works as if at 0 health until it is treated
  (Medicine: set, splint, stitch), then heals as harmed:
  - hand: cannot hold anything
  - lower or upper arm: that arm cannot attack or block
  - leg: speed −60 %, no jumping, weaker swimming; both legs or hips:
    crawl
- **Dismembered.** The part is gone, and so is everything below it in
  the tree: losing an upper arm loses the lower arm and hand too. Heavy
  bleeding until treated. The part stays lost until the character
  respawns (§5), the only way to regrow it in our game (a game can add
  others through the `onRespawn` hook or items). The client hides the
  missing pieces, which the modular character makes easy, and caps the
  stump.

**Bleeding.** Characters have **blood** (100). Cuts, thrusts and
dismemberment bleed at rates set in `body.json`; bandaging stops it. At
0 blood the character dies.

### 4.3 What kinds of damage do

- **Cuts** bleed, and are the only way to dismember.
- **Blunt** blows are softened less by armour, stagger, and break bones
  (maim) without severing.
- **Thrusts** find gaps in armour (more often with higher mastery) and
  bleed heavily.

### 4.4 Where blows land

The server does not animate skeletons. Where a blow lands is decided
from the attacker's aim and precision:

- With probability `precision = 0.3 + 0.65 × m` the blow lands on the
  aimed part (30 % for a novice, 95 % for a master).
- Otherwise it lands on a neighbouring part in the body tree, weighted
  by the part's size.
- A harmed or maimed arm lowers its own precision, so injuries feed back
  into the fight. A dismembered part can't be hit; blows aimed there
  land on its parent.

This is cheap, deterministic, and needs no per-bone physics on the
server. A later version can use real hit volumes from the character's
pose.

### 4.5 Healing

- Harmed parts recover on their own once bleeding stops.
- Maimed parts need treatment first: bandaging, setting bones and
  stitching all use **Medicine**, which improves by use like everything
  else. A skilled healer treats faster and more reliably.
- Dismembered parts come back only on respawn (our game).

## 5. Death and respawn

When a character's head or torso reaches 0, or its blood runs out, it
dies. Characters **respawn**, and the reason they do belongs to the
world's lore; the engine provides the mechanics and the lore decides how
they are dressed.

The engine side, all in `content/rules/death.json` plus the `onDeath`
and `onRespawn` hooks:

- **Where**: respawn points (anchors placed in the world, or chosen by
  a rule such as "nearest one the character has visited").
- **When**: a delay before respawning, optionally shown with lore text
  or an event.
- **What carries over**: skills (never lost by default), items (kept,
  dropped where the character fell, or partly lost), injuries (cleared,
  including lost parts, in our game).
- **What is remembered**: every death is recorded on the character
  (count, place, cause, killer), so the lore can react to it: the world
  can know how often, and how, a character has died and come back.

How our lore explains respawning, and whether dying costs anything
beyond the trip back, are still to be written; the mechanics above
support either.

## 6. In the ECS and on the wire

| Component | Fields | Sent to |
|---|---|---|
| `Body` (new) | `hp: [f32 × 16]`, `max: [f32 × 16]`, `blood`, `bleed` (one slot per part in the rules, up to 16) | Owner only (in the `self` message) |
| `Injury` (new) | `u32`: 2 bits of state per part (healthy, harmed, maimed, dismembered), for up to 15 parts, plus a bleeding bit | Everyone: limps, missing parts, blood |
| `Combat` (new) | `phase` (idle, wind-up, strike, recover, defend), `technique`, `aim`, `timer` | Everyone: animations and reactions |
| `Held` (new) | Item in each hand | Everyone |
| `Health` (exists) | `current, max`, now the sum of the parts | Everyone |

- **Intent** gains `technique` and `aim` (u8 each), and two button bits:
  Attack (0x02) and Defend (0x04). This is a protocol version bump.
- **Skills** stay server-side and go to the owner in the `self` message
  (see `CHARACTERS-AND-SOCIAL.md` §4.4).
- A new `CombatSystem` runs after `CharacterSystem`: it moves attacks
  through their phases, resolves strikes, and applies damage and skill
  gains. A `BodySystem` applies bleeding, healing, severity, death, and
  the movement and combat penalties of injuries.
- The rules loader is its own module in engine-core, shared by the
  server, the tests and the editor's rules view.

## 7. Slices

These replace slice C4 ("skills") in `CHARACTERS-AND-SOCIAL.md`. Each is
its own PR, with tests.

| # | Slice | Needs |
|---|---|---|
| M0 | Rules loader: `content/rules/*.json`, Zod schemas, the hook registry, engine defaults plus our game's rules (**built**: `packages/rules`, `content/rules`) | — |
| M1 | Mastery core: use-based gain with challenge, anti-farming, related skills, deterioration; first uses wired (Swimming, Athletics, Exposure); character sheet | M0, C2 |
| M2 | Body parts: `Body` and `Injury`, harm and maim from falls, drowning and exposure, bleeding, healing, penalties, death and respawn; injury display on the client | M1 |
| M3 | Items and melee: physical item properties, holding items, `Combat` phases, fit and power, precision and landing, defence contests, damage kinds and dismemberment; the attack and defend controls | M2 |
| M4 | Disciplines, familiarity, disarms, and Medicine | M3 |

M1 and M2 already work with what the world has today: swimming, falling,
drowning and the climate exist, so skills, injuries and respawning can be
tested before any weapons do.

## 8. Open questions

1. **The respawn lore**: why characters come back, and whether dying
   costs anything beyond the trip back (items dropped, time, a mark on
   the character).
2. **Player-versus-player rules**: where fighting other players is
   allowed at all.
3. **Regrowing lost parts**: only on respawn (this design), or also by
   rare healing or prosthetics.
