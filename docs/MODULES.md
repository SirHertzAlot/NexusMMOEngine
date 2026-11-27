# Modules

Everything the engine does beyond its tick loop is a **module**: a folder `modules/<name>/` with a `module.json`. The server's systems (combat, economy, physics), the editor's panels, native C++ code, helper processes and edge services all arrive the same way. This page is the contract: the manifest, how modules are enabled and ordered, and how to write one.

## How a module is enabled

- **`content/modules.json`** lists the enabled modules: `{ "modules": ["core", "physics", ...] }`. `MMO_MODULES` points the server at a different file. `core` is always on.
- **In the editor**, the Modules workspace turns modules on and off. **Apply modules** restarts the play server, because the server reads the set once, at boot.
- **At boot** the server resolves the dependency order and one tick order, then builds the systems. **Any problem stops the boot and every problem is named**: a dependency that is not installed or not enabled, a dependency cycle, an unknown system id in an `after` or `before`, or a declared system the entry did not return. The engine would rather refuse to start than run half a game.

### What the engine actually needs

Three: `core`, `physics` and `character`. A set of just those boots, listens
and ticks, with no items, combat, economy, quests, dungeons, creatures or
residents — the engine holds a chunk back until its terrain colliders are in,
and a player needs ground height, bounds and a sheet, so those two modules are
the engine's own rather than a game's design. Everything else is a feature
that is simply absent when its module is off.

Leave one out that the server does need and it says which, all of them at
once, before it starts:

```
[server] fatal: MissingServicesError: 1 service the server needs is not available:
  - physics (the Jolt world, and the terrain collider hook the streamer needs),
    provided by the physics module — enable physics in the module set
```

The boot also prints what this run has: `[modules] services: 17/19, off: bots,
residents`. The list of what the server reads and what it can do without is
one table, `packages/engine-core/src/services.ts`.

## The manifest, `module.json`

