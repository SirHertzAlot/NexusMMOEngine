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

Characters are built from body parts, and blows land on one part. A
broken leg slows you, a wounded sword arm weakens your swing, and a blow
to the head can end a fight.

## 2. Mastery

### 2.1 Skills

Every skill runs from 0 to 100 (stored in tenths). Write `m = skill/100`.

| Family | Skills |
|---|---|
| Weapon techniques | Cutting, Thrusting, Bludgeoning, Throwing, Striking (unarmed), Grappling |
| Defence | Parrying, Blocking, Evading |
| Body | Athletics (sprint, jump, climb), Swimming, Endurance |
| Survival | Foraging, Exposure (heat and cold from the climate), Medicine |
| Work | Woodcutting, Mining, Fishing, plus crafts as they arrive |

Skill definitions are data (`content/skills.json`: id, family, gain
curve, related skills), so they are tuned without code changes.

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
  (§3.2). "You get better at using it" applies to the tool too, but the
  technique matters far more.

### 2.3 Paths without classes

- **No hard cap.** Instead, skills you stop using **rust**: after 7 days
  without use a skill slowly falls, but never below 60 % of its peak, and
  regaining lost points is 3× faster than learning them the first time.
  Practice time is the real limit, so players still specialise.
- **Disciplines.** When a set of skills reaches given levels, the
  character earns a named discipline (for example, *Staff Master*:
  Bludgeoning 80, Parrying 70, Evading 50). A discipline is a title and
  can unlock a special technique (a disarm, a sweep). Disciplines are
  data, so designers add them freely, and they are how a player "chooses
  a path" without a class.

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
  (part multipliers: head 2.0, torso 1.0, arms and legs 0.8).
- **Precision** (§4.3) decides where the blow lands, which is the other
  half of what mastery buys.

Worked example (no armour):

| Attacker | Tool, technique | fit_eff | power | Lands on | Damage |
|---|---|---|---|---|---|
| Novice (m = 0.05) | Sword, cut | 0.90 | 0.42 | Wherever the swing drifts: torso | ≈ 4.3 |
| Master (m = 1.0) | Stick, cut | 0.81 | 2.0 | Aimed at the head: head | ≈ 29 |
| Master (m = 1.0) | Sword, cut | 0.98 | 2.0 | Head | ≈ 45 |

The master with a stick does about 7× what the novice with a sword does,
and chooses where; the same master with a sword does half as much again.
These numbers are starting points for tuning, not balance.

### 3.3 The attack

1. **Wind-up.** The player starts an attack with a technique and an aim
   (head, torso, arms or legs, and a side). Wind-up time grows with the
   item's mass and falls with mastery and balance. Other players see the
   wind-up (it is replicated), so they can react.
2. **Strike.** At the end of the wind-up the server checks reach (item
   length plus arm reach) and a facing cone against the target.
3. **Defence.** If the defender is defending and facing the blow, their
   Parrying, Blocking or Evading is contested against the attacker's
   technique. Winning stops or deflects the blow; a parry by a much
   better defender can disarm.
4. **Landing.** The blow lands on a body part (§4.3) and does damage.
5. **Recovery.** A short pause, set by balance and mastery, before the
   next attack.

Every roll uses a deterministic random stream seeded by the tick and the
two entities, so fights can be replayed in tests.

## 4. Body parts and limb damage

### 4.1 Parts

Six parts: **head, torso, left arm, right arm, left leg, right leg**
(hands and feet belong to their limb). Each has its own health, and its
own armour slot. The overall health bar is the parts combined.

| Part | Share of health | At 0 |
|---|---|---|
| Head | 15 % | Down |
| Torso | 35 % | Down |
| Each arm | 12.5 % | Disabled: drops what it holds |
| Each leg | 12.5 % | Disabled: cannot bear weight |

Each part is in one of four states: **healthy** (above 75 %), **hurt**,
**wounded** (below 40 %) and **disabled** (0, for limbs).

### 4.2 What injuries do

