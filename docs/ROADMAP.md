# Roadmap

The official list of what is built, what is being built, and what comes
next, so anyone can follow along and pick something up. **Every pull
request updates this file**: its item's status, and a line in the
[update log](#update-log) at the bottom.

The design behind each item lives in the linked doc; this page is the
index and the status board, not the spec.

| Status | Meaning |
|---|---|
| ✅ | Built and merged |
| 🚧 | In progress (a branch or an open PR) |
| ⏭️ | Next up |
| 📋 | Planned |

**Want to help?** Pick a 📋 item, read its design doc, and open an issue
or a draft PR saying you're on it, so work isn't doubled. Each item is
one PR (`CLAUDE.md` has the workflow: tests, screenshots, one feature per
PR).

## Where things live

- **The game client (`apps/client`) is what players see**, and only that:
  the world, and the player's own interface (health and resource bars,
  chat, parties, quests, inventory, character sheet, settings).
- **The editor (`apps/editor`) is where every developer tool lives.**
  Its play mode runs the game against a local server and is the engine's
  debugger: performance graphs, draw calls and triangles, level-of-detail
  views, network traffic, wireframe, effect showcases, entity
  inspection, navmesh and path overlays.

`npm run client` starts the player's client, `npm run dev` the
development environment (the server and the developer client), and
`npm run editor` the editor.

Debug views that are still in the client today move to the editor's play
mode (E4, E5) and are then removed from the client.

---

## 1. Editor and developer tools

Doc: [`EDITOR.md`](EDITOR.md)

