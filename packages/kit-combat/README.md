# `@mmo-engine/kit-combat`

The fighting this engine ships with. It is a kit, not a part of the engine:
nothing in `@mmo-engine/engine-core` imports it, and a game that wants
different fighting does not have to work around this one.

## What is in it

Nine systems, in the order a host ticks them:

| System | What it does |
| --- | --- |
| `CombatSystem` | A swing: reach, facing, the technique's timing, the blow it lands |
| `AbilitySystem` | Cooldowns, costs and the effects an ability applies |
| `TelegraphSystem` | The wind-up a defender can see and step out of |
| `StatusSystem` | What a landed effect leaves behind, and when it lapses |
| `DuelSystem` | Two entities who agreed to fight, and who won |
| `BodySystem` | Parts, wounds, bleeding, and treating them |
| `MagicSystem` | Mana, casts, and what a cast puts in the world |
| `StaminaSystem` | What a swing costs and how fast it comes back |
| `DeathSystem` | Dying, what is left behind, and respawning |

Plus `defaultDungeonCombat`, which fills a dungeon run's combat slot
(`DungeonCombatContext` in the engine) with those three of them a run needs.

## How a host finds them

By port, never by class. Six of the nine declare what they offer:

```ts
readonly [PORTS] = ["combat"];
```

so a host asks its `PortSet` for `combat`, `life`, `abilities`, `telegraphs`,
`statuses` or `duels` and takes whatever answers. The other three are reached
the way they were built: `StaminaSystem` is handed to `CombatSystem`, and
`BodySystem` and `MagicSystem` are passed to the gateway as its `BodyPort` and
`MagicPort` (making those two table ports as well is on the roadmap).

A port nothing offers is a feature that run lacks, not an error, so a game
can drop this kit, keep part of it, or replace one system and leave the rest. `packages/engine-core/src/net/ports.ts` holds the table;
`docs/MODULES.md` explains it.

## Replacing it

Three ways, cheapest first:

1. **Retune it.** The numbers are in `content/` and the rules files, not in
   this code.
2. **Write a hook.** `loadGameRules` takes overrides; each one gets the
   engine's own version to wrap.
3. **Write your own system.** Offer the same port and the host will find it.
   Nothing here is privileged: this kit is the same kind of package yours
   would be.

Forking this package is the fourth way, and it is a supported one. The whole
of it is yours to change.

## Imports

The source files import `@mmo-engine/engine-core` and nothing else from the
engine — a bare specifier, the package's public surface, which is what a kit
you write would have.

The tests reach further. Several of them boot a whole region gateway to watch
fighting happen inside it, so they import engine internals by path
(`@mmo-engine/engine-core/dist/src/rules/boot.js`) and use engine-core's own
test harness (`@mmo-engine/engine-core/dist/test/net/headless-client.js`). That
is deliberate: those are integration tests, and a deep path says so instead of
quietly widening the engine's public API to make a test look tidy.
`test/kit-boundary.test.ts` holds that line.