| Part | Wounded | Disabled |
|---|---|---|
| Arm | Power and precision with that hand −25 % | Drops its item; no two-handed items |
| Leg | Speed −25 %, no sprint | Speed −60 %, no jumping, weaker swimming; both legs: crawl |
| Head | Blunt hits stagger; blurred vision on the client | Down |
| Torso | Stamina recovers more slowly | Down |

How the damage was done matters too:

- **Cuts** make bleeding wounds (blood loss over time).
- **Blunt** blows are softened less by armour, stagger, and can break a
  limb (disabled until the bone is set).
- **Thrusts** find gaps in armour (more often with higher mastery) and
  bleed heavily.

Characters have **blood** (100). Bleeding drains it; at 0 the character
goes down. "Down" leads to death or a knock-out, depending on the rules
chosen in §7.

### 4.3 Where blows land

The server does not animate skeletons. Where a blow lands is decided
from the attacker's aim and precision:

- With probability `precision = 0.3 + 0.65 × m` the blow lands on the
  aimed part (30 % for a novice, 95 % for a master).
- Otherwise it lands on a neighbouring part (head ↔ torso, torso ↔
  arms and legs, arm ↔ torso), weighted by size.
- A wounded arm lowers its own precision, so injuries feed into the
  fight.

This is cheap, deterministic, and needs no per-bone physics on the
server. A later version can use real hit volumes from the character's
pose.

### 4.4 Healing

- Parts recover slowly on their own, but bleeding must be stopped and
  broken limbs set first.
- Bandaging, setting bones and stitching use **Medicine**, which improves
  by use like everything else: a skilled healer is faster and gets people
  back to full.

## 5. In the ECS and on the wire

| Component | Fields | Sent to |
|---|---|---|
| `Body` (new) | `hp: [f32 × 6]`, `max: [f32 × 6]`, `blood`, `bleed` | Owner only (in the `self` message) |
| `Injury` (new) | `u16`: 2 bits of state per part, plus a bleeding bit | Everyone: limps, hanging arms, blood |
| `Combat` (new) | `phase` (idle, wind-up, strike, recover, defend), `technique`, `aim`, `timer` | Everyone: animations and reactions |
| `Held` (new) | Item in each hand | Everyone |
| `Health` (exists) | `current, max`, now the sum of the parts | Everyone |

- **Intent** gains `technique` and `aim` (u8 each), and two button bits:
  Attack (0x02) and Defend (0x04). This is a protocol version bump.
- **Skills** stay server-side and go to the owner in the `self` message
  (see `CHARACTERS-AND-SOCIAL.md` §4.4).
- A new `CombatSystem` runs after `CharacterSystem`: it moves attacks
  through their phases, resolves strikes, and applies damage and skill
  gains. A `BodySystem` applies bleeding, healing, and the movement and
  combat penalties of injuries.

## 6. Slices

These replace slice C4 ("skills") in `CHARACTERS-AND-SOCIAL.md`. Each is
its own PR, with tests.

| # | Slice | Needs |
|---|---|---|
| M1 | Mastery core: skill data, use-based gain with challenge, anti-farming, related skills, rust; first uses wired (Swimming, Athletics, Exposure); character sheet | C2 |
| M2 | Body parts: `Body` and `Injury`, damage to parts from falls and drowning, bleeding, healing, movement penalties; injury display on the client | M1 |
| M3 | Items and melee: physical item properties, holding items, `Combat` phases, fit and power, precision and landing, defence contests, damage types; the attack and defend controls | M2 |
| M4 | Disciplines, familiarity, disarms, and Medicine | M3 |

M1 and M2 already work with what the world has today: swimming, falling
and drowning exist, so bodies and skills can be tested before any
weapons do.

## 7. Open questions

1. **Rust or a hard cap?** This design uses rust (no cap, skills fade
   when unused). A hard total cap forces choices more sharply.
2. **What "down" means:** death with a respawn, a knock-out that others
   can finish or save, or both depending on the area.
3. **Severed limbs:** allowed (and then how they are restored), or never
   beyond "disabled".
4. **Body parts and the art:** six parts is the proposal. If the
   character rigs are segmented differently (hands, feet, neck), the
   part list should match them.
5. **Player-versus-player rules:** where fighting other players is
   allowed at all.
