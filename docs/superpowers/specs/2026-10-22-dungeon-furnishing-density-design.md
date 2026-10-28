# Dungeon furnishing C: dense, realistic rooms

## Intent
Parts A and B put props in arrangements and gave them shapes, but a room still holds a handful of items. The user's direction
(2026-10-22): rooms should read as the real thing at real quantity. A crypt holds many coffins. A barracks is rows of bunks, each
with a place for the soldier's gear, lockers, racks. An armoury is a cache of the different arms and armour different fighters need.
A library is rows and rows of shelves and reading tables. A chapel has plenty of pews looking at an altar, with a huge statue of the
patron behind it and paintings of them on the walls. A jail is rows of cells. "And so on": every room type gets that treatment.

## Goals
1. **Density by archetype**: counts rise to realistic numbers (a crypt 10 to 24 coffins plus sarcophagi down the middle; a barracks 8 to 16 bunks, each with
   a footlocker; a library 8 to 20 shelves and 4 to 12 reading tables with benches; a chapel 10 to 24 pews). The room's area
   budget (`dress.ts`: the floor fraction the inventory may fill) becomes per-archetype (`fill`, default today's 0.6), so
   dense rooms may fill more of the floor while still leaving every doorway reachable (the guard from part A stays).
2. **Richer vocabulary of patterns** in `arrange.ts` / `dress.ts` (data-driven, as part A):
   - `row` also for **mounted** lines (paintings, shields, banners hung along a wall at their `lift`), spaced by `gap`;
   - `line`: items down the room's long axis through the centre (a hall of pillars, sarcophagi down a crypt), `at` the offset across it;
   - `before`: **one item in front of each** item of the anchor kind (a footlocker at the foot of every bunk, a bench before every table);
   - more `row` passes (up to 8) so a long list of items fills several walls.
3. **More kinds of prop** (about 30), with collision boxes in `props.json` and a procedural mesh each (part B's `prop-mesh.ts`), because
   the dressing can only place what exists: bunk-bed, footlocker, gear-locker, sword-rack, spear-rack, bow-rack, shield-rack, armour-stand
   (exists), workbench, lectern, scroll-rack, bench, reading-table, candle-stand, altar, statue-large (the patron's), painting (mounted),
   shield-wall (mounted), jail-cell, stocks, guard-desk, key-rack, hearth, cauldron, bone-pile, skull-shelf, carpet (flat runner), pulpit,
   quench-trough, coal-bin, tool-rack, long-table, serving-counter.
4. **New room archetypes**: `jail` (rows of cells down both walls, a guard desk and key rack at the door side; stocks and a rack at rank 3+),
   `messhall` (long tables with benches in rows, a hearth, barrels, a serving counter), and a bigger `forge`, `vault`, `throne` hall
   (two lines of pillars, a carpet runner, banners, statues flanking the dais), `ritual`, `storeroom`. Each room type gets a real inventory
   (the recipes are data in `dressing.ts`; see "Rooms").
5. **Look**: in the running client, one 360° sweep per room type, with the procedural props and (locally, never on GitHub) with the licensed art.

## Rooms (my proposal; data, easy to change)
- **crypt**: coffins in rows along every wall (10 to 24), sarcophagi in a `line` down the middle (2 to 5), candle stands between, urns in the
  corners, a bone pile or two, a saint's statue at the far wall.
- **barracks**: bunk-beds in rows on the long walls (8 to 16), a footlocker `before` each, gear lockers in a row by the door, a weapon rack and an
  armour stand, a table with benches in the middle.
- **armoury**: sword, spear, bow and shield racks in rows (6 to 14 across the kinds), armour stands in a row (4 to 8), shield-wall mounted, a workbench,
  crates of arrows, barrels.
- **library**: bookshelves in rows (8 to 20), reading tables in a grid with a bench `before` each, lecterns, scroll racks, candle stands, a desk.
- **chapel**: a statue-large against the head wall, an altar `before` it, candle stands flanking the altar, pews in a grid (10 to 24) facing the altar,
  paintings mounted along both side walls, a lectern or pulpit.
- **jail**: jail-cells in rows on both long walls (6 to 16), a guard desk and key rack, stocks and a torture rack at higher rank, buckets/bone piles.
- **messhall**: long tables in a grid (4 to 10) with a bench `before` each, a hearth on a wall, barrels, a serving counter.
- **vault**: chests in rows (6 to 14), coin piles `beside`, shelves, statues; gilded chests at rank 3+.
- **forge**: smelter (hearth) on a wall, anvils (2 to 3) `beside`, quench trough, coal bins, tool racks, a workbench.
- **throne hall**: dais and throne on the far wall, a carpet runner `line`, two `line`s of pillars, statues flanking, braziers, banners mounted.
- **ritual**: circle at the centre, candles in a ring, an altar, a cauldron, bookstands, cages in a row.
- **storeroom**: shelves, crates and barrels in rows, sacks.
- grotto, icehall, hall: more of what they have (mushrooms, ice pillars, rubble), scatter.

## Non-goals
- Rebalancing the room mix or tying the boss room to its boss (still decided out); lighting; the shell; animation; enemies.
- Interactive props (opening chests, sitting, loot from lockers): these are scenery.
- Any licensed art committed or uploaded: GitHub gets procedural-mesh pictures only; the art captures stay local.

## Anti-goals
- A room too full to walk: every doorway stays reachable (the part A guard), a minimum clear aisle through the middle of a dense room.
- Frame rate: the instance spawns each prop as a static entity, so a dungeon goes from about 150 to a few hundred props; instanced rendering
  handles that, but a test pins the count per dungeon below a ceiling (default 700) and the bake reports it.
- Special cases per room type in code: arrangements stay data; the code knows patterns.

## Constraints
- The dungeon file format is unchanged (`dressing.props`); new kinds need a `props.json` entry or they do not spawn (they are counted in
  `unspawnedProps`) and a recipe (a test pins the two lists equal).
- Deterministic per seed; scatter-only and part A/B dressings stay valid. The built-in dressing changes, so the pool needs a rebake to show
  this (again only when the user says so).
- One PR, stacked on part B (`feat/dungeon-furnishing-density`), roadmap row DF3.

## Left to the builder
Exact counts and proportions, the recipes of the new meshes, the aisle rule, pattern details (spacing, margins), tests' tolerances.
