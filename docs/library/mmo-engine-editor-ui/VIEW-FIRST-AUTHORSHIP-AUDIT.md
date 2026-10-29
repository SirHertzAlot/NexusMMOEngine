# View-First Authorship Audit

**Date:** 2026-10-18 · **Repo:** `~/workspace/nexus-engine` @ `7baf039` (checked 2026-10-18T01:05Z; tree clean)
**Direction being served:** Joey's 2026-10-17 authoring direction — **viewport-only workflow**: the 3D scene is the
primary interface; clicking a game object opens a **modal** with that object's authoring UI, plus a **hierarchical
breakdown** of what's visibly within a scene. Modules presented as composable units; shared verbs promoted to
first-class authoring actions instead of duplicated per domain.

This audit answers three questions:
1. Is Joey's duplication suspicion right? (Mostly no — and that's good news.)
2. What do the 17 modules actually contribute to authoring?
3. What does the viewport-only modal need to show for each clickable object?

---

## Part 1 — The duplication verdict

**Headline: the server-side verb layer is already deduplicated.** Joey's suspicion — "give the player an item"
implemented separately in quests, vendors, loot drops, and trade — does not survive a code check. There is one
funnel per verb, and every domain routes through it.

| Suspected duplication | Verdict | Evidence |
|---|---|---|
| grantItem / grantGold in quests vs vendors vs dungeons | **Single funnel — not duplicated** | `packages/engine-core/src/server.ts:730,734` defines `grantItem`/`grantGold` on the module config; they call `itemsOf().give(character, def)` and `wallet.grant(character, amount, tick)`. `modules/quests/server.js:27-28` and `modules/dungeons/server.js:32` both delegate to these — they don't reimplement. |
| Vendor sales | **Same funnel** | `VendorSystem` buys via `this.items.give(buyerChar, def)` (`packages/engine-core/src/economy/vendor.ts:183`) — the exact verb quest rewards resolve to. |
| Trade settlement | **Same funnel** | Settles via `wallet.transfer(...)` and `items.move(item, a, b)` (`packages/engine-core/src/economy/trade.ts`, `settle()`) — shared wallet/item verbs, not a parallel economy. |
| Loot drops | **Same funnel** | `LootDropper` is constructed with the shared `items` service and `wallet` (`modules/items/server.js`) — drops land through the same item store. |
| Creature/NPC spawning across spawn tables, quests, encounters, admin | **Single funnel — not duplicated** | `CreatureSystem.spawn` / `spawnPack` (`packages/engine-core/src/creatures.ts:163,168`) is the only creature constructor. Called by scene-spawn (`scene-spawn.ts:149,158`), dungeon instances (`dungeons/instance.ts:199,299`), and the gateway admin spawn (`net/gateway.ts:2609`). |
| Ground-height query | **Single owner, shared** | Owned by the `character` module; items and creatures both receive it as `groundHeightAt` config (stated in `modules/character/module.json`, wired in `modules/items/server.js` and `modules/creatures/server.js`). Correct already. |
| Nav backend | **Single owner, shared** | Owned by `physics`; creatures consumes it via `ctx.shared.navBackend` (`modules/creatures/server.js:22-24`). Correct already. |

