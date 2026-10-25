# Admin Authoring Cookbook

How to place and manage every authorable thing in the world while
in-game as an admin. All commands go through the admin console (0x10)
as `{kind: "admin", command, args}`. You must be in `MMO_ADMINS` or on
a dev server. Failures come back as error 4003 with a plain message.

Coordinates are world x/z. **Skip x/z to place at your own feet** —
every placement command does this.

---

## Items — look up, hand out, drop

```js
// What exists? Browse the 600+ defs by base, rank, or source.
{command: "items", args: {base: "sword"}}
{command: "items", args: {rank: "legendary"}}
{command: "items", args: {base: "axe", rank: "rare"}}
// → "4 items: Flaming Mithril Sword of the Bear [legendary sword] …"

// Put one straight into your bag (picks the first match).
{command: "give", args: {base: "sword", rank: "rare"}}

// Drop one at your feet for anyone to pick up.
{command: "drop", args: {base: "sword"}}

// …or at an exact spot. With `fixture: true` it is placed as a fixture:
// it lies there for anyone and never despawns on the timer (the form
// scene ItemSpawn nodes use at boot).
{command: "drop", args: {base: "sword", x: 120, z: -40}}
{command: "drop", args: {base: "sword", x: 120, z: -40, fixture: true}}

// Exact def by its string id (from the `items` output).
{command: "give", args: {def: "abc123..."}}
```

## Bags — take, move, count, identify

The `items` command's sub-actions run the ItemService bag verbs
against the console holder's bag (the same holder `give` fills):

```js
// How many swords am I carrying?
{command: "items", args: {sub: "countbase", base: "sword"}}
// → "you carry 2 × sword"

// Which definition is this item instance? (ids come from give/drop
// messages and the inventory.)
{command: "items", args: {sub: "defof", item: 1234}}
// → "item 1234: Flaming Steel Sword [rare sword] abc123..."

// Take an item out of your bag and destroy it — by instance id, or
// one of a base.
{command: "items", args: {sub: "take", item: 1234}}
{command: "items", args: {sub: "take", base: "sword"}}

// Move an item to another character's bag. `to` (and `from`, which
// defaults to you) are character ids — an entity's is in its
// `inspect` dump ("CharacterRef: character <id>").
{command: "items", args: {sub: "move", item: 1234, to: 77}}
```

## Components — add one, tune it, take it off again

`set` writes fields of a component an entity already has. To give an
entity a component it lacks, add it first — it starts at the
component's defaults, exactly as if it had spawned with it:

```js
{command: "addcomponent", args: {entity: "12345", component: "FlowRef"}}
// → "FlowRef added to 12345 (graph=0 enabled=1)"

// …then tune fields with set, and read the result back with inspect.
{command: "set", args: {entity: "12345", component: "FlowRef", field: "graph", value: 12345}}
{command: "inspect", args: {entity: "12345"}}
```

