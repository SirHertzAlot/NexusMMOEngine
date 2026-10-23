# Interaction and destructibility (IX)

## Intent
You decided: "Interactions button should be E. Simple and castable to all interactions." One key, E, does whatever
makes sense for the thing you're looking at or standing next to: open a chest or door, talk to an NPC, gather from a
node, pick up loot, take a key, buy from a vendor, and anything that becomes interactable later. Every game asset should
be able to be interactable, breakable, or both, from data.

**My reading of "castable":** an interaction can have a cast time. You hold still while a bar fills (picking a lock,
mining a vein, searching a coffin), and moving or being hit cancels it. It uses the same E key and the same wire op as an
instant interaction. If you meant something else (for example, interactions bound to ability slots), say so: it changes
slice IX3 only.

## What exists today (main at 3922c955)
There's **no interaction or destructibility system**: no Interactable, Destructible or Breakable component, and no
"interact" or "use" wire op. E already exists as a key, but each thing it does is a separate one-off path with its own
op.

**The client's E key.** `interact` is bound to `KeyE` (`apps/client/src/input/bindings.ts:60`), as a UI action
(`:76`) fired from `bindInput` (`apps/client/src/input/input.ts:211`). `world-canvas.tsx:453-463` resolves it with a
fixed priority chain, each step with its own message:

| Priority | Target | Client call | Wire | Server handler |
| --- | --- | --- | --- | --- |
| 1 | Nearest ground item | `client.pickup` | 0x13 Item `pickup` | `Gateway.onItem` → `items.pickup` (`net/gateway.ts:5090-5092`) |
| 2 | Nearest resource node | `client.gather` | 0x24 Gather | `Gateway.onGather` (`gateway.ts:5158-5195`) → `GatheringSystem.gather` (`gathering/gathering.ts:147-172`) |
| 3 | Nearest quest giver | `client.quest({op:"talk"})` | 0x11 Chat, extension `quest` (`gateway.ts:2972`) | `QuestService.onMessage` → `talk` (`quests/quest-service.ts:102,164`) |
| 4 | Nearest dungeon entrance | `client.dungeon({op:"enter"})` | 0x11 Chat, extension `dungeon` | `DungeonManager.onMessage` (`dungeons/manager.ts:97`) |

There's one "nearest" per kind, each from its own client-side tracker with its own range (`PICKUP_PROMPT_RANGE`,
`GATHER_PROMPT_RANGE`). There are four prompt blocks in `App.tsx:660-689`, also in a fixed order, all reading
`bindings.interact`.

**Not on E today:**
- **Dungeon chests** are HUD-only logic. The run's HUD has an "open" button (`App.tsx:692`) that sends
  `{kind:"dungeon", op:"open"}`. The instance opens the nearest unopened chest within `chestOpenRadiusM`
  (`dungeons/instance.ts:201,464-488`; `content/dungeons/instances.json:11-13`). Chests aren't entities: roadmap D4f
  (`ROADMAP.md:329`) is the open item to make them world entities.
- **Dungeon keys** don't exist. `dungeon:key-rack` is only a prop (`content/dungeons/props.json:75`).
- **Vendors** are `VendorSystem` templates that an admin attaches to an entity (`economy/vendor.ts:115`, admin
  `vendor attach`, `gateway.ts:5306-5344`). They're reached through 0x21 Trade, with no key and no client window
  (EC1, 🚧).
- **NPC dialog** after `talk` continues on the quest extension (`reply`, `close`): that's a UI, not an interaction.

**Breakable today.** Nothing in the shipped content breaks:
- A spawn-table archetype may declare `health: {max}` (`packages/scatter/src/spawn-table.ts:48`). Scatter then adds
  `Health` (`procgen/scatter-spawn.ts:212-217`), but no content sets it (only creatures carry health).
- Combat can hit any entity with `Health`: `canHit` is `true` for everything except player against player
  (`modules/combat/server.js:70-71`).
- `DeathSystem` queries every `[Transform, Health]` body (`death.ts:49`). At zero it starts a corpse timer (`:95-100`),
  then refills health and puts the body back where it fell (`:120-127`). So a breakable prop would "die" and get back up.
- `StructuralIntegrity` (ComponentId 21, `components.ts:386-389`) was reserved for buildings, but no system reads it
  and it isn't on the wire.
