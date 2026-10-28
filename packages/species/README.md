# @mmo-engine/species

Creature species as data, and where they live.

A species has:

- a **kind**: organic, beast, undead, demon or otherworldly
- a **needs** declaration: weighted need ids (food, water, thermal, habitat…)
  with tolerances, scored against the world's condition fields by `suitability`
- a legacy **habitat** (optional): open-world biomes by weight, and dungeon
  themes by weight with the room depth it lives at — kept for existing game
  files, superseded by needs
- pack size, the spawn tiers it fills, whether it can lead a boss room, the
  lowest dungeon rank it appears at, and the room archetypes it's drawn to

The sample roster is **data, not code**: `content/species/species.json` plus the
need catalog in `content/species/needs.json`. There is no built-in bestiary in
the engine source — a game ships its own directory (override with
`MMO_SPECIES_DIR`) and `loadSpecies` merges it over the sample pack by id.

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
import { loadSpeciesPack, suitability, pickWorldPack } from "@mmo-engine/species";

const { roster, catalog } = loadSpeciesPack();   // sample pack data, no builtins
suitability(catalog, roster.goblin.needs, pos, fields);  // 0 = hard exclusion
pickWorldPack(roster, "forest", rng);             // legacy habitat-world path
```

Needs evaluation runs off the tick: `NeedStateStore` + `NeedBatchRunner` in
`need-state.ts` decay and refill per-entity need levels at the draft cadence
(instinct 1 Hz, social 0.2 Hz, strategic on-demand); `needIntensity` feeds the
decision-substrate seam's state digest.
