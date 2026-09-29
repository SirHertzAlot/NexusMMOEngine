# @mmo-engine/dungeon

Procedural dungeon layouts, baked offline into a pool that instances are
started from. Each dungeon is fully connected, with an entrance, a boss,
and difficulty rising along the way. Its rooms have roles (combat, elite,
treasure, shrine), and it comes with liquids, props, torches and monster
spawn points. Everything is deterministic per seed.

```
npm run dungeon:bake -- --n 10          # add 10 unique dungeons to the pool
npm run dungeon:bake --n 10             # the same (npm passes the count through)
npm run dungeon:bake -- --n 5 --theme grim --rooms 30-60 --png
npm run dungeon:bake -- --n 20 --seed random --fresh
npm run dungeon:bake -- --n 10 --rank 4-5 --dressing ours.json
```

The pool lives in `$MMO_DATA_DIR/dungeons`, else `packages/engine-core/data/dungeons`
(git-ignored, next to the baked world):

- `index.json`: every dungeon in the pool, with its id, name, theme, seed,
  size, and content hash.
- `<id>.dungeon.json`: the layout (format `mmo-dungeon/1`) and its dressing: the
  rank, room archetypes, their contents, and resource veins.
- `<id>.png`: a top-down map, with `--png`.

A bake **adds** to the pool, and a layout already in it (same content hash)
is never baked twice. The same options on an empty folder always give the
same pool.

| Option | Default | |
|---|---|---|
| `--n` | 10 | new dungeons to add |
| `--seed` | 1 | base seed, or `random` |
| `--theme` | auto | `ancient`, `molten`, `frost`, `grim`, `verdant`, a custom theme, or `auto` (picked per dungeon) |
| `--rooms` | 20-48 | rooms per dungeon, `n` or `min-max` |
| `--loops` | 0.15 | share of extra links beyond the spanning tree (shortcuts, cycles) |
| `--decor` | 0.6 | dressing density |
| `--themes` | | a JSON file adding or replacing themes (see `ThemeSchema`) |
| `--out` | | the pool folder |
| `--fresh` | | remove the existing pool first |
| `--png` | | also write a map of each new dungeon, with its contents and veins |
| `--rank` | 1-5 | the dressing's rank, `n` or `min-max` (picked per dungeon) |
| `--dressing` | | a JSON file adding or replacing archetypes and veins (see `DressingSchema`) |
| `--bare` | | layouts only, no dressing |

## The pipeline

scatter → separate → Delaunay → minimum spanning tree + loops → room roles → carve →
liquids and arches → flood fill (every floor cell must be reachable) → decorate.

The generator is a typed port of [Dungeon Forge](https://github.com/majidmanzarpour/threejs-procedural-dungeon)
(MIT, see `THIRD_PARTY_NOTICES.md`), split from its renderer. For the same seed
and parameters it produces the original's layout exactly (checked against
200 dungeons across all five themes). The test suite pins the original's
default dungeon (seed 1337, 42 rooms) as a golden vector. Any change to the
order of random draws changes every baked dungeon, and that test catches it.

## Dressing: WFC decides what, scatter and the raymarcher decide where

`dressDungeon(dungeon, dressing, rank)`:

1. **Room archetypes (WFC over the room graph).** Each room becomes a crypt,
   armoury, barracks, storeroom, library, ritual chamber, forge, chapel, vault,
   throne room and so on. The choice depends on the room's role, the theme, the
   room's size and the rank. Archetypes never sit beside ones they avoid (a
   library beside a ritual chamber), a storeroom needs a barracks or armoury
   beside it, and some archetypes are limited per dungeon.
2. **Inventories (WFC).** Each room gets a count for each item its archetype
   holds, within the room's floor capacity. Items with a `minRank` appear only
   in higher-rank dungeons.
3. **Seams (WFC over the room graph).** Some rooms get a resource vein kind:
   iron seams, gold veins, elemental crystals, enchanted ore, exotic ore and
   rune stones. Kinds are gated by rank and depth and favoured by theme.
   Neighbouring rooms share one seam kind.
4. **Where (`@mmo-engine/placement`).** The dungeon becomes a signed distance
   field. In each room, scatter proposes spots and the raymarcher settles every
   item on the floor, in the open centre, against a wall or into a corner. Each
   item stays clear of doorways, of the layout's own set pieces and monster
   spawns, and of other items. A seam's veins are mounted on the walls in a
   cluster.

The data (`BUILTIN_DRESSING`) is our game's. A game adds or replaces
archetypes and veins with `--dressing file.json`. If a custom dressing is too
strict for a layout, its rules are loosened rather than the dungeon failing,
and `dressing.relaxed` says which.

What comes next (design: `docs/DUNGEONS-AND-LOOT.md`):

- traps and puzzles as slots of the same kind
- species and ranks for the spawn points
- the editor's dungeon view
- instances started from the pool