- `docs/WILDLIFE.md:81-82`: settlement buildings carry no `Health`, so a raid on an empty town has nothing to smash.
  "Destructible structures are the next piece."

**Persistence today:**
- **Scatter entities** are spawned once on a fresh boot and then persist through the ECS snapshot. A removed scatter
  entity stays removed (`scatter-spawn.ts:21-30`).
- **Scene entities** (settlements, places, dungeon-free world scenes) are removed and spawned again on every boot
  (`scene-spawn.ts:25-27`). Any lasting change to them has to live in a record keyed by scene and node id, as resource
  node stocks already do (`scene-spawn.ts:85`, `gathering/gathering-store.ts`).
- Those stocks ride the range snapshot as `places.resource_nodes` (PL3a; `server.ts:429,1418`).

**Hooks to reuse:**
- `AbilitySystem` already has cast state (`castMs`, `interrupt`, `casting`/`interrupted` events; `abilities.ts:11,112,158`).
- `NeedsSystem.restore()` is there for food and drink, but nothing calls it (`stats/needs-system.ts:7,30`). `Needs`
  isn't on the wire (`components.ts:88-98`).

## Goals
1. E does every interaction through one client resolver, one prompt, one wire op and one server dispatch.
2. Whether a thing is interactable, and how, is data on its archetype or kind, not code.
3. An interaction can have a cast time that movement or a hit cancels.
4. Any archetype can be breakable from data. A broken prop stays broken (removed, swapped to a broken look, or left as
   debris), drops loot if it says so, loses its collider, and comes back only if its data says so.
5. Settlement buildings can be smashed in a raid.
6. Food and drink go through the same op and refill hunger and thirst.

## Non-goals
- Dialog trees, vendor windows, the bag UI: E opens them; their screens are their own items (U11, EC1, U10).
- Physics-driven fracture (Jolt pieces flying apart). Debris is a spawn, not a simulation.
- Building and repairing structures (a crafting loop). Repair is noted as a follow-up.
- Player housing and ownership rules.

## Anti-goals
- **A second path.** When a slice migrates an interaction, its old op leaves the client in the same PR. The server's old
  handler stays only until the client no longer sends it, and never past the IX2 PR.
- **Trusting the client's pick.** The client chooses what to interact with. The server re-checks range, state,
  requirements and the cast, as `GatheringSystem.gather` already does.
- **Per-entity strings in SoA.** Kinds and verbs are small enums or fnv1a32 hashes, as `AssetRef` and `FlowRef` already
  are.
- **Props that rise again** through `DeathSystem`.

## Design (my calls)

### Content: one `interact` and one `breakable` field per archetype
Any spawn-table archetype (scatter tables, `props.json`, scene `Structure` kinds) can declare either field. Validation
lives in `packages/scatter`'s spawn-table schema, next to `health`:

```jsonc
"dungeon:coffin": {
  "asset": "dungeon:coffin", "category": "prop", "collision": { ... },
  "interact": {
    "verb": "search",          // prompt string: interact.<verb>; also picks the handler (below)
    "rangeM": 2.0,             // from the footprint's edge, like gathering
    "castMs": 1500,            // 0 = instant
    "once": true,              // one-shot (stays used) or repeatable
    "cooldownS": 0,            // repeatable only
    "requires": { "item": "crypt-key", "consume": false },
    "loot": "chest:crypt"      // verb-specific payload (a loot pool, a dialog, a vendor id...)
  },
  "breakable": {
    "health": 40,
    "into": "debris",          // "remove" | "variant" | "debris"
    "debris": "dungeon:bone-pile",
    "loot": "prop:crypt",      // optional loot pool rolled at the break
    "respawnS": null,          // null = stays broken; instances never respawn
    "damage": { "blunt": 1.5, "slash": 0.5, "pierce": 0.25 }   // optional per-kind multipliers
  }
}
```

Implicit interactables keep their own data. The server gives them the component at spawn, so content doesn't repeat
itself:
- A ground item (`WorldItem`) gets verb `pickup`.
- A resource node gets verb `gather`, with `rangeM` from `gathering.json`.
- A quest giver gets verb `talk`.
- A dungeon entrance gets verb `enter`.
- A vendor-attached entity gets verb `trade`.

