# Wildlife

Wildlife is as dangerous as enemies and bandits, and it is the first challenge a new player must learn: that
the deer bolts, the boar warns before it charges, the wolves come in packs, the bear is to be left alone. This
page is why the numbers are what they are. **Every number lives in
[`packages/engine-core/content/wildlife/wildlife.json`](../packages/engine-core/content/wildlife/wildlife.json)**,
checked by `parseWildlifeTable` (`src/procgen/wildlife-table.ts`, zod schema plus the pyramid and safety rules
below); a table that breaks a rule does not load.

## What exists today, and what does not

- **Real, moving, fighting creatures exist.** `CreatureSystem` (`creatures.ts`) runs a brain per creature (idle at
  home, chase when a living character comes inside `aggroRadius`, swing through intent, return home past
  `leashRadius`), packs spawn together, and `WildCreatures` spawns a biome's packs as chunks load
  (`MMO_WILD_CREATURES=1`, `content/biomes.json`). Species come from `content/rules/creatures.json`; only the
  goblin is defined there, so the registry's wolves and bears wait for rules.
- **This table drives what, where and how many.** With `MMO_WILDLIFE=1` the server also plans the wildlife table
  (`planWildlifeChunk`, via `WildCreatures.extraPlan`): ratios, danger ramp, safe radius, aquatic depths, livestock
  ring. A species only spawns once it has creature rules; until then it is planned out, like the registry's.
