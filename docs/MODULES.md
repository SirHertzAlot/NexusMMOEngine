# Modules

Everything the engine does beyond its tick loop is a **module**: a folder `modules/<name>/` with a `module.json`. The server's systems (combat, economy, physics), the editor's panels, native C++ code, helper processes and edge services all arrive the same way. This page is the contract: the manifest, how modules are enabled and ordered, and how to write one.

> **Why this page exists.** The wiki's earlier examples ordered systems `"after": ["TransformSystem"]` and returned an array from `createSystems(world)`. Neither is real: system ids are lowercase (`integrate`, `physics`, `combat`), and `createSystems(ctx)` returns an **object keyed by system name**. The wiki now points here.

## How a module is enabled

- **`content/modules.json`** lists the enabled modules: `{ "modules": ["core", "physics", ...] }`. `MMO_MODULES` points the server at a different file. `core` is always on.
- **In the editor**, the Modules workspace turns modules on and off. **Apply modules** restarts the play server, because the server reads the set once, at boot.
- **At boot** the server resolves the dependency order and one tick order, then builds the systems. **Any problem stops the boot and every problem is named**: a dependency that is not installed or not enabled, a dependency cycle, an unknown system id in an `after` or `before`, or a declared system the entry did not return. The engine would rather refuse to start than run half a game.

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
| `native` | `{ entry, systems }`: a compiled N-API `.node` file exporting `createSystems` ([EA10-CPP-MODULES.md](EA10-CPP-MODULES.md)). |
| `sidecar` | A helper process run beside the server, with a readiness `health` check: a `command` string, an `exec` argv array, or a `wasm` file ([EA11-SIDECARS.md](EA11-SIDECARS.md)). |
| `edge` | `{ regions, endpoint, capabilities }`: a service that runs on edge nodes, such as voice or matchmaking ([EA12-EDGE-MODULES.md](EA12-EDGE-MODULES.md)). |
| `tools` | `{ entry, tools }`: host-side dev tools (a bake step, a converter) that never run on the tick ([EA13-TOOLS-AS-MODULES.md](EA13-TOOLS-AS-MODULES.md)). |
| `db` | `{ functions?, caches? }`: stored functions and materialized caches, as `.sql` files under `db/functions/` and `db/caches/`. |

An `entry` is a relative path with no `..`. A server entry is a `.js` or `.mjs` file, an editor entry may be a `.tsx` file, and a native entry ends in `.node`.

## Tick order

A system is declared `{ "name": "...", "after": [...], "before": [...], "optional": true }`. The server resolves **one order from every enabled module's `after` and `before`**, once at boot. Nothing about ordering runs on the tick.

- `after` and `before` name other systems by id, and may be a string or a list.
- `optional: true` lets the entry leave the system out (bots when there are none, the crowd when no navigation backend provides one). The tick order drops it like any unbuilt system. Without `optional`, a declared system the entry does not return stops the boot.
- The real orders are in the manifests. `core` fixes its own (`reloader`, `streamer`, `gathering`, `chests`, `breaks`); `combat` runs `stamina`, `body`, `magic`, `abilities`, `status`, `telegraphs`, `duels`, `combat`, `death`; `physics` pins the character bridge between `integrate` and `prop-collision`:

```json
{ "name": "character-bridge", "after": "integrate", "before": "prop-collision" }
```

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
| `ctx.config` | Per-module bootstrap data the server supplies (game rules, data dirs, callbacks). Optional: tolerate its absence. |
| `ctx.stores` | Shared domain stores. A module that owns a store (economy's wallet, the character store) publishes it here for the server to wire to the gateway. |

A module may also export `dispose(ctx)`; on shutdown the server runs every module's `dispose` in reverse dependency order.

**3. Try it.** Add `"sample-heartbeat"` to `content/modules.json` (or tick it in the editor's Modules workspace and press **Apply modules**). The boot line lists the system between `crowd` and `intent`, and the log shows the heartbeat.

Game rules belong in data, not in a module's code: put tunables in `content/rules/` and read them through the rules package ([ARCHITECTURE.md](ARCHITECTURE.md#game-rules-are-data)).

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
| `core` | server: `reloader`, `streamer`, `gathering`, `chests`, `breaks`; editor | none | The engine's own contribution: the server's systems in their fixed tick order |
| `creatures` | server: `creatures`, `bots`, `crowd`, `needs` | `physics` | Creatures domain (AI1): creature AI, bots, crowd steering, and needs |
| `database` | editor | `core` | Editor module: Database workspace: data grid, query console, audit log |
| `debug` | editor | `core` | Editor module: Debug: play-mode viewport |
| `dungeons` | editor; gateway extensions | `character` | Dungeon instances (D1): pool, content, InstanceManager as a gateway extension |
| `economy` | server: `wallet`, `trade`, `vendor`, `auction` | none | Gold wallets, player trades, NPC vendors, and the auction house (EC1) |
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
| `residents` | server: `residents` | none | Settlement residents (SG3b): the baked towns' people live a day in the world |
| `sample-heartbeat` | server: `sample-heartbeat` | `core` | Sample server module: one system that logs a heartbeat every 600 ticks |
| `sample-sidecar` | sidecar | none | Sample sidecar module (EA11): a tiny HTTP health-check server demonstrating the sidecar lifecycle |
| `scenes` | editor | `core` | Editor module: the Scenes workspace's Scene document panel |
| `social` | — | none | Social domain stores: guilds, friends/blocks, and parties (SQLite-backed) |
| `story` | editor | `core` | Editor module: the Story workspace's quest & dialog editor |
| `template-native` | server: `template-probe`; native | none | Template native module (EA10): proves the N-API toolchain builds and loads |
| `terrain` | editor | `core` | Editor module: Terrain sculpting viewport for the World workspace |
| `vfx` | editor | `core` | Editor module: the Art & audio workspace's VFX particle editor |

## Related

- [EDITOR-ARCHITECTURE.md](EDITOR-ARCHITECTURE.md) section 4: why the editor and the server share one module system.
- [EDITOR-AUTHORING.md](EDITOR-AUTHORING.md): adding editor panels from a module.
- `packages/modules/src/index.ts`: the manifest schema and the resolver, with every problem message.
