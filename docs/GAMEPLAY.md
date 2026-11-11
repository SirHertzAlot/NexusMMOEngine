# Gameplay

What a player can do today, and how each piece is implemented. The numbers
here are the server's, read from source — the client sends intent, the server
decides. For the machinery behind it see [ARCHITECTURE.md](ARCHITECTURE.md);
for the design behind mastery, damage and injury, see
[MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md).

## Controls

While the canvas has the pointer (click it to capture; `Esc` releases):

| Input | Action |
|---|---|
| Mouse | Look (third-person orbit; sensitivity 0.0025 rad per pixel) |
| Mouse wheel | Camera distance (4–24 m) |
| `W` `A` `S` `D` / arrows | Move |
| `Space` | Jump; up while swimming or flying |
| `C` | Down while swimming or flying |
| `F` | Toggle flight (only when the server grants it) |
| Left mouse | Attack — press again in rhythm to chain the combo |
| Right mouse (held) | Guard |
| `Q` | Dodge roll |
| `E` | Interact: open a chest or a shop, pick up a ground item, gather from a node, talk to a quest giver, enter a dungeon |
| `R` / `T` | Next technique / next body part to aim at |
| `H` | Treat your worst wound (Medicine) |
| `Tab` | Cycle targets |
| `B` | Bag |

`Space`, `F`, left mouse and `Q` are **press** inputs; the rest are held
state. The client's input layer is DOM-free and unit-tested, and it sends one
intent per server tick: pressing and releasing within a single tick still
reaches the server as a press followed by a release, so no input is lost to
the tick boundary.

## Movement

The server owns movement. `IntentSystem` turns your wish-move into velocity;
`IntegrateSystem` advances position; `CharacterSystem` then corrects the
vertical axis against the terrain in the same tick.

The speed is the server's, by mode:

| Mode | Speed |
|---|---|
| Walking | `PLAYER_SPEED` = 6 m/s |
| Swimming | `SWIM_SPEED` = 3 m/s |
| Flying | `FLY_SPEED` = 12 m/s |

These numbers are rules data: `content/rules/movement.json` (`walkSpeed`, `swimSpeed`, `flySpeed`, `gravity`, `jumpSpeed`, `breathSeconds`, `breathRecovery`, `drownDamagePerSecond`, `flightCeilingM` and the stamina costs below). The capitalised names in this section are the engine's code names for them.

The client cannot exceed these: `sanitizeIntent` normalises your horizontal
wish-move to unit length, so the *direction* is yours but the *speed* is the
server's.

**Gravity and grounding.** `GRAVITY` = 22 m/s². Jumping is on the rising edge
of the jump input while grounded, at `JUMP_SPEED` = 8 m/s, so holding the key
does not multi-jump. When you are within `GROUND_SNAP` = 0.08 m of the
surface you are glued to it, which is what keeps you on a slope rather than
skipping down it. Ground height comes from the same chunk tiles the world is
built from, through a small LRU cache (64 chunk tiles) so walking does not
re-generate heightfields every tick.

**World edge.** Your X and Z are clamped just inside the world's bounds
(`maxX - 0.01`), so you walk into an invisible wall rather than off the map.

### Stamina

Exertion costs stamina (`StaminaSystem`, with the costs in `movement.json`):

| Action | Cost |
|---|---|
| Dodge | 20, flat |
| Attack | 10, flat |
| Jump | 8, on the press (only from the ground) |
| Swimming | 10 per second while you are moving |
| Running | 6 per second |

Attacks and dodges spend at the start of the move, and **a move you cannot afford never starts**. After your last spend there is a 1 second pause, then stamina regenerates at the `staminaRegen` stat (12 per second by default), slower while injured. The pool floors at zero. Climbing has no locomotion yet, so nothing drains for it.

### Swimming

Walk into water deeper than `SWIM_DEPTH` = 1.3 m and you start swimming;
`Locomotion.mode` becomes `Swim`, the speed drops to 3 m/s, and `Space`/`C`
become vertical control at `SWIM_VERTICAL_SPEED` = 2 m/s. Afloat, your head
(`HEAD_HEIGHT` = 1.7 m) is held above the surface (`FLOAT_DEPTH` = 1.4 m).
Walk back into the shallows and you stand up.