### ECS
- **`Interactable`** (new ComponentId 22, replicated): `verb: ui8` (index into a verb table that ships in the welcome),
  `state: ui8` (0 ready, 1 used or opened, 2 locked), `castMs: ui16`, `rangeDm: ui8` (decimetres). The full def (loot,
  requires, cooldown) stays server-side in a `Map<eid, InteractDef>` resolved from the archetype at spawn, the same way
  `GatheringSystem` keeps its `nodes`.
  - It's replicated so the client can draw prompts for any kind without a kind-specific message. Today there are four
    of those (drops, resources, npcs, entrances), and this design stops it from growing.
- **`Breakable`** (new ComponentId 23, server-only): `def: ui16` and `brokenAt: ui32`. Clients see its effect through
  `Health` (already replicated) and the `AssetRef` variant or the entity's removal.
- **Quest givers and dungeon entrances become entities** (an invisible static marker with `Interactable`). Today they're
  content positions the client draws by itself. This puts every E target behind one wire id. Their figures and gates
  stay client-drawn.
- **`StructuralIntegrity` is retired.** Buildings use `Health` + `Breakable` like any other prop, so the existing combat
  damage path (`Health.current -= amount`, `combat/server.js:55-58`) breaks them with no second damage model. Its id
  (21) stays reserved, and IX6 deletes the component.

### Wire: one op, 0x25 Interact (protocol version bump)
- **C→S** `{ kind: "interact", entity: "<wire id>", verb?: "<verb>" }`, or `{ kind: "interact", item: <bag item id>,
  verb: "use" }` for something in your bag.
  - `verb` is optional. It's only needed when a target offers more than one (a later "pick lock" vs "break open"). Absent,
    it means the target's default.
  - The op shares the session's pickup token bucket (`gateway.ts:5176`).
- **S→C**, to the actor only: `{ kind: "interact", entity, state: "casting", endsAt }`, then `{ state: "done" }`,
  `{ state: "interrupted" }` or `{ state: "refused", reason }`. A refusal is a 4005-style reason string, as gather
  refusals are today.
- **Side effects use their existing messages:** the pouch (0x24 S→C), the inventory (0x14), the quest dialog (quest
  extension), the dungeon hop and the life events. Only the C→S request is unified. The answers stay where their screens
  already listen.
- **Retired C→S ops:** 0x13 `pickup` (`equip`, `drop` and `unequip` stay), 0x24 C→S `gather` (S→C `resources` and
  `pouch` stay), the quest extension's `talk`, and the dungeon extension's `enter` and `open`.

### Server: `InteractSystem`, one dispatch
`InteractSystem` (`packages/engine-core/src/interact/`) owns the defs, the cast timers and the one-shot and cooldown
state. `Gateway.onInteract` does only what every op does: decode, Zod, welcomed, token, `resolveWireId`. Then it calls
`interact.request(sim, holder, avatar, target, verb)`, which:
1. Looks up the def. A missing one, or `state` used and `once`, is a refusal.
2. Checks range from the footprint edge (the `GatheringSystem.gather` math, moved here).
3. Checks `requires`: the item is in the bag, and is consumed on completion if `consume`.
4. If `castMs > 0`, it records a cast `{endsAt, x, z}` and replies `casting`. `step()` finishes casts that come due. A
   cast is interrupted when the avatar moves more than 0.3 m from where it started, takes damage (the DeathSystem/Body
   hit hook already reports blows), starts an attack, or dies.
5. On completion, it calls the verb's handler from a plain `Record<verb, handler>`, filled in at boot by the systems that
   already own the behaviour:

| Verb | Handler (existing code it calls) |
| --- | --- |
| `pickup` | `items.pickup` |
| `gather` | `GatheringSystem.gather` (its range and cooldown checks move to the def) |
| `talk` | `QuestService.talk` |
| `enter` | `DungeonManager.enter` |
| `open` / `search` | chest: roll the def's loot pool into ground items at the chest (the L2 drop path), set `state=1` |
| `open` / `close` (door) | toggle `state` and the door's collider (`BodyConfig` removed or added; PhysicsSystem's membership diff picks it up) |
| `take` | key rack or key: give the item, set `state=1` |
| `trade` | `VendorSystem`: send the vendor's list (the window is EC1's) |
| `use` | consumables (below) |

A handler returns `{ ok } | { ok: false, reason }`. An instance (`DungeonInstance`) registers its own `open` handler for
run chests, so instance-only state stays in the instance.

### Client: one resolver, one prompt
- **One tracker.** It replaces `drops.nearest`, `resources.nearest`, `npcs.nearest` and `entrances.nearest` for E
  purposes, and is fed by every entity with `Interactable` in the mirror state.
