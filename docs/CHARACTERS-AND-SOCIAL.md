# Characters and Social Systems

Status: **design** (not yet built). Review this before any code lands.
Companion to `docs/WORLD-SERVER-SPEC.md` (where world-level data lives)
and `docs/MESSAGE-CATALOG.md` (the wire protocol this extends).

## 1. Decisions taken (2026-09-29)

- **Progression is classless mastery.** Characters get better at what
  they do by doing it; skill belongs to the technique, not the item, and
  characters take damage to individual body parts (harmed, maimed or
  dismembered). Unused skills deteriorate slowly. Characters respawn, as
  part of the world's lore. Designed in `docs/MASTERY-AND-COMBAT.md`.
- **Every rule is the game's to change.** The engine ships defaults; a
  game's rules (skills, body parts, injuries, death, appearance options)
  are data files and hooks, and ours are one such set.
- **Several characters per account, names unique across the whole
  world.** Default limit 8 per account (configurable).
- **The first social release has chat (say, yell, whisper), parties,
  friends with presence, and guilds.**
- **Characters come before social.** Every social feature needs a stable
  character id and a name to point at.

## 2. Where it is today

- An account is a username and password in the region's `users.csv`
  (world-server slice C, which moves accounts to SurrealDB, is not built).
- A login spawns an anonymous avatar (Transform, Velocity, PlayerIntent,
  Health, Locomotion) at the spawn grid. Nothing about it is saved: no
  name, appearance or skills, and not its position. It is despawned when
  the 30 s reconnect grace runs out.
- What a player can do (swim, fly) is one server-wide setting
  (`MMO_PLAYER_ABILITIES`), not per character.
- There is no social code. The world-server spec lists chat, mail,
  auction and leaderboards as "later global services".

## 3. Where things live

Clients only ever talk to their region (world-server spec, non-goal: the
world server is not client-facing). A region acts for its signed-in
players towards the world server.

| Concern | Owner | Why |
|---|---|---|
| Accounts, characters, skills, name registry | World server (SurrealDB) | Characters cross regions; names are unique world-wide |
| "Who is online, on which region" (presence) | World server, in memory | Whispers, friends and parties span regions |
| Friends, blocks, guilds | World server (SurrealDB) | Durable, global |
| Parties | World server, in memory | Short-lived, global; lost on world restart (acceptable in v1) |
| Say, yell, emote | Region | Spatial: only nearby players hear them |
| The live character (ECS entity) | Region that hosts it | 30 Hz sim |
| Delivery to a player's socket | Region | It owns the connection |

**Standalone regions.** A region started without `WORLD_URL` (the dev
setup) has no world server. Both the character store and the social
service are interfaces with two backings: the world server over webrpc,
and a local SQLite implementation inside the region for standalone runs.
Standalone behaves like a one-region world.

## 4. Characters

### 4.1 Data model (SurrealDB, world server)

```surql
DEFINE TABLE character SCHEMAFULL;
DEFINE FIELD account     ON character TYPE record<account>;
DEFINE FIELD name        ON character TYPE string;   -- as the player typed it
DEFINE FIELD name_key    ON character TYPE string;   -- NFKC, lower-cased: the unique key
DEFINE FIELD created_at  ON character TYPE datetime;
DEFINE FIELD deleted_at  ON character TYPE option<datetime>;
DEFINE FIELD appearance  ON character TYPE object;   -- see 4.4
DEFINE FIELD vitals      ON character TYPE object;   -- health, breath
DEFINE FIELD abilities   ON character TYPE int;      -- protocol Ability bits
DEFINE FIELD skills      ON character TYPE object;   -- skill id -> value (tenths)
DEFINE FIELD location    ON character TYPE object;   -- {x, y, z, yaw, region}
DEFINE FIELD version     ON character TYPE int;      -- optimistic concurrency
DEFINE FIELD lease       ON character TYPE option<object>; -- {region, session, expires}
DEFINE INDEX character_name ON character FIELDS name_key UNIQUE;
```

- **Character ids** are u64, assigned by the world server, never reused.
  They travel as JSON strings, like entity ids.