- **Missing for real wildlife behaviour** (not built; the data is ready for it):
  1. creature rules for these species. A creature carries an item-base weapon (`dagger`, `axe`, ...); animals need
     natural-weapon bases (bite, claw, tusk, horn) with the table's `damageX` and `health`;
  2. brain modes beyond idle/chase/return: `flee` (skittish), `defend` (fight only when hit or with young),
     territorial warning with `telegraphS`, pack `flank` and `ambush` tactics, activity by time of day
     (`MMO_DAY_SECONDS` gives the engine a day clock; nothing reads `activity` yet);
  3. a look for non-humanoid creatures (`lookOf` returns a character Look; animal GLBs are static props, and the
     imported ones are not skinned or animated; the client already rigs and animates a moving entity that carries
     such a model's `AssetRef`, see [`ART-PIPELINE.md`](ART-PIPELINE.md) "Animals");
  4. aquatic creatures: the wild-pack path skips water (`blocked`) and creatures walk, they do not swim;
  5. settlement centres are not fed to the planner yet (only the spawn), so livestock waits;
  6. the editor (below).
- Until those land, `npm run wildlife:plan` places the same animals as static ambient props.

## The pyramid (why the ratios)

Counted by individuals per biome (groups x mean group size, `biomeCounts`):

- **Predators are 1 in 8 to 1 in 15 of the prey** (`ratios.predatorToPrey` = 0.0667 to 0.125): the usual
  mammal range, because each trophic step keeps about a tenth of the energy.
- **Apex predators are at most 7% of the prey** (`apexToPrey`) and in practice 1 to 5%: bears and cougars are
  solitary, wolves hold large territories, so apex groups are far fewer than mesopredator groups.
- **Large herds, small predator packs**: deer 4 to 10, quail flocks 4 to 9, rabbit colonies 3 to 6; wolves 3 to 6,
  coyotes 2 to 4; bears and cougars alone.
- **Scavengers** (ravens, raccoons) and **livestock** are outside the pyramid; scavengers sit at the edges
  (small `territoryM`, weights near the prey).
- **Density** per biome is `packsPerKm2 x fertility`, then up to `1 + boost` (0.6) times more within
  `waterProximity.rangeM` (250 m) of water, fading with distance: rainforest and forest are rich, snow and
  tundra poor.

| Biome | packs/km2 | fertility | prey ind. | predator ind. | predator:prey | apex:prey |
|---|---|---|---|---|---|---|
| forest | 55 | 1.0 | 63.1 | 5.20 | 1:12.1 | 0.043 |
| plains | 45 | 0.9 | 56.1 | 5.25 | 1:10.7 | 0.024 |
| mountains | 20 | 0.5 | 35.2 | 2.57 | 1:13.7 | 0.048 |
| tundra | 15 | 0.4 | 26.5 | 1.82 | 1:14.5 | 0.050 |
| snow | 10 | 0.3 | 14.5 | 1.17 | 1:12.3 | 0.047 |
| swamp | 40 | 1.0 | 38.8 | 2.88 | 1:13.5 | 0.020 |
| rainforest | 60 | 1.2 | 41.2 | 2.80 | 1:14.7 | 0.012 |
| lake | 20 | 1.0 | 66.5 | 5.20 | 1:12.8 | 0.000 |
| sea | 30 | 1.0 | 45.5 | 3.85 | 1:11.8 | 0.058 |

The planner does not yet place a predator group next to a prey herd (they overlap by biome weight, not by
range); "near but not on top of prey" is approximated by the large `territoryM` it will use for home and leash.

## Danger ramps with distance (a learnable first hour)

`rings` give the highest danger tier allowed from each distance to the nearest spawn or settlement centre, and
`safeRadiusM` (250 m) forbids tier 2 and above inside it; `checkWildlife` refuses a table whose rings break that.

| Tier | Means | Examples | From |
|---|---|---|---|
| 0 | harmless, flees | deer, rabbits, quail, sheep, hens, shoals of fish | the centre |
| 1 | defends itself only | fox (shy), porcupine, raccoon, cow, pig, goat, horse | the centre |
| 2 | solitary, clearly telegraphed | boar, elk bull, bobcat, snake, eel, jellyfish | 250 m (`safeRadiusM`) |
| 3 | packs and big hunters | wolves, coyotes, cougar, shark | 700 m |
| 4 | apex | bear, orca | 1500 m |

Every species of tier 2 or more must have `telegraphS > 0`: a visible warning (a growl, rearing up, a hiss, a
head-lowered stare) before it attacks. Livestock is tier 0 or 1 only, and appears only in the `livestock.radiusM`
ring (20 to 160 m) of a settlement centre, at 150 groups/km2: docile, defensive when attacked or with young.

## Species (inferred from the animals the models depict)

Danger is read off the real animal: bears, wolves, boars, big cats and venomous snakes hurt; deer, rabbits and
sheep run. `Dmg x` is the damage per blow as a multiple of a goblin's, `HP` absolute (goblin 60).

| Species | Role | Habitat | Group | Territory m | Activity | Temperament | Tier | HP | Dmg x | Notice m | Warn s | Tactics |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deer | large_herbivore | land | herd 4-10 | 400 | crepuscular | flee | 0 | 80 | 0.4 | 30 | 0 | none |
| elk | large_herbivore | land | herd 3-8 | 600 | crepuscular | territorial | 2 | 260 | 1.4 | 14 | 2.0 | none |
| boar | large_herbivore | land | herd 2-5 | 250 | cathemeral | defend | 2 | 140 | 1.2 | 10 | 1.5 | none |
| bighorn | large_herbivore | land | herd 3-8 | 500 | diurnal | flee | 1 | 110 | 0.9 | 25 | 0 | none |
| porcupine | large_herbivore | land | solitary 1-1 | 60 | nocturnal | defend | 1 | 30 | 0.5 | 4 | 0 | none |
| rabbit | small_prey | land | herd 3-6 | 60 | crepuscular | flee | 0 | 8 | 0.1 | 18 | 0 | none |
| squirrel | small_prey | land | pair 1-3 | 40 | diurnal | flee | 0 | 6 | 0.1 | 15 | 0 | none |
| quail | small_prey | land | flock 4-9 | 80 | diurnal | flee | 0 | 5 | 0.1 | 12 | 0 | none |
| frog | small_prey | land | flock 3-8 | 30 | nocturnal | flee | 0 | 3 | 0.05 | 8 | 0 | none |
| monkey | small_prey | land | herd 3-8 | 200 | diurnal | flee | 0 | 25 | 0.3 | 20 | 0 | none |
| fox | mesopredator | land | solitary 1-1 | 250 | crepuscular | flee | 1 | 35 | 0.5 | 14 | 0 | none |
| coyote | mesopredator | land | pack 2-4 | 500 | crepuscular | hunt | 3 | 45 | 0.7 | 20 | 1.5 | flank |
| bobcat | mesopredator | land | solitary 1-1 | 400 | nocturnal | territorial | 2 | 70 | 1.0 | 12 | 2.0 | ambush |
| snake | mesopredator | land | solitary 1-1 | 20 | diurnal | defend | 2 | 12 | 1.0 | 4 | 2.5 | ambush |
| wolf | apex_predator | land | pack 3-6 | 1500 | crepuscular | hunt | 3 | 90 | 1.0 | 28 | 3.0 | flank |
| cougar | apex_predator | land | solitary 1-1 | 1200 | nocturnal | hunt | 3 | 120 | 1.6 | 16 | 2.0 | ambush |
| bear | apex_predator | land | solitary 1-1 | 1500 | diurnal | territorial | 4 | 400 | 2.4 | 14 | 2.5 | none |
| raven | scavenger | land | flock 3-8 | 300 | diurnal | flee | 0 | 5 | 0.1 | 15 | 0 | none |
| raccoon | scavenger | land | solitary 1-1 | 80 | nocturnal | defend | 1 | 45 | 0.5 | 6 | 1.5 | none |
| cow | livestock | land | herd 3-8 | 40 | diurnal | defend | 1 | 220 | 1.2 | 8 | 0 | none |
| sheep | livestock | land | flock 5-12 | 40 | diurnal | flee | 0 | 70 | 0.3 | 8 | 0 | none |
| goat | livestock | land | herd 3-7 | 40 | diurnal | defend | 1 | 70 | 0.6 | 8 | 0 | none |
| pig | livestock | land | herd 2-5 | 40 | diurnal | defend | 1 | 110 | 0.7 | 8 | 0 | none |
| horse | livestock | land | pair 1-3 | 40 | diurnal | flee | 1 | 200 | 1.0 | 8 | 0 | none |
| hen | livestock | land | flock 4-10 | 40 | diurnal | flee | 0 | 8 | 0.1 | 8 | 0 | none |
| duck | livestock | land | flock 3-8 | 40 | diurnal | flee | 0 | 12 | 0.1 | 8 | 0 | none |
| fish | aquatic | water 0.5-40 m | shoal 5-15 | 150 | diurnal | flee | 0 | 6 | 0.1 | 10 | 0 | none |
| squid | aquatic | water 2-60 m | shoal 3-8 | 200 | nocturnal | flee | 0 | 20 | 0.2 | 10 | 0 | none |
| shark | aquatic | water 3-60 m | pair 1-2 | 800 | crepuscular | hunt | 3 | 300 | 2.2 | 30 | 3.0 | none |
| orca | aquatic | water 8-80 m | pack 3-5 | 2000 | diurnal | hunt | 4 | 900 | 3.0 | 40 | 3.0 | flank |
| eel | aquatic | water 1-12 m | solitary 1-1 | 40 | nocturnal | defend | 2 | 40 | 1.0 | 5 | 2.0 | ambush |
| octopus | aquatic | water 1-20 m | solitary 1-1 | 40 | nocturnal | defend | 1 | 60 | 0.6 | 6 | 1.5 | ambush |
| otter | mesopredator | shore | pair 1-2 | 150 | diurnal | flee | 1 | 35 | 0.5 | 10 | 0 | none |
| jellyfish | aquatic | water 0.5-15 m | shoal 2-6 | 100 | cathemeral | defend | 2 | 10 | 0.8 | 3 | 1.0 | none |

Aquatic species stand in water within `depthM` (metres below the surface), by the same habitat rule as
`habitat.ts` (water habitat only below the surface, land habitat only above it); land species never appear in
water.

## Art models

A species' `models` are generic name words matched against the local art catalog, so no licensed model name is
committed. `npm run build -w @mmo-engine/engine-core && node packages/engine-core/dist/src/procgen/wildlife-table.js`
writes the species-to-model-id map to the gitignored `content/wildlife/models.local.json`. Free swimmers and
anything skinned are only shown once the engine can animate them.

## Editor parity

The editor edits `content/rules/creatures.json`, the species overlay and the biome registry in its Gameplay
grids; the wildlife table (ratios, group sizes, danger tiers, `safeRadiusM`, rings) is **not yet viewable or
editable there**. Follow-up: add a `wildlife` table to `gameplay-tables.ts`/`gameplay-host.ts` and a ratio gauge
per biome (the `biomeCounts` numbers above), reusing `checkWildlife` for the Problems list.
