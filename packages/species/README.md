# @mmo-engine/species

Creature species as data, and where they live.

A species has:

- a **kind**: organic, beast, undead, demon or otherworldly
- a **habitat**: open-world biomes by weight, and dungeon themes by weight with
  the room depth it lives at
- its **sustenance**: food, water, rest, emotion, lifeforce, necromancy or none
- pack size, the spawn tiers it fills, whether it can lead a boss room, the
  lowest dungeon rank it appears at, and the room archetypes it's drawn to

The built-in roster (`BUILTIN_SPECIES`) is our game's ecology:

- **Goblins, orcs, trolls and ogres** prefer the open world. Some also raid the
  shallow parts of dungeons.
- **Beasts** roam the world. Giant spiders also nest below.
- **The undead** (skeletons, ghouls, wraiths, bone champions, liches) and the
  **otherworldly** (elemental shards, void watchers) dwell in dungeons.
- **Demons** (imps, fiends, infernal brutes, pit lords) manifest only in
  dungeons, where they feed on emotion and lifeforce. `loadSpecies` rejects a
  demon with a world habitat.
- The living never share a doorway with demons or the undead
  (`kindsCoexist`).

```ts
import { loadSpecies, pickWorldPack, worldSpawnTable } from "@mmo-engine/species";

const roster = loadSpecies("ours.json");    // merged over BUILTIN_SPECIES, by id
worldSpawnTable(roster, "forest");           // [{ id: "bear", weight: 2 }, ...]
pickWorldPack(roster, "forest", rng);        // { id: "goblin", count: 4 }
```

Dungeons are populated from the same roster by `populateDungeon` in
`@mmo-engine/dungeon`.
