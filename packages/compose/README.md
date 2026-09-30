# @mmo-engine/compose

Ranks, and composing creatures and items from components by WFC. Both go through the same composer, so a
legendary sword and a legendary troll are built the same way.

## The rank ladder

```ts
buildLadder(5);                     // common … legendary
buildLadder(["worn", "fine", "masterwork", "relic"]);
loadLadder("content/ranks.json");   // { "ranks": [names] } or full ranks
```

- **Names** come from the count (1 to 7: common, uncommon, rare, epic, legendary, mythic, divine),
  or are given.
- **Loot shares:** 100% starts divided evenly, 100/N each. It is then tilted linearly until each rank
  takes less than the rank below: the lowest rank takes the most and the highest the least, still
  summing to exactly 100%. By default the top rank ends at half the even share.

  | Ranks | Shares |
  |---|---|
  | 3 | 50 / 33.33 / 16.67 |
  | 5 | 30 / 25 / 20 / 15 / 10 (legendary 10%) |
  | 7 | 21.43 / 19.05 / 16.67 / 14.29 / 11.9 / 9.52 / 7.14 |

  Tune from there (`rankShares(n, top)`, or full ranks in the file). `ladderProblems` rejects shares that
  don't fall strictly or don't sum to 100.
- **Budgets** run from 1 at the bottom to 11 at the top, triangularly between (five ranks: 1, 2, 4, 7, 11).
- **Signals** switch on up the ladder:
  - a quarter of the way up: a tint
  - halfway: particles
  - three quarters of the way: an aura and carved runes
  - the top: a unique ability and body transforms

## Composing

```ts
composeItem("sword", "legendary", { seed });
composeCreature({ id: "fiend", name: "Fiend", tags: ["demon", "fire"], stats }, "epic", { seed, bias: { fire: 3 } });
```

An entity is a tree of slots. Their count is set by the rank's place on the ladder and its signals:

- material (items)
- affixes (0 to 4)
- abilities
- a unique ability (at the top)
- aura, runes, particles, tint and transform

WFC fills the slots from the catalog (`BUILTIN_CATALOG`, or merged with `loadCatalog(file)`):

- **Fit:** each component fits its slot, the base (metals on blades, woods on staves, gems on jewellery),
  the entity kind and the rank.
- **No clashes:** no component twice, and nothing a component excludes (fire and frost; holy on demons
  or the undead).
- **One element:** a hidden affinity slot picks an element or none, and every elemental part matches it.
  An elemental base, such as a fire demon, allows only its own elements.
- **Signals match the entity:** an elemental aura, runes, particles or tint needs its element on the body.
- **Budget:** the total cost stays within the rank's budget and above the rank below's, so each rank is
  stronger than the last. Higher ranks also lean toward dearer parts.

The result is deterministic per seed. `bundle` holds the ECS components:

- `Identity`: id, name, kind, base
- `Rank`
- `Element`
- `Stats`: the base's, scaled by rank, plus every part's
- `Material`, `Affixes`, `Abilities`
- `Signals`
- `Prefab`: the base mesh or species, the material's colour, and every signal to attach with its
  parameters. The client builds the `Object3D` from this.

The top rank gets a proper name ("Fencor, Mighty Iron Sword of the Bear"; "Cornae the Swift Fiend
of the Bear").

In the browser, import `@mmo-engine/compose/browser`: everything but the
file loaders (`loadLadder`, `loadCatalog`, which read JSON from disk). The
client builds a bundle's `Prefab` onto a model with its PrefabBuilder
(`apps/client/src/render/prefab`).

The composer takes about 1.5 ms per entity. It is bake-time code: the loot pool (L1) is composed once
and stored.