- **Deleting** a character sets `deleted_at`; the name stays reserved
  for 30 days, then is released. A hard purge job removes the row later.
- **Inventory** is out of scope here; it gets its own table when items
  exist.

### 4.2 Names

- 3–16 characters: letters (any script NFKC-normalises to), with at most
  one space, apostrophe or hyphen inside the name, not at the ends.
- Unique case-insensitively on `name_key`. Uniqueness is enforced by the
  database index, not by a check-then-insert.
- A reserved list (`gm`, `admin`, `system`, staff names…) and a pluggable
  offensive-name filter are checked at creation.
- Renames are an admin tool in v1, not a player feature.

### 4.3 Sign-in flow (protocol v5)

Today `hello` joins the world at once. In v5 it signs in to the
**account**, and the player then picks a character on the same socket:

1. C→S `hello` (unchanged shape, `protocol: 5`).
2. S→C `account` (new, 0x0c): `{characters: [{id, name, appearance,
   location: {region}, lastPlayed}], limit}`. There is no player entity
   yet.
3. C→S `character` (new, 0x0d), one of:
   - `{op: "create", name, appearance}` → the new list, or an error
     (name taken, invalid, over the limit)
   - `{op: "delete", id}` → the new list
   - `{op: "enter", id}` → the region loads the record, takes the
     character's lease, spawns the entity from it, then sends `welcome`
     (now with `character: {id, name}`) and a snapshot, as today.
4. A **token reconnect** inside the grace period re-enters the same
   character directly (steps 2–3 are skipped).
5. `register` (0x0b) creates the account and answers `account`, like
   `hello`.

If the character's `location.region` is a different region, `enter`
answers with a redirect (`{op: "redirect", endpoint}`); the client
reconnects there with its token. This is the same hand-off
world-server slice B needs for border crossings.

### 4.4 In the ECS

| Component | Fields | Sent to |
|---|---|---|
| `CharacterRef` (new) | `idHi, idLo` (u64 character id) | Everyone |
| `Appearance` (new) | one piece index per slot, and the colour-mask colours (§4.7) | Everyone |
| `Health` (exists) | `current, max` | Everyone |
| `Locomotion` (exists) | `mode, abilities, breath` | Everyone |
| `Body`, `Injury`, `Combat`, `Held` | see `MASTERY-AND-COMBAT.md` §6 | `Body` owner only, the rest everyone |
| `Skills` (not a component) | per-character map, server-only | Owner only |

- **Names are not in the snapshot.** Strings don't belong in the SoA
  blocks. The region sends a `names` control message (JSON) with
  `[[entity, name, guildTag]]` for every character entity before the
  snapshot or delta that first shows it to that client, and again when a
  guild tag changes.
- **Owner-only data** (skills and later inventory) goes in a `self`
  control message to the owning client when it changes, never in the
  broadcast delta.
- Per-character `abilities` replace `MMO_PLAYER_ABILITIES` (which stays
  as the default for new characters).

### 4.5 Saving and single login

- **The lease.** On `enter`, the region asks the world server for the
  character's lease (`region`, `session`, 60 s expiry, renewed with the
  heartbeat). A second login of the same character anywhere is refused
  while the lease is live. A region that dies leaves a lease that expires
  on its own.
- **One character in the world per account** at a time (the same lease
  check, keyed on the account).
