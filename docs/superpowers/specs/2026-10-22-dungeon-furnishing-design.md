# Dungeon furnishing: props that look like the room they are in

## Intent
A baked dungeon already knows what every room is (986 rooms in the 30-dungeon pool, each with an archetype: crypt, armoury,
forge, throne, vault, chapel, ...) and what it holds (`dressing.props`, 30 kinds). Two things keep a crypt from looking like
a crypt:

- **Arrangement.** `dress.ts` settles every item on its own: WFC picks the counts, scatter and the raymarcher pick a spot
  (floor, centre, wall, corner). Bedrolls are dotted about instead of laid in rows, pews do not face anything, a weapon rack
  is wherever a wall happened to be free, an anvil is not beside its smelter.
- **Appearance.** In the client every prop is a plain box (no kind has a mesh anywhere).

Fix both inside the pipeline that exists: arrange rooms by archetype in `dress.ts`, and give every kind a recognisable model,
from the licensed art where one matches, else a procedural shape.

## Goals
1. **Arrangement as data.** Each content line of an archetype (`dressing.ts`, `ContentSchema`) may name how its items are
   laid out: `scatter` (today, the default), `row` (evenly along a wall, facing into the room), `grid` (rows and columns
   aligned to the room's axes, all facing one way), `flank` (symmetric pairs either side of the room's focal item), `beside`
   (next to another line's item: an anvil by its smelter), `ring` (round the centre piece). Each also names which way it faces
   (`room`, `wall`, `focal`, `along`). `dress.ts` implements the patterns on the distance field and region it already has;
   an item that does not fit falls back to `scatter`, then to `unplaced`, as now. Built-in archetypes are given arrangements
   (see "Rooms").
2. **Art where it matches.** A local, git-ignored overlay maps prop kinds to licensed catalog models. A step generates it from
   `assets/catalog.json` by name (about half the kinds: weapon-rack, barrel, chest, statue, brazier, throne, anvil, coffin,
   torch, pillar, rubble, crate, table, candles, sack, ...). The server loads it over `props.json`; a prop's `AssetRef` hash is
   `fnv1a32(asset id)`, so a catalog model id makes the client's `SyntyProps` draw it, with no client change. The overlay is
   never committed and the art is never copied.
3. **Procedural fallback.** Every kind without a match (sarcophagus, ritual-circle, bedroll, coin-pile, gilded-chest,
   armour-stand, bookshelf, smelter, reliquary, mushrooms, root-knot, ice-pillar, frozen-body, ...) gets a small mesh built from
   primitives (box, cylinder, cone, ring) with material slots (stone, wood, metal, cloth, gold, bone, ...). One PCGM per kind
   is mounted in the instance's Pcg library (`addPrebaked`, as the shell is) under the kind's committed asset id
   `dungeon:<kind>`; the client's `PcgMeshes` already follows `SyntyProps` in its chain. Slot colours come from the look's
   palette (matte, per theme).
4. **Verified in the running client**, one screenshot per room type (crypt, armoury, forge, throne, vault, chapel, library,
   ritual, barracks, storeroom, grotto, icehall), with and without the art.

## Rooms (the arrangement each archetype gets; my proposal, built to taste)
crypt: sarcophagus on the centre, coffins in a row along the walls, urns in the corners. armoury: weapon racks in a row on
the longest wall, armour stands flanking the door side, crates in a corner. barracks: bedrolls in a grid, a table in the
middle, barrels in a corner. storeroom: crates and barrels in rows against the walls, sacks between. library: bookshelves
in rows along the walls, the desk in the middle, candles on its corners. ritual: the circle in the middle, candles in a ring,
cages along a wall. forge: the smelter on a wall, the anvil beside it, crates in a corner. vault: chests along the wall, coin
piles in front of them. chapel: pews in a grid facing the reliquary or altar wall, candles in the corners. throne: the throne
on the far wall facing the room, statues flanking it, braziers either side. gatehall: statues flanking the entrance, braziers
in the corners. grotto/icehall/hall: scatter (natural). Facing and counts stay in data.

## Non-goals
- Rebalancing the room mix (barracks and storerooms are 36% of rooms) and tying the boss room to its boss: out of scope.
- New archetypes, new prop kinds (beyond what an arrangement needs, procedural if so), the shell, room layout, lighting.
- Raycasting props onto the shell's surfaces (the dressing already keeps to dry floor cells and the 2D field; props stand at
  floor level, mounted ones at `props.json`'s `lift`). The earlier `decorateShell` (uncommitted on
  `feat/dungeon-shell-decoration`) is dropped.
- Animated or lit props; tuning numbers; enemy models; resource nodes.

## Anti-goals (a failure even if it technically works)
- Any licensed art, catalog name or art-derived file committed, pushed, or copied out of `assets/`.
- Props blocking doorways, standing in basins, overlapping, or crossing walls; a rebake that makes the old pool fail.
- Hand-written special cases per room type in code: arrangements stay data (`dressing.ts`); the code knows patterns only.

## Constraints
- Existing dungeons keep working: no arrangement named = today's behaviour; a missing overlay = procedural everywhere. The
  dungeon file format does not change (`dressing.props` keeps `x, y, rot, kind`), so no format bump and old pools load.
- Deterministic per seed: the same dungeon, dressing, rank and seed dress the same. Dressing a dungeon with the new
  arrangements changes its props, so its hash changes on a rebake; the user's pool is rebaked only when they say so.
- Server-side collision stays the box from `props.json`, placed at the prop's position and yaw.
- One PR per feature (CLAUDE.md). Two PRs, stacked: (A) arrangements in `dress.ts` and the built-in dressing, (B) art overlay
  and procedural meshes. Roadmap rows and update-log lines with each.

## Decisions
- **Yours:** the licensed art where it matches, procedural shapes as the fallback; furnishing only; drop `decorateShell` and
  extend the existing pipeline.
- **Mine:** the arrangement vocabulary above; the overlay at `content/dungeons/props.local.json` (git-ignored, like
  `content/scale.local.json`); procedural meshes in `packages/dungeon/src/propmesh.ts` from a small recipe table, built on the
  fly; conservative name matching with an explicit per-kind pattern table and a printed contact list for review by eye.

## Left to the builder
Exact recipes and proportions of procedural shapes; the name patterns; how the overlay handles a model's scale (a per-kind
`scale`); the pattern algorithms' details (spacing, margins, orientation); test fixtures.
