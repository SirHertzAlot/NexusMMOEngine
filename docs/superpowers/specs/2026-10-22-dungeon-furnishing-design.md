# Dungeon furnishing: props that look like the room they are in

## Intent
A baked dungeon already knows what every room is (986 rooms in the 30-dungeon pool, each with an archetype: crypt, armoury,
forge, throne, vault, chapel, ...) and what it holds (`dressing.props`, 30 kinds). In the client those props are plain boxes
at 2D grid positions. Make a crypt look like a crypt, a forge like a forge: each prop stands on the real shell floor or hangs
on the real wall, and shows a recognisable model, from the licensed art where one matches, else a procedural shape.

## Goals
1. **Placement on the real shell.** `decorateShell` (written by an earlier session, uncommitted on
   `feat/dungeon-shell-decoration`: `packages/dungeon/src/decorate.ts`, `decorate-cli.ts`, `obj.ts`, `test/decorate.test.ts`)
   runs inside the dungeon bake. Its result (3D position, yaw, surface normal, mount height, `on: floor|wall|corner`) is stored
   in the dungeon file and the server spawns the props from it (y and yaw included). A dungeon without it spawns as today.
2. **Art where it matches.** A local, git-ignored overlay maps prop kinds to licensed catalog models. It is generated from
   `assets/catalog.json` by a step that matches names (about half the kinds: weapon-rack, barrel, chest, statue, brazier,
   throne, anvil, coffin, torch, pillar, rubble, crate, table, candles, sack, ...). The server loads it over `props.json`; a
   prop's `AssetRef` hash is `fnv1a32(asset id)`, so a catalog model id makes the client's `SyntyProps` draw it, with no client
   change. The overlay is never committed and the art is never copied.
3. **Procedural fallback.** Every kind without a match (sarcophagus, ritual-circle, bedroll, coin-pile, gilded-chest,
   armour-stand, bookshelf, smelter, reliquary, mushrooms, root-knot, ice-pillar, frozen-body, and any other) gets a small
   mesh built from primitives (box, cylinder, cone, ring) with material slots (stone, wood, metal, cloth, gold, bone, ...). One
   PCGM per kind is mounted in the instance's Pcg library (`addPrebaked`, as the shell is), under the kind's committed asset
   id `dungeon:<kind>`; the client's `PcgMeshes` already sits after `SyntyProps` in the chain. Slot colours come from the look's
   palette (matte, per theme).
4. **Verified in the running client**, one screenshot per room type (crypt, armoury, forge, throne, vault, chapel, library,
   ritual, barracks, storeroom, grotto, icehall), with and without the art.

## Non-goals
- Rebalancing the room mix (barracks and storerooms are 36% of rooms) and tying the boss room to its boss: decided out of scope.
- New prop kinds, new archetypes, room layout, the shell, lighting (the look): unchanged.
- Animated or lit props; tuning numbers; enemy models; resource nodes.

## Anti-goals (a failure even if it technically works)
- Any licensed art, catalog name or art-derived file committed, pushed, or copied out of `assets/`.
- Props floating, buried or crossing walls; a changed bake that makes the old pool or the old server fail.
- Hand-written special cases per room type in code: furnishing stays data-driven (`dressing.ts`, `props.json`).

## Constraints
- Existing dungeons keep working: no decoration in the file = the 2D path as today; a missing overlay = procedural everywhere.
- Deterministic per seed (the bake already is); decoration must not change the dungeon hash for unchanged inputs unless the
  format version moves (see below).
- Server-side collision stays the box from `props.json`; a decorated prop's box is placed at its real height and yaw.
- One PR per feature (CLAUDE.md). Two PRs, stacked: (A) decoration in the bake and the server, (B) art overlay and procedural
  meshes. Roadmap rows and update-log lines with each.

## Decisions (mine unless marked as yours)
- **Yours:** use the licensed art where it matches, procedural shapes as the fallback; furnishing only.
- **Mine:** decoration is stored in the dungeon file as an optional `decoration` block (format version bump, readers accept both).
- **Mine:** the art overlay is `content/dungeons/props.local.json` (git-ignored), same idea as `content/scale.local.json`.
- **Mine:** procedural meshes live in `packages/dungeon/src/propmesh.ts`, built on the fly from a small recipe table (kind to
  parts), not stored files.
- **Mine:** matching by name is conservative (a false hit like "Ribcage" for cage is worse than a procedural prop), with an
  explicit per-kind pattern table, reviewed by eye from a contact list printed by the step.

## Left to the builder
Exact recipes and proportions of the procedural shapes; the name patterns; how the overlay's model scale is handled (art is in
metres; a per-kind `scale` if a model's size is off); the dungeon format version number; the test fixtures.