**The one real naming collision:** `character` (server module: player characters, stats, mastery, ground height)
vs `characters` (editor module: the Characters workspace's Records panel). Different things, near-identical names —
rename the editor one to `records` or `npc-records` when convenient. Cosmetic, but it confuses every new reader.

**What this means:** the engine already speaks in shared verbs. The duplication problem is not in the engine —
it's in the **authoring layer**, which doesn't expose the verbs. A designer typing a quest reward and a designer
stocking a vendor are both reaching for `items.give()` but neither of them can see that, because neither action
has a real view.

---

## Part 2 — The 17 modules, mapped to authoring

Ten server modules (systems behind narrow interfaces) and seven editor modules (workspace panels). The split
matters: server modules are thin wiring slices over `packages/engine-core`; editor modules are UI panels that
can be toggled per workspace.

**Server modules → what a designer authors through them:**

> Trajectory note: under the viewport-only direction, the seven editor-module panels below dissolve — modules get
> no standalone UI presence. Each server module instead contributes (a) selection-summoned widget(s) + relevance
> rules, and optionally a shelf recipe (§6). The panels are the migration source, not the destination.

| Module | Systems | Authorable surface (today) |
|---|---|---|
| `core` | reloader, streamer, wallet, trade, vendor, auction | Economy rules; vendor templates (code/admin only — see Part 3) |
| `character` | character, animation, mastery, stats | Character records, skills, stats (Characters workspace) |
| `creatures` | creatures, bots?, crowd?, needs | Creature kinds, packs, needs (rules JSON) |
| `combat` | stamina, body, magic, abilities, status, telegraphs, duels, combat, death | Abilities, telegraphs, status effects (rules + data) |
| `items` | items (+ItemService, LootDropper) | Item defs, loot tables (rules JSON) |
| `quests` | gateway extension + bag/place checker | Quests + dialogue (Story workspace) |
| `dungeons` | pool, InstanceManager (gateway ext) | Dungeon content (content/dungeons) |
| `physics` | physics, navigation, obstacles, integrate, prop-collision, collider | Collision/nav (mostly bake-time, not authored per-object) |
| `intent` | intent | Input budgets (tuning, not authored) |
| `chat` | (rules only) | Chat channels/ranges (rules JSON) |

**Editor modules → the panels they contribute:**

| Module | Workspace | Panel |
|---|---|---|
| `story` | Story | Quest & dialog editor |
| `scenes` | Scenes | Scene document panel |
| `characters` | Characters | Records panel |
| `flow` | Flow | Flow graph editor |
| `hud` | Release | HUD layout editor |
| `audio` | Art & audio | Audio panel |
| `vfx` | Art & audio | VFX particle editor |

**The structural gap this reveals:** the server modules are presented to the designer as *zero* composable units.
`modules-panel.tsx` in the editor only toggles modules on/off. There is no "pull Quest / Vendor / Encounter off a
shelf and compose" — which is exactly Joey's "modules aren't presented as modules" complaint. The fix is not
reorganizing the server modules (they're fine); it's building the shelf.

---

## Part 3 — The authoring surface today: views, data-entry, and holes

### Exists as a real view
- **Quest & dialog editor** (`apps/editor/src/ui/story-editor.tsx`, 379 lines) — quest list, steps, dialogue tester.
- **Scene document panel** (`apps/editor/src/ui/scenes-panel.tsx`, 593 lines) — scene nodes.
- **Characters Records panel** (`apps/editor/src/character-records.ts`) — character records.
- **Flow graph editor**, **HUD layout editor**, **audio panel**, **VFX particle editor** — present.
- **ECS inspector**, **world-map**, **selection**, **dungeon-view**, **graph-editor** inspectors — present.

### Exists only as data-entry (the "data heavy" complaint, with receipts)
- **Quest rewards** are a comma-separated text field: *"Rewards (item bases, comma separated)"*
  (`story-editor.tsx:181`) — the designer types raw item base IDs (`iron_sword, health_potion`) from memory.
  No item picker, no validation that the base exists, no connection shown to the vendor that sells the same sword.
- **Quest chains** are a comma-separated text field: *"After (quest ids, comma separated)"* (`story-editor.tsx:156`).
- **Step objectives** render as generic key/value text inputs (`story-editor.tsx:165-172`) — the objective *type*
  has a dropdown, but every parameter is a raw string/number field.
- **Loot tables, creature packs, spawn tables** — authored in rules JSON via the rules editor (data, no view).

### Missing entirely (holes the modal design must fill)
- **Vendor authoring: no editor UI at all.** `VendorSystem` has a complete authoring-capable API —
  `create(id, name)`, `define(def)`, `setStock(id, def, price, qty)` (`economy/vendor.ts:82-104`) — but the only
  caller of `setStock` in the whole repo is a **gateway admin command** (`net/gateway.ts:4634`). To stock a vendor
  today you either hand-write the call or type it into the admin console. There is no vendor concept in
  `apps/editor/src` whatsoever (only hit is a CSS comment in `app.css`).
- **NPC role composition** — a blacksmith who sells swords is: a character record (Characters workspace) + a
  vendor template (admin command) + placement (Scenes workspace). Three surfaces, no connective tissue. The human
  does the join in their head.
- **Encounter staging** — telegraphs, packs, trigger zones exist server-side (`combat`, `creatures`) but have no
  authoring view; encounters are assembled from rules JSON.

---

## Part 4 — Viewport-only modal designs (per clickable object)

Per the direction: the designer clicks an object in the 3D scene; a modal opens with that object's authoring UI.
Scene node component kinds already in `scene-spawn.ts` give us the clickable object taxonomy for free:
`ItemSpawn`, `QuestGiver`, `Spawner` (creature/species), scatter props, spawn-points — plus vendor-bound NPCs.

### 1. NPC selection → contextual module widgets (click any character/creature entity)
Per the refined direction (2026-10-17): **modules have no standalone UI presence — selection summons them.**
Clicking an NPC summons one contextual widget per *relevant* module, each showing **what's already applied +
CRUD** for that module's slice of the NPC. This is the "blacksmith who sells swords" fix: the NPC is one object,
not three workspace visits, and the designer never sees modules that don't apply.
- **character widget** (always relevant for NPCs): name, appearance, stats — picker-based. Shows current values,
  edits in place. Replaces the Records-panel row.
- **vendor widget** (relevant when the NPC has — or is being given — a vendor template): stock list as item-picker
  rows — pick item → price → quantity → resolves to `vendor.setStock`. "Make vendor" creates the template via
  `vendor.create`. *This is the missing UI from Part 3.*
- **quests widget** (relevant when the NPC gives quests or is quest-targetable): quests offered — pick from the
  quest shelf, not a comma-separated string. Placing the giver resolves to the `QuestGiver` scene-node path
  (`scene-spawn.ts:142-150`).
- **combat widget** (relevant when the NPC is hostile/guard): abilities, aggro, telegraphs — pickers over
  existing defs.
- Each widget resolves to the shared verbs (Part 5).

**Relevance rules (per module, evaluated on selection):** a widget appears iff the module has something to say
about the selection — the NPC already carries that module's data (has vendor template → vendor widget), or the
module declares the selection *eligible* (any NPC can become a vendor → "+ vendor" affordance summons it).
Irrelevant modules stay invisible: clicking a rock never summons the quests widget; clicking a quest giver never
summons audio. Relevance is derived from (a) data present on the entity, (b) module-declared eligibility per
entity kind. No registry UI, no toggles — the selection is the query.

### 2. Quest selection → quests widget (click a quest giver's quest, or a quest in the hierarchy)
- Giver: NPC picker (not a string field). Steps: cards with objective-type picker + parameter pickers.
- **Rewards: item shelf** — the designer picks items visually; each chip resolves to `grantItem(character, base)`
  (→ `items.give`). Gold row resolves to `grantGold` (→ `wallet.grant`). Replaces the comma-separated text field.
- "After" chain: quest picker, not a text field.
- Relevance: summons for quest-giver NPCs, quest journal objects, and quest rows in the hierarchy.

### 3. Spawner / encounter selection → widgets (click a Spawner node or trigger zone)
- **creatures widget**: creature/species picker → pack size → spawn radius → resolves to `creatures.spawnPack`.
- **combat widget** (relevant when the encounter is hostile): trigger zone picker + condition; telegraph preview
  toggle — stage the encounter visually, then play-test in place.

### 4. Item / container selection → items widget (click an ItemSpawn node or lootable)
- Item picker (base + rank) → placement; loot-table picker for containers → resolves to `LootDropper` tables.
- Shows every other place the same item appears (vendor stock, quest rewards, loot tables) — the connection
  Joey asked for, made visible: "this sword is also sold by Blacksmith Mira and drops from cave wolves."

### 5. Scene hierarchy breakdown (the second half of the direction)
A tree of what's visibly in the scene — zones → NPCs (with role badges: vendor/quest/combat) → spawners →
items/props — each row click-opens that object's modal. This replaces "search around and click for what you want":
the hierarchy *is* the navigation, and the viewport *is* the canvas. The existing `scenes-panel.tsx` (593 lines)
is the starting point, but it needs role badges and modal hooks, not more document fields.

### 6. The module shelf (the "presented as modules" fix)
A palette — in the viewport toolbar, not a workspace — offering composable units: **Quest**, **Vendor**,
**Encounter**, **Spawner**, **Item cache**, **Dialogue**. Dragging one onto the scene creates the object *and*
opens its modal. Each shelf item is a thin recipe over module capabilities:
- Quest → quests module (doc) + QuestGiver scene node + grantItem/grantGold rewards
- Vendor → core/vendor (`create` + `setStock`) bound to an NPC entity
- Encounter → creatures (`spawnPack`) + combat (telegraphs) + trigger zone
- Spawner → creatures (`spawnPack`) + scene Spawner node
No new engine code — the verbs exist (Part 1). The shelf is pure authoring UI.

---

## Part 5 — Shared verb registry (first-class authoring actions)

These are the verbs the modals resolve to. All verified present in the repo at the cited locations:

| Verb | Signature | Owner | Used by |
|---|---|---|---|
| `give` | `items.give(character, def) → {ok}` | items/ItemService | quest rewards, dungeon rewards, vendor sales |
| `grantGold` | `wallet.grant(character, amount, tick)` | core/WalletSystem | quest rewards, dungeon rewards |
| `move` | `items.move(item, from, to)` | items/ItemService | trade settlement |
| `transfer` | `wallet.transfer(a, b, amount, tick)` | core/WalletSystem | trade settlement |
| `setStock` / `create` / `define` | vendor template authoring | core/VendorSystem | (today: admin only — needs the modal) |
| `spawn` / `spawnPack` | `creatures.spawn(sim, kind, x, z)` | creatures/CreatureSystem | scenes, dungeons, admin spawn, quest hooks |
| `place` | `items.placeFixture(sim, def, x, z)` | items | scene ItemSpawn nodes |
| `groundHeightAt` | `(x, z) → y` | character | items, creatures, scene-spawn |

Promotion work (small, server-side): expose `vendor.create/define/setStock` and the quest-reward grant paths
through the editor's backend API the way `items` and `creatures` already are — the verbs exist, they just aren't
all reachable from authoring yet.

---

## Part 6 — Suggested build order (smallest view-first wins)

1. **Item picker component** — one shared picker over item bases/defs. Unblocks quest rewards, vendor stock,
   loot tables, encounter loot in a single stroke. Kills the comma-separated text field.
2. **Selection → widget summoning + NPC character widget** — click NPC → contextual widget(s). Proves the
   viewport-only pattern end to end, including the relevance-rule evaluation (data-present + eligibility).
3. **Vendor widget** (the hole) — `vendor.create` + `setStock` UI. First net-new authoring capability; the blacksmith
   becomes a 2-minute task instead of a 3-surface expedition.
4. **Quest modal rewards row** — item-shelf chips → `grantItem`/`grantGold`. Deletes the worst text field.
5. **Scene hierarchy with role badges** — navigation fix; makes every object findable.
6. **Module shelf** (drag Quest/Vendor/Encounter onto the scene) — the composable-units payoff.
7. **"Used by" cross-links** (item modal §4) — the connection-made-visible; cheapest high-delight item, do it
   whenever the pickers exist.

None of this touches the sim, the wire protocol, or module boundaries. It's all authoring surface over verbs
that already exist — which is why the audit's real finding is optimistic: **the engine is ready for view-first
authorship; only the views are missing.**