Addable components (each starts at its defaults): Transform, Velocity,
PlayerIntent, Health (100/100), Stamina (100/100), Needs (full),
BodyConfig (a 0.5 static box — the scene Collider's ECS form),
Locomotion, CharacterRef (unassigned), FlowRef, VfxEmitter,
AudioEmitter. Adding a component the entity already has refuses, and
components whose rows are system-owned state (PathState, NavAgent,
WorldItem, Chunk, Animation, Action, AssetRef, Appearance) have no
defined defaults and refuse by name.

`removecomponent` is the inverse — the authoring layer's unbind. It
takes a component off a live entity through the normal ECS path, so
queries, systems and `inspect` stop seeing it:

```js
{command: "removecomponent", args: {entity: "12345", component: "FlowRef"}}
// → "FlowRef removed from 12345"
```

Removing a component the entity lacks refuses. Every registered
component is removable except **God** and **Noclip**: those stay with
their `god` / `noclip` toggle commands, which own the session-facing
side of the state, and `removecomponent` refuses them by name.

## Gold — grant and check

```js
// Grant yourself (or anyone holding the console) gold.
{command: "gold", args: {amount: 500}}
```

## Creatures — spawn packs, remove them

```js
// A pack of goblins at your feet…
{command: "spawn", args: {asset: "goblin"}}
// …or at an exact spot, facing east (yaw radians about +Y).
{command: "spawn", args: {asset: "goblin", x: 120, z: -40, yaw: 1.57}}

// Remove one by its wire id (see `inspect` or the spawn message).
{command: "despawn", args: {entity: "12345"}}
// Remove whatever you're standing on / looking at.
{command: "despawn", args: {entity: "me"}}
```

## Props & trees — what can I plant?

```js
// List every spawn-table archetype.
{command: "spawnlist"}
// → "birch oak pine"

// Plant one (same x/z/yaw rules as creatures).
{command: "spawn", args: {asset: "oak"}}
{command: "spawn", args: {asset: "pine", x: 200, z: 150}}
```

## Vendors — the full shop lifecycle

```js
// 1. Define the shop template.
{command: "vendor", args: {sub: "define", id: "blacksmith", name: "Blacksmith", buyback: 0.3}}

// 2. Stock it — by item name (no need to memorize def numbers)…
{command: "vendor", args: {sub: "stock", id: "blacksmith", name: "Flaming Mithril Sword", price: 250}}
// …or by def number. qty -1 (default) = infinite stock.
{command: "vendor", args: {sub: "stock", id: "blacksmith", def: 7, price: 100, qty: 5}}

// 3. Put the shopkeeper in the world — at coords, or at your feet.
{command: "vendor", args: {sub: "spawn", id: "blacksmith", x: 120, z: -40}}
// → vendor "blacksmith" spawned as 12346 at (120, -40)
{command: "vendor", args: {sub: "spawn", id: "blacksmith"}}

// …or attach the template to an existing entity instead.
{command: "vendor", args: {sub: "attach", id: "blacksmith", target: "12345"}}

// 4. Manage it.
{command: "vendor", args: {sub: "list"}}                          // what shops exist
{command: "vendor", args: {sub: "disable", id: "blacksmith"}}     // close everywhere (refuses trade)
{command: "vendor", args: {sub: "enable", id: "blacksmith"}}      // reopen
{command: "vendor", args: {sub: "detach", target: "12346"}}       // unbind one NPC, keep the template
{command: "vendor", args: {sub: "remove", id: "blacksmith"}}      // delete the template entirely
```

Players shop with the 0x21 `vendor` actions (`list` / `buy` / `sell`)
within 4 metres of the NPC. The shop list shows real item names.

## Quick reference — every command

| Command   | What it places/manages        | Key args |
|-----------|-------------------------------|----------|
| `items`   | Browse item defs              | `base?`, `rank?`, `source?`, `def?` |
| `items`   | Bag verbs (sub-actions)       | `sub: take\|move\|defof\|countbase`, `item?`, `base?`, `from?`, `to?` |
| `give`    | Item → your bag               | same as `items` |
| `drop`    | Item → ground (at your feet, or at `x`/`z`; `fixture` stays) | pick + `x?`, `z?`, `fixture?` |
| `addcomponent` | Component → entity, at its defaults | `entity`, `component` |
| `removecomponent` | Component off an entity (unbind) | `entity`, `component` |
| `gold`    | Gold → your wallet            | `amount` |
| `spawn`   | Creature pack / prop          | `asset`, `x?`, `z?`, `yaw?` |
| `spawnlist` | List placeable archetypes   | — |
| `despawn` | Remove any entity             | `entity` (wire id or `"me"`) |
| `vendor`  | Full shop lifecycle           | `sub: define\|stock\|spawn\|attach\|detach\|disable\|enable\|remove\|list` |

## Notes

- Vendor templates are in-memory: they don't survive a restart (wallets
  do — they're in SQLite). Placed entities (trees, creatures, NPCs)
  persist like any other world entity.
- `vendor spawn` creates a bare entity — no model yet. It works for
  trade (reach check, shop UI) but the client renders whatever its
  fallback for model-less entities is until NPC art lands.
- The content library is thin on purpose right now: 3 trees, 1 goblin,
  600+ items. The commands accept anything added to the spawn table,
  creature rules, or loot pool with no code changes.