**Breath.** Underwater you hold `BREATH_SECONDS` = 30 s of air. Surfacing
refills it over `breathRecovery` = 3 s. Run out and you lose
`DROWN_DAMAGE_PER_SECOND` = 10 health per second and are pushed up toward the
surface until you can breathe.

Swimming is the default ability: unset or empty `MMO_PLAYER_ABILITIES` means
`swim`, and the word `none` means no abilities at all. With `none` there is no
swimming skill — you walk along the bottom. An unrecognised word is a startup
error rather than a silent default.

### Flight

Granted with `MMO_PLAYER_ABILITIES=swim,fly`; `F` toggles it (subject to the
server's ability bits). Flight climbs and dives at `FLY_VERTICAL_SPEED` = 6
m/s, cruises at 12 m/s, and is capped at `MAX_FLIGHT_HEIGHT` = 250 m. Toggling
off in mid-air drops you; diving into deep water starts you swimming.

## Combat

Combat is server-authoritative: the client asks for a move, and the server decides what
happens. Blows land on body parts, and damage, injury, bleeding, healing and death all run on
the server and come back to clients as events (see [Hurt, healing and death](#hurt-healing-and-death)).
The server runs each character's current move and tells clients which move they are in and from
which tick, so a client only ever plays the clip it is told about. The move table lives in
`packages/protocol/src/combat.ts` and is shared by the server (timing, chaining, movement) and
the client (which clip). **Move ids are wire contract**; the durations are the animation clips'
own, and a test keeps the two in step. The design behind mastery, damage and injury is in
[MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md).

### The moves

| Move | Id | Clip | Duration | Chain window | Forward travel | Walk |
|---|---|---|---|---|---|---|
| Sword A | 1 | `Sword_Regular_A` | 0.4333 s | 0.08–0.4333 → B | 0.79 m / 0–0.4333 s | 0 |
| Sword B | 2 | `Sword_Regular_B` | 0.5333 s | 0.08–0.5333 → C | — | 0 |
| Sword C (finisher) | 3 | `Sword_Regular_C` | 2.0 s | — | 1.49 m / 0.1–0.9 s | 0 |
| Sword A recovery | 4 | `Sword_Regular_A_Rec` | 0.9667 s | 0–0.25 → B | 0.3 m / 0–0.6 s | 0.3 |
| Sword B recovery | 5 | `Sword_Regular_B_Rec` | 1.0333 s | 0–0.25 → C | 0.35 m / 0–0.6 s | 0.3 |
| Guard | 6 | `Idle_Shield_Loop` | held | — | — | 0.35 |
| Roll | 7 | `Roll` | 1.4667 s | — | 4.5 m / 0.05–1.05 s | 0 |
| Shield bash | 8 | `Shield_OneShot` | 0.8333 s | — | — | 0 |

### How the combo works

The sword attack is a three-hit chain. An attack pressed during a hit's
**chain window** is queued; when the current hit lands (`branchAt`) the queued
hit starts, facing wherever you now look. With nothing queued, the hit's
**recovery** plays instead — and because the recovery has its own chain window
(0–0.25 s) opening from its first frame, a press early in the recovery still
picks the combo back up. That is what makes the rhythm feel forgiving rather
than frame-perfect.

### Guard, dodge, and their rules

- **Guard** is `held`: it lasts while right mouse is down and its clip loops.
  It slows walking to 35% and turning faces wherever you look. Pressing attack
  while guarding plays **shield bash**; releasing guard ends the move.
- **Dodge** is a 4.5 m roll along the direction you were moving, or along your
  facing if you were standing still. `moveScale` is 0, so nothing else carries
  you during it.
- **New moves start only on the ground** (`Locomotion.mode === Ground`).
  You cannot start an attack, guard or roll in mid-air or in water.
- During a move your walking is scaled by the move's `moveScale`, and the
  move's own `advance` carries you along its facing — a lunge on the swings,
  the whole 4.5 m on the roll.

### What combat does *not* do yet

- **Some discipline unlocks** (sweep, lunge, throw down, reattach) are data only so far.
- **Ragdolls and a physics character controller** are planned. See [RAGDOLL-COST-GATE.md](RAGDOLL-COST-GATE.md) for why ragdolls for every player do not fit one world today.
- **Range filtering.** `hit` and `life` events go to every welcomed session in the region, not just those nearby.

## Attributes and stats

A character has five **attributes**, each 10 at the start (range 1 to 100): strength, agility, vitality, intellect and willpower. The twelve **stats** are computed from them (`content/rules/stats.json`), and buffs and statuses can modify a stat (the `guarded` status does). A stat that is not listed under "rises with" is a flat number.

| Stat | Name | Base | Rises with |
|---|---|---:|---|
| `maxHealth` | Max health | 50 | +5 × vitality |
| `maxStamina` | Max stamina | 100 | +2 × vitality |
| `staminaRegen` | Stamina regeneration | 12 | none |
| `maxMana` | Max mana | 20 | +3 × intellect |
| `manaRegen` | Mana regeneration | 0.5 | +0.1 × willpower |
| `healthRegen` | Health regeneration | 0 | +0.05 × vitality |
| `moveSpeed` | Movement speed | 0.95 | +0.005 × agility |
| `attackSpeed` | Attack speed | 0.9 | +0.01 × agility |
| `power` | Power | 0.8 | +0.02 × strength |
| `spellPower` | Spell power | 0.8 | +0.02 × intellect |
| `armour` | Armour | 0 | none |
| `resilience` | Resilience | 0 | +0.01 × willpower |

## Creatures

Creatures (`content/rules/creatures.json`) spawn in packs and share one behavior: they notice you inside their **aggro radius**, chase, attack, and give up and walk home if you take them past their **leash**. A pack that is killed comes back after its **respawn** time. Each kind carries its own health, a list of weapons it may carry, a chase speed (a share of walking speed), a seconds between attacks and a loot table for what it drops (rolled at the corpse).

| Creature | Health | Aggro radius (m) | Leash (m) | Respawn (s) | Pack |
|---|---:|---:|---:|---:|---:|
| Goblin | 60 | 12 | 30 | 60 | 2 to 4 |
| Orc | 140 | 14 | 32 | 60 | 2 to 4 |
| Troll | 350 | 16 | 35 | 90 | 1 to 2 |
| Ogre | 420 | 15 | 35 | 120 | 1 to 2 |
| Wolf | 80 | 16 | 35 | 60 | 3 to 6 |
| Bear | 260 | 12 | 30 | 90 | 1 to 2 |
| Boar | 110 | 10 | 25 | 60 | 2 to 4 |
| Giant Spider | 90 | 14 | 30 | 60 | 2 to 5 |
| Skeleton | 75 | 12 | 28 | 60 | 2 to 4 |
| Ghoul | 120 | 15 | 32 | 60 | 2 to 4 |
| Wraith | 150 | 16 | 35 | 90 | 1 to 3 |
| Bone Champion | 280 | 16 | 35 | 120 | 1 to 2 |
| Lich | 500 | 18 | 40 | 180 | 1 |
| Imp | 50 | 14 | 30 | 45 | 3 to 6 |
| Fiend | 160 | 15 | 35 | 75 | 2 to 3 |
| Infernal Brute | 380 | 16 | 38 | 120 | 1 to 2 |
| Pit Lord | 800 | 20 | 45 | 240 | 1 |
| Elemental Shard | 130 | 14 | 30 | 60 | 2 to 4 |
| Void Watcher | 650 | 22 | 45 | 240 | 1 |

The goblin attacks every 1.5 seconds and carries a dagger, axe or mace.

## Hunger and thirst

Every character has a hunger meter and a thirst meter (`content/rules/needs.json`). Both start full at 100 and drain per minute (hunger 2, thirst 3), **1.5 times faster while you run or swim**. A meter at zero costs 1 health per second, for each empty meter. Standing in or at water (feet within 0.5 m of the surface) refills thirst at 10 per second. Respawning refills both, so a starved player does not respawn into the same death.

**What is not built:** food and drink items cannot refill a meter yet (the system has a `restore()` for them, but there is no consumable item or use action). The meters are not saved with the character, and they are not on the wire, so the client shows no meter for them.

## Loot and drops

A dropped item becomes a **ground item**, an ordinary entity that streams to clients like any prop (`content/rules/loot.json`).

- **Ownership.** A drop belongs to whoever earned it for **30 seconds**, then to anyone.
- **Despawn.** A drop disappears after **300 seconds** (5 minutes).
- **Pickup.** Press **E** within **2.5 m**; the server validates range and ownership. Pickups share a rate limit with duels, treatment and trades.
- **Bags.** A bag has **24 slots**. The region keeps at most **4096** items on the ground at once.
- **Drops.** A creature's `drops` name a loot table and say how many rolls, and the chance, to take at the corpse. Tables (`loot.json`, `tables`) are lists of `{ base, chance, count? }` entries: `key-rack`, `chest-common`, `goblin-spoils`, `orc-spoils`, `troll-spoils`, `beast-spoils`, `undead-spoils`, `demon-spoils`, `boss-spoils`. Chests roll the `chest-common` table (see [Chests](#chests-doors-and-things-you-press-e-on)).

## Chat, parties and guilds: the numbers

All from `content/rules/social.json`.

| | Limit |
|---|---|
| Party | up to 6 members; an invite lasts 60 s; a member who goes offline keeps their place 5 minutes |
| Guild | up to 500 members; an invite lasts 60 s; message of the day up to 200 characters; the officer log keeps the last 200 entries |
| Say | heard within 30 m; a chat line is up to 500 characters; you can block up to 200 people |
| Chat cooldowns | say 2 s, yell 10 s, emote 2 s, whisper 1 s, party 0.5 s, guild 0.5 s |
| Characters per account | 8 |

## Hurt, healing and death

Fights have consequences, and all of them are decided on the server and told to clients as events.

- **Blows land on body parts.** A character's body is a tree of parts (`content/rules/body.json`). A blow lands on a part (the aim you chose, if your precision lets it land there). A part is `healthy`, `harmed`, `maimed` or `dismembered`; a severing cut takes the part and everything below it.
- **Wounds bleed.** Open wounds bleed, then clot. Injuries slow you, lame you or weaken you. Parts heal over time.
- **Death.** A vital part destroyed, or too much blood lost, kills. The server sends `life` with `dead` and the tick the body rises (`respawnAt`); players come back at the spawn point, bots where they fell. Corpses are left and deaths are recorded.
- **You see your own body** part by part (hp share, state, bleeding), sent to you only and only when it changes.

### Medicine

Press **H** to treat your own worst wound: a stump first, then the worst bleeding, then a maimed part. You can also treat another character within the body rules' `treatment.reach`.

| Treatment | What it does |
|---|---|
| Bandage | Stops a bleeding wound |
| Stump | Closes the stump of a lost part |
| Set | Turns a maimed part back to harmed so it can heal |

A treatment takes time (shorter with more Medicine skill) and holds while the healer stands still, stays out of a fight and keeps in reach. At the end it works or fails, and the healer's Medicine trains either way.

## Abilities, telegraphs and status effects

Abilities (M5) sit on a generic trigger layer. The client sends `trigger` with an ability id, and the server's `AbilitySystem` decides.

- **Global cooldown.** Firing any ability locks all of them for a short time. Pressing during it **queues one press** (one deep, the latest wins), so mashing is harmless.
- **Per-ability cooldowns and cast times.** Each ability has its own cooldown, and a cast can be interrupted.
- **The answer is an event.** The result comes back as `ability` with a state: `casting`, `queued`, `fired`, `interrupted` or `rejected`. A rejection is the answer; no error is sent, so the ability bar can show it.
- **Targeting.** Tab cycles targets. The ability bar is part of the HUD layout.
- **The starter set** is in `content/combat/abilities.json`, designed from the existing balance numbers (strike is one blow's base damage; heal is Mend's amount):

| Ability | Global cooldown | Own cooldown | Cast | Effect |
|---|---:|---:|---:|---|
| Strike | 1.0 s | none | instant | 10 damage within 2.5 m |
| Guard | 1.0 s | 4 s | instant | Applies the `guarded` status (below) |
| Heal | 1.0 s | 8 s | 1.5 s | Heals 15 |

  The `heal` ability is **not** the Mend spell: it shares Mend's amount of 15 but has its own cast time and cooldown and costs no mana. In the live two-account check of 2026-11-02 a strike did 10 and a guarded strike 5.

**Telegraphs** are danger zones the server owns. `warned` is sent when a cast starts (the client draws the zone), `resolved` when its timer runs out (who was hit and how hard, decided that tick from authoritative positions), and `cancelled` if the caster died or was stunned. They go to every welcomed session.

**Status effects** are buffs and debuffs with a stack count. The one in the starter set is `guarded`: a buff that lasts 2.5 s, does not stack (a new one refreshes it), cannot be dispelled, and halves the damage you take. `applied` is sent with the stacks, and `removed` when one expires, is cleansed or is dispelled. The client's status frame shows only the entities it is displaying.

## Duels

Duels are consensual player-versus-player fights. By default **strangers cannot hurt each other**; a duel is what lets two players hurt each other.

1. A player **challenges** another. A challenge fails if either player is already dueling, or if you challenge yourself. One incoming challenge is held at a time (a newer one replaces it) and it **waits 30 seconds** for an answer.
2. The target **accepts** or **declines**. Accepting starts the duel.
3. While it runs, **only the two duelists** can hurt each other.
4. It ends at **first blood** (a duelist's health reaches zero), when someone **yields**, or after **5 minutes** (a draw).

A duelist felled by their opponent **does not die**: the death system is told it was a duel, so there is no death penalty. If either duelist disconnects, the challenge or duel is cancelled.

The client shows challenges and results in the duel panel. Everyone gets `duel` events with a state (`challenged`, `accepted`, `declined`, `expired`, `started`, `ended`); an ending carries the reason (`blood`, `yield`, `timeout`, `declined`, `expired`, `cancelled`) and the winner. Duel messages share the pickup rate-limit bucket. A bad shape is error 4003; a refusal ("cannot challenge now", "nothing to accept", "not dueling") is 4005.

**For developers.** `DuelSystem.canHit(a, b)` is what the combat path asks before a blow lands. `setHostile(a, b, true)` marks ad-hoc hostility without a duel, for events such as a brawl pit or a faction war. The 30-second and 5-minute limits are constructor defaults of `DuelSystem`.

## Magic and mana

Every character gets a mana pool, full, the first time the server sees it. The pool is not saved: you enter the world with it full.

| | Rule |
|---|---|
| **Maximum** | The `maxMana` stat: 20 + 3 per point of intellect (`content/rules/stats.json`). If the stat is absent, `defaultMax` (50) |
| **Regeneration** | The `manaRegen` stat: 0.5 + 0.1 per point of willpower, per second. If absent, `defaultRegen` (1). It only regenerates **while no cast is under way** |
| **Spell power** | The `spellPower` stat: 0.8 + 0.02 per point of intellect. Multiplies a spell's effect |

**Casting.** A cast starts on yourself or on a character within the spell's reach. It takes `castSeconds` and **holds only while you stand still, stay out of a fight, and the target stays alive and in reach**. The mana is spent when the cast completes; a cast that stops costs nothing. Then the spell's cooldown starts.

Refusals you can get: you can't cast now (dead), no one to cast on, the spell is self-only, too far away, you or they are unhurt (for a heal), cooling down, or not enough mana. Each is a 4005.

**The one spell today is Mend** (`content/rules/spells.json`):

| Field | Mend |
|---|---|
| Mana | 25 |
| Cast time | 2 s |
| Cooldown | 6 s |
| Target | any (yourself or another) |
| Reach | 3 m |
| Effect | Heals `15 × spellPower` |

The body system spreads the heal over the parts that are harmed. A heal **does not set a maimed part and does not stop bleeding**: that is Medicine's job.

Your mana shows in the player frame. Casting a spell is the `cast` message (`0x1c`). As of this audit the client has no UI and no code that sends `cast`, so Mend is reachable only through the protocol, by bots and tools. Players heal with the ability bar's separate `heal` ability, which costs no mana (see [Abilities](#abilities-telegraphs-and-status-effects)).

**Adding a spell.** Add an entry to `spells.json` with `id`, `name`, `mana`, `castSeconds`, `cooldownSeconds`, `target` (`self` or `any`), `reach` and an `effect`. The only effect kind today is `heal`. A rules reload applies new spells at once, and stops casts under way.

## Gathering

Resource nodes are the tree stands, ore veins and fishing spots round the towns. A node is a scene node with a `ResourceNode` component:

| Field | Meaning |
|---|---|
| `material` | What it gives |
| `tier` | 1 to 5; harder tiers train the skill faster (see below) |
| `skill` | The skill it trains, such as mining |
| `stock` | How many gathers it holds |
| `regrowHours` | Hours of **real time** before an empty node refills; `0` means never (ore veins) |
| `town` | The settlement whose stock it is |

Press **E** at a node. The server owns every stock:

- You must be within **2.5 m** of the node, and a gather needs a **2-second** cast. You can gather once per **1.2 seconds**.
- Each gather takes one from the node into your **materials pouch** (a separate store from your bag). The pouch holds **999** of one material.
- It trains the node's skill at a difficulty of `tier × 0.2`, capped at 1.
- An empty node says how long it has left ("it comes back in about 3 hours") or that it is worked out for good.

Stocks and pouches are saved (`gathering.db`), so a worked-out node **stays worked out across a restart** and comes back on the wall clock, not the tick. Node stocks also ride the world snapshot. The pouch panel in the client shows what you carry.

The numbers above are `content/rules/gathering.json`: `reachM`, `cooldownSeconds`, `castSeconds`, `pouchMax`, `trainDifficultyPerTier`.

## Gold, shops, trading and the auction house

**Gold** is integer coins per character: no fractions and no debt. It comes from loot, quest rewards, vendors and trades; a new character starts at 0. It is private (only you are told your balance) and it survives restarts (`economy.db`), because it belongs to the character, not the avatar.

### Vendors

A vendor is a world entity with a price list. Press **E** at one to open its shop (the client has a vendor panel).

- **Buy:** you pay the listed price and a fresh item goes into your bag. Stock is infinite or counts down per sale (`quantity`).
- **Sell:** you sell a bag item back for `floor(price × buybackRate)`, and only items that vendor stocks ("doesn't want that" otherwise).
- You must be within **4 m**, have the gold, and have room in your bag.
- **Vendors never run out of gold, and there is no restock timer:** a finite stock that sells out stays out until the template is redefined.

Shops are templates in `content/vendors.json` (`MMO_VENDORS` points elsewhere): a name, a `buybackRate` (0.2 to 0.4 in the shipped shops) and a stock list. `byArchetype` maps a settlement building (bakery, smithy, or `*` for anything else) to a template, and a scene node that names a vendor places a shop.

### Trading between players

A two-sided flow: open a trade with a player, each side offers **gold and bag items** (equipped gear stays out), both accept, and it settles.

- **Changing an offer after accepting resets both accepts**: no bait and switch.
- Either side can cancel before it settles, and **an open trade expires after 2 minutes** by default.
- Settlement is **all or nothing.** It checks both balances, that every item is still owned and that both bags have room, and moves nothing if any check fails.
- When the region is connected to a world server, the completing accept settles **atomically through the world tier**; if that server cannot be reached the trade is refused ("trade refused: the world tier is unreachable") and nothing moves. Standalone, it settles locally.

### The auction house

- **List** a bag item with a starting bid, an optional **buyout** and a duration: 24 hours by default, 1 minute at least, 48 hours at most. The item stays in your bag while listed, and a listed item cannot be listed twice. Listings live in memory, so a restart clears them, and the items never left the bag.
- **Bid** must top the current bid. The gold leaves the bidder at once and the previous top bidder is refunded immediately.
- **Buyout** is an instant sale at the buyout price; the top bidder, if any, is refunded.
- **Cancel** reclaims a listing, but only while nobody has bid.
- **Expiry:** the top bidder wins at their bid; with no bids the seller keeps the item.
- **Every sale takes a 5% fee** (rounded down), a gold sink.
- If the seller no longer holds the item when it settles (they traded it away), the sale aborts and every bid is refunded.

**In the client today:** there is a vendor panel and a duel panel, and the pouch panel for gathering. **There is no client UI for player-to-player trade or the auction house**; both are built and exposed through the protocol (message `0x21`, actions `trade` and `auction`), so they are usable by bots and tools but not yet by a player.

## Chests, doors and things you press E on

**E** is the one interact key. The client sends a single request (`interact`, message `0x27`) and the server decides what it means, after re-checking reach and state. A refusal is error 4005. E can:

- open a **chest** or a **door**, or mend a broken **ruin**;
- pick up a **ground item**;
- **gather** from a resource node (see [Gathering](#gathering));
- open a **shop** (see [Vendors](#vendors));
- talk to a **quest giver**, or enter a **dungeon entrance**.

**World chests** are shared by every player. Whoever opens one first gets the items from its loot table on the ground beside it. The chest is empty until its `refillSeconds` have passed (600 by default), then full for the next player. A chest is a scene node with a `Chest` component: `table` (which loot table, `chest-common` by default) and `refillSeconds`. The server sends all chests on joining, then the ones that changed. Loot tables are in [DUNGEONS-AND-LOOT.md](DUNGEONS-AND-LOOT.md).

## The people of the towns (residents)

Baked towns have people living in them. Residents are **derived, not authored and not saved**: a restart gives the same people in the same places for the same time of day, and a resident looks the same on every boot and to every player (the look is seeded from their id).

- **Schedules.** Once a second a resident's schedule says where they are. Someone outdoors has an entity standing at their anchor; someone indoors has none (buildings are boxes), so **at night nearly the whole town costs nothing**. Where a navigation crowd runs, a resident walks between places: out of the building they were in, to the next anchor, or to the door and gone on arrival.
- **Only near players.** A town is simulated in three tiers by the nearest player's distance to its edge: **within 150 m**, its residents walk (a navigation agent each, up to `MMO_RESIDENTS_FULL`, 300 region-wide); **within 400 m**, they stand at their anchor and snap when their block of the schedule changes; **beyond that**, the town has no entities at all and is placed from the schedule when a player comes. A town changes tier with 25 m of hysteresis, and the nearest town is served first. The region as a whole is capped at `MMO_RESIDENTS_MAX` (800) resident entities.
- **They can be hurt.** Residents have health and anyone may hurt them; the weak points of a town are its people. One who falls lies where they fell for 10 seconds, then is gone, and stays dead until three game days have passed. There is no crime, reputation or guard response to killing one yet. Then "someone new has moved in" to the same household slot: the same id with a new generation, so a new look. Deaths are kept in the places store, so a restart does not bring them back.
- **Raids.** When raiders reach a town, everyone outdoors runs for home (sprinting if they can) and is gone on arrival, while guards and the watch hold their posts. Schedules resume 20 to 60 seconds after the raid ends, and their talk is in the raid's voice meanwhile.
- **Shops.** A resident who keeps a shop sells from the vendor template for that kind of shop (`content/vendors.json`, `byArchetype`), to whoever talks to them.
- **Lessons.** A master of a profession teaches a skill **for gold, once a game day per pupil** (you ask by talking to them). A lesson adds skill points on top of use-based gain, on an S curve of the pupil's level: small at the start (a beginner always gets a worthwhile first lesson), best about a third of the way up, and harder toward the top. The price rises with the pupil's level. Tuned in `content/lessons.json` (`MMO_LESSONS`).

- **Homesteads and roadside people.** Places between the towns have people too, baked into `places.json`: a homestead's family of 2 to 10 (the adult head, the grown work the field or pen, children and elders stay about the house), an inn's keeper and hand, and an outpost's three guards. Each place is run as a little town (the yard is its square).
- **Talking.** Press **E** on a resident within 4 m. They answer with a line generated from the hour, their work, their class and whether a raid is on, seeded by their id and the game day, so it is the same for everyone. If they keep a shop, talking also opens it; a quest giver can be bound to a specific resident; and a master offers a lesson.

## Characters

Logging in gives you an account; entering the world is a separate step, and
one account can hold several characters (`DEFAULT_MAX_CHARACTERS` = 8).

- **Names** must match `/^[A-Za-z][A-Za-z'-]{2,15}$/` — 3–16 characters,
  starting with a letter, with apostrophes and hyphens allowed. Names are
  unique world-wide, case-insensitively; a refusal is a `4005` and **keeps the
  connection open** so you can simply try another.
- **Looks** are the modular character: face, hair, brows, beard, ears, and
  colours for skin, hair, stubble, scars and body art. A look is validated
  against the art pack's part catalog when one is present
  (`MMO_CHARACTER_CATALOG`); without the pack it is checked structurally only,
  so the creator still works on a machine with no licensed art.
- **A character is in the world once.** Entering with a character that is
  already in play takes it over: the other session's avatar is despawned, that
  session is told `4005` "this character entered the world elsewhere" and
  closed. The last connection wins.
- **Spawn positions** are spread on an 8-wide grid (4 m apart, offset −14 m)
  around the world's spawn point, so several players do not stack.

The creator is available without a server at
`http://localhost:5173/?preview=character`, which is the fast loop for working
on looks.

## Reconnecting

Session tokens live in memory only, and the token outlives the entity:

- A network blip parks your session and keeps your avatar for a **30 s grace
  period**. Reconnecting with the token inside it re-attaches you to the
  **same entity** and sends a fresh snapshot.
- After the grace period the entity is despawned and the token spawns a fresh
  one. The token itself stays valid for its 24 h TTL.
- The client's **reconnect** button re-hellos with the stored token.
- A server restart logs everyone out — sessions are not persisted — and
  restored player avatars with no session are cleaned up at boot. Accounts,
  characters and the world survive.

## Bots

`MMO_BOTS=<n>` puts computer-driven characters in the world near the spawn
point. They are not a special case in the simulation: a `BotSystem` produces
intents, and the bots then flow through the same intent, combat, integrate,
character, physics and navigation systems a player does. Two in three spawn as
sparring pairs (they attack and guard each other); the rest wander.

| Variable | Default | |
|---|---|---|
| `MMO_BOTS` | `0` | how many |
| `MMO_BOTS_HOME` | `spawn.x + 6, spawn.z + 10` | `"x,z"` where they gather |
| `MMO_BOTS_RADIUS` | `18` | how far from home they roam, metres |

Bots take random looks from the part catalog and use the same player abilities
as everyone else. They are a good way to see combat and crowding without a
second person: `MMO_BOTS=10 npm run server`.

## Extending gameplay

Where to make a change depends on what kind of thing it is:

- **A tuning number** — speed, gravity, jump, breath, a move's duration or
  advance — is a constant in `systems.ts` or `packages/protocol/src/combat.ts`.
  Move durations are shared with the animation clips and checked by a test, so
  changing one means checking the other.
- **A game rule** — damage, mastery gain, injury severity, respawn — belongs in
  `content/rules/*.json`, with a hook override if you need behaviour the
  defaults do not express. Prefer data over a new branch in the engine; see
  [ARCHITECTURE.md](ARCHITECTURE.md#game-rules-are-data).
- **A spell** — an entry in `content/rules/spells.json` (see [Magic and mana](#magic-and-mana)); the only effect kind today is `heal`.
- **Gathering** — a `ResourceNode` on a scene node, plus `content/rules/gathering.json` for reach, cooldown and pouch size (see [Gathering](#gathering)).
- **A shop** — a template in `content/vendors.json` and a scene node that names it (see [Gold, shops, trading and the auction house](#gold-shops-trading-and-the-auction-house)).
- **A new move** — add it to `COMBAT_MOVES` with a **new id** (never renumber
  existing ones), give it a clip, and wire the button in `CombatSystem`. Add a
  protocol test alongside the existing ones.
- **A new input button** — it is an `IntentButton` bit; add the bit, the
  client binding, and the server read. Bits are wire contract too.
- **A new component** — add it to `components.ts` with the next free id, add
  its block to the `.fbs` and the codec, and add it to the delta tracker's
  tracked fields if it should replicate on change. See
  [ARCHITECTURE.md](ARCHITECTURE.md#components).

Whatever you change, add the test that would have caught the bug you are
afraid of — that is the house style (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