- **Saves** go to the world server with the record's `version`
  (optimistic concurrency) and an `opId` (the spec's idempotency rule):
  on leaving the world, every 60 s while anything changed, and inside the
  migration payload when crossing regions. A save with a stale `version`
  is refused and logged: it means two regions thought they owned the
  character, which the lease should prevent.
- What is saved: location, vitals and body, abilities, skills, appearance.

### 4.6 Progression

Classless mastery, body parts and combat have their own design:
`docs/MASTERY-AND-COMBAT.md`. What matters here is what the character
record stores for them: `skills` (value, peak, and last use per skill,
for rust), familiarity per item family, earned disciplines, and the
body's part health, blood and injuries (saved with the vitals).

### 4.7 Character customisation

Our characters are built from the art packs' modular hero: the character
creator picks one piece for each slot, and colours them through the
pack's colour-mask shader. The slots, and which of them are body parts
(`MASTERY-AND-COMBAT.md` §4), are rules (`content/rules/appearance.json`
and `body.json`), so a game with other art defines its own.

| Slot | Body part (takes damage) | Notes |
|---|---|---|
| Head | Head | Face shape; the base for the cosmetic slots below |
| Hair | — | Or none |
| Eyebrows | — | |
| Facial hair | — | Or none |
| Torso | Torso | |
| Hips | Hips | |
| Upper arm, left and right | Upper arm | |
| Lower arm, left and right | Lower arm | |
| Hand, left and right | Hand | |
| Leg, left and right | Leg | |
| Attachments (helmet, shoulders, elbows, knees, back, hips) | — | Worn over a part; armour later covers that part |

Colours: skin, hair, eyes, stubble, scar, body art, and the primary,
secondary and metal colours, all from palettes in the rules.

`Appearance` stores one u8 piece index per slot and a u32 colour per
colour channel. The creator's 3D preview uses the same pieces as the
game, and missing (dismembered) body parts simply hide their piece.
The exact slot list follows the pack's own parts and is checked against
it when the art pipeline converts the character pieces.

## 5. Social systems

### 5.1 Region ↔ world event stream

Chat and presence need pushes from the world server to regions, and the
region↔world contract today is request/response webrpc polled by a
heartbeat every few seconds, too slow for chat. The world server gains
one region-facing WebSocket, `/regions/events`, authenticated with the
region's lease token:

- Region → world: presence changes, whispers, party and guild messages,
  social commands.
- World → region: messages and events addressed to characters on that
  region.

The world server routes by presence (`character → region`). Durable
operations (friend requests, guild changes) are still webrpc calls, so
they keep `opId` idempotency; the stream only carries live traffic.

### 5.2 Chat

New message `chat` (0x0e), JSON, both directions.

- C→S: `{channel, text, to?}`, where `channel` is `say`, `yell`,
  `emote`, `whisper`, `party` or `guild`, and `to` is a character name
  for whispers.
- S→C: `{channel, from: {id, name}, text, at}`. The server fills in the
  sender; clients never supply it.

| Channel | Reaches | Routed by |
|---|---|---|
| say | 30 m | Region |
| yell | 150 m | Region |
| emote | 30 m | Region |
| whisper | One named character | World server |
| party | Party members | World server |
| guild | Online guild members | World server |

Rules:

- 256 characters at most; control characters stripped.
- Rate limit per character: 5 messages per 5 s, burst 3. Over it the
  message is dropped and the sender gets a `chat` system notice.
- A whisper to an offline or unknown name answers "not online". It does
  not say which, so it can't be used to probe names.
- Blocks apply silently: a blocked sender's whispers, invites and chat
  never reach the blocker.
- Chat isn't stored, except the last 50 lines kept per region in memory
  so a player report can attach context.

### 5.3 Friends, blocks and presence

- **Friends are mutual**: request → accept. Pending requests expire
  after 14 days. Limit 100 per character.
- **Presence**: friends see online/offline, and the region name (never a
  position). A character can set itself to appear offline.
- **Blocks** are per account, so they cover all of a player's
  characters. Limit 200. Blocking also removes a friendship.
- Stored as `friendship` (a pair, state `pending` or `accepted`) and
  `block` tables in SurrealDB.

### 5.4 Parties

- Up to 6 members. The leader invites, kicks and promotes. Anyone can
  leave.
- Invites expire after 60 s. A party with one member left disbands.
- A member who logs out stays in the party for 5 minutes, then is
  removed; the leader role passes to the longest-standing member.
- Party chat, and **party frames**: members in view come through the
  normal delta. For members in another region or out of view, the world
  server relays name, health and region once a second.
- Kept in the world server's memory; a world server restart disbands
  parties.

### 5.5 Guilds

- A guild has a unique name (3–24 characters, same normalisation as
  character names) and a unique tag (2–5 letters, shown on nameplates).
- Ranks: leader, officer, member, recruit. Permissions per rank: invite,
  kick (lower ranks only), promote/demote (lower ranks only), edit the
  message of the day. There is exactly one leader; a leader can hand the
  role over, and a guild whose leader is deleted passes it to the
  longest-standing officer.
- 500 members at most. A character is in at most one guild.
- Guild chat, roster (with presence), message of the day.
- Stored as `guild` and `guild_member` tables; every change is also
  appended to a `guild_log` for officers to read.

### 5.6 Social commands

New message `social` (0x0f), JSON:

- C→S `{op, ...}`: `friend.request`, `friend.accept`, `friend.remove`,
  `block.add`, `block.remove`, `party.invite`, `party.accept`,
  `party.leave`, `party.kick`, `party.promote`, `guild.create`,
  `guild.invite`, `guild.accept`, `guild.leave`, `guild.kick`,
  `guild.setRank`, `guild.motd`, `presence.set`.
- S→C `{event, ...}`: the resulting state (`friends`, `party`, `guild`
  snapshots on join and after each change) and notices (`invite`,
  `presence`).

Every command is checked on the world server against the acting
character, which the region vouches for from its lease. Clients never
name the actor.

## 6. User interface

All React, in the client (and, for inspection, the editor):

- **Character select and create**: the list, create (name, appearance
  sliders, live 3D preview), delete with name confirmation, enter.
- **Nameplates**: name and guild tag over characters, fading with
  distance.
- **Chat panel**: tabs per channel, `/w Name`, `/p`, `/g`, `/y`, `/e`
  commands, reply to the last whisper.
- **Social window**: friends (with presence), blocks, guild roster and
  message of the day.
- **Party frames**: each member's name and health.
- **Character sheet**: skills with values and their peaks, disciplines
  earned, and the body with each part's state.
- **Editor**: the selection card (PICG slice 3) shows character
  components like any other entity, and gains a read-only character
  record view.

## 7. Security and abuse

- Every id and name on the wire is checked server-side against the
  acting session; the sender of any chat or social event is filled in
  by the server.
- Rate limits per character on chat, invites and friend requests.
- Names and chat pass through a pluggable text filter (off by default,
  one interface, so a real filter can be swapped in).
- Player reports store the reporter, the target and the recent chat
  lines. There is no admin UI in v1; reports are read from the database.
- Admin mute (per account, with an expiry) is enforced on the region
  when the message arrives.
- Character data is never logged. Chat text isn't logged either, except
  when attached to a report.

## 8. Slices

Each slice is its own PR, with tests.

| # | Slice | Needs |
|---|---|---|
| C1 | Accounts and characters on the world server: tables, name rules, create/list/delete/load/save, leases; the SQLite backing for standalone regions | World-server slice C (accounts move) is folded in here |
| C2 | Protocol v5 sign-in: `account` and `character` messages, spawn from the record, saving, single login; the client's select and create screens | C1 |
| C3 | Identity on screen: `CharacterRef`, `Appearance`, `names` message, nameplates | C2 |
| M0–M4 | Rules loader, mastery, body parts, items and melee, disciplines: see `MASTERY-AND-COMBAT.md` §7 (M0–M4) | C2 |
| S1 | Say, yell and emote on the region; the chat panel; rate limits and the text filter hook | C3 |
| S2 | Region↔world event stream, presence, whispers, friends and blocks, the social window | C3, S1 |
| S3 | Parties and party frames | S2 |
| S4 | Guilds: tables, ranks, roster, guild chat, tags on nameplates | S2 |

Cross-region hand-off (world-server slice B) is needed for `redirect`
and for saving inside a migration; until then a standalone or
single-region setup covers every slice.

## 9. Open questions

1. **Appearance**: the slot list in §4.7 is taken from the modular
   hero pack and must be checked against its converted pieces.
2. **Death and respawn**: see `MASTERY-AND-COMBAT.md` §5; whatever is chosen
   touches saving.
3. **World-wide channels** (trade, help, global): left out of v1 on
   purpose. Adding one is a channel on the world server's stream.
