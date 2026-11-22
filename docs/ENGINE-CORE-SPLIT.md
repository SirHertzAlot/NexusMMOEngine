# Engine core / game IP split

Where the line between **the engine** (what any team can build a game
with) and **our game** (our world, lore, content and design) runs today,
where it should run for alpha, and how to get from one to the other
without a stop-the-world refactor.

> **Status: design, for review.** Nothing in this document has been
> implemented. It is the analysis and the plan; each stage below becomes
> its own PR and its own roadmap row. Every claim about the code is cited
> by file and line against `main` at `d9fe367` (2026-11-21), and says
> whether it was verified by reading the code or by running it.

## 0. The short version

The engine is in better shape than the question implies. A content-pack
split already landed (see [§1](#1-what-already-landed)): `content/` is
documented as the sample game pack, 13+ `MMO_*` seams point the engine at
another pack, and the package graph is cleanly layered — 43 workspaces,
and **nothing depends on `engine-core` except `bench` and `playtest`**.
Procgen, physics, navigation, WFC, synthesis, settlement, dungeon,
placement and the perf work are all general-purpose and stay put.

Four things are missing, and they are what stops a second team shipping a
game without editing our source:

1. **No code seam, only a data seam.** A game can swap *content*. It
   cannot add *code* without reaching into engine internals: every module
   today imports engine internals by deep relative path into `dist/`
   (`modules/combat/server.js:17` →
   `../../packages/engine-core/dist/src/combat.js`), and `server.ts`
   hand-wires 19 modules back out by hardcoded name.
2. **No project manifest.** A "game" is currently 30-odd environment
   variables plus a repo layout. There is no single file that says "this
   is a game, here is its content, its modules, its rules".
3. **Design baked into the core.** The engine hard-requires seven named
   skill and technique ids, and one engine schema names our bestiary in a
   `strictObject`, so a game without goblins cannot author a valid
   wildlife table.
4. **Nothing is publishable.** No package has an `exports` map, and five
   are missing `private: true` so they would publish by accident. There
   is also no `LICENSE` file, which is **deliberately on hold** — see
   [§5](#5-the-licence-is-deferred-on-purpose).

The proposal is three tiers — **core / kits / game** — reached in nine
stages, the first four of which are additive and break nothing. Per the
decision on this PR, the engine keeps a playable starting point, but as a
**set of swappable starter kits** a developer forks and edits, not one
blessed template: the brief is the fastest *and* most flexible route to
someone else's game, including a game that replaces our kits entirely.

## 1. What already landed

`docs/engine-game-split/README.md` records an earlier pass (branch
`arlo/engine-game-split`, merged). Verified still true on `main`:

| Claim | Verified |
|---|---|
| `content/` is documented as the sample game pack with an `MMO_*` seam table | `content/README.md:6,25-36` — 13 seams tabled |
| A skill contract fails the boot by name instead of degrading | `packages/engine-core/src/rules/skill-contract.ts` — `ENGINE_REQUIRED_SKILLS`, called at `server.ts:367` |
| The engine boots content-free | Claimed in that README, **not re-verified here** (needs a full install and native build; see [§5](#5-what-is-not-verified)) |

So this document is a *second* pass, and a deeper one: the first moved
**data** out of engine code, this one moves **code** out of the engine's
hand-wiring and gives the result a publishable shape.

## 2. Part 1 — Inventory, classified

Three classes:

- **Core** — general-purpose, no game design in it. Ships in the engine.
- **SDK** — the surface a game is *meant* to touch: schemas, loaders,
  hooks, registries, manifests, tools.
- **Kit** — opinionated but swappable gameplay design: our combat model,
  our quest shape, our rank ladder. Engine-authored, game-replaceable.
- **IP** — our world: named places, lore, our bestiary, our HUD.

LOC counts are non-test source, counted 2026-11-21.

### 2.1 Core — general purpose, stays in the engine

| Package | LOC | Why it is core |
|---|---|---|
| `addons/physics` (Jolt) | 4,246 | Rigid bodies, characters, ragdolls. No game design |
| `addons/navigation` (Recast) | 1,899 | Navmesh bake + bulk SoA pathfinding |
| `addons/procgen`, `addons/terrain-kernel` | 1,413 | FastNoise2 chunks; tectonics + erosion |
| `addons/geometry` (manifold, Clipper2) | 659 | Mesh and polygon Booleans |
| `addons/scatter`, `addons/picg`, `addons/fanout`, `addons/codec` | 2,806 | Cooked scatter, PCG meshing, per-tick fan-out, delta codec |
| `addons/perf-probe`, `addons/template`, `addons/integrate` | 1,184 | Callgrind marks, toolchain probes, benchmark harness |
| `wfc` | 2,497 | WFC over any graph. Explicitly generic |
| `placement` | 1,669 | SDFs, raymarcher, Poisson-disc, surface placement |
| `scatter` | 1,728 | `.pcg.json` authoring + cooker |
| `synthesis` | 14,653 | Continuous model synthesis, inverse procedural modelling |
| `settlement` | 11,239 | Demographics → districts → parcels → WFC structures |
| `dungeon` | 7,016 | Dungeon Forge port (MIT). Themes are data (`themes.ts:9`) |
| `fortify` | 2,064 | Threat → counter loop over a baked settlement |
| `picg` | 1,242 | PCG graph host library |
| `logging` | 2,686 | Lockless SAB rings + log worker |
| `nethealth` | 347 | Counters, gauges, Prometheus exposition |
| `channel` | 1,031 | Edge↔core framed TCP |
| `protocol` | 6,602 | Wire envelope + message catalog |
| `schema` | — | `mmo_engine.fbs`, generated bindings gitignored |
| `mirror` | 3,085 | Shared browser/Node protocol driver |
| `graphify` | 3,666 | ECS graph harvester |
| `build`, `playtest`, `bench` | 1,706 | Build profiles, headless playtests, tick benchmarks |
| `render-fx` | 700 | VFX schema + GLSL primitives, framework-free |
| `animal-rig` | 1,977 | Procedural skeletons and gaits from a mesh |
| `world-server` | 11,365 | Region registry, leases, migration, SurrealDB system of record |

**Core inside `engine-core`** (69,965 LOC total in `src/`), all
general-purpose: `net/` (9,743), `terrain/` (5,822), `world/` (4,125),
`pools/` (3,323), `procgen/` (3,054), `persist/` (2,979), `navigation/`
(1,452), `streaming/` (452), `auth/` (811), `characters/` (611), plus the
tick loop, ECS world, SAB store and lockless ring.

### 2.2 SDK — the surface a game is meant to touch

| Surface | Where | State |
|---|---|---|
| Module manifests | `packages/modules/src/index.ts` | **Good.** Validates `editor`/`server`/`native`/`sidecar`/`edge`/`tools`/`db` contributions, resolves tick order from `after`/`before`, refuses unknown keys |
| Rule hooks | `packages/rules/src/hooks.ts:150-163` | **Good shape, unreachable.** 8 hooks, each handed the default so a game can wrap it — but see [§2.5](#25-where-a-dev-must-edit-engine-internals-today) |
| Rules as data | `packages/rules` (3,503) | **Good.** Zod schemas + a loader with field-precise errors for 18 files in `content/rules/` |
| Scene documents | `packages/scene` (2,371) | **Good.** Versioned schema, node/component registry, pure edit ops with undo |
| Species as data | `packages/species` (1,344) | **Good.** Schema only; "no species ids appear in this file" is an asserted invariant (`needs.ts`) |
| Composition / ranks | `packages/compose` (1,453) | **Mixed** — see kit, below |
| Art pipeline | `packages/art` (16,316) | **Core + SDK.** Manifest schema, pack scanning, placeholder fallback |
| Content-pack seams | `content/README.md`, 30 `MMO_*` paths | **Works, wrong shape** — see [§3.2](#32-the-game-project-manifest) |
| Editor panels | `packages/modules` `editor.entry` + `apps/editor/src/modules-client.ts` | **Partly wired** — see [§2.5](#25-where-a-dev-must-edit-engine-internals-today) |

### 2.3 Kit — our design, engine-authored, should be game-replaceable

These are not our *world*, they are our *rules of play*. They belong to
whoever makes the call in the decision attached to this PR; the plan
below assumes they become `@mmo-engine/kit-*`.

| Cluster | LOC | The design decision inside it |
|---|---|---|
| Combat cluster (`combat`, `abilities`, `magic`, `duel`, `body`, `death`, `status`, `telegraph`, `stats/`) | 3,669 | Body-part damage with harmed/maimed/dismembered states, mastery-by-use, disciplines, telegraphs, consensual duels. `docs/MASTERY-AND-COMBAT.md` |
| Quest content pipeline | 1,477 | A fixed six-stage shape: hook → travel → obstacle → twist → confrontation → reward (`quests/content.ts:5-6`) |
| Dungeon instance rules | 1,998 | Party size, time limit, re-entry, crash behaviour as "proposed defaults" (`dungeons/content.ts:4`) |
| Economy + items + gathering + interact + crafting | 5,590 | Auction house with escrow-free listings, vendor archetypes, loot tables, rank-coloured drops |
| Rank ladder + component catalog | 1,453 (`compose`) | The rank names, loot shares and budgets |
| Crafting balance | 692 (`crafting`) | Recipes balanced backwards from top gear |
| Residents | 624 | Town schedules, shop attachment, 3-game-day replacement |

### 2.4 IP — our world. Moves to the game project

| Item | Where | Evidence |
|---|---|---|
| **Civic / Redwater Crossing** | `engine-core/src/civic/` (4,432) + `world/civic-sync.ts` (921) + `logging/civic-metrics.ts` = **5,566 LOC** | `packages/rules/src/civic.ts:184` `name: "Redwater Gorge Bridge"`, `:201` `"Ruined Crossing"`. Reaches `net/gateway.ts`, `net/health.ts`, `items/item-service.ts`, `pools/*`, `server.ts:1328-1357` |
| **Our bestiary, in an engine schema** | `engine-core/src/procgen/wildlife-table.ts:110` | `yardsticks: z.strictObject({ goblin, orc, troll, golem })` — a `strictObject`, so a game with no goblins **cannot author a valid wildlife table** |
| **Hardcoded ambushers** | `engine-core/src/server.ts:1352` | `["bandit","raider","goblin","wolf"].find(k => creaturesOf().has(k))` — soft (falls through if absent), but a game's names never appear |
| **Named world content** | `content/settlements` (4.5 MB), `content/quests`, `content/dungeons`, `content/strings`, `content/wildlife`, `content/species` | Baked towns, authored quests, NPCs, dialog, name pools |
| **The player's HUD** | `apps/client/src/ui` (6,269) | `civic-panel.tsx`, `duel-panel.tsx`, `disciplines.tsx`, `body-doll.tsx`, `vendor-panel.tsx`, `quests.tsx` — one game's interface |
| **Licensed art bindings** | `apps/client/src/render/synty-props.ts` (305) | Named art-pack loader; the art itself is correctly out of the repo |
| **Dungeon theme names** | `packages/dungeon/src/themes.ts` | Five built-in themes are Dungeon Forge's (MIT, attributed in `packages/dungeon/THIRD_PARTY_NOTICES.md`) — engine sample content, not our IP, and already replaceable via `loadThemes` |

### 2.5 Where a dev must edit engine internals today

Each of these is a specific file and line, and each is a blocker for
"build a game without heavy engine customization".

1. **Hooks are unreachable.** `loadGameRules(dir, overrides)` takes
   `HookOverrides` (`rules/boot.ts:23`), but the only call in the server
   is `server.ts:354`: `loadGameRules(process.env.MMO_RULES || undefined)`
   — **no second argument**. To replace `computeDamage`, a game must edit
   `packages/engine-core/src/server.ts`.
2. **Modules import engine internals from `dist/`.**
   `modules/combat/server.js:17-27` imports nine systems and four
   components by `../../packages/engine-core/dist/src/*.js`. A game's
   module would do the same: no package boundary, no version contract,
   and it breaks if the build layout changes.
3. **`server.ts` hand-wires modules by name.** 18 `assembled.byName[...]`
   reads over 15 names and 4 `assembled.extensions[...]` reads
   (`server.ts:1416-1449`), each cast to a concrete engine class. A game
   module that wants to take part in those seams must be added here.
4. **Per-module config is hand-built.** `server.ts:1394` constructs
   `config` for 11 named modules. A new module needing boot config needs
   a line here.
5. **Paths are resolved relative to the engine's own `dist/`.** 40
   references across 19 files, e.g. `rules/boot.ts:12`
   `"../../../../../content/rules"`, plus `REPO_ROOT` at `server.ts:183`
   used 9 times (`modules/`, `content/modules.json`,
   `content/vendors.json`, `content/structures.json`,
   `content/settlements`, …). The engine assumes it sits inside the
   monorepo next to one `content/` folder.
6. **The engine requires our skill names.**
   `rules/skill-contract.ts:21` — `athletics`, `blocking`, `evading`,
   `medicine`, `parrying`, `swimming`, and the `disarm` technique. A
   pack that declares any skills must declare all seven. A sci-fi
   shooter must ship a skill called `parrying`.
7. **Editor panels only load from the engine repo.**
   `apps/editor/src/ui/modules-panel.tsx:32` builds the panel registry
   from a Vite glob,
   `import.meta.glob("../../../../modules/*/editor/index.{ts,tsx}")`. A
   module must physically live at `<engine>/modules/<name>/` and be
   compiled into the engine's editor bundle. A game project in its own
   folder cannot contribute an editor panel. The workspace tab list
   itself is also a hardcoded array (`App.tsx:88`) — a game can add a
   view inside an existing workspace, not a new workspace.
8. **Nothing is packaged for consumption.** No package sets `exports`,
   so there is no import surface to promise. Five are missing
   `private: true` and so are publishable by accident:
   `packages/mirror` (which declares `UNLICENSED`), `addons/geometry`,
   `addons/navigation`, `addons/perf-probe`, `addons/physics`. That last
   one is a safety fix independent of the licence question, and it is
   `ES1a` below.

### 2.6 Boundary problems worth fixing in the same pass

- **Dev tools in the player client.** `CLAUDE.md` says developer tools
  belong in the editor. `apps/client/src/ui/` holds `dev-panels.tsx`,
  `perf-hud.tsx`, `debug.ts`, `admin-console.tsx` and `dev-layout.ts`.
  The split is the moment to move them behind the editor's play mode.
- **`engine-core` → `world-server` import.** Nine imports, all
  `import type` (`net/gateway.ts:221`, `world/*`), so there is no
  runtime coupling — but the shared record types belong in their own
  contract package rather than making the simulator depend on the
  coordinator.
- **`rogue-packages/`, `paperclip_snippets/`, `sources/`, `tmp_perf/`,
  14 `isolate-*.log` files and `lighthouse-report.json`** sit in the repo
  root. Noise for anyone cloning the engine; worth a tidy.
- **`packages/addons/codec` is not a workspace** and no `package.json`
  depends on `@mmo-engine/addon-codec`. It builds nothing and ships
  nowhere — either wire it in or retire it before alpha.
- **No root third-party notices.** Vendored third-party code sits in
  seven `third_party/` folders plus `packages/dungeon` and `apps/client`,
  each with its own `THIRD_PARTY_NOTICES.md`. There is no aggregated root
  notices file. It is needed whenever the licence lands, and is parked
  with it.

## 3. Part 2 — The proposed alpha skeleton

### 3.1 Three tiers

```
┌─ @mmo-engine/core ──────────────────────────────────────────┐
│  tick, ECS, SAB, net, persistence, streaming, terrain,      │
│  procgen, navigation, physics, pools, world/region          │
│  → no game design, no named content, no content/ path       │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌─ @mmo-engine/sdk ───────────────────────────────────────────┐
│  THE ONLY IMPORT A GAME NEEDS                               │
│  defineGame() · defineModule() · defineSystem()             │
│  rule hooks · component registry · schemas · loaders        │
│  semver-stable, documented, the thing we promise            │
└──────────────────────────┬──────────────────────────────────┘
          ┌────────────────┴───────────────┐
┌─ @mmo-engine/kit-* ─────────┐   ┌─ games/<name>/ ───────────┐
│  kit-combat   kit-progress  │   │  game.json                │
│  kit-economy  kit-quests    │   │  content/   modules/      │
│  kit-dungeons kit-social    │   │  client/    editor/       │
│  forkable starter packs     │   │  → imports @mmo-engine/sdk│
└─────────────────────────────┘   └───────────────────────────┘
```

Our game becomes `games/nexus/` — the first consumer of its own engine,
which is the only way the seams stay honest.

### 3.2 The game project manifest

One file replaces 30 environment variables. `game.json`, validated by a
Zod schema in the SDK, every path relative to the file. **Shipped in
`ES2`/`ES4`; this is the schema as built, which differs from the sketch
this section first carried:**

```jsonc
{
  "name": "nexus",
  "content": "content",                  // the root; every content seam hangs off it
  "assets": "assets",
  "paths": {                             // one seam at a time, when a game's layout differs
    "rulesDir": "rules",                 // was MMO_RULES
    "combatFile": "combat/moves.json",   // was MMO_COMBAT
    "biomesFile": "world/biomes.json"    // engine-bundled by default; point it at your own
  },
  "hooks": "rules/hooks.mjs",            // the gap that was at server.ts:354
  "modules": {                           // per-module settings, by module name
    "residents": { "maxEntities": 1200 }
  }
}
```

Two differences from the sketch, both deliberate. `content` is a *root*
with a `paths` map beside it rather than one object of 15 paths: the
common case is a game whose layout matches ours, which then writes one
line instead of fifteen, and the full list of 34 seams lives in
`packages/sdk/src/seams.ts` where it can carry each seam's `MMO_*`
aliases and its default. And `modules` holds per-module *settings*, not
the module dirs and the enabled set: the set already has a seam
(`paths.modulesSetFile`, i.e. `content/modules.json`) and so does the
module folder (`paths.modulesDir`). What is still missing for `ES5` is
*several* module folders, so a kit can ship its own — that wants a
`modulesDirs` array when the first kit needs it, not a reshuffle of
`modules`.

`MMO_*` variables stay as per-run overrides — they are genuinely useful
for tests and benchmarks — but they stop being the *definition* of a
game. One `GameProject` object, resolved once at boot, replaces
`REPO_ROOT` and every `../../../../content` path.

### 3.3 The code seam: `defineModule`

What a game module looks like when it imports a package instead of
reaching into `dist/`:

```ts
import { defineModule, type SystemContext } from "@mmo-engine/sdk";
import { CombatSystem } from "@mmo-engine/kit-combat";

export default defineModule({
  name: "raiding",
  version: "0.1.0",
  dependsOn: ["combat", "items"],
  systems: [{ name: "raiding", after: "combat" }],
  create(ctx: SystemContext) {
    // ctx.components, ctx.sim, ctx.stores, ctx.config, ctx.hooks
    return { raiding: new RaidingSystem(ctx) };
  },
});
```

Four changes make that possible:

1. **`@mmo-engine/sdk` with a real `exports` map**, so a module imports
   `@mmo-engine/sdk` and `@mmo-engine/kit-combat`, never
   `../../packages/engine-core/dist/src/...`.
2. **A typed service registry replaces `assembled.byName[...]`.**
   *Done (ES4, 2026-11-22.)* `packages/engine-core/src/services.ts` holds
   one row per service the engine's entry point reads — the module behind
   it, system or gateway extension, and whether the server runs without
   it — and `server.ts` resolves by a typed key instead of casting. Boot
   fails loud when a required service is missing, naming the module to
   enable, the same fail-closed style as the skill contract. The
   mechanism is in `@mmo-engine/sdk`, so a game with its own entry point
   writes its own table.
3. **Config comes from `game.json`**, resolved per module by name.
   *Done (ES4), with one correction to this plan:* the 11 objects at
   `server.ts:1394` do **not** move. They are host wiring — callbacks
   into the host and live engine objects (`craftAndGrantItem`,
   `groundHeightAt`, the spawn pool, the chunk source) — which no JSON
   file can hold, and a manifest that could replace them would be a way
   to break a boot rather than a way to configure one. What moved is the
   data keys: `game.json`'s `modules` block layers *under* what the host
   passes each module, so a `MMO_*` variable still wins for one run, a
   key the host leaves unset comes from the file, and a key neither sets
   is the module's own default. A module the host wires nothing for still
   reads its settings, which is the part that matters for a game's own
   modules.

4. **The gateway reads its systems by port, not by class.**
   *Done (ES4c, 2026-11-22.)* `net/gateway.ts` found six systems with
   `instanceof` — `CombatSystem`, `DeathSystem`, `AbilitySystem`,
   `StatusSystem`, `TelegraphSystem`, `DuelSystem` — which meant a value
   import of each: the one import a system cannot have if it is to live
   in a kit, because a class you look for by identity has to be in your
   own build. `net/ports.ts` now declares what the gateway asks of each
   (`combat`, `life`, `abilities`, `telegraphs`, `statuses`, `duels`,
   with the methods it calls), a system offers a port by name through
   `@mmo-engine/sdk`'s `PORTS` symbol, and `openPorts` resolves them at
   boot. A game's own combat system is found the same way ours is. The
   eight economy and world systems the gateway still scans for are
   `ES4d`, the same change over a second set.

### 3.4 Hooks, reachable

`game.json`'s `hooks` entry is loaded at boot and passed to
`loadGameRules(dir, overrides)` — closing the gap at `server.ts:354`
with a one-line change and a loader:

```ts
// games/nexus/hooks.js
export default {
  computeDamage: (input, base) =>
    input.part === "head" ? { ...base(input), amount: base(input).amount * 1.5 } : base(input),
};
```

The eight hooks already defined (`computeDamage`, `resolveLanding`,
`resolveDefence`, `resolveTreatment`, `skillGain`, `onInjury`, `onDeath`,
`onRespawn`) are a good set and need no change. Two more are worth
adding for alpha, because they are the two most common things a game
wants to change and both currently require engine edits: `onSpawn`
(what a creature kind spawns as) and `onLoot` (the roll at a corpse).

### 3.5 The skill contract, inverted

Today the engine declares seven ids and demands the content supply them.
Instead, a **kit** declares the ids *it* needs, and the engine declares
only *roles*:

```ts
// @mmo-engine/kit-combat
export const REQUIRED_SKILLS = ["athletics","blocking","evading","medicine","parrying","swimming"];
export const SKILL_ROLES = { dodge: "evading", block: "blocking", treat: "medicine" };
```

A game using `kit-combat` gets the same loud boot failure it gets today.
A game not using it is free of our vocabulary. Mechanically this is a
move of `rules/skill-contract.ts` plus a per-kit registration call — the
check itself stays as it is, because it is good.

### 3.6 `create-mmo-game`: several starting points, not one

The decision on this PR asks for the fastest *and* the most flexible
route to someone else's game: a simple starting point for a dev who
wants to be playing today, and a set of starting points for a dev who
wants to tear ours apart. So the starter is a template picker, not a
single scaffold:

```
npx create-mmo-game my-game --template <name>

  bare       core + SDK only. No kits. A world you can walk, nothing to fight.
             The honest floor: proves what the engine gives you with no design in it.
  survival   kit-combat + kit-progress. Creatures, damage, skills by use, death.
  sandbox    kit-economy + kit-social. Gathering, crafting, vendors, parties. No combat.
  full       every kit. What our own game is built on, minus our content.
```

Each template is the same shape, and every file in it belongs to the
developer:

```
my-game/
  game.json                 the manifest above; lists which kits are on
  package.json              deps: @mmo-engine/sdk, the template's kits
  hooks.js                  one hook, commented, showing base() wrapping
  content/
    rules/                  the engine's neutral defaults, copied in to edit
    world.spec.json         a 4 km island, one seed
    scenes/start.scene.json one spawn point, flat ground, one prop
    species/species.json    two creatures, data only
  modules/
    my-first-system/        module.json + index.ts, a system that logs
  client/
    main.tsx                the engine client shell + one HUD panel
  editor/                   empty; panels drop in here
  README.md                 what to edit for the ten most common changes
```

Two targets, and both should be CI jobs rather than claims:

1. **Fast:** `npx create-mmo-game my-game && npm start` gives a walkable
   world with one creature in under five minutes, with **zero files from
   the engine edited**.
2. **Flexible:** the `bare` template boots and runs with **no kit
   installed at all**. If that fails, design has leaked back into the
   core and the split has regressed — which makes it the single most
   valuable test in this whole plan.

### 3.7 The editor as an engine tool

The next phase (a proper Unreal/Unity-style editor) lands on the right
side of this line if it is built to these two rules, both of which fix
the gap at `modules-panel.tsx:32`:

- **The editor reads `game.json`**, not `REPO_ROOT`. It opens a game
  project the way an IDE opens a folder, and a game project is not
  required to live inside the engine repo.
- **Panels load at runtime, not at build time.** The Vite glob becomes a
  manifest-driven dynamic import against the open project's
  `modules/*/editor/`, and the hardcoded `WORKSPACES` array
  (`App.tsx:88`) becomes a registry a module can add a workspace to.

Everything the editor authors — gameplay tables, quests, story, dungeon
rules, town rules, crafting, scenes, VFX, strings — is *game* data. The
editor itself is *engine*. That is already the shape; it just needs the
project to be a parameter.

## 4. Part 3 — Staged migration

Stages 1–4 are additive: nothing moves, nothing breaks, each is
independently shippable and useful on its own. Stages 5–9 move code.

| # | Stage | Scope | Risk | Gate before merging |
|---|---|---|---|---|
| 1a | **Stop the accidental publishes** | `private: true` on the five packages that lack it. Nothing about licensing | **Low.** One field in five `package.json` files, reversible | `npm publish --dry-run` in each ends in "Skipping workspace …, marked as private" (note `npm pack` still packs a private package, so it is not the check); `npm test` unaffected |
| 1b | **Package hygiene** (parked with the licence) | `exports` maps on the packages that go public, `license` fields, root `LICENSE` and an aggregated third-party notices file | **Low.** Metadata only | Blocked on the licence choice — see [§5](#5-the-licence-is-deferred-on-purpose) |
| 2 | **`GameProject` resolver** | `@mmo-engine/sdk` with `game.json` schema + resolver. Engine reads paths from it, defaulting to today's `content/` so current behaviour is byte-identical | **Low–medium.** 40 path sites in 19 files. Mitigated: default resolver returns exactly today's paths; a test asserts every resolved path equals the old constant | A test per seam asserting old path == new resolved path; boot smoke unchanged |
| 3 | **Reach the hooks** | Load `game.json.hooks`, pass to `loadGameRules`. One line at `server.ts:354` plus a loader | **Low.** Absent hooks = today's behaviour | A test game pack that overrides `computeDamage` and changes a measured damage number |
| 4 | **Service registry** ✅ | Typed resolve replacing the 18 `assembled.byName[...]` and 4 `extensions[...]` reads, plus `game.json`'s `modules` block. Delivered as a typed view over the same two bags, which is why nothing had to live side by side | **Medium**, as judged. What it actually caught: `navigation` was cast to a non-null type at `server.ts:1687` although its consumer takes `NavigationSystem \| null`, and three refs were carrying hand-written structural types because a cast stood in the way of the real ones | Engine-core's 1,991 tests green; booted three ways (defaults, a manifest setting a module's value, a required module disabled); no workload imports `server.ts`, `modules.ts` or `services.ts`, so the tick cannot move |
| 4b | **The engine without a game** ✅ | Shrink the registry's required list: everything a game may want none of becomes optional, and the wiring that assumed it treats it as absent | **Low**, and it is the cheap half of what stages 5–8 were for: no code moves, so the risk is a path that assumed a system and now meets `null` | `core` alone reports 3 missing instead of 11; `core`, `physics`, `character` reaches `listening`, ticks 70 s and saves clean; a test pins the required list to those three |
| 4c | **Ports, not classes** ✅ | The gateway names the systems it reaches instead of finding them by class, so a kit can own them | **Low**: a lookup change, no behaviour and no moved code | No `instanceof` of a system class left in `net/gateway.ts`; 271 net tests unchanged; a system offering a port it cannot answer ends the boot |
| 5 | **Kits** | `@mmo-engine/kit-combat`, `-progress`, `-economy`, `-quests`, `-dungeons`, `-social`. Code moves out of `engine-core/src` into kit packages; modules import the kit, not `dist/`. Each kit is written to be **forked and edited**, not just configured: small files, no cross-kit imports, and a `README` that says which hook or system to change for the common edits | **High.** ~13,000 LOC moving. Mitigated: one kit per PR, pure file moves with import rewrites and **no behaviour change in the same commit**; the roadmap row records the before/after test counts | Per kit: that kit's tests plus the full root suite; a measured duel and a measured loot roll identical before and after. Plus: the kit still builds with one system deleted, proving a game can drop part of it |
| 6 | **Civic → game** | 5,566 LOC. The *mechanisms* (bridge wear, escrow contracts, item provenance, foundry specialization, vein surveying) are general: they become `kit-logistics`. The *names and the Redwater rules* become `games/nexus/content`. The `gateway`/`health`/`items`/`pools` touchpoints become SDK extension points, which is what they should have been | **High.** Deepest coupling in the repo. Mitigated: it is already a gateway extension (`modules/civic/module.json` declares `extensions: ["civic"]`), so the seam exists — the work is widening it | `civic.test.ts`, `civic-e2e.test.ts`, `civic-world-tracks.test.ts`, `fleet-telemetry.test.ts` all green; a live run showing a bridge restoring |
| 7 | **Our game into `games/nexus/`** | `content/` → `games/nexus/content/`; our HUD panels → `games/nexus/client/`; dev panels out of the client into the editor | **Medium.** Mostly moves, but `content/settlements` is 4.5 MB of baked data and every bake script path changes | `npm run bake:all` produces byte-identical output; the 6-seed town/route/place counts from the geology guard test unchanged |
| 8 | **`create-mmo-game` + de-IP the schemas** | The template picker (`bare`, `survival`, `sandbox`, `full`); the `wildlife-table.ts:110` `strictObject` becomes an open map; `server.ts:1352` ambushers come from rules; `apps/client` splits into `client-runtime` + game client | **Medium.** The `strictObject` change is a content-schema change: existing wildlife tables must keep validating | Both CI jobs from §3.6: the five-minute walkable world, **and** `bare` booting with no kit installed. Existing `content/wildlife` still validates |
| 9 | **Editor as an engine tool** | The panel registry loads from the open project at runtime instead of the build-time Vite glob (`modules-panel.tsx:32`); `WORKSPACES` (`App.tsx:88`) becomes a registry a module can add to | **Medium.** Touches editor boot, and the glob is how every panel loads today | The editor opens a generated `my-game` outside the engine repo and shows its module's panel. Folds into the planned editor rebuild rather than being done twice |

Sequencing note: `1a`, `2` and `3` can run in parallel with each other
and with the perf and editor work already in flight; `1b` waits on the
licence. Stage 4 must land before 5.
Stage 6 should wait for 5, because `kit-logistics` is easier to carve
once the kit pattern exists.

### 4.1 Risks worth naming explicitly

- **Fleet pack consistency.** Already recorded in
  `docs/engine-game-split/README.md`: every region must be pointed at the
  same pack. A `game.json` makes this *better* (one file to hash) and the
  boot should log and register that hash so a mismatched region is
  visible immediately.
- **Perf regressions from indirection.** A service registry and a
  resolved-path object are both boot-time. Nothing proposed here touches
  the tick. Still: stage 4 and stage 5 each run `npm run valgrind:perf`
  and report what moved, per `CLAUDE.md`. The current baseline must not
  be refreshed while the residents-tick question is open.
- **Moving code loses history.** Use `git mv` and keep moves separate
  from edits, so `git log --follow` and `git blame` survive. A PR that
  both moves and changes a file is the one that costs us later.
- **Half-split is worse than either end.** If stages 5–7 stall halfway,
  we have two import conventions and two config paths at once. Mitigation:
  stages 1–4 are designed to be a stable resting point — they deliver the
  SDK, the manifest and reachable hooks without moving a line of gameplay
  code. If the effort stops there, the engine is still meaningfully more
  reusable than it is today.
- **Several starting points cost more than one.** Each kit a developer
  can fork is a kit we keep working, test and document. Three or four
  well-separated kits is the useful number; a dozen is a maintenance
  burden that makes none of them trustworthy. The gate in stage 5 (the
  kit still builds with one system deleted) is what keeps them genuinely
  separable rather than one template in six folders.
- **The licence is deferred, so the audience is still internal.** Until
  it lands, "another team builds a game on this" is a capability we are
  building, not one anyone may exercise. That is a deliberate choice, not
  an oversight — see [§5](#5-the-licence-is-deferred-on-purpose) — but it
  does mean the five-minute starter test in stage 8 proves the seams
  work, not that the engine is adoptable yet.

## 5. The licence is deferred on purpose

**Decided 2026-11-22: no licence is chosen yet**, pending the call on
whether this becomes a monetized venture. Nothing in this plan picks one,
and no `LICENSE` file is added.

What that does and does not block:

| | Status |
|---|---|
| `private: true` on the five packages that would publish by accident | **Goes ahead** (`ES1a`). A safety fix in either direction: unlicensed code publishing by accident is the bad outcome whichever licence is later chosen |
| `exports` maps, `license` fields, root `LICENSE`, aggregated third-party notices | **Parked** (`ES1b`). Each of these is a statement about how others may consume the code, so each waits for the decision |
| Everything else, `ES2` through `ES9` | **Unaffected.** The SDK, the manifest, reachable hooks, the kits and the templates are all internal engineering. They are worth doing for our own game regardless |

The honest consequence: until a licence lands, the repo is public but
all rights reserved, so "another team builds a game on this" stays a
capability we are building rather than one anyone may use. That does not
weaken the case for the split — our own game is the first consumer of
these seams, and it is the only thing that keeps them honest — but it
does mean the adoption story is on hold, not the engineering.

One thing worth knowing before the monetization call, because it
constrains it: the engine already vendors third-party code under its own
terms — Jolt, Recast/Detour, FastNoise2, manifold, Clipper2, Dungeon
Forge (MIT) and others, across seven `third_party/` folders. Those
licences will shape what the engine itself can be released as, so the
aggregated notices file in `ES1b` is worth producing as *input* to the
decision rather than as a consequence of it.

## 6. What is not verified

Honest limits of this document:

- Every code claim was verified by **reading the code** at `d9fe367`.
  Nothing was verified by **running** it: this container has no
  `node_modules` and no built native addons, and a full install plus
  Jolt/Recast/FastNoise2 build was out of scope for a design pass.
- The earlier split's claim that the engine **boots content-free** is
  therefore repeated, not re-tested. It should be a CI job, and stage 8's
  starter test is the natural place for it.
- LOC counts are `wc -l` over non-test source, including comments, which
  are unusually thorough in this codebase. They indicate scale, not
  effort.
- No screenshots: this PR changes one Markdown file and adds no visible
  or measurable behaviour. Stages 2 onward will carry captures.