| # | Item | Status | Notes |
|---|---|---|---|
| E0 | **Separate commands**: `npm run client` is the player's client only; `npm run dev` is the development environment (until E4, the client with its developer panels; after, the editor's play mode) | ✅ | `scripts/dev.mjs`; the client's `dev:tools` script (Vite mode `devtools`) |
| E1 | ECS inspector (read-only, over the 0x0a debug queries) | ✅ | |
| E2 | Play mode: start a local server, connect, path and navmesh-tile overlays | ✅ | |
| E3 | Art asset pipeline: pack models to GLB, previews | ✅ | |
| E4 | **Play-mode game view**: the world renderer embedded in play mode, with the editor's panels around it | ⏭️ | Prerequisite for E5; shares the client's renderer (a shared package, not a copy) |
| E5 | **Play-mode debugger**: dockable panels you move, resize, fade and hide; performance graphs (fps, frame time, draw calls and triangles over every pass, props by level of detail, GPU memory, network in/out, heap); wireframe and FX showcase toggles | 🚧 | Interim: in the developer client (`npm run dev`), not the player's. Moves into the editor with E4 |
| E6 | PICG slice 3: selection cards (an entity's components and graph parameters) | 📋 | [`PCG-SPEC.md`](PCG-SPEC.md) §6 |
| E7 | PICG slice 4: hierarchical graph editor | 📋 | [`PCG-SPEC.md`](PCG-SPEC.md) |
| E8 | D3: dungeon view: pool browser, 3D view, edits as patches | 📋 | [`DUNGEONS-AND-LOOT.md`](DUNGEONS-AND-LOOT.md) §3.5 |
| E9 | Editor at world scale: world map overview, streaming the area round the camera, regenerate one region | 📋 | [`OPEN-WORLD-PLAN.md`](OPEN-WORLD-PLAN.md) Phase 4 |
| E10 | Character record view (read-only) | ✅ | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6 |
| E11 | Rules editor: every `content/rules/*.json` tunable listed, edited as a tree, validated on save | ✅ | Loopback `/api/editor/rules` routes (whitelisted names, path-confined, write only when valid; strict across files); Rules tab with tree editor and per-path errors. Opened from opencode's work; no screenshot yet |

## 1b. Admin console: control the running game

The development client's (`npm run dev`) control over the live world, to
test every part of the engine: then with the rest of the developer tools
in the editor's play mode (E4). Every change goes through the server,
which accepts admin commands only from admin accounts or a development
server, and logs them. Source definitions (prefabs, species, rules files)
stay read-only here; this edits the running game.

| # | Item | Status | Needs |
|---|---|---|---|
| A1 | **Admin channel**: an admin command message, admin accounts (and every account on a development server), a command log | 🚧 | 0x10 `help`/`whoami` live; `MMO_ADMINS` + `MMO_DEV_SERVER=1`; A2+ adds world-editing commands |
| A2 | Inspect and edit any entity: pick or search it, every component and field, change any value | 🚧 | `inspect` + `set` live via the dev console (whitelisted numeric fields); click-to-pick UI awaits E4 overlays |
| A3 | Spawn anything at the cursor or the player: species, archetypes, props, PICG assets; despawn | 🚧 | `spawnlist`/`spawn` (table archetypes at avatar or x/z) + `despawn` (live avatars refused) live; creatures need a shared spawner; cursor targeting awaits E4 |
| A4 | The player: health, mana, stamina and any stat; teleport; fly and no-clip; invulnerable; time of day and weather | 🚧 | `teleport` (ground snap), `heal`, `fly` bit live; stats via `set`; god-mode needs damage (M2/M3), mana its spender, time/weather a runtime clock design |
| A5 | Loot and inventory: browse the loot pools, put items in the inventory, grant gold | 🚧 | `items` (browse the pool), `give` (into the bag), `drop` (on the ground), `loot` (mob drops round you) live; gold awaits a currency |
| A6 | Appearance and equipment editor, live on the character | 📋 | A1, M3 |

## 2. Game client: the player's interface

Everything here is React DOM over the world canvas, fed by the server
(the client holds no game logic). Docs:
[`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6,
[`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md).

| # | Item | Status | Needs |
|---|---|---|---|
| U1 | Login, character select and create (live 3D preview) | ✅ | |
| U2 | **Player frame**: health, mana and stamina bars | 🚧 | Health + stamina live (mirror rows; dodge/attack/jump/swim/run drain, cooldown regen); mana deferred to its first spender |
| U3 | Hunger and thirst meters | ✅ | Survival needs as rules on the server (new, alongside M1). Server side done (`needs.json`, `Needs` component, `NeedsSystem`). Wire and HUD meters deferred (no data on the wire yet; needs a flatc regen); meters aren't persisted; `restore()` waits for food and drink items |
| U4 | Settings: graphics quality, controls, audio, UI scale | 🚧 | Controls remappable (persisted, steal-on-conflict, mouse fixed) + UI scale 90–125% live; audio deferred to an audio engine |
| U5 | Nameplates (name, guild tag) | 📋 | C3 |
| U6 | Chat panel: channel tabs, `/w /p /g /y /e`, reply | 🚧 | Say/yell/emote tabs + history + send live (two-client verified); whispers (S2) and party (S3) commands live (`/w /p /invite /kick /promote /accept /leave`); guild commands live (S4); reply awaits |
| U7 | Party frames | ✅ | Member list (leader star, online dot, lead/kick for the leader), invite card with accept, leave. Per-member health and region are not on the wire yet, so rows show name and presence only (deferred with the party stats message) |
| U8 | Social window: friends, presence, blocks, guild roster | 🚧 | Friends frame live (presence dot, whisper, remove; `/friend` `/unfriend`); block list UI awaits; guild roster ships in the guild frame (S4) |
| U9 | Character sheet: attributes, stats, skills and their peaks, the body's injuries | 🚧 | Attributes + derived stats with modifier deltas live; skills await M1, injuries M2 |
| U10 | Inventory and equipment | 📋 | M3 (items), C1 crafting (built) |
| U11 | Quest log and tracker, dialog | 📋 | P1 |
| U12 | Injury display and hit feedback | 📋 | M2 |

## 3. Characters, combat and social

| # | Item | Status | Doc |
|---|---|---|---|
| C1 | Accounts and characters: name rules, create/list/load/save, per-account limits | 🚧 | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §8. Built on the region's SQLite store; moving them to the world server is open |
| C2 | Protocol v5 sign-in: account and character messages, select and create screens, entering the world | ✅ | 〃 |
| C3 | Identity on screen: `CharacterRef`, `Appearance`, names, nameplates | 🚧 | CharacterRef wired + `names` fan-out + sprite nameplates live; guild tags live (S4) |
| M0 | Rules loader (`packages/rules`, `content/rules`) | ✅ | [`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md) §7 |
| — | Stats as rules: attributes, derived stats, the moveSpeed drive, the stats message | ✅ | 〃 |
| M1 | Mastery core: use-based gain, deterioration, first skills (swimming, athletics, exposure) | ✅ | Swimming and Athletics train in `MasterySystem`; Exposure waits on weather; not on the wire yet |
| M1b | Skills saved with the character | ✅ | `character_skills` table in the character store; the gateway saves a character's `SkillSheet` with its state and restores it on entering the world, applying deterioration for the time away |
| M2 | Body parts, injuries, healing, death and respawn | 📋 | 〃 |
| M3 | Items and melee: combat phases, fit and power, defence, dismemberment | 🚧 | Attack combos, guard and dodge exist (`CombatSystem`); combat skills (M3c) feed damage and train from landed hits, blocks and dodges; the rest is open |
| M4 | Disciplines, familiarity, disarms, Medicine | 📋 | 〃 |
| S1 | Say, yell, emote; rate limits; text filter hook | ✅ | Server slice live (0x11, range + cooldowns + filter hook); client panel is U6 |
| S2 | Region↔world event stream, presence, whispers, friends, blocks | 🚧 | Whispers, blocks and friends with presence live (in memory; friends reset on restart, persistence and the world-server event stream deferred) |
| S3 | Parties | ✅ | 〃 |
| S4 | Guilds | ✅ | `GuildBook` (500 members, ranks leader/officer/member/recruit, officer invites, MOTD, 200-entry officer log, 60 s invites), guild chat, `GuildState` pushes, tags on the names rows, guild frame + `/g /gcreate /ginvite /gkick /grank /gmotd /gaccept /gleave`. Persisted by `SqliteGuildStore` (`guilds.db`: guilds, members, 200-line log per guild); `purge` awaits a character-delete path |
| P1 | Progression graphs: quests and dialog | 📋 | [`DUNGEONS-AND-LOOT.md`](DUNGEONS-AND-LOOT.md) §9 |

## 4. World, content and generation

| # | Item | Status | Doc |
|---|---|---|---|
| — | World bake (4 × 4 km, climate-driven survey, glaciers, volcano) | ✅ | [`OPEN-WORLD-PLAN.md`](OPEN-WORLD-PLAN.md) Phase 1 |
| — | Server streaming of chunks round players | ✅ | 〃 Phase 2 |
| — | Client terrain: streamed chunks near, the coarse map to the horizon, water, sky, weather | ✅ | 〃 Phase 3, [`CLIENT-FX.md`](CLIENT-FX.md) |
| — | Client terrain LOD rings and fewer terrain draw calls | 📋 | 〃 Phase 3 |
| — | Biome registry: scatter sets and creature tables per biome | 📋 | 〃 Phase 5 |
| W1 | WFC solver (`packages/wfc`) | ✅ | [`DUNGEONS-AND-LOOT.md`](DUNGEONS-AND-LOOT.md) §9 |
| W2 | Formations: WFC decides what, scatter and the raymarcher decide where | ✅ | 〃 |
| D1 | Dungeon layouts, `dungeon:bake` | ✅ | 〃 |
| D2 | Dungeon dressing: archetypes, interiors, resource veins | ✅ | 〃 |
| S1 (species) | Species ecology and spawn tables | ✅ | 〃 |
| R1 | Rank ladder and the entity composer | ✅ | 〃 |
| R2 | Prefab builder | ✅ | 〃 |
| L1 | Loot pool bake | ✅ | 〃 |
| C1 (crafting) | Materials, recipes, tradability | ✅ | 〃 |
| D4 | Dungeon instances: a sandbox engine instance per run, started from a prebaked dungeon (layout plus its shell as one mesh buffer); players moved out of the world into it; results reported instance → region → world server | 📋 | 〃 §3.4. Shells are prebaked (`dungeon:bake`, `<id>.shell.pcgm`) ✅ |
| PCG1 | PICG native cook addon | ✅ | [`PCG-SPEC.md`](PCG-SPEC.md) |
| PCG2 | Asset library, server cook, client meshes | ✅ | 〃 |

## 5. Engine, physics and native libraries

| # | Item | Status | PR |
|---|---|---|---|
| — | Jolt physics; automatic colliders for every entity | ✅ | #38 |
| — | uWebSockets.js transport (ws as fallback) | ✅ | #39 |
| — | DetourCrowd steering | ✅ | #40 |
| — | DetourTileCache: static bodies cut the navmesh | ✅ | #42 |
| — | meshoptimizer: optimised cooked meshes, LOD chains for every prop | ✅ | #43 |
| — | Performance instrumentation: frame, renderer, GPU memory and network counters | ✅ | Feeds E5 |
| — | manifold + Clipper2 (`addon-geometry`): cell outlines, polygon Booleans, CSG solids; prebaked dungeon shells | ✅ | |
| — | Valgrind: memcheck gate for every addon's tests; callgrind instruction-count baselines for headless workloads (`npm run valgrind:memcheck`, `valgrind:perf`) | ✅ | Found and fixed a tile-bake leak and a Recast tile-cache overflow |
| — | Valgrind Helgrind on the addons' threaded paths (Jolt jobs, PICG cooks off the tick thread) | 📋 | Suggested in [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) |
| — | Ragdolls, and Jolt CharacterVirtual (characters blocked by props) | 📋 | |

## 5b. Edge / core split

Doc: [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md). Its E1–E6 are the
split's slices, not the editor's E items.

| # | Item | Status | Notes |
|---|---|---|---|
| E1 | Edge skeleton + generic packet router (`apps/edge`, `content/edge/routes.json`) | 🚧 | Core channel stubbed until E2: core-bound packets answer `core.unavailable` |

## 6. World server

Doc: [`WORLD-SERVER-SPEC.md`](WORLD-SERVER-SPEC.md) §12

| # | Item | Status |
|---|---|---|
| A | Core and registry: `WorldCore`, SurrealDB schema, webrpc, region auth, heartbeats | ✅ |
| B | Region migration (border hand-off) | 📋 |
| C | Accounts on the world server | 📋 (folded into C1 above) |
| D | Stress harness and the published number | 📋 |

## 7. Alpha

Doc: [`ALPHA-PLAN.md`](ALPHA-PLAN.md): what alpha means, its exit
criteria, and its decisions (D1 to D3 decided; D4 to D8 proposed defaults).

| # | Item | Status | Needs |
|---|---|---|---|
| M3a | Item instances: definitions from the loot pool, a runtime store, ground items, admin `give`/`drop` | ✅ | Pickup (E), bag (B), rank-coloured labels and beams; bags in memory until P2a |
| M3b | Held weapons: `Held` on the wire, weapon on the hand bone, starter sword | ✅ | Held models ride the appearance JSON; equip/unequip on 0x13; starter sword once per character per run |
| M2a | Damage: strike resolution at the hit frame, `computeDamage`, guard and dodge, hit events | ✅ | M3b |
| M2b | Death and respawn, corpses, deaths recorded | ✅ | M2a — `DeathSystem`, 0x17 `life`, `deaths` table; `nearestVisited` falls back to the spawn point |
| AI1 | Creature spawner and brain: goblins with weapons, aggro, chase, attack, leash | ✅ | M2a |
| L2 | Drops and pickup: seeded `mob` rolls at the corpse, validated pickup, despawn timeout | ✅ | M2b, AI1 |
| U10a | Inventory and equipment, first cut | ✅ | Bag grid, item details, drop (M3a); equip and unequip (M3b); drag to equip and unequip, comparison tooltip, held stat totals |
| U12a | Hit feedback and target frame | ✅ | M2a |
| ED1 | Gameplay tables in the editor: items, creatures, loot and death rules, validated, hot-reloaded | ✅ | M3a; each α1 slice adds its table. Restart-only: bag slots, stats, a spawned creature's health and weapon, a dropped item's model |
| P2a | Item ledger: append-only, valid and transaction time, tombstones | ✅ | Bags, hands and ground items survive restarts; owners are entity ids, so P2b maps them to saved characters |
| P2b | Character save: position, health, inventory, equipment | ✅ | Position, health and stamina saved on the 1 s timer, on leaving and on shutdown, restored on entering; bags and hands already persist via P2a |
| P2c | Crash and replay tests over the ledger | ✅ | A crash loses only unflushed events, a failed flush writes nothing, restarts keep ids climbing, full history replays to the latest state |
| L3 | Pool rebake keeps held items | 📋 | P2a |
| T1 | Ingress hardening: frame cap, rate limits, validation tests | ✅ | 64 KiB frame cap, token-bucket intent and pickup limits, abuse disconnect; tunables in content/rules/ingress.json and the editor |
| T2 | Play telemetry into the editor's graphs (server counters + `stats` admin command done; editor graphs wait on E5) | 🚧 | α1 |

---

## Update log

- **2026-10-03**: Edge/core split E1 edge skeleton: new `apps/edge` process (Express `GET /health`, client WebSocket) routes packets by type from strictly validated `content/edge/routes.json` to local modules (`ping`) or the core; the core channel is a stub until E2, so core-bound packets answer `core.unavailable` (the contract E4 reuses). Graceful SIGTERM/SIGINT. Valgrind not run (skipped at the user's request).
- **2026-10-03**: Valgrind repaired: the container run (`docker-run.sh`) rebuilt every addon from scratch on every run, silently (Jolt takes minutes), so `npm run valgrind:*` looked hung, and two runs at once corrupted the shared volume. Addons now rebuild only when their sources change (hash in the volume), runs are serialised with `flock`, progress is printed and a failed addon build shows its log. Verified: `valgrind:memcheck -- physics` clean in 16 s, `valgrind:perf` all 8 workloads in 84 s (container Node is v25; the baseline is from v22, so deltas are indicative only). Valgrind/perf are no longer paused.
- **2026-10-03**: M3c combat skills: the attacker's weapon skill (Cutting/Thrusting/Bludgeoning, via the technique's skill in `combat.json`) feeds `computeDamage`; a landed hit trains it, a block trains Blocking and a dodge trains Evading (difficulty 0.5, keyed on the opponent). Server wires `CombatSkills` to the mastery sheets; no skills means the old behaviour. Valgrind/perf paused.
- **2026-10-03**: E11 rules editor: a Rules tab in the editor lists every `content/rules/*.json`, edits it as a tree and validates on save with the `@mmo-engine/rules` schemas and cross-file checks; invalid saves write nothing and show per-path errors. Save is strict (any invalid rules file blocks). Perf and valgrind runs paused.
- **2026-10-03**: T1 ingress hardening: 64 KiB frame cap, per-session token buckets for intents (40/s, burst 60) and pickups (5/s, burst 10), drops counted, 100 violations in 10 s disconnects. Numbers in `content/rules/ingress.json`, editable in the editor's rules tab. Built by opencode, reviewed by Claude. Live reload of limits not wired (`Gateway.updateIngress` is ready).
- **2026-10-02**: M2a damage (in progress): attack moves strike once on their `hitAt` tick; living targets with Health in reach and the 120° cone take `computeDamage` for the held weapon (fists when empty), whole-body (D1). A facing guard takes 0.25, a roll in its i-frames none. Health clamps at 0 (death is M2b). Protocol v12: 0x16 `hit`.
Newest first. One line per merged PR or decision.

- **2026-10-02**: ED1 gameplay tables: the editor's Gameplay Tables tab edits item bases, creatures, loot and death rules, validates through the host (`/api/editor/rules`) and saves to `content/rules`; a refused save lists its issues and writes nothing. A running server's `RulesReloader` watches the folder and swaps the tables on its next tick (`HooksDelegate`, `CreatureSystem.setRules`, `ItemService.setLoot`, `ItemDefs.applyRules`); a bad file is refused and the running rules stay.
- **2026-10-02**: U10a bag panel: drag a bag item onto its hand slot to equip it (the slot lights only for the right hand), drag a held item onto the bag to put it away, double-click equips. Hovering an item shows a tooltip beside the bag with its stats and the signed change against what it would replace, by the server's swap rules (`displaced`). The held items' stat totals sit under the hands. Drops send the same 0x13 equip/unequip, so the server still decides.
- **2026-10-02**: U12a hit feedback: struck entities flash red for 0.15 s (hits and blocks; dodges don't), a top-centre target frame shows the target's name and health from `hit` messages (you target what you strike, or your attacker when nothing is targeted; left click selects the hovered entity; cleared when it despawns), creatures get nameplates via the names message, and the player frame's health updates on each hit.
- **2026-10-02**: L2 creature drops: a creature's death rolls its `drops` (`rolls` range, `chance` per roll; defaults 1-2 at 0.8) from the `mob` pool with a seeded rng, scattering items within 1.2 m of the corpse owned by the killer for the ownership window. Pickup, ownership and despawn are M3a's. `DeathSystem` gained an `onDeath` hook. Editor tables come with ED1.
- **2026-10-03**: E10 character record view (read-only): `readCharacterView`/`listCharacters` over the character and item stores, a Characters panel in the editor (look, saved state, deaths, items). Built by opencode, reviewed. Perf not run (paused).
- **2026-10-03**: S4 guilds: `GuildBook` with injected clock and write-through `GuildStore` (in-memory default; SQLite store and `purge` caller deferred). Ranks and rules enforced server-side, guild chat channel, `GuildState` to members on change, tag on the names fan-out (`Name <TAG>`), `GuildFrame` and guild chat commands in the client. Protocol 15; ops ride 0x11 (`kind:"guild"`). Perf and valgrind not run (paused).
- **2026-10-03**: S4b guild persistence: `SqliteGuildStore` (`guilds.db`, WAL, FK cascades, log trimmed to 200 per guild) behind `GatewayOptions.guildStore`; the server wires it, tests default to memory. Guilds now survive restarts. Perf and valgrind not run (paused).
- **2026-10-03**: S3 parties: `PartyBook` (up to 6, leader invites/kicks/promotes, 60 s invites, 5 min offline removal with leadership to the longest-standing, disband at one), party chat channel, `PartyState` pushed to affected members on every change (in memory; a restart disbands). Protocol 14. Ops ride the 0x11 envelope (`kind:"party"`) because 0x0f is Stats here. Out-of-view frame data (U7) next.
- **2026-10-03**: U7 party frames: `PartyFrame` over the world canvas shows the party (leader star, online dot, lead/kick for the leader, leave) and a pending invite with accept; chat commands `/invite /kick /promote /accept /leave /p /w` parse client-side. The server lapses invites after 60 s without telling the invitee, so the client hides the card itself after 60 s. Per-member health and region need a wire change (deferred). Perf not run (paused).
- **2026-10-03**: T2 play telemetry (server): `PlayTelemetry` keeps kills, deaths, pickups, drops and player damage dealt/taken in 10 s buckets (60-bucket ring, preallocated, no tick allocation) plus a tick-time histogram (p50/p99/max). Admin `stats` returns the JSON for the editor graphs (E5).
- **2026-10-03**: S2 whispers and blocks (in-memory): whisper by character name on 0x11 (`to`), echoed to the sender; unknown, offline, self or blocking targets all answer the same system "not online". Per-account silent blocks (200 limit, `block` message) hide say/yell/whispers from the blocker. Friends, presence, reply and the world-server event stream are deferred.
- **2026-10-03**: S2b friends and presence (in-memory): `/friend name` and `/unfriend name` (100 limit, online characters only, uniform "not online" reply); the server pushes the `friends` list on login and on every friend login/logout; a friend who blocks you shows offline. Protocol v16. `FriendsFrame` in the client. Friend persistence deferred. Perf and valgrind runs paused.
- **2026-10-03**: M1 mastery core: `SkillSheet` (gain by challenge, slowdown at the top, repeat falloff, related skills, decay with relearn bonus, save/load) and a `MasterySystem` training Swimming and Athletics every 5 s of effort (proposed defaults). Exposure (no weather yet), familiarity, persistence and the wire/character sheet (U9, flatc) deferred. E11 rules editor panel added to the list (editor parity).
- **2026-10-03**: M1b skill persistence: skills saved with the character (`character_skills`) and restored on enter-world with deterioration applied; `MasterySystem` shared between gateway and tick list.
- **2026-10-03**: L3 pool rebake keeps held items: `npm run loot:rebake -w @mmo-engine/engine-core -- --db <world.db> --pool <pool.jsonl>` bakes a new pool that keeps every bag and hand item (via the bake's `held`) and appends ledger rows pointing each live item at its new def; unheld ground items whose entry is gone are tombstoned.
- **2026-10-03**: P2c crash and replay tests over the item ledger (unflushed loss, atomic failed flush, hot-WAL recovery, restart cycles, history replay).
- **2026-10-03**: U3 hunger and thirst: `content/rules/needs.json` (max, drain per minute, damage per second at zero, exertion factor), a `Needs` component (id 14) and a `NeedsSystem` after stamina. Meters drain by the minute, faster while running or swimming, and hurt Health once empty. Wire/HUD meters deferred, not persisted.
- **2026-10-03**: P2b character save: `character_state` in characters.db (position, health, stamina), saved on the save timer, eviction, grace expiry and shutdown, restored on enter world; dead or never-saved characters get the ordinary spawn.
- **2026-10-03**: P2a item ledger: every item change (create, ground, bag, hold, destroy tombstone) appends to `item_events` in world.db with its tick (valid time) and write time (transaction time); flushed on the save timer, restored at boot (ids never reused, ground items get fresh despawn timers). Perf not run (paused).
- **2026-10-02**: AI1 creatures: `content/rules/creatures.json` (goblin: 60 health, aggro 12 m, leash 30 m, packs of 2-4, dagger/axe/mace, 60 s respawn) drives `CreatureSystem`, a bot-shaped entity whose brain idles, aggros the nearest living character, chases (crowd-steered when navmesh is up), swings through `PlayerIntent`, and leashes home healing. `DeathSystem` takes a per-creature delay and a `place` hook; admin `spawn goblin` drops a pack. Editor tables for the numbers come with ED1.
- **2026-10-02**: M2b death and respawn: `DeathSystem` (after combat) ends a body's move and walk at 0 Health, asks the rules' `onDeath` for the delay (10 s), and on that tick restores full Health, clears held buttons and puts players at the spawn point (bots rise in place; `nearestVisited` has no visited-anchor tracking yet, so it falls back to the spawn point). The dead neither fight nor are struck. Characters get a `deaths` row when the rules ask. Protocol v13: 0x17 `life`.
- **2026-10-02**: M3b held weapons: the avatar's appearance JSON carries `Held` models (`withHeld`), the gateway refreshes it on equip and unequip, and the client parents the weapon to `Hand_R`/`Hand_L`. Entering the world outfits the lowest-ranked starter sword once per character per run. Bag shows the two hand slots with equip and unequip buttons. Protocol: 0x13 `equip`/`unequip`, 0x14 `main?`/`off?`.
- **2026-10-01**: M3a items: definitions from the loot pool with each
  base's physics (`content/rules/items.json`), ground items you pick up
  with E (owned 30 s, gone after 5 min, `loot.json`), a bag (B), and
  admin `items`/`give`/`drop`/`loot`. Protocol v11 (0x13–0x15). Typing
  in a text field no longer moves the character.
- **2026-10-01**: Valgrind: `npm run valgrind:memcheck` (every addon's
  tests under memcheck; our code's errors and leaks fail it) and
  `npm run valgrind:perf` (callgrind instructions per operation for eight
  headless workloads, against a committed baseline). Its first run fixed
  two navigation bugs: a detail-mesh leak on every tile bake, and a heap
  overflow in Recast's tile-cache region builder.
- **2026-10-01**: Fix: the client's panels (player frame, chat, sheet,
  settings) were see-through. Their `bg-card/90`-style classes generated
  nothing; the theme colours now live in the Tailwind config.
- **2026-10-01**: Fix: `addon-geometry` failed to compile under MSVC
  (C2666 on a `Uint8Array` index), so the geometry and dungeon suites
  failed on Windows. The mask is now read through a raw byte pointer.
- **2026-10-01**: Fix: admin commands (0x10) fell through into the chat
  handler and drew a stray "malformed chat" 4003 after every result.
  Every workspace now compiles with `noFallthroughCasesInSwitch`.

- **2026-10-01**: Alpha plan ([`ALPHA-PLAN.md`](ALPHA-PLAN.md)):
  three milestones (first fight, keep it, hold it) and section 7 here.
  Decided: whole-body damage, loot owned 30 s then free, despawn 5 min,
  key-press pickup, every tunable editable in the editor (ED1).

- **2026-10-01**: Edge / core split build plan saved as
  [`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md) (recovered from a local
  stash). Not scheduled; its slices E1–E6 are not the editor's E items.

- **2026-09-30**: U9 character sheet: attributes + derived stats with
  modifier deltas from the stats message, toggleable panel. Skills
  await M1, injuries M2.

- **2026-09-30**: U6 chat panel: say/yell/emote tabs, 50-line history,
  send-on-Enter over MirrorClient.chat()/onChat; verified with two live
  clients. Whispers/party/guild/reply await S2–S4.


- **2026-09-30**: A4 first slice: `teleport` (ground snap, stilled
  velocity), `heal` (fill from max), `fly` (ability bit) admin commands.
  God/time/weather need damage, a spender, and a clock design.

- **2026-09-30**: A3 props spawn: `spawnlist`/`spawn` (forest-table
  archetypes via spawnScatterEntity, at avatar or x/z with ground
  height) + `despawn` (refuses live session avatars). Creatures need a
  shared spawner with bots; cursor targeting awaits E4.

- **2026-09-30**: A2 write path: `set` admin command (whitelisted numeric
  fields, integer stores reject fractions) sharing one entity resolver
  with `inspect`; console takes JSON or quoteless `{k:v}` args (pure
  parser, tested).

- **2026-09-30**: A2 read path: `inspect` admin command (entity u64 or
  "me") dumping every component + stats sheet, shown in the dev
  console. Write path (field edits) is the next slice.

- **2026-09-30**: A1 admin channel: 0x10 `help`/`whoami` over the control
  plane (protocol v8), adminhood from `MMO_ADMINS` or `MMO_DEV_SERVER=1`
  decided once at join, ring-buffer command log + console lines, dev
  tools console in the client. A2+ adds world-editing commands.
- **2026-09-30**: U4 controls + UI scale: remappable keyboard bindings
  (bindings.ts, persisted, live-swapped into InputState) and 90–125%
  interface scale in the settings menu; dev controls help reads the
  same data. Audio deferred to an audio engine.
- **2026-09-30**: U2 stamina: `Stamina` wire component (additive `.fbs` +
  codegen), `maxStamina` drive + `staminaRegen` stat, `StaminaSystem`
  (dodge/attack/jump/swim/run drains, cooldown regen, combat gating),
  live bar in `PlayerFrame`. Mana deferred to its first spender.

- **2026-09-30**: U2 player frame (health): `PlayerFrame` over the world
  canvas, fed by the mirror's Health rows at 1 Hz; stamina/mana await
  their pools (M1).
- **2026-09-30**: S1 region chat: 0x11 say/yell/emote (protocol v8 —
  second merger with the admin branch bumps to v9), 30 m say/emote
  range, per-channel cooldowns, TextFilter hook, full e2e coverage.
  Client panel stays U6.
- **2026-09-30**: C3 identity: CharacterRef wire block (id 12 — second
  merger with the stamina branch renumbers), `names` fan-out before
  first-showing state, cached-sprite nameplates with distance fade.
  Guild tags await S4.

- **2026-09-30**: manifold + Clipper2 (`addon-geometry`) and prebaked
  dungeon shells. Added the admin console (A1–A6) and the dungeon instance
  model (D4).
- **2026-09-30**: `npm run dev` (the server and the developer client)
  and `npm run client` (the player's client) split (E0). The developer
  client gets performance graphs in movable, resizable, fadeable panels
  (E5, interim until E4); the player's client gets a settings menu (U4).

- **2026-09-30**: Roadmap published. Decided: the client shows only the
  player's interface; all developer tooling, the debugger included,
  lives in the editor's play mode (E4, E5). Added the player interface
  items (U1–U12), and separate `npm run client` / `npm run dev` commands
  (E0).
- **2026-09-30**: meshoptimizer merged (#43): optimised meshes and LOD
  chains for every prop.
- **2026-09-30**: DetourTileCache merged (#42): static bodies cut the
  navmesh.
- **2026-09-29**: DetourCrowd (#40) and uWebSockets.js (#39) merged.
