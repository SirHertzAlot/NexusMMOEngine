# 02. Engine / Game Decoupling (The Blank Substrate)

[← Previous: Architectural Blueprint](01-architecture-overview.md) | [Back to Wiki Index](README.md) | [Next: Simulation & ECS Subsystem →](03-ecs-and-simulation.md)

---

## 1. Design Philosophy: The Unconstrained Substrate

Traditional game engines often bundle pre-built gameplay frameworks (character classes, inventory slots, attribute sets, combat loops). While useful for quick prototypes, these frameworks force developers building non-conforming games (flight simulators, space exploration, puzzle sandboxes, racing games) to spend immense effort tearing out or fighting default behavior.

The Nexus MMO Engine solves this through strict **Engine / Game Decoupling**:

> **Axiom**: The engine core owns only generic mathematical, spatial, scheduling, and networking mechanisms. It boots cleanly with zero gameplay content.

---

## 2. Boot Architecture

```
                  ┌─────────────────────────────────────┐
                  │      Engine Core (Generic Only)     │
                  │   TickLoop, ECS World, Net, Spatial │
                  └──────────────────┬──────────────────┘
                                     │
                       Discovers & boots via seams
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
┌──────────────────┐                                   ┌──────────────────┐
│  content/rules/  │                                   │    modules/      │
│  Data Rules      │                                   │  Pluggable Logic │
│  (Zod-validated) │                                   │  (module.json)   │
└──────────────────┘                                   └──────────────────┘
```

### Clean Boot Behavior
- If launched with no content packs, the server starts as a blank 30 Hz spatial simulator.
- No default character species, items, skills, or factions exist in memory.
- The server does not throw errors on missing game data; it simply treats rule sets as empty.

---

## 3. Pluggable Modular Architecture (`modules/`)

All gameplay features are isolated into modular packages located in [`modules/<name>/`](file:///c:/Users/user/Downloads/mmo-engine-full/modules).

### Anatomy of a Module: `module.json`
Every module declares its metadata and server execution hooks:
```json
{
  "name": "space-flight",
  "version": "1.0.0",
  "description": "Orbital mechanics and thrust vectors",
  "server": {
    "entry": "dist/index.js",
    "systems": [
      { "name": "ThrustSystem", "after": ["TransformSystem"] },
      { "name": "GravitySystem", "after": ["ThrustSystem"] }
    ]
  }
}
```

### Module Selection: `content/modules.json`
Modules are enabled or disabled by listing their names in [`content/modules.json`](file:///c:/Users/user/Downloads/mmo-engine-full/content/modules.json):
```json
{
  "modules": [
    "core",
    "physics",
    "space-flight"
  ]
}
```
If a developer does not want RPG combat, dungeons, or crafting, they remove those names from `modules.json`. The engine will **never allocate memory, compile, or tick those systems**.

---

## 4. Data-Driven Rule Contracts (`packages/rules`)

Game rules are defined entirely as JSON data files located under `content/rules/`:
- `body.json`: Anatomical body parts, hit locations, and damage distribution.
- `skills.json`: Skill trees, proficiency curves, and discipline affinities.
- `combat.json`: Defense contests, posture recovery rates, and weapon technique parameters.

### Validation at Boot
The [`@mmo-engine/rules`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/rules) package inspects all rules against strict Zod schemas:
- A missing rule pack causes the engine to use inert defaults.
- A present but malformed rule pack halts the boot sequence immediately, specifying the exact file, path, and error:
  ```
  [server] invalid rules:
    content/rules/body.json: parts.3.share: expected number, received string
  ```

---

## 5. Authoring a Custom Game

To build a new game on top of the engine:

1. **Create Custom Modules**: Add a new folder in `modules/my-game/` with a `module.json`.
2. **Export System Factories**:
   ```ts
   import type { SimWorld } from "@mmo-engine/engine-core";
   
   export function createSystems(world: SimWorld) {
     return [
       {
         name: "OrbitalSystem",
         step: (dt: number) => {
           // Iterate over custom bitECS components
         }
       }
     ];
   }
   ```
3. **Register in `content/modules.json`**: Enable your module and disable any unneeded modules.
4. **Point to Custom Data**: Point the `MMO_RULES` environment variable to your custom rule folder.

---

[← Previous: Architectural Blueprint](01-architecture-overview.md) | [Back to Wiki Index](README.md) | [Next: Simulation & ECS Subsystem →](03-ecs-and-simulation.md)
