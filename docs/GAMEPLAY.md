# Gameplay

What a player can do today, and how each piece is implemented. The numbers
here are the server's, read from source — the client sends intent, the server
decides. For the machinery behind it see [ARCHITECTURE.md](ARCHITECTURE.md);
for the combat and character systems that are *designed but not yet built*,
see [MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md).

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

### Swimming

Walk into water deeper than `SWIM_DEPTH` = 1.3 m and you start swimming;
`Locomotion.mode` becomes `Swim`, the speed drops to 3 m/s, and `Space`/`C`
become vertical control at `SWIM_VERTICAL_SPEED` = 2 m/s. Afloat, your head
(`HEAD_HEIGHT` = 1.7 m) is held above the surface (`FLOAT_DEPTH` = 1.4 m).
Walk back into the shallows and you stand up.

**Breath.** Underwater you hold `BREATH_SECONDS` = 30 s of air. Surfacing
refills it over `BREATH_RECOVERY` = 3 s. Run out and you lose
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

Combat is server-authoritative and, deliberately, **deals no damage yet**.
What exists is the move system: the server runs each character's current move
and tells clients which move they are in and from which tick, so a client only
ever plays the clip it is told about. The move table lives in
`packages/protocol/src/combat.ts` and is shared by the server (timing,
chaining, movement) and the client (which clip). **Move ids are wire
contract**; the durations are the animation clips' own, and a test keeps the
two in step.

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

No damage, no hit detection, no hit reactions. The system's header says so
plainly. Mastery, body-part damage, injury, bleeding, death and respawn are
specified with working reference implementations in `@mmo-engine/rules` and
documented in [MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md); the simulation
does not call them yet. That is the next slice, not a bug.

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
