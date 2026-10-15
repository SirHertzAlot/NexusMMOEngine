# Wildlife

Wildlife is as dangerous as enemies and bandits, and it is the first challenge a new player must learn: that
the deer bolts, the boar warns before it charges, the wolves come in packs, the bear is to be left alone. This
page is why the numbers are what they are. **Every number lives in
[`packages/engine-core/content/wildlife/wildlife.json`](../packages/engine-core/content/wildlife/wildlife.json)**,
checked by `parseWildlifeTable` (`src/procgen/wildlife-table.ts`, zod schema plus the pyramid and safety rules
below); a table that breaks a rule does not load.

## What is real now, and what is not

With `MMO_WILD_CREATURES=1 MMO_WILDLIFE=1` the table spawns real, moving, fighting creatures. Nothing here is
species-specific code: one brain (`creatures.ts`) runs every kind from numbers, and the kinds are *generated from
the table* (`wildlifeCreatures`, `src/procgen/wildlife-creatures.ts`), so health, damage, notice radius, warning
seconds and group size live in `wildlife.json` and nowhere else. A kind the rules already define (the goblin) wins
over a generated one.

**Real**

- **Creature rules from the table.** Health, `damageX` (a blow is that many goblin blows: the natural weapon's
  mass scales by `damageX^(1/massPower)`, checked against `computeDamage`), group size, notice radius,
  telegraph, tactics, activity, habitat and depth. Derived knobs (documented in the file): leash is a fifth of
  the territory held to 25-150 m, run speed 0.75 + 0.05 per tier (prey run 1.4x faster), blow rate 1.2 s + 0.2 s
  per tier, respawn 300 s, no drops.
- **Natural weapons** are item bases in `content/rules/items.json`: `bite`, `claw`, `tusk`, `horn`, `crush`,
  `tailslam` (reach, which property they use: cut / thrust / bludgeon). `content/wildlife/natural.json` maps a
  species to one, else its role does. A creature's reach grows with its `size`.
- **Temperaments** (`behavior.temperament`): `flee` runs from anyone inside the notice radius until 1.5x clear, then
  walks home; `defend` bluffs (a warning, no strike) and fights back only once hurt (attacker from CombatSystem, else
  the nearest within 20 m); `territorial` warns, then drives the intruder off and gives up when it leaves 1.6x the
  notice radius; `hunt` warns (if it has a telegraph) then chases to its leash; `raid` below.
- **The warning is the existing telegraph (0x1e):** a creature with `telegraphS > 0` stops, faces the player and casts
  a damage-0 cone through `TelegraphSystem`, so every client draws it; the blow comes `telegraphS` later through
  the normal attack intent. Backing away cancels the warning (and it stays calm 6 s).
- **Packs.** One member noticing alerts the group (40 m); `flank` members approach from alternating sides and
  converge inside 6 m; `ambush` creatures notice only half as far (they lie in wait).
- **Day and night.** `activity` is read from the day clock (`MMO_DAY_SECONDS`): outside its hours a creature is
  asleep and notices a quarter as far. Windows: diurnal 06-18, nocturnal 18-06, crepuscular 04:48-08:24 and
  15:36-19:12, cathemeral always.
- **Aquatic.** Water species spawn only where the water is deep enough (the spawner's `blocked` now knows aquatic
  packs), swim (`Locomotion` Swim), hold their `depthM` below the surface through the vertical intent, and never
  swim on toward a cell shallower than their depth (walking creatures keep to land as before). They steer by direct
  intent: the navmesh does not cover water.
- **Raids** (`temperament: raid`, `behavior.raid`): instinct, no planning. When hungry (`hungerSeconds`) the creature
  picks the settlement within `rangeM` with the best size over distance (and at least `minStructures`),
  walks to it, and at each rescan takes the target of greatest weight over distance among players (noise),
  livestock (food, scent) and structures (bulk), by `weights`. After `satiateSeconds` of fighting, or when
  beaten to a quarter of its health, it goes home to its lair and is hungry again after `hungerSeconds`. No
  table species is a raider yet; the megafauna data (`feat/megafauna`) names them.
- **Looks.** A kind's model (first match for the species in the gitignored `content/wildlife/models.local.json`,
  rotating through them) is its `AssetRef` hash (the scatter path's `fnv1a32` of the catalog id), drawn at
  `Transform` scale = `behavior.size`. Nothing is skinned: no walk cycle yet.
- **Settlements.** The boot scene's `Structure` nodes form a settlement (centre, count, radius,
  `sceneSettlements`); its centre is a planner centre, so livestock appears in the ring round it and nothing of tier 2+
  within `safeRadiusM`, and raiders can choose it.
- `MMO_WILDLIFE_LOG=1` logs every pack spawned.

**Not built**

1. Settlement buildings carry no `Health`, so raiders can fight players and livestock but there is nothing to
   smash: destructible structures are the next piece (a raid on an empty town ends after the raider lingers).
2. No wandering: creatures stand at home until they notice something. Herds do not graze or move.
3. Per-species animation (walk, bite, rear up) and an animal Look: models are static meshes.
4. Pack roles beyond left/right flankers (no pincer timing, no retreat of wounded wolves).
5. Prey fleeing from predators and predators hunting prey (only players are noticed).
6. `behavior.size` also scales reach but not the physics capsule, so a megafauna collides like a person.
7. The editor (below).
- `npm run wildlife:plan` still places the same animals as static ambient props.
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

The editor edits `content/rules/creatures.json` (now with `damageX` and `behavior` fields it does not show yet), the species overlay and the biome registry in its Gameplay
grids; the wildlife table (ratios, group sizes, danger tiers, `safeRadiusM`, rings) is **not yet viewable or
editable there**. Follow-up: add a `wildlife` table to `gameplay-tables.ts`/`gameplay-host.ts` and a ratio gauge
per biome (the `biomeCounts` numbers above), reusing `checkWildlife` for the Problems list.
