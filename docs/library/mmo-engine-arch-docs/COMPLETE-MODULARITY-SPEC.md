# Complete Modularity Spec

**Status:** spec (2026-10-12), Joey's directive: "make the engine completely modular"
**Parents:** `packages/modules` manifest system (EA3/EA9), EA10 native, EA11 sidecar,
EA12 edge, EA13 tools-as-modules, EA17 DB functions, BAKE-OUTPUT-CONTRACT.md

## The problem

The module *loading* system exists and works: manifests, discovery, dependency
ordering, native/sidecar/edge contributions. But the engine itself doesn't use it.
`server.ts` constructs ~30 systems inline (`combat`, `magic`, `quests`, `chat`,
...) and hands them to the assembler as `provided.core`. The `core` module's
manifest is a fixed list, not a composition. Result: the engine is a monolith
with a module system bolted on, not a modular engine.

"Completely modular" means: **the engine is the module system plus a minimal
core. Everything else is a module.**

## What "completely modular" means concretely

1. **Every subsystem is a module.** Combat, magic, quests, chat, guilds, items,
   dungeons, crafting, terrain streaming, baking — each has a `module.json`,
   declares its systems, its dependencies (`dependsOn`), and its tick order
   constraints (`after`/`before`).
2. **`core` is minimal.** World, tick loop, gateway, module assembly. Nothing
   game-specific. A build with only `core` boots an empty world that accepts
   connections — the "hello world" of the engine.
3. **No inline construction in server.ts.** The server reads the enabled set,
   assembles modules, and starts. System instances come from module entries
   (`server.entry` exporting `createSystems`), never from hardcoded `new`.
4. **Client modules exist.** `apps/client` gains the same manifest treatment:
   feature modules (terrain streaming, HUD, VFX, chat UI) discovered and
   composed at startup. A client build is a set of client modules.
5. **Packages stay build-time; modules are run-time.** `packages/*` are npm
   workspaces (libraries). `modules/*` are runtime composable units. A package
   may *implement* a module's systems, but the module is what the engine sees.
6. **Third-party modules are first-class.** The manifest format is public and
   stable. Anyone can write `modules/my-combat/` and enable it instead of the
   built-in one — no fork required.

## Module anatomy (all layers)

```
modules/<name>/
  module.json          # manifest: name, version, dependsOn, contributions
  server.js            # server.entry: createSystems(ctx) -> { id: SimSystem }
  client/              # client contribution (dynamic import)
  native/              # EA10: .node binary
  sidecar/             # EA11: helper process { command, port, health }
  edge/                # EA12: edge deployment { regions, endpoint, capabilities }
  tools/               # EA13: dev tools
  db/                  # EA17: schema functions
```

Every contribution type already exists in the manifest schema. What's new is
*using them for the engine's own subsystems* instead of only for examples.

## Seam contracts (what modules may touch)

A module's systems interact through exactly three channels:

1. **ECS components.** The shared data language. Modules read/write components;
   they never reach into another module's internals. New components are
   declared in the module's manifest (`components: [...]`) so the assembler
   can detect conflicts (two modules defining `Health` = boot error, not
   silent overwrite).
2. **The tick order.** `after`/`before` constraints, resolved once at boot.
   No runtime ordering hacks.
3. **Gateway extensions.** Modules that need protocol messages register via
   the existing `GatewayExtension` interface (message type → handler).
   Protocol ranges are allocated per module in the manifest
   (`protocol: { base: 0x40, count: 4 }`) — no more global enum collisions.

Forbidden: importing another module's `src/` directly; constructing another
module's systems; depending on boot order side effects.

## Lifecycle

- **Discovery:** `discoverModules(modulesDir)` lists manifests, validates all.
- **Selection:** `content/modules.json` (or `MMO_MODULES`) names the enabled set.
- **Resolution:** `resolveModuleSet` orders systems, checks deps, detects cycles
  and component conflicts. Any problem stops the boot with every issue listed.
- **Assembly:** each module's entry builds its systems; the result is the same
  plain array the gateway always received.
- **Teardown:** modules expose `dispose()`; the server shuts down in reverse
  dependency order. (New — currently missing.)

## Migration path (slices, not a big bang)

The monolith doesn't get rewritten. Each subsystem is extracted in place:

1. **Pick a subsystem** (start with the most decoupled — see grading).
2. **Write its module.json** declaring systems, deps, order constraints,
   components, protocol range.
3. **Move its construction** from `server.ts` into the module's `server.js`
   entry (`createSystems`). No logic changes.
4. **Declare its seams**: which components it reads/writes, which messages
   it handles, what it needs from `ctx`.
5. **Remove it from `provided.core`.** The assembler now loads it as a module.
6. **Tests:** the subsystem's tests run unchanged; add a boot test that the
   enabled set resolves and the tick order is sane.

`core` shrinks with every slice. When `provided.core` is empty except for the
tick loop and world, the migration is done.

## What stays in core (the irreducible minimum)

- `SimWorld` (the ECS world itself)
- Tick loop + system ordering
- Gateway (transport) — but protocol *handlers* move to modules via extensions
- Module assembly/discovery
- Session/auth plumbing (the gateway needs it to route)

Everything else — combat, magic, quests, chat, items, dungeons, terrain,
baking — is a module.

## Client modularity

`apps/client` gets `client-modules/` with the same manifest shape:
- `terrain-streaming` (the StreamingCoordinator we just built)
- `hud`, `chat-ui`, `vfx`, `entity-layer`, ...
- Each declares its render dependencies and startup order.
- A minimal client (core + terrain-streaming) renders a world with no HUD —
  the embeddable/viewer use case.

## Non-goals

- This doesn't change what the engine *does*, only how it's *composed*.
- No performance work: module boundaries are boot-time, not tick-time.
- The `packages/*` npm structure doesn't change; this is runtime composition.

## Open questions

- Component ownership conflicts: first-claim-wins or explicit override
  declarations in the manifest?
- Hot reload of modules (dev): the reloader system exists — does it extend
  to module entries?
- Versioning: semver ranges on `dependsOn` already exist; do we need
  lockfiles for reproducible module sets?
