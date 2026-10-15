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
     imported ones are not skinned or animated);
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
| 5 | boss (megafauna) | short-faced bear, megalodon, mammoth | 1600 m, from the spawn only (see below) |

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

## Megafauna: mega predators and megaherbivores as mini bosses

Tier 5 is the prehistoric record scaled to a fight: animals far larger, faster and stronger than a human, as
dangerous as orcs, trolls and golems and with none of their cunning. They act on instinct alone
(`boss.intelligence: 0`, enforced by the schema): no talk, no tactics beyond what the animal does, no
bargaining. Everything is in `content/wildlife/wildlife.json` (`species.*.boss`, `megafauna`), checked by
`checkMegafauna`; a table that breaks a bound does not load. They are outside the pyramid (`biomeCounts` skips
them, the per-chunk planner never places them): their own planner is `planMegafauna` (`megafauna.ts`).

**Strength against the creature yardstick.** `content/rules/creatures.json` has only the goblin (60 hp, damage 1).
The orc, troll and golem do not exist as rules yet, so `megafauna.yardsticks` names the design values bosses
are read against (they are not shipped creatures): goblin 60, orc 180 (3 goblins), troll 500, golem 1000 hp.
A boss has 2 to 8 trolls of health (1000 to 4000 hp, `healthTrolls`; 3 to 6 for most) and hits 6 to 16 times a
goblin's blow (`damageX`; bear 2.4 and orca 3.0 are the old apex). The ratio is what makes one a mini boss: a
party of 4 to 6 geared players, with a telegraph (`telegraphS` >= 2.5 s) and weak points to exploit.

| Boss | Kind | Body m (L x H) | Model scale | HP (trolls) | Dmg x | Speed x sprint | Notice m | Warn s | Lives | Rarity /100 km2 | Raids |
|---|---|---|---|---|---|---|---|---|---|---|---|
| short-faced-bear | land hunter | 3.8 x 2.4 | 1.9 | 2200 (4.4) | 9 | 1.35 | 60 | 3.0 | forest, plains, mountains, tundra | 1.5 | edge, livestock/structures/players |
| sabre-tooth | land ambusher | 3.0 x 1.4 | 2.7 | 1700 (3.4) | 8 | 1.7 | 70 | 2.5 | forest, plains, rainforest | 1.5 | edge, livestock/players |
| dire-wolf (alpha, 4 to 7 wolves) | land pack | 3.0 x 1.6 | 2.5 | 1500 (3.0) | 7 | 1.6 | 80 | 3.0 | forest, plains, tundra, snow | 1.2 | direct, livestock/players |
| terror-bird | land runner | 3.0 x 4.0 | 6.8 | 1400 (2.8) | 7 | 2.0 | 90 | 2.5 | plains, forest | 1.2 | direct, livestock/players |
| giant-monitor | land ambusher | 5.5 x 1.2 | 5.5 | 1600 (3.2) | 7 | 1.3 | 40 | 3.0 | swamp, rainforest, plains | 1.0 | edge, livestock/players |
| giant-crocodilian | shore ambusher | 10.0 x 2.0 | 10 | 2800 (5.6) | 11 | 1.2 land, 1.8 swim | 50 | 3.0 | swamp, rainforest, lake | 1.2 | along water, livestock/players/boats |
| giant-constrictor | land ambusher | 12.0 x 1.0 | 12 | 1800 (3.6) | 6.5 | 1.2 | 25 | 2.5 | swamp, rainforest | 1.0 | edge, livestock/players |
| mammoth | megaherbivore | 6.0 x 4.0 | 2.5 | 3000 (6.0) | 10 | 1.25 | 35 | 3.5 | tundra, snow, plains | 1.2 | none (rut, provoked) |
| woolly-rhino | megaherbivore | 4.2 x 2.0 | 3.2 | 2000 (4.0) | 9.5 | 1.5 | 30 | 2.5 | tundra, plains | 1.2 | none (rut, provoked) |
| giant-ground-sloth | megaherbivore | 6.0 x 3.0 | 3.0 | 2600 (5.2) | 8.5 | 1.1 | 20 | 4.0 | forest, rainforest, swamp | 1.0 | none (defends young) |
| megalodon | sea hunter | 16 x 4 | 5.3 | 3500 (7.0) | 12 | 1.9 swim | 90 | 3.0 | sea 6 to 200 m | 1.2 | along water, boats/players/piers |
| raptorial-whale | sea hunter | 15 x 4 | 1.9 | 4000 (8.0) | 13 | 2.0 swim | 100 | 3.5 | sea 10 to 300 m | 0.6 | along water, boats/players |
| mosasaur | sea ambusher | 12 x 2.5 | 4.0 | 3000 (6.0) | 11 | 2.1 swim | 70 | 3.0 | sea 3 to 80 m, lakes | 1.0 | along water, boats/players/livestock |
| giant-squid (kraken-scale) | sea ambusher | 16 x 5 | 20 | 3200 (6.4) | 10 | 1.6 swim | 50 | 3.0 | sea 8 to 400 m | 0.6 | along water, boats/piers/players |
| giant-eel | sea ambusher | 9 x 1.2 | 7.5 | 1500 (3.0) | 6.5 | 1.8 swim | 25 | 2.5 | sea, lakes 2 to 40 m | 1.2 | along water, livestock/players/boats |

