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
```

The pool lives in `$MMO_DATA_DIR/dungeons`, else `packages/engine-core/data/dungeons`
(git-ignored, next to the baked world):

- `index.json`: every dungeon in the pool, with its id, name, theme, seed,
  size, and content hash.
- `<id>.dungeon.json`: the layout (format `mmo-dungeon/1`).
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
| `--png` | | also write a map of each new dungeon |

## The pipeline

scatter → separate → Delaunay → minimum spanning tree + loops → room roles → carve →
liquids and arches → flood fill (every floor cell must be reachable) → decorate.

The generator is a typed port of [Dungeon Forge](https://github.com/majidmanzarpour/threejs-procedural-dungeon)
(MIT, see `THIRD_PARTY_NOTICES.md`), split from its renderer. For the same seed
and parameters it produces the original's layout exactly (checked against
200 dungeons across all five themes). The test suite pins the original's
default dungeon (seed 1337, 42 rooms) as a golden vector. Any change to the
order of random draws changes every baked dungeon, and that test catches it.

What comes next (design: `docs/DUNGEONS-AND-LOOT.md`):

- a WFC and scatter pass over the layout for props, resource veins and traps
- species and ranks for the spawn points
- the editor's dungeon view
- instances started from the pool
