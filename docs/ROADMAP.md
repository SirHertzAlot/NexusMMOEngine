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

## 2. Game client: the player's interface

Everything here is React DOM over the world canvas, fed by the server
(the client holds no game logic). Docs:
[`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §6,
[`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md).

| # | Item | Status | Needs |
|---|---|---|---|
| U1 | Login, character select and create (live 3D preview) | ✅ | |
| U2 | **Player frame**: health, mana and stamina bars | ⏭️ | The stats message (built); stamina and mana drives in the rules |
| U3 | Hunger and thirst meters | 📋 | Survival needs as rules on the server (new, alongside M1) |
| U4 | Settings: graphics quality, controls, audio, UI scale | 🚧 | The menu exists with graphics quality and leaving the world; the rest is open |
| U5 | Nameplates (name, guild tag) | 📋 | C3 |
| U6 | Chat panel: channel tabs, `/w /p /g /y /e`, reply | 📋 | S1 |
| U7 | Party frames | 📋 | S3 |
| U8 | Social window: friends, presence, blocks, guild roster | 📋 | S2, S4 |
| U9 | Character sheet: attributes, stats, skills and their peaks, the body's injuries | 📋 | M1, M2 |
| U10 | Inventory and equipment | 📋 | M3 (items), C1 crafting (built) |
| U11 | Quest log and tracker, dialog | 📋 | P1 |
| U12 | Injury display and hit feedback | 📋 | M2 |

## 3. Characters, combat and social

| # | Item | Status | Doc |
|---|---|---|---|
| C1 | Accounts and characters: name rules, create/list/load/save, per-account limits | 🚧 | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §8. Built on the region's SQLite store; moving them to the world server is open |
| C2 | Protocol v5 sign-in: account and character messages, select and create screens, entering the world | ✅ | 〃 |
| C3 | Identity on screen: `CharacterRef`, `Appearance`, names, nameplates | 📋 | 〃 |
| M0 | Rules loader (`packages/rules`, `content/rules`) | ✅ | [`MASTERY-AND-COMBAT.md`](MASTERY-AND-COMBAT.md) §7 |
| — | Stats as rules: attributes, derived stats, the moveSpeed drive, the stats message | ✅ | 〃 |
| M1 | Mastery core: use-based gain, deterioration, first skills (swimming, athletics, exposure) | 📋 | 〃 |
| M2 | Body parts, injuries, healing, death and respawn | 📋 | 〃 |
| M3 | Items and melee: combat phases, fit and power, defence, dismemberment | 🚧 | Attack combos, guard and dodge exist (`CombatSystem`); the rest is open |
| M4 | Disciplines, familiarity, disarms, Medicine | 📋 | 〃 |
| S1 | Say, yell, emote; rate limits; text filter hook | 📋 | [`CHARACTERS-AND-SOCIAL.md`](CHARACTERS-AND-SOCIAL.md) §8 |
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
| D4 | Dungeon instances | 📋 | 〃 §3.4 |
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
| — | manifold + Clipper2: mesh and polygon booleans for dungeon and PICG geometry | ⏭️ | |
| — | Ragdolls, and Jolt CharacterVirtual (characters blocked by props) | 📋 | |

## 6. World server

Doc: [`WORLD-SERVER-SPEC.md`](WORLD-SERVER-SPEC.md) §12

| # | Item | Status |
|---|---|---|
| A | Core and registry: `WorldCore`, SurrealDB schema, webrpc, region auth, heartbeats | ✅ |
| B | Region migration (border hand-off) | 📋 |
| C | Accounts on the world server | 📋 (folded into C1 above) |
| D | Stress harness and the published number | 📋 |

---

## Update log

Newest first. One line per merged PR or decision.

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