Speeds are multiples of the player's sprint: even the sloth (1.1) cannot be outrun, the fastest (terror bird 2.0,
mosasaur 2.1) cannot be escaped on foot or by swimming; the answer is a door, a boat, a trap or a party.
`megafauna.minSpeedX` (1.1) and `minSwimSpeedX` (1.3) are checked. A giant flying predator is not in the table: the
habitat rules are land, shore and water, with no altitude, so it waits for an air habitat.

**Instincts, as data.** `boss.drives` are tags for the brain: `hunger`, `territory`, `scent_blood`,
`scent_food`, `scent_livestock`, `noise` and `season` (the rut). The megaherbivores are `territory`, `noise` and
`season` only: they never raid, they charge what enters the lair, wounds, noise or a smell of food at rut
season. `boss.weakPoints` (`part`, `damageMult`, `staggerS`) are where a hit hurts more and interrupts (the eye of a
crocodile, the throat of a wolf, the foreleg of a mammoth). `boss.loot` names a drop table for the creature rules.

**How rare (a handful per world at most).** Per species `rarityPer100Km2` is at most 2 (`maxRarityPer100Km2`), the
total 20 (`totalRarityPer100Km2`; shipped 16.6) and no world holds more than `maxPerWorld` = 4. On the default
4x4 km world (16 km2) the rarity sum gives 2.7 bosses on average if every habitat exists; the synthetic run in
the tests, with sea round the edge and mixed land, gives 1.5 (0 in 18%, 4 in 4%). `boss:predator` is checked
per biome: a boss is at most 5% as common as the predator groups it lives among (`bossToPredator`), so the
pyramid above is unchanged (bosses do not count in it).

