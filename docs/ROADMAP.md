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
| E10 | Character record view (read-only) | 📋 | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6 |

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
| U3 | Hunger and thirst meters | 📋 | Survival needs as rules on the server (new, alongside M1) |
| U4 | Settings: graphics quality, controls, audio, UI scale | 🚧 | Controls remappable (persisted, steal-on-conflict, mouse fixed) + UI scale 90–125% live; audio deferred to an audio engine |
| U5 | Nameplates (name, guild tag) | 📋 | C3 |
| U6 | Chat panel: channel tabs, `/w /p /g /y /e`, reply | 🚧 | Say/yell/emote tabs + history + send live (two-client verified); whispers/party/guild/reply await S2–S4 |
| U7 | Party frames | 📋 | S3 |
| U8 | Social window: friends, presence, blocks, guild roster | 📋 | S2, S4 |
| U9 | Character sheet: attributes, stats, skills and their peaks, the body's injuries | 🚧 | Attributes + derived stats with modifier deltas live; skills await M1, injuries M2 |
| U10 | Inventory and equipment | 📋 | M3 (items), C1 crafting (built) |
| U11 | Quest log and tracker, dialog | 📋 | P1 |
| U12 | Injury display and hit feedback | 📋 | M2 |

## 3. Characters, combat and social

| # | Item | Status | Doc |
|---|---|---|---|
| C1 | Accounts and characters: name rules, create/list/load/save, per-account limits | 🚧 | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §8. Built on the region's SQLite store; moving them to the world server is open |
| C2 | Protocol v5 sign-in: account and character messages, select and create screens, entering the world | ✅ | 〃 |
| C3 | Identity on screen: `CharacterRef`, `Appearance`, names, nameplates | 🚧 | CharacterRef wired + `names` fan-out + sprite nameplates live; guild tags await S4 |
| M0 | Rules loader (`packages/rules`, `content/rules`) | ✅ | [`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md) §7 |
| — | Stats as rules: attributes, derived stats, the moveSpeed drive, the stats message | ✅ | 〃 |
| M1 | Mastery core: use-based gain, deterioration, first skills (swimming, athletics, exposure) | 📋 | 〃 |
| M2 | Body parts, injuries, healing, death and respawn | 📋 | 〃 |
| M3 | Items and melee: combat phases, fit and power, defence, dismemberment | 🚧 | Attack combos, guard and dodge exist (`CombatSystem`); the rest is open |
| M4 | Disciplines, familiarity, disarms, Medicine | 📋 | 〃 |
| S1 | Say, yell, emote; rate limits; text filter hook | ✅ | Server slice live (0x11, range + cooldowns + filter hook); client panel is U6 |
| S2 | Region↔world event stream, presence, whispers, friends, blocks | 📋 | 〃 |
| S3 | Parties | 📋 | 〃 |
| S4 | Guilds | 📋 | 〃 |
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
| AI1 | Creature spawner and brain: goblins with weapons, aggro, chase, attack, leash | 📋 | M2a |
| L2 | Drops and pickup: seeded `mob` rolls at the corpse, validated pickup, despawn timeout | 📋 | M2b, AI1 |
| U10a | Inventory and equipment, first cut | 🚧 | Bag grid, item details, drop live (M3a); equip and unequip live (M3b); stats and tooltips later |
| U12a | Hit feedback and target frame | 📋 | M2a |
| ED1 | Gameplay tables in the editor: items, creatures, loot and death rules, validated, hot-reloaded | 📋 | M3a; each α1 slice adds its table |
| P2a | Item ledger: append-only, valid and transaction time, tombstones | 📋 | M3a, L2 |
| P2b | Character save: position, health, inventory, equipment | 📋 | P2a |
| P2c | Crash and replay tests over the ledger | 📋 | P2b |
| L3 | Pool rebake keeps held items | 📋 | P2a |
| T1 | Ingress hardening: frame cap, rate limits, validation tests | 📋 | |
| T2 | Play telemetry into the editor's graphs | 📋 | α1 |

---

## Update log

- **2026-10-02**: M2a damage (in progress): attack moves strike once on their `hitAt` tick; living targets with Health in reach and the 120° cone take `computeDamage` for the held weapon (fists when empty), whole-body (D1). A facing guard takes 0.25, a roll in its i-frames none. Health clamps at 0 (death is M2b). Protocol v12: 0x16 `hit`.
Newest first. One line per merged PR or decision.

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