- **Targeting.** While the pointer is locked, the entity under the crosshair wins if it's within its `rangeDm`.
  Otherwise the nearest in range wins, ties going to the one most in front of the camera (largest forward dot). With no
  crosshair hit, this matches today's "nearest" feel without the fixed kind order. The drop, resource, npc and entrance
  layers keep drawing their labels and beams.
- **Prompt.** One block replaces the four in `App.tsx:660-689`: `[E] <interact.verb> <name>`, for example
  "E — Open chest" or "E — Gather Iron ore (12 left)". The name and extra line come from the kind's existing data (drop
  names, resource stock, NPC names). A locked target reads "Locked: needs Crypt key".
- **Cast bar.** On `casting`, a bar fills to `endsAt`. Movement keys don't block it on the client; the server interrupts
  and the client shows "Interrupted".
- **Rebinding.** E stays rebindable (U4). The prompt already reads `bindings.interact`.

### Destructibility: `BreakSystem`
- **Spawn.** An archetype with `breakable` spawns with `Health {max = breakable.health}` (the existing scatter path,
  `scatter-spawn.ts:212`, now fed from `breakable.health`) plus `Breakable`.
- **DeathSystem stops reviving props.** Its query becomes `[Transform, Health, Not(Breakable)]`. Bodies that die and
  respawn are characters and creatures. Props break.
- **Damage.** Melee and abilities already hit anything with `Health`. Per-kind multipliers (`damage`) apply in
  `damageScale` when the target is `Breakable`. God-mode and duel rules are unchanged. Hit feedback (0x16) works as it
  does today.
- **Break, when `Health.current` reaches 0:**
  - **`remove`:** the entity is removed. The snapshot delta drops it, and its body goes with it.
  - **`variant`:** `AssetRef.variant` is set to `BROKEN_VARIANT` (replicated already). `BodyConfig` is removed, so the
    prop has no collider. `Interactable` is removed. The client draws the kind's broken model if the art names one, else
    the stand-in tipped and darkened. This is one client rule, like `GROUND_ITEM_VARIANT`.
  - **`debris`:** the entity is removed and the `debris` archetype is spawned in its place (walk-through, no
    `Breakable`).
  - **Loot.** In every case, `loot` rolls into ground items at the spot (the L2 drop path; owner = whoever dealt the last
    blow, 30 s then free, per the alpha decision).
  - The life event (0x17 `dead`) is sent, so the client can play a break sound or VFX by kind.
- **Respawn.** `respawnS` is null (stays broken) or a delay. When it comes due, BreakSystem restores the entity: re-spawn
  for `remove` and `debris`, or variant 0 + `BodyConfig` + full `Health` for `variant`. Instances ignore `respawnS`.
- **Town structures (raids).** Settlement `Structure` kinds get `breakable` in their kind data (walls, gates, houses;
  big health, `into: "variant"` so the ruin stays, `respawnS` per the open question below).
  - Raiders' brains add "attack the nearest structure" when no player or livestock is noticed (WILDLIFE.md not-built
    item 1). A raid ends when its target count of buildings is broken or the raider is driven off.

### Persistence
| Where | What | How |
| --- | --- | --- |
| World, scatter props | Broken and removed | Already persists: the ECS snapshot keeps the removal (`scatter-spawn.ts:28-30`). Respawn timers need a record, below |
| World, scene props (settlements, places) | Broken (+ when), opened or used (+ when) | Scenes re-spawn every boot, so a **place record** keyed `scene:node` (as resource nodes are) rides the range snapshot as `places.breakables` and `places.interactables`, next to PL3a's `places.resource_nodes`. Recall seeds them before the scene spawns; the spawner applies them (spawn broken, or spawn used) |
| World, scatter respawn timers | `respawnAt` per broken scatter prop | `places.breakables` too, keyed `scatter:<cx>,<cz>:<index>` |
| Dungeon instances | Chests opened, props broken, doors and keys | Instance memory only; gone when the run ends (runs are fresh by design). Nothing goes to the world but the run report |
| Character | Keys and consumables taken | Ordinary bag items, already in the item ledger (P2a) |

Storage is one local SQLite table per kind of record, `places.db`, with columns `key`, `state`, `at` and `respawn_at`.
It uses the same store, snapshot and recall pattern as `gathering.db`'s `resource_nodes`, and the content hash covers it
so idle ranges still skip uploads.

