# Documentation

Documentation for people building a game on this engine.

**New here?** [GETTING-STARTED.md](GETTING-STARTED.md) gets you from a fresh
clone to walking around a world. [CAPABILITIES.md](CAPABILITIES.md) tells you
what the engine can do and what it cannot. [BUILDING-A-GAME.md](BUILDING-A-GAME.md)
tells you how to use it well.

## Start here

| Doc | What it is |
|---|---|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Fresh clone to a playable world: prerequisites, `npm start`, the editor, troubleshooting |
| [CAPABILITIES.md](CAPABILITIES.md) | What the engine can do, what is partial, and what it is not |
| [BUILDING-A-GAME.md](BUILDING-A-GAME.md) | The opinionated guide: what is yours to change, in what order, and the directives that keep you fast |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit: the tick, the ECS, replication, persistence, streaming |
| [PERFORMANCE.md](PERFORMANCE.md) | What the engine costs today, measured, and what that means for the game you build |

## Extending the engine

| Doc | What it is |
|---|---|
| [MODULES.md](MODULES.md) | The module system: the manifest, ordering, and how to write server, editor, native, sidecar, edge, tools and database modules |
| [CLIENT.md](CLIENT.md) | The mirror client: prediction, cosmetic physics, rendering layers |
| [MESSAGE-CATALOG.md](MESSAGE-CATALOG.md) | The client/server wire protocol, message by message |
| [EDITOR.md](EDITOR.md) | The editor: inspectors, play mode, debugger, terrain, art pipeline |

## Content and worlds

| Doc | What it is |
|---|---|
| [WORLD-BUILDING.md](WORLD-BUILDING.md) | Design or regenerate a world: specs, biomes, baking, terrain editing |
| [PROCEDURAL-GENERATION.md](PROCEDURAL-GENERATION.md) | PICG graphs, scatter plans and procedural assets |
| [SETTLEMENTS.md](SETTLEMENTS.md) | Procedural towns, roads and the places between them |
| [DUNGEONS-AND-LOOT.md](DUNGEONS-AND-LOOT.md) | Dungeon generation, species, ranks, loot, crafting |
| [WILDLIFE.md](WILDLIFE.md) | Creature ecologies and spawn tables |
| [ART-PIPELINE.md](ART-PIPELINE.md) | The art manifest contract and the conversion tools |

## Gameplay systems that ship

These describe the systems in the box. They are useful as a reference and as
a worked example; they are not a specification you must keep.

| Doc | What it is |
|---|---|
| [GAMEPLAY.md](GAMEPLAY.md) | Movement, combat, creatures, needs, gathering, economy, and how to extend each |
| [MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md) | Mastery, skills, stats, and the combat ruleset |
| [CHARACTERS-AND-SOCIAL.md](CHARACTERS-AND-SOCIAL.md) | Characters, social systems, and their data model |

## Running it

| Doc | What it is |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | Processes, ports, health and metrics, state and logs, failure behaviour, security checklist |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable and data file |
| [CLI.md](CLI.md) | Every command, plus admin console commands, chat commands and keys |
| [WORLD-SERVER.md](WORLD-SERVER.md) | The world server: registry, leases, hand-offs, the durable record |
| [ADMIN-COOKBOOK.md](ADMIN-COOKBOOK.md) | Placing and managing authorable things in-game as an admin |

## Project

| Doc | What it is |
|---|---|
| [ROADMAP.md](ROADMAP.md) | The official task board: built, in progress, planned, with an update log |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch workflow, tests, code standards |

[internals/](internals/) holds subsystem design references that source code
points at by path. They are engineering notes, not part of this
documentation set.

---

**Keeping this honest.** `python3 scripts/docs-audit.py` checks these docs
against the code: relative links, repository paths named in backticks,
`MMO_*` variables, npm scripts, workspace packages and protocol message
codes. It cannot tell you a paragraph is out of date, so read as well as run.