Unknown keys are refused. The folder name must match `name`.

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits and dashes, starting with a letter. Must match the folder name. |
| `version` | `major.minor.patch`. |
| `description` | Optional. Shown in the editor. |
| `engine` | Optional engine version range, `">=x.y.z"` or an exact `"x.y.z"`. The module is refused on an older engine. |
| `dependsOn` | Other modules this one needs. They must be installed **and enabled**; modules are built in dependency order. |
| `server` | `{ entry?, systems, extensions? }`: systems for the tick (below). Without an `entry` the host process builds them (that is how `core` works). |
| `editor` | `{ entry }`: a module the editor shell imports dynamically to add panels. |
| `native` | `{ entry, systems }`: a compiled N-API `.node` file exporting `createSystems` ([Native modules](#native-modules)). |
| `sidecar` | A helper process run beside the server, with a readiness `health` check: a `command` string, an `exec` argv array, or a `wasm` file ([Sidecar modules](#sidecar-modules)). |
| `edge` | `{ regions, endpoint, capabilities }`: a service that runs on edge nodes, such as voice or matchmaking ([Edge modules](#edge-modules)). |
| `tools` | `{ entry, tools }`: host-side dev tools (a bake step, a converter) that never run on the tick ([Tools modules](#tools-modules)). |
| `db` | `{ functions?, caches? }`: stored functions and materialized caches, as `.sql` files under `db/functions/` and `db/caches/`. |

An `entry` is a relative path with no `..`. A server entry is a `.js` or `.mjs` file, an editor entry may be a `.tsx` file, and a native entry ends in `.node`.

## Tick order

A system is declared `{ "name": "...", "after": [...], "before": [...], "optional": true }`. The server resolves **one order from every enabled module's `after` and `before`**, once at boot. Nothing about ordering runs on the tick.

- `after` and `before` name other systems by id, and may be a string or a list.
- `optional: true` lets the entry leave the system out (bots when there are none, the crowd when no navigation backend provides one). The tick order drops it like any unbuilt system. Without `optional`, a declared system the entry does not return stops the boot.
- The real orders are in the manifests. `core` holds what no module owns (`reloader`, `streamer`, `collapse`), and `gathering` and `props` tick back into the middle of the old list from their own modules — `{ "after": "streamer", "before": "collapse" }` and `{ "before": "collapse" }` — which is how a module slots a system into an order it does not own. Both anchor on `collapse` rather than on each other, because `core` is always enabled and an edge to another optional module's system would make a module refuse to boot without it; `combat` runs `stamina`, `body`, `magic`, `abilities`, `status`, `telegraphs`, `duels`, `combat`, `death`; `physics` pins the character bridge between `integrate` and `prop-collision`:

```json
{ "name": "character-bridge", "after": "integrate", "before": "prop-collision" }
```

**Where a module sits in the set matters.** The resolver takes the lowest
*declaration* index that is ready, and indices run `core` first and then the
enabled set in order, so two systems that no edge separates run in set order.
A system whose module is listed late therefore ticks late, however early its
`after` anchor is — and a `before` edge can pull the system it points at
*later*, because that one now has to wait. `gathering` is listed immediately
after `core` for exactly this reason: moving it out of `core` without that
dropped it, and `chests`, `breaks` and `collapse` with it, from third in the
tick to the far end. If a module's systems have to run at a particular point,
give them edges **and** put the module where those edges want it, then check
the boot's `[modules] … | tick order: …` line. Point the edges at a `core`
system where you can: an edge naming another optional module's system makes
yours refuse to boot whenever that one is off.

## Writing a server module

The shipped example is `modules/sample-heartbeat/`. It logs a line every 600 ticks.

**1. The manifest**, `modules/sample-heartbeat/module.json`:

```json
{
  "name": "sample-heartbeat",
  "version": "0.1.0",
  "description": "Sample server module: one system that logs a heartbeat every 600 ticks.",
  "dependsOn": ["core"],
  "server": {
    "entry": "server/index.js",
    "systems": [{ "name": "sample-heartbeat", "after": "crowd", "before": "intent" }]
  }
}
```

**2. The entry**, `modules/sample-heartbeat/server/index.js`. `createSystems(ctx)` returns **one system per name the manifest declares, as an object keyed by that name**:

```js
export function createSystems(ctx) {
  let ticks = 0;
  return {
    "sample-heartbeat": {
      name: "sample-heartbeat",
      step() {
        ticks++;
        if (ticks % 600 === 0) ctx.log(`[sample-heartbeat] ${ticks} ticks`);
      },
    },
  };
}
```

A system is a `SimSystem`: a `name` and a `step(sim, dt)` that runs once per tick. The context `ctx` gives you:

| Field | Use |
|---|---|
| `ctx.sim` | The `SimWorld`: the ECS and the tick number. |
| `ctx.log(message)` | Log a line. |
| `ctx.config` | Per-module bootstrap data: what the server wires (game rules, data dirs, callbacks) with the game's own settings under it (see below). Optional: tolerate its absence. |
| `ctx.stores` | What a module hands back. A module that owns a store (economy's wallet, the character store) publishes it here for the server to wire to the gateway, and so does a module that owns an *answer* the host needs rather than a system: `gatheringRecords` is what rides a character's world record, `lessonTerms` is what a lesson is worth. The host reads these through an accessor that returns `null` when no module published one, so an absent module is a feature the server does without rather than a boot failure. A module with an early return publishes an answer **before** it, when the answer does not depend on what the module spawned. |

A module may also export `dispose(ctx)`; on shutdown the server runs every module's `dispose` in reverse dependency order.

**Settings from `game.json`.** A game sets a module's values in its manifest's
`modules` block, by module name, and they arrive as `ctx.config[name]`:

```json
{
  "name": "my-game",
  "modules": {
    "residents": { "maxEntities": 1200, "fullM": 60 },
    "my-own-module": { "whatever": "the module reads" }
  }
}
```

The keys are the module's own — nothing in the engine lists them — so a
module you write is configured from `game.json` the day you write it, with no
engine change. Three layers, in order:

1. what the host passes for that module, which is where a run's `MMO_*`
   variable lands;
2. the `modules` block above;
3. the module's own default, for a key neither sets.

So a variable still wins over the file for one run, and the host's own wiring
(a callback, a live engine object) can never be replaced by a value out of a
JSON file. `residents.maxEntities` is the worked example: `MMO_RESIDENTS_MAX`
first, then the manifest, then the system's own 800.

**Reading another module's work.** The server reads back what the enabled
modules built through one table, `packages/engine-core/src/services.ts`: a row
per service its entry point needs, naming the module that provides it, whether
it is a tick system or a gateway extension, and whether the server runs without
it. A missing required service stops the boot naming the module to enable,
rather than crashing in the first tick that touches it. The table is the
engine's statement of what *its* entry point couples to, not a list of what a
module may provide — that is the module's own `module.json`. A game with its
own entry point writes its own table over `openServiceRegistry` from
`@mmo-engine/sdk` and uses none of ours.

**Being read by the gateway.** A service is how the *server's entry point*
reaches a system. The region gateway has its own, narrower need: a handful of
systems it must reach every tick to turn their events into client messages,
and reach again when a key press arrives. It asks for those by **port**, not
by class.

A port is a name plus the methods behind it. `packages/engine-core/src/net/ports.ts`
declares the fourteen our gateway reads — `combat`, `life`, `abilities`,
`telegraphs`, `statuses`, `duels`, `trade`, `wallet`, `auction`, `vendors`,
`gathering`, `chests`, `breaks`, `residents` — and a system offers one by
naming it:

```ts
import { PORTS } from "@mmo-engine/sdk";

export class MyCombatSystem implements SimSystem {
  readonly name = "combat";
  readonly [PORTS] = ["combat"];
  drainHits(): HitEvent[] { /* … */ }
  setStance(e: number, technique?: string | null, aim?: string | null): string | null { /* … */ }
}
```

Nothing in `ports.ts` names a system. A port's signatures mention only the
shared vocabulary (`packages/engine-core/src/vocabulary.ts` — the events and
views the engine and your systems must agree on), the protocol's wire types,
and `SimWorld` where what a port answers depends on where things stand. So
you can write a system against a port without importing the engine's own, and
the engine never imports yours.

Replace the engine's combat system with your own and the gateway finds yours,
because it never looked for a class in the first place. Offer a port without
the methods it needs and the boot ends naming the system and the methods it
lacks; offer none of them and the gateway simply sends none of those messages,
which is what a game with no duels wants. A game with its own gateway declares
its own ports over `openPorts` from `@mmo-engine/sdk`.

The engine's own fighting is a package like yours would be:
`@mmo-engine/kit-combat` holds the nine systems — combat, abilities,
telegraphs, status, duels, bodies, magic, stamina and death — and nothing in
`engine-core` imports it. `modules/combat/server.js` builds them from that
package, which is the same thing your module would do with your own. Take the
kit as it is, fork it, or replace one system in it and keep the other eight:
each of the nine builds without the rest, so dropping one costs you that
feature and nothing else. Its `README` says what each system does and what the
three ways to change it cost.

The economy is the second such package. `@mmo-engine/kit-economy` holds eight
systems — gathering, chests, breakables, wallets, trade, vendors, auctions and
settlement residents — plus what a master teaches and what persists, and
nothing in `engine-core` imports it either. Five modules build from it:
`modules/gathering/`, `modules/props/`, `modules/economy/`,
`modules/residents/` and `modules/dungeons/` for the run's world slot. What
stayed on the engine's side is worth knowing before you fork it: `places.db`,
because a break and an opened chest ride the range snapshot; the respawn pool
everything respawning shares; the loot a table rolls; and `CollapseSystem`,
because a broken part is what topples a building and toppling is the world's
business. Each of those a system here takes as an argument rather than owning.

The quests are the third. `@mmo-engine/kit-quests` holds one system and the
pieces it is built from — the log's rules, the generator, the content schema
and the store — and `modules/quests/server.js` builds it from the package.
This one is not a port: a port is a system the gateway ticks and asks, and
this one speaks to a player directly, so it registers as the `"quest"`
extension and the host asks the registry for a `QuestService` of two calls,
`place` and `onDeath`. What stayed on the engine's side is the journey rather
than the rules: a character's log rides their world record between regions, so
`QuestRecords` moves rows the host never reads inside, and the kit keeps the
validator for them, because the only thing that can say which rows are valid
is whatever wrote them.

A dungeon run is its own host, so it cannot ask for a system by port: it was
the one building them. It declares two slots instead, and a module fills
them. `dungeons/combat-slot.ts` is its fighting and `dungeons/world-slot.ts`
is its chests, breakables and veins; each takes everything the run can say
about itself and gives back the systems to tick plus the few things the run
has to ask afterwards. `modules/dungeons/server.js` passes the two the engine
ships with in — `defaultDungeonCombat` from `kit-combat` and
`defaultDungeonWorld` from `kit-economy` — and a game passes its own in their
place. Pass neither and
a run still boots and ticks: it just has no fighting and no props, which is
the rule the ports follow.

**3. Try it.** Add `"sample-heartbeat"` to `content/modules.json` (or tick it in the editor's Modules workspace and press **Apply modules**). The boot line lists the system between `crowd` and `intent`, and the log shows the heartbeat.

Game rules belong in data, not in a module's code: put tunables in `content/rules/` and read them through the rules package ([ARCHITECTURE.md](ARCHITECTURE.md#game-rules-are-data)).

### Where a store lives

A module that persists anything opens its own SQLite file, and the host says
where: `ctx.config.<module>.dataDir`. `server.ts` resolves that from
`game.json`'s `paths.dataDir` — the SDK seam whose default is `./data` — and
creates the directory before it assembles anything, so in a real run the
directory is already there and every module's files sit together.

Absent is the interesting case. A test, an editor harness or a partial boot
may build a module with no `dataDir` at all, and a module that treated that as
`.` wrote its database into whatever the process's working directory happened
to be: a run started from the repo root left `economy.db` beside the lockfile,
twice. So the fallback is `./data` — the same place the configured path
resolves to, and a directory `.gitignore` already covers — and each module
creates it before opening:

```js
const configured = ctx.config?.social?.dataDir;
const dataDir = typeof configured === "string" ? configured : "./data";
fs.mkdirSync(dataDir, { recursive: true });
```

Seven shipped modules open a store this way (character, civic, dungeons,
economy, gathering, quests, social). `packages/engine-core/test/server-modules.test.ts`
finds them by looking for `new Sqlite` rather than from a list, so a module
added later is held to the same rule without anyone remembering to add it.

## Other kinds of module

A module may contribute more than one kind at once: a manifest with both
`server` and `editor` ships a system and the panel that tunes it.

### Editor modules

`editor: { entry }` points at a module the editor shell imports dynamically.
The entry exports the panel component as a contributed panel; the panel code
itself can stay wherever it lives. Workspaces declare no views of their own —
every panel in the editor arrives this way, so disabling a module leaves its
workspace showing a "no module contributes" placeholder rather than breaking
the shell.

```json
{ "name": "vfx", "version": "0.1.0", "dependsOn": ["core"],
  "editor": { "entry": "editor/index.tsx" } }
```

### Native modules

`native: { entry, systems }` points at a compiled N-API `.node` file whose
`createSystems(ctx)` returns systems that run on the tick exactly like
JavaScript ones. The resolver orders a module's native systems after its
JavaScript systems.

```json
{ "name": "physics-jolt", "version": "1.0.0",
  "server": { "systems": [{ "name": "physics", "after": "intent" }] },
  "native": { "entry": "./build/Release/physics.node", "systems": ["physics"] } }
```

`npm run build:native` compiles every module with a `native.entry` through
node-gyp. A missing `.node` file disables the module with an error pointing
at that command rather than failing obscurely. node-gyp does the whole build:
there is no CMake step and no shell script in the path, so an addon compiles
from a plain checkout on Windows and Linux alike with nothing installed but a
compiler.

Copy `packages/addons/template` to start. The boundary rule is absolute:
**pass bulk typed arrays once per tick, never inspect JavaScript objects
per entity inside a loop.** Breaking it produces native code slower than the
JavaScript it replaced. `modules/template-native` is a working minimal
example and a toolchain smoke test.

### Sidecar modules

`sidecar` runs a helper process beside the server with a readiness check, for
work that must not share the tick's process: a model server, a bake worker, a
telemetry collector, anything in another runtime.

```json
{ "name": "sample-sidecar", "version": "0.1.0",
  "sidecar": { "command": "node sidecar.js", "port": 49876, "health": "/health" } }
```

Exactly one of `command` (a shell string), `exec` (an argv array) or `wasm`
(a `.wasm` path) is required, plus `port` and a `health` path. Sidecars start
before the game server and are health-checked; an unhealthy sidecar disables
its module. They terminate on shutdown. The point is crash isolation: a
sidecar dying never stops the tick. `modules/sample-sidecar` is the worked
example.

### Edge modules

`edge: { regions, endpoint, capabilities }` declares a service that runs on
edge nodes rather than on the core — regional voice, an asset CDN,
matchmaking. The edge keeps a registry, serves it at
`GET /api/edge/modules` (filterable by region and capability), and clients
find the nearest endpoint by latency probe.

```json
{ "name": "voice-us-east", "version": "1.0.0",
  "edge": { "regions": ["us-east"], "endpoint": "wss://voice.example.com",
            "capabilities": ["voice"] } }
```

Registration and discovery only. **The edge never simulates.**

### Tools modules

`tools: { entry, tools }` contributes host-side developer tools — a bake
step, a converter, an importer — whose entry exports `createTools(ctx)`.
These never run on the tick. Use this instead of adding another ad-hoc script
to `scripts/`, so your tool is enabled, ordered and discoverable like
everything else.

### Database modules

`db: { functions?, caches? }` contributes stored functions and materialized
caches as `.sql` files under the module's `db/functions/` and `db/caches/`.

- **Functions** are named, parameterized, **read-only** `SELECT` statements
  using `:name` placeholders. They are validated at load and bound at run
  time through a read-only query child process, so a function cannot write
  or block the server.
- **Caches** are snapshot tables (`_cache_<name>`) built from a query and
  refreshed as a delete-and-reinsert inside one transaction, with freshness
  tracked in `_cache_meta`. Use one for anything expensive that readers hit
  often, such as a leaderboard.

The editor's Database workspace lists, creates, runs and refreshes them
(`/api/editor/database/...`).


## The modules that ship

Generated from `modules/*/module.json`; the 34 below are what `content/modules.json` can enable.

| Module | Contributes | Depends on | What it is |
|---|---|---|---|
| `art` | editor | `core` | Editor module: Art tooling: asset inspector and materials |
| `audio` | editor | `core` | Editor module: the Art & audio workspace's audio panel |
| `authoring` | editor | `core` | Editor module: the Design workspace's Authoring panel — view-centered, no-code authoring (hierarchy navigator, selecti… |
| `changes` | editor | `core` | Editor module: Version control: the Changes panel |
| `character` | server: `character`, `animation`, `mastery`, `stats` | none | Character domain: player characters, animation, mastery (skills), and stats |
| `characters` | editor | `core` | Editor module: the Characters workspace's Records panel |
| `chat` | — | none | Region chat (S1): shape validation, per-channel range and rate limits, text-filter hook |
| `combat` | server: `stamina`, `body`, `magic`, `abilities`, `status`, `telegraphs`, `duels`, `combat`, `death` | none | Combat domain (M2/M5): stamina, body parts, magic, abilities, status effects, telegraphs, duels, combat resolution, an… |
| `core` | server: `reloader`, `streamer`, `collapse`; editor | none | The engine's own contribution: what no module owns, in its fixed tick order |
| `creatures` | server: `creatures`, `bots`, `crowd`, `needs` | `physics` | Creatures domain (AI1): creature AI, bots, crowd steering, and needs |
| `database` | editor | `core` | Editor module: Database workspace: data grid, query console, audit log |
| `debug` | editor | `core` | Editor module: Debug: play-mode viewport |
| `dungeons` | editor; gateway extensions | `character` | Dungeon instances (D1): pool, content, InstanceManager as a gateway extension |
| `economy` | server: `wallet`, `trade`, `vendor`, `auction` | none | Gold wallets, player trades, NPC vendors, and the auction house (EC1) |
| `gathering` | server: `gathering` | none | Resource nodes and the materials pouch (EG1): tree stands, ore veins, fishing spots, and what a player carries from them |
| `props` | server: `chests`, `breaks` | none | The world's chests and doors (IX1) and the props that break in it (IX4, IX5): barrels, crates, urns, and a building's parts |
| `ecs` | editor | `core` | Editor module: ECS inspector viewport for the Scene workspace |
| `flow` | editor | `core` | Editor module: the Flow workspace's flow graph editor |
| `gameplay` | editor | `core` | Editor module: Gameplay data tooling: data grids, content browser, tables, rules |
| `hud` | editor | `core` | Editor module: the Release workspace's HUD layout editor |
| `intent` | server: `intent` | none | Player intent: per-session intent/pickup budgets and the frame cap (T1) |
| `items` | server: `items`; gateway extensions | `economy` | Items in the world (M3a): dropping, pickup, bags, ground expiry |
| `liveops` | editor | `core` | Editor module: Live operations: server & world overview, admin console, telemetry |
| `network` | editor | `core` | Editor module: Network: edge routes and connections |
| `physics` | server: `physics`, `navigation`, `obstacles`, `integrate`, `character-bridge`, `prop-collision`, `collider` | none | Physics domain: Jolt physics, navigation mesh, obstacle cutting, collision, and integration |
| `quests` | gateway extensions | none | Quests and dialogue (P1): the gateway's quest extension and a system checking places and bags |
| `release` | editor | `core` | Editor module: Release: build pipeline and playtests |
| `residents` | server: `residents` | none | Settlement residents (SG3b): the baked towns' people live a day in the world. Also what this game's teaching is worth: it reads `lessons.json` and publishes a `LessonTerms` on `ctx.stores.lessonTerms`, above its own early returns, so a trainer can teach in a world with no baked towns in it |
| `sample-heartbeat` | server: `sample-heartbeat` | `core` | Sample server module: one system that logs a heartbeat every 600 ticks |
| `sample-sidecar` | sidecar | none | Sample sidecar module (EA11): a tiny HTTP health-check server demonstrating the sidecar lifecycle |
| `scenes` | editor | `core` | Editor module: the Scenes workspace's Scene document panel |
| `social` | — | none | Social domain stores: guilds, friends/blocks, and parties (SQLite-backed) |
| `story` | editor | `core` | Editor module: the Story workspace's quest & dialog editor |
| `template-native` | server: `template-probe`; native | none | Template native module (EA10): proves the N-API toolchain builds and loads |
| `terrain` | editor | `core` | Editor module: Terrain sculpting viewport for the World workspace |
| `vfx` | editor | `core` | Editor module: the Art & audio workspace's VFX particle editor |

## Related

- [BUILDING-A-GAME.md](BUILDING-A-GAME.md) — when to reach for a module, and when data or a rules hook is enough.
- [ARCHITECTURE.md](ARCHITECTURE.md#the-tick) — what a tick does, so you know where your system sits in it.
- `packages/modules/src/index.ts` — the manifest schema and the resolver, with every problem message.
- `packages/engine-core/src/net/ports.ts` — the ports the gateway reads, and what each one must answer.
