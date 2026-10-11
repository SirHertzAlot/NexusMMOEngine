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

// Exact def by its string id (from the `items` output).
{command: "give", args: {def: "abc123..."}}
```

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
| `give`    | Item → your bag               | same as `items` |
| `drop`    | Item → ground at your feet    | same as `items` |
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