**Where (`planMegafauna`).** Per species the world draws a count (rarity x area, rounded by a seeded draw), then
for each lair tries 48 seeded points and takes the first that: has biome weight (accepted with weight over the
species' largest, so the table's biome weights matter), suits the habitat (water bosses in water within `depthM`,
land bosses dry, shore bosses by the water), is allowed tier 5 by the rings measured from the spawn only (1600 m,
past the tier 4 ring at 1500 m; so never in the safe radius), is >= 500 m from any settlement and >= 800 m from
another lair, and leans toward megaflora groves by the species' `lair.floraBias` (pass `groveAt: (x, z) =>
megaGroveAt(plan, x, z)`). The result is capped at `maxPerWorld`, dropping the lowest seeded scores. Pure and
seeded: same inputs, same lairs.

**Settlement raids (`raid`, `raidTargets`).** A raiding boss targets a settlement only if all thresholds hold:
population >= `minPopulation` (>= 300, `raidMinPopulation`, i.e. towns not hamlets), `minStructures`,
`minLivestock`, `minFoodStores`, within `rangeM` of its lair, reachable by its `approach` (`habitat_edge`: leaves its
biome's edge nearest the town; `along_water`: by river, lake or sea, so only waterside towns, and water bosses
must use it; `direct`: straight from the lair), and not inside `safeRadiusM` of the spawn unless the species'
raid sets `allowInsideSafeRadius`. Between raids it waits `cooldownS` (>= 7200 s). `targets` are livestock,
structures, players, boats; it retreats when fed (`satiatedMeals`), below `hpBelowPct` health or after `maxS`.
`warningSigns` (`tracks`, `claw_marks`, `carcass`, `wake`, `noise`, `bones`) are the dressing the settlement can
find `leadS` seconds before, within `radiusM`, so a raid is learnable: spawning that dressing is a follow-up.

**Models.** `bossModels` maps each boss to static catalog models: its own `models` name words (minus
`modelsNot`: heads, props, items), else its `base` species' models; the scale is the boss' `lengthM` over the
model's longer horizontal side (or `base.lengthM` if the catalog has no size); a model that would need more than
`maxModelScale` (20) is skipped. `npm run wildlife:models` writes `content/wildlife/megafauna.local.json` beside
`models.local.json` (gitignored, lists licensed ids). On the local catalog: own model for short-faced-bear,
sabre-tooth, dire-wolf, terror-bird (a turkey, x4.5), giant-constrictor, megalodon, raptorial-whale, giant-squid,
giant-eel; scaled from the base species' model for giant-monitor and giant-crocodilian (snake), mammoth (bull),
woolly-rhino (boar), giant-ground-sloth (bear) and mosasaur (shark); none without a model. They are static props
until a creature look and animation exist.

### Megaflora

`megaflora` entries are giant ancient plants as ecology layers (`megafloraLayers`, `withMegaflora`, written by
`npm run wildlife:plan` to the gitignored plan). The size is the layer's `scale` (1.5 to 8 times the model's
natural size, `MEGAFLORA_SCALE`, validated), on top of the global dial for its category (`tree` or `plant` in
`content/scale.json`): no new scale category was needed. Kinds: `giant-fern`, `giant-horsetail` (fronds, no
collision), `scale-tree` (club-moss/lepidodendron-like trunks), `giant-cycad`, `giant-fungus` (prototaxites,
5 to 8 m caps) and `giant-pitcher` (a carnivorous plant with a `hazard`: radius, `damageX`, a telegraph).
Trunks and stems use a box fitted to 15% of the footprint (`fit`), so the trunk collides and the crown does not;
fronds, fern leaves and caps are `none`. They live in humid lowlands by biome weights (swamp, rainforest, a
little forest; zero everywhere else, since each layer reads a biome group named after itself) and grow in groves
(the `megaGrove` noise field, 220 m features). Lairs lean toward groves, so a giant constrictor's lair is in the
thick of it. On the local catalog: giant ferns 4 models, scale trees 1 (palm), giant fungus 5, no cycad,
horsetail or pitcher models yet.

## Art models

A species' `models` are generic name words matched against the local art catalog, so no licensed model name is
committed. `npm run build -w @mmo-engine/engine-core && node packages/engine-core/dist/src/procgen/wildlife-table.js`
writes the species-to-model-id map to the gitignored `content/wildlife/models.local.json`. Free swimmers and
anything skinned are only shown once the engine can animate them.

## Editor parity

The editor edits `content/rules/creatures.json`, the species overlay and the biome registry in its Gameplay
grids; the wildlife table (ratios, group sizes, danger tiers, `safeRadiusM`, rings) is **not yet viewable or
editable there** (nor the megafauna block or raid rules). Follow-up: add a `wildlife` table to `gameplay-tables.ts`/`gameplay-host.ts` and a ratio gauge
per biome (the `biomeCounts` numbers above), reusing `checkWildlife` for the Problems list.