### Consumables
- Item definitions gain `consume: { hunger?, thirst?, health?, castMs? }`, validated where item defs are.
- `{kind:"interact", item, verb:"use"}` checks that the item is in the caller's bag and runs the cast (eating takes
  about 1 s and moving cancels it). Then it removes one from the stack (item ledger) and calls
  `NeedsSystem.restore(avatar, "hunger" | "thirst", n)`, and heals `Health` if the item gives health.
- The bag's item menu gets a "Use" action that sends this op. E stays a world key, so you eat from the bag, not with E
  (see the questions).
- `Needs` goes on the wire (one block like `Stamina`), and the HUD gets the two meters. That is U3's missing half.

### Editor parity
The spawn-table and item editors grow the `interact`, `breakable` and `consume` fields with validation in the slice
that adds each field. Dev-only views (cast and break timers) go in the debugger, not the client.

## Left to the builder
The exact verb table, cast-interrupt distance and default ranges, the `BROKEN_VARIANT` value, the place-key format, the
test fixtures, and whether `InteractDef` is cached per archetype or per entity.

## Slices (one PR each, in order)
1. **IX1: E, chests and gathering on one path (2–3 days).**
   - `Interactable`, op 0x25, `InteractSystem` (instant only), and the client resolver and prompt.
   - Gathering is migrated: the 0x24 C→S gather leaves the client.
   - Dungeon chests become entities with `interact: open` (the chest half of D4f), opened with E. The HUD "open" button
     and the `open` op go.
   - Tests: dispatch, range, a one-shot chest, refusals. Checked in the client in a run and in the world.
2. **IX2: Loot, dialog and entrances migrated (2 days).**
   - Ground-item pickup, quest `talk` and dungeon `enter` go through the op.
   - Quest givers and entrances become marker entities. The old ops leave the client and the server.
   - Afterwards there is one path.
3. **IX3: Cast time, doors and keys (2–3 days).**
   - `castMs`, the cast bar, and interrupts (move, hit, attack, death).
   - `requires` (item, consume).
   - Doors (repeatable open and close with a collider toggle) and dungeon keys: key racks give a key, and a locked
     chest or door needs it.
4. **IX4: Breakable core in dungeons (2–3 days).**
   - The `breakable` field, `BreakSystem`, and DeathSystem skipping `Breakable`.
   - `remove`, `variant` and `debris`, loot at the break, collider removal, damage multipliers.
   - Dungeon props get first data (barrels, crates, pots, bone piles). Instance-only, no respawn.
5. **IX5: Breakable in the world, with persistence (2–3 days).**
   - `places.db` (`breakables`, `interactables`) on the PL3a snapshot and recall, and scene spawning applies it.
   - Respawn timers. World scatter and place props get `breakable` data.
   - Checks: a live wipe-and-recall, and a break that survives a restart.
6. **IX6: Town structures and raids (2–3 days).**
   - Settlement `Structure` kinds become breakable, and raiders attack buildings.
   - `StructuralIntegrity` is deleted.
   - Checked with a live raid on an empty town.
7. **IX7: Consumables and the needs HUD (2 days).**
   - The item `consume` field, bag "Use", `NeedsSystem.restore`, `Needs` on the wire, and the hunger and thirst meters.
8. **IX8: Vendors on E (1 day, after EC1's window).**
   - Content-placed vendor NPCs (not only admin `attach`) get `interact: trade`, and E opens the vendor window.

## Open questions for you
1. **World chests:** shared (the first to open it gets the loot, and it refills on a timer) or per player (everyone gets
   their own roll once)? My default is shared, with a refill timer.
2. **Who can break town buildings:** only creatures and raiders, or players too (griefing)? My default is creatures
   only, with players able to break small props anywhere.
3. **Broken buildings:** do they come back on their own after a time, or stay ruined until players repair them (a later
   crafting loop)? My default is back after 2 real hours until repair exists.
4. **Gathering feel:** should gathering become a cast (a 1.2 s bar, cancelled by moving) instead of today's instant
   gather with a 1.2 s cooldown? My default is to keep it instant (`castMs: 0`) in IX1 and decide after playing IX3.
5. **Eating:** from the bag only, or should E eat or drink when nothing is in range? My default is the bag only, so E
   never eats your food by accident.
