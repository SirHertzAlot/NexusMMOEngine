# Module → Authoring-View Audit

Read-only audit of `~/workspace/nexus-engine`, 2026-10-17. No repo files were modified.
Covers the 17 engine modules from PR #251 (+1 sample module), answering three questions:

1. Where is capability X *actually* implemented? (duplication check)
2. What designer-facing widget does each module contribute?
3. When should that widget appear on viewport selection? (relevance rules)

Direction (Joey's, 2026-10-17): **viewport-only workflow**. Modules have NO standalone
UI presence. Clicking a game object opens contextual widgets/modals inside the viewport —
one per relevant module, each showing what's already applied + CRUD. Selection summons
them; only the relevant ones appear.

---

## 1. Module inventory

18 module folders under `~/workspace/nexus-engine/modules/` (17 engine + `sample-heartbeat`).
Each module = `module.json` manifest + `server.js` entry (thin wrapper importing the real
implementation from `packages/engine-core/dist/src/...`). The 7 `editor/` modules contribute
workspace panels; the 10 `server` modules contribute tick systems and/or gateway extensions.

### Server/domain modules

| # | Module | Path | Purpose (one line) | Key capabilities / verbs |
|---|--------|------|--------------------|--------------------------|
| 1 | `core` | `modules/core/` | The engine's own systems: wallet, trade, vendor, auction, streamer, reloader | `WalletSystem.grant/spend/transfer/balanceOf` (`packages/engine-core/src/economy/wallet.ts`); `VendorSystem.attach/detach/vendorOf/buy/sell` (`economy/vendor.ts`); `TradeSystem`, `AuctionSystem` |
| 2 | `character` | `modules/character/` | Player characters: character system, animation, mastery (skills), stats | Systems: `character`, `animation`, `mastery`, `stats` (`modules/character/server.js`) |
| 3 | `combat` | `modules/combat/` | Combat domain: stamina, body, magic, abilities, status, telegraphs, duels, death | Systems: `stamina`, `body`, `magic`, `abilities`, `status`, `telegraphs`, `duels`, `combat`, `death` (`modules/combat/server.js`) |
| 4 | `creatures` | `modules/creatures/` | Creature AI, bots, crowd steering, needs | `CreatureSystem.spawn/spawnPack/kindOf` (`packages/engine-core/src/creatures.ts:163-174`, `:123`); `BotSystem`, `CrowdSystem`, `NeedsSystem` |
| 5 | `physics` | `modules/physics/` | Jolt physics, navmesh, obstacles, collision, integration | Systems: `physics`, `navigation`, `obstacles`, `integrate`, `prop-collision`, `collider` (`modules/physics/server.js`) |
| 6 | `items` | `modules/items/` | Items: dropping, pickup, bags, ground expiry; gateway `dropper` extension | `ItemService.give/take/spawnDrop/placeFixture/pickup/dropFromBag/wear/equip/unequip` (`packages/engine-core/src/items/item-service.ts:92-289`) |
| 7 | `quests` | `modules/quests/` | Quests + dialogue: gateway `quests` extension, place/bag checking | `QuestService` (`packages/engine-core/src/quests/quest-service.ts`); quest content + dialog graphs (`quests/content.ts`) |
| 8 | `dungeons` | `modules/dungeons/` | Dungeon instances: pool, content, `InstanceManager` gateway extension | `dungeons` extension (`modules/dungeons/server.js`); entrances in `packages/engine-core/src/dungeons/content.ts:7` |
| 9 | `intent` | `modules/intent/` | Player intent: per-session intent/pickup budgets, frame cap | System: `intent` (`modules/intent/server.js`); `PlayerIntent` component (`components.ts:53`) |
| 10 | `chat` | `modules/chat/` | Region chat (S1): validation, per-channel range/rate limits, text filter | No tick systems; gateway-owned fan-out (`modules/chat/module.json`) |

### Editor modules (workspace panels — see §5 for the no-standalone-UI reframing)

| # | Module | Path | Panel today |
|---|--------|------|-------------|
| 11 | `audio` | `modules/audio/` | Art & audio workspace: audio panel (`modules/audio/editor/index.tsx`) |
| 12 | `characters` | `modules/characters/` | Characters workspace: Records panel |
| 13 | `flow` | `modules/flow/` | Flow workspace: flow graph editor (`apps/editor/src/ui/flow-editor.tsx`) |
| 14 | `hud` | `modules/hud/` | Release workspace: HUD layout editor (`apps/editor/src/ui/hud-editor.tsx`) |
| 15 | `scenes` | `modules/scenes/` | Scenes workspace: Scene document panel (`apps/editor/src/ui/scenes-panel.tsx`) |
| 16 | `story` | `modules/story/` | Story workspace: Quest & dialog editor (`apps/editor/src/ui/story-editor.tsx`) |
| 17 | `vfx` | `modules/vfx/` | Art & audio workspace: VFX particle editor (`apps/editor/src/vfx/bezier-editor.tsx`) |
| — | `sample-heartbeat` | `modules/sample-heartbeat/` | Sample only — one system logging every 600 ticks. Not a real module; no widget. |

Note: `character` (server domain) vs `characters` (editor Records panel) is a naming
collision, not a duplication — see §5, rule 12.

---

## 2. Duplication flags

Joey's suspicion was: *"give the player an item" exists separately in quest, vendor,
loot, trade.* **Verdict: the core verbs are clean — but the adapters around them are
duplicated.** Every claim below has a file path (verify-before-claiming).

### TRUE duplication (same logic, two homes)

**D1. `defOf` adapter written twice, verbatim.**
`packages/engine-core/src/server.ts:647-650` (vendor wiring) and `server.ts:658-661`
(auction wiring) contain the identical 4-line lambda:
```js
defOf: (item) => {
  const slot = itemsOf().store.slot(item);
  return slot < 0 ? -1 : itemsOf().store.defs[slot];
},
```
Fix: promote to `ItemService.defOf(item)` (or `ItemStore`), delete both lambdas.

**D2. `move` adapter written twice, verbatim.**
`server.ts:633-636` (trade wiring) and `server.ts:662-665` (auction wiring):
```js
move: (item, from, to) => {
  if (!itemsOf().store.inBagOf(from, item)) return false;
  return itemsOf().store.putInBag(to, item) >= 0;
},
```
Fix: promote to `ItemService.moveItem(item, from, to)`, delete both lambdas.

### Should-be-shared verbs (hand-rolled per call site, no canonical home)

**D3. `countInBag` hand-rolled in quest config.**
`server.ts:723-728` iterates `itemsOf().store.bag(character)` inline to count items of a
base — quest objective checking ("have N of X") reaches into store internals instead of
calling a service method. No canonical count method exists on `ItemService`
(checked `packages/engine-core/src/items/item-service.ts:64-416`).
Fix: add `ItemService.countBase(character, base)`.

**D4. Vendor `take` adapter hand-rolled.**
`server.ts:642-645` reimplements take as `inBagOf` + `store.destroy`. The `VendorItems`
interface (`economy/vendor.ts:28-37`) already names `take(charId, itemId)` as a verb —
it just isn't a method on the service.
Fix: add `ItemService.take(character, item)`, wire the interface to it.

**D5. Two `grantItem` adapters, different signatures.**
`server.ts:730-733` (quests: resolves `base`→`def` via `defs.starter(base, rankOrder)`,
then `itemsOf().give`) vs `server.ts:802` (dungeons: takes `def` directly, then
`itemsOf().give`). Both funnel to the single `ItemService.give`
(`items/item-service.ts:289`) — NOT true duplication. But the base→def resolution
(`defs.starter`) is quest-only; any future caller repeats it.
Fix: canonical `resolveBase(base, rank) → def` on the item defs, one `grantItem`
shape everywhere.

### CLEARED — suspected but actually single-homed

- **Give item.** ONE implementation: `ItemService.give` (`items/item-service.ts:289`).
  Consumed by: vendor buy (`economy/vendor.ts:183`), gateway `give` command
  (`net/gateway.ts:4589`), quest rewards (`server.ts:732` via adapter), dungeon rewards
  (`server.ts:802` via adapter), `server.ts:641`. Thin adapters, shared core. ✅
- **Give gold.** ONE implementation: `WalletSystem.grant` (`economy/wallet.ts:54`).
  Consumed by: auction settlement/refunds (`economy/auction.ts:146,240,261,267`),
  vendor buy/sell (`economy/vendor.ts:185,208`), gateway `gold` command
  (`net/gateway.ts:4563`), loot-dropper (`items/loot-dropper.ts:72`), quest rewards
  (`server.ts:735`). ✅
- **Spawn creature/NPC.** ONE implementation: `CreatureSystem.spawn` / `spawnPack`
  (`creatures.ts:163-174`). Consumed by: gateway `spawn` (`net/gateway.ts:2609`),
  dungeons (`dungeons/instance.ts:199,299`), scene boot (`scene-spawn.ts:149,158`). ✅
- **Despawn.** `world.despawn(eid)` — single (`net/gateway.ts:559-562`, `:1682`). ✅
- **Teleport.** Single: `admin/player.ts:104` (+ gateway `teleport` command at
  `net/gateway.ts:2624`). No duplication found.

**Net: Joey's instinct was directionally right but the duplication is in the
4-line bag adapters in `server.ts`, not in the headline verbs.** The modularization
(PR #251) got the verb cores right; the wiring layer is where the copies live.

---

## 3. Authoring-view mapping

Under the viewport-only direction, no module keeps a standalone panel. Each module
contributes **one contextual widget** shown on selection when relevant (§5), displaying
what's already applied + CRUD. Mapping below: natural widget per module, and whether the
module is pure infrastructure (scene-level or no object relevance).

| Module | Widget it contributes | Infrastructure-only? |
|--------|----------------------|----------------------|
| core (economy) | Vendor widget: template, stock lines, prices, buyback; attach/detach vendor to NPC | Trade/auction have no per-object marker → scene-level |
| character | Character sheet widget: stats, mastery, animation clip state | No |
| combat | Combat widget: abilities, status effects, health/stamina | No |
| creatures | Creature widget: species/kind, AI state, needs | No |
| physics | Physics widget: collider shape, NavAgent state | No |
| items | Item widget: def, owner, despawn timer; bag/inventory CRUD on characters | No |
| quests | Quest widget: quests given by this NPC, objectives, rewards; dialogue graph | No |
| dungeons | Dungeon widget: entrance pools, rank, themes | No |
| intent | Intent widget: per-session budgets, frame cap (player avatars) | Borderline — player-only |
| chat | — | **Yes.** Region chat has no per-object marker; scene-level widget (channels, rate limits) |
| audio | Audio widget | **Mostly.** No per-object audio-emitter marker found in code; scene-level (ambient/music) until emitters exist |
| characters | Records widget (character records) | No — but overlaps `character` module's widget (see §5.12) |
| flow | Flow-graph widget | **Needs a marker.** No behavior/flow component found on entities; cannot trigger per-object today |
| hud | — | **Yes.** HUD layout is global; no object relevance |
| scenes | — | **Yes.** Scene document is scene-level; it IS the hierarchy view (§5, scene selection) |
| story | Quest & dialog editor widget | No — but overlaps `quests` module's widget (see §5.16) |
| vfx | Particle widget | **Needs a marker.** No emitter component found in `components.ts`; likely keyed by `AssetRef`/scene node |

**Overlaps to resolve in design (not code duplication, but two widgets claiming one selection):**
- `character` (server) vs `characters` (editor Records): both fire on character selection.
- `quests` (server) vs `story` (editor quest & dialog): both fire on quest-giver NPC selection.
  Recommendation: merge each pair into ONE widget with tabs, not two modals.

---

## 4. Shared-verb candidates

Verbs multiple authoring workflows need, with the module each should canonically live in.
✅ = already canonical. ➕ = needs promoting from an inline adapter (see §2).

| Verb | Signature | Canonical home | Status |
|------|-----------|----------------|--------|
| `giveItem` | `(character, def) → ok` | items (`ItemService.give`, `items/item-service.ts:289`) | ✅ |
| `giveGold` | `(character, amount) → ok` | core (`WalletSystem.grant`, `economy/wallet.ts:54`) | ✅ |
| `takeItem` | `(character, item) → ok` | items (`ItemService.take` — NEW) | ➕ D4 |
| `defOf` | `(item) → def` | items (`ItemService.defOf` — NEW) | ➕ D1 |
| `moveItem` | `(item, from, to) → ok` | items (`ItemService.moveItem` — NEW) | ➕ D2 |
| `countBase` | `(character, base) → n` | items (`ItemService.countBase` — NEW) | ➕ D3 |
| `resolveBase` | `(base, rank) → def` | items (item defs — NEW) | ➕ D5 |
| `spawnCreature` / `spawnPack` | `(kind, x, z) → eid(s)` | creatures (`CreatureSystem.spawn/spawnPack`, `creatures.ts:163-174`) | ✅ |
| `teleport` | `(entity, x, z)` | admin (`admin/player.ts:104`) — keep; GM verb, not designer verb | ✅ |
| `startDialogue` | `(npc, player)` | quests (dialog graphs, `quests/content.ts:14-18`) | ✅ (content-side) |
| `attachVendor` / `detachVendor` | `(entity, templateId)` | core (`VendorSystem.attach/detach`, `economy/vendor.ts:115-123`) | ✅ |
| `placeItemFixture` | `(base, rank, x, z)` | items (`ItemService.placeFixture`, `items/item-service.ts:104`) | ✅ |
| `grantQuestReward` | `(character, {base,count,gold}[])` | quests (reward application, `quests/quest-service.ts:234-238`) — resolves to `giveItem`/`giveGold` | ✅ (composite) |

Design note: the authoring layer should speak ONLY these verbs. A quest reward, a vendor
sale, a loot drop, and an admin `give` are four call sites for `giveItem`, not four
features. The modal for "give the player something" is one widget used by four workflows.

---

## 5. Relevance rules

One line per module: when its widget appears on viewport selection, grounded in what the
code actually exposes. "Scene-level" = appears on scene/region selection or a scene
toolbar, never on object click. "Needs marker" = the code has no per-object hook today;
the widget cannot trigger until one exists (flagged, not invented).

1. **core (economy):** vendor widget appears when `VendorSystem.vendorOf(entity)` is defined — i.e. the entity is in the vendor map (`economy/vendor.ts:153`); CRUD includes attach/detach (`vendor.ts:115-123`). Trade/auction: scene-level (no per-object marker in code).
2. **character:** widget appears when the entity has the `CharacterRef` component (`components.ts:336`); shows stats, mastery, and `Animation` clip state (`components.ts:364`).
3. **combat:** widget appears when the entity has `Health` (`components.ts:71`) or `Stamina` (`components.ts:82`); shows abilities, status effects, body config.
4. **creatures:** widget appears when `CreatureSystem.kindOf(entity)` returns a kind id (`creatures.ts:123-124`); shows species, AI/bot state, needs (`Needs`, `components.ts:92`).
5. **physics:** widget appears when the entity has a collider (prop-collision/collider systems) or the `NavAgent` component (`components.ts:261`); shows collision shape + nav state.
6. **items:** widget appears when the entity has the `WorldItem` component (`components.ts:349`) — shows def, owner, despawn timer; on `CharacterRef` entities it shows bag/inventory CRUD instead.
7. **quests:** widget appears when the selected NPC's id matches a quest-content `npcs` entry or a quest `giver` (`quests/content.ts:89`); shows quests given, objectives, rewards, and the dialog graph.
8. **dungeons:** widget appears when the selected object is a dungeon entrance (`dungeons/content.ts:7`, `entrances.json`); shows pool layouts, rank, themes.
9. **intent:** widget appears when the entity has the `PlayerIntent` component (`components.ts:53`); shows per-session intent/pickup budgets and frame cap.
10. **chat:** no per-object marker in code — scene-level widget only (region channels, range, rate limits).
11. **audio:** no per-object audio-emitter marker found in code — scene-level widget (ambient/music) until emitters exist.
12. **characters:** widget appears on `CharacterRef` entities — MERGE with the `character` module widget (one modal, tabs); the `character`/`characters` naming split is editor-vs-server, not two features.
13. **flow:** no behavior/flow component found on entities — NEEDS MARKER; widget cannot trigger per-object until a flow-graph binding exists on the entity.
14. **hud:** no object relevance — global only, never on selection.
15. **scenes:** scene-level only — this IS the hierarchical scene breakdown view, not an object widget.
16. **story:** same trigger as quests (quest-giver NPC, `quests/content.ts:89`) — MERGE with the `quests` widget into one modal (Quest & dialogue tabs), not two.
17. **vfx:** no emitter component found in `components.ts` — NEEDS MARKER; likely keyed by `AssetRef` (`components.ts:285`) or scene node once emitters are modeled.
18. **sample-heartbeat:** no widget. Not a real module.

### Relevance gaps (need code, not just design)

- **flow** and **vfx** cannot participate in selection-driven UI until entities carry a flow-binding / emitter marker. Options: a `FlowRef`/`EmitterRef` component, or derive from `AssetRef`/scene-node metadata.
- **audio** needs an audio-emitter marker for per-object sound; until then it's scene-level.
- The **merge pairs** (§3: character/characters, quests/story) should be resolved before building widgets, or designers get two modals for one click.

---

*End of audit. All file paths are relative to `~/workspace/nexus-engine` unless stated.
Read-only audit — no repo state was modified.*
