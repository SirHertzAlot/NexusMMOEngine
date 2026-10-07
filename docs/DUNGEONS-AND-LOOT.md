# Dungeons, creatures, loot and crafting: generation by WFC

Status: **design**. Only D1 is built so far (the dungeon generator and `npm run dungeon:bake`,
`packages/dungeon`). Everything else here is a proposal to review.

This covers:

- the generation stack everything else stands on: WFC over graphs, scatter, and node graphs
- dungeons: layouts, dressing, instances, and the editor
- which species live where, and why
- ranks, and composing creatures and items by WFC
- the pre-baked, rank-balanced loot pool
- crafting materials, and balancing the whole chain backwards from top gear

Like the rules (M0), every table here is game data. A game built on the engine replaces
it; ours is one configuration of it.

## 1. What exists today

| Piece | State |
|---|---|
| Terrain bake: survey, erosion, rivers, biomes, climate | built (`bake-world.ts`, `terrain/`) |
| Ecology: layered, noise-driven scenery placement (groves, scree, flower patches) | built (`procgen/ecology.ts`, `content/ecology/`) |
| Scatter: PCG graph cooking; the C++ addon is the runtime authority | built (`packages/scatter`, `packages/addons/scatter`) |
| Region ↔ world server: registry, migration, async batch reports | spec + slice A (`docs/WORLD-SERVER-SPEC.md`, `packages/world-server`) |
| Combat, bots, characters, rules and hooks | built (`combat.ts`, `bots.ts`, `characters/`, M0 rules) |
| Dungeon layouts + bake | **D1, built** (`packages/dungeon`) |
| WFC | **none yet**: the terrain uses the climate survey and ecology layers, not WFC |
| Species, ranks, items, loot, crafting | none yet |

## 2. The generation stack

Three tools, used together at every stage of generation.

### 2.1 WFC over graphs: the solver

Classic Wave Function Collapse fills a tile grid so that every pair of neighbouring
tiles is allowed. The engine's WFC is the same algorithm over **any graph**:

- **Slots** are the nodes. Each slot has a *domain*: a list of weighted options with
  tags. An option can be a tile, a prop, a creature component, an affix, a quest step
  or a line of dialog.
- **Constraints**:
  - *Edge* constraints: which option may sit next to, or follow, which. These come
    from tags, so "fire" never sits next to "ice", and "ambush" never follows
    "ambush".
  - *Slot* constraints come from context: biome, depth, rank, theme, species.
  - *Global* constraints: counts and budgets. At most one boss relic. The rank's
    power budget. Exactly 10% legendary across the pool.
  - *Pins*: slots already decided (a neighbour chunk's border, an editor override).
- **Solving**:
  1. Collapse the lowest-entropy slot (Shannon entropy of its remaining weights, with
     seeded noise to break ties) to one option, drawn by weight.
  2. Propagate: arc consistency along the edges, and re-check the budgets.
  3. On a contradiction, backtrack (bounded), then restart from a derived seed.

  The solver is seeded, so the same graph and seed always solve the same way, which a
  bake needs.
- **Package:** `packages/wfc`. It is domain-agnostic, like `packages/scatter`: a
  solver plus adapters that turn a problem into a graph.

| Adapter | The graph | Used for |
|---|---|---|
| grid (2D/3D) | cells, 4/6/8 neighbours | settlement and ruin layouts, dungeon room interiors, tile sets |
| points | scatter candidates, linked to their neighbours within a radius | what each scatter point becomes: a camp's tents around one fire, one shrine per clearing, veins that cluster |
| room graph | dungeon rooms and corridors | room archetypes (crypt, armoury, ritual chamber) consistent along the path |
| component tree | an entity's parts (body, weapon, armour, affixes, aura, abilities) | creature and item composition by rank (§5) |
| progression | stages from 0% to 100% of a domain | quests, dialog, cut scenes, life cycles (§2.3) |

### 2.2 Scatter: placement

Scatter and ecology decide *where* things can go: candidate points from noise, biome,
slope, water, and the neighbourhood. WFC then decides *what* each point becomes, given
its neighbours. The terrain bake becomes:

    survey → ecology layers → scatter candidates → WFC over the point graph → spawns

**Seams.** Bakes are per chunk, so a WFC solve can't depend on the order chunks
happen to be baked. The solve runs in world-space tiles on a fixed checkerboard:

1. The "even" tiles solve alone.
2. Each "odd" tile solves with its borders pinned to its even neighbours.

This way any chunk can be rebuilt from the seed alone, just as the ecology's
world-space noise cells already keep groves continuous across chunk borders.

### 2.3 Node graphs: progression

Anything with a natural progression is a graph of stages from 0% to 100% of its
domain, and each node can bring in a new data set, type or method. A quest might run:

    hook (0%) → travel → obstacle → twist → confrontation → reward (100%)

Each stage is a slot whose domain is the step types that fit there. The edges carry
preconditions ("a twist needs an earlier ally"). WFC collapses the graph to a
concrete quest, with the world's own entities (a region, a species, an item) bound as
parameters. The same works for:

- **Dialog:** beats and replies.
- **Cut scenes:** shots and cues.
- **Living systems:** a creature's life cycle, or a settlement's growth.
- **Dungeons:** the path from entrance to boss already is one (D1 computes the
  critical path and the difficulty along it).

The editor's graph view (PICG slices 3 and 4) is where these graphs are drawn.

**Built (P1, quests and dialog):** `content/quests/` holds the stages, step
types (objective, text, tags given, needed and excluded) and templates;
`engine-core/src/quests/generate.ts` collapses a template with the WFC
solver (one slot per stage, a "seq" edge between every pair of slots for
needs and exclusions) and binds it to the giver's world: a creature kind
living near, one of the giver's places, an item base. Authored quests and
dialog graphs (lines, replies with conditions and actions) sit beside them.
A region's `QuestService` runs dialog, quest logs (saved in `quests.db`),
progress from kills, places, bags and talks, and hand-in with rewards; each
quest giver's board offers every character one generated quest a day.

### 2.4 Raymarching

Raymarching comes in at two points. Which matters most to you is an open question (§10):

- **Rendering:** signed-distance effects on the client. Auras around high-rank
  creatures, runes carved into a mesh by SDF, volumetric miasma and light shafts in
  dungeons.
- **Generation:** SDF and noise fields as inputs to constraints (a crystal vein
  follows a field inside the rock, a cave follows a carved tunnel field). The solver
  reads fields the same way ecology reads its noise.

## 3. Dungeons

### 3.1 Layout (D1, built)

`packages/dungeon` is a typed port of Dungeon Forge (MIT). Its pipeline:

    scatter rooms → separate → Delaunay → spanning tree + loops → room roles →
    carve → liquids and arches → flood fill (connectivity) → decorate

Each dungeon has an entrance, a boss, treasure and shrine rooms, and elites on the
critical path, with difficulty rising from 0 to 1. It has themed liquids and dressing,
torches, and monster spawn points by tier. For the same seed its output is identical
to the original's.

    npm run dungeon:bake --n 10

This adds 10 unique dungeons to the pool (`<data>/dungeons`). A layout already in the
pool (by content hash) is never baked twice.

### 3.2 Dressing: WFC + scatter (D2)

1. **Room archetypes.** WFC over the room graph assigns each room an archetype from
   its role, theme, depth and the dungeon's rank: crypt, armoury, library, ritual
   chamber, flooded hall. Neighbouring rooms stay coherent.
2. **Room interiors.** A grid WFC per room lays out furniture and structure. Scatter
   then fills the room with props and variations, using the same ecology layer format
   as the open world, so one plan format serves both.
3. **Resource nodes.** Veins are a scatter layer on wall cells, clustered by a field
   and scaled by the dungeon's rank: elemental crystal veins, enchanted metals, gold,
   exotic ores, rune stones (§7).
4. **Traps and puzzles (later).** These are slots of the same kind: a trap is an
   option on a corridor or doorway slot, and a puzzle is a small progression graph
   (§2.3). A game adds its own by adding options.

### 3.3 Rank and population

A dungeon has a **rank** (§5), chosen at bake time. The rank sets:

- the monster ranks for each spawn tier
- which species may appear (§4)
- the loot tiers its chests and bosses draw from
- the rank of its resource veins

The layout's spawn points (tier 1–3, rising with difficulty) become creature slots.
The component-tree WFC (§5.2) fills them.

### 3.4 Instances (D4)

An instance is a small engine instance started from a baked layout on request. It
runs the same engine-core: a region whose "world" is one dungeon, a small sandbox
apart from the open world. Players are taken out of their place in the world and
put into it; results go back the way the rest of the game's do, instance to
region to world server, which ingests them.

Everything an instance needs is prebaked in the pool, so starting one reads files
instead of generating anything: the layout, dressing and population
(`<id>.dungeon.json`) and the shell, its walls, floors and ceilings as one mesh
buffer (`<id>.shell.pcgm`, built with manifold and Clipper2), which is its
collider, its navmesh input and what clients draw.

1. **Request:** a party asks at a dungeon entrance.
2. **Start:** the region picks a layout from the pool that matches the entrance's rank
   and theme, and starts an instance: in-process first, a child process later (the
   world-server spec's deployment path).
3. **Enter:** players move into the instance through the existing migration handoff.
4. **Play:** all state lives in the instance: monsters, loot drops, depleted nodes,
   opened chests, traps.
5. **Result:** when it completes or times out, the instance sends one result batch to
   its region: loot granted, kills, deaths, skill gains, materials gathered. The region
   folds it into its next batch report to the world server, which records it, and it
   reaches the world on the next snapshot update.
6. **Teardown.** Players return to the entrance.

A result is committed only once it is reported. If an instance crashes before
reporting, its run didn't happen. That choice is yours (§10).

**Built (D4, first cut):** `packages/engine-core/src/dungeons/`. The region's
`InstanceManager` is a gateway extension: `{kind:"dungeon", op:"enter",
entrance}` from a party member standing at an entrance
(`content/dungeons/entrances.json`) picks a pool layout by the entrance's rank
and themes and starts a `DungeonInstance` in-process: its own SimWorld and
Gateway on an ephemeral port, running stats, creatures, intents, combat, death,
stamina and integration, with the layout grid as its collider
(`DungeonWallSystem`; the prebaked shell is what clients draw). Instead of the
migration handoff, each party member online gets a `transfer` message with the
instance's endpoint and a token (`Gateway.admit`) and says hello there as their
character, at the entrance; their region avatar stays at the entrance. Every
spawn point gets one creature (its baked species when that has creature rules,
else the rules' fallback) and dead creatures stay down. A run ends cleared
(boss room empty), on timeout, or abandoned (empty for a while), and hands one
result to the region: kills, deaths, and loot rolled per kill from the mob
pool. The region commits it then, items into bags and the batch into
`<data>/instances.db` (unreported), where the world server's ingest will pick
it up once that endpoint exists. The run rules are data
(`content/dungeons/instances.json`), the proposed answers to §10.2: parties of
1 to 5, 45 minutes, re-entry while the run lasts, abandoned after 2 minutes
empty, at most 8 runs per region, nothing kept until the run reports. Skill
gains: the region's commit trains one use of each killer's weapon skill per
kill, at the open-world hit difficulty and keyed by victim kind, through the
character's saved sheet (no live sheet exists while its owner is away in the
instance). The client's transfer (hop in and back out, run HUD, result) rides
the `transfer`/`ended` messages. Chests: each run places `chestsPerRun`
chests in the lowest-id non-entrance rooms; a member opens the nearest one
in reach (`{op:"open"}`, 3 m) for 1–2 rolls from the chest pool into the
run's loot, and the run state names each chest for the HUD's open button.
Not yet: depleted nodes and traps.

### 3.5 Editor (D3)

- A dungeon pool browser, with the map thumbnails the bake writes (`--png`).
- Regenerate with different parameters, or bake more.
- A 3D view in the editor's R3F canvas, reusing Dungeon Forge's instanced look.
- Edits (a room's role, moving or adding props, pinning a spawn, changing its rank)
  are saved as a patch over the baked layout. A re-bake keeps them, and they become
  WFC pins.

## 4. Species and where they live

Species are data (`content/species/*.json`). Each species has:

- **kind:** `organic`, `undead`, `demon`, `otherworldly`, or `beast`
- **habitat:** open-world biomes, or dungeon themes and depths, with weights
- **sustenance:** what keeps it alive, which drives behaviour and where it gathers
- its body (reusing the body-part rules from M0), abilities, and rank range

Our configuration:

| Kind | Lives | Sustenance | Notes |
|---|---|---|---|
| organic (goblins, orcs, trolls) | the open world, by biome | food, water, rest: living needs | camps, hunting grounds, trade routes; a bot's needs drive its day |
| beast | the open world | food and water | herds and predators, placed by the ecology |
| undead | dungeons, mostly grim and ancient | none (necromantic) | tireless guards, the dungeons' common population |
| otherworldly | dungeons, deep | varies by species | the rarer deep dwellers |
| demon | **dungeons only**: they manifest there, never wander the world | **emotions and lifeforce** | why dungeons draw them (see below) |

**Demons feed on emotion and lifeforce.** One way to make that a mechanic: a
dungeon's **dread**.

- Fighting, fear, wounds and deaths inside the dungeon raise it.
- Demons manifest at shrines and ritual rooms, and grow stronger as dread rises.
- Clearing a demon lowers it.

That turns "demons feast on emotion" into something players see and play around.
Whether it works this way is yours to decide (§10).

**Placement:**

- *Open world:* species spawn tables join the ecology plans. A species is weighted
  by how well each chunk's biome suits it, and a scatter + WFC pass places camps and
  lairs.
- *Dungeons:* each theme has a table of kinds and species by depth, such as grim →
  undead, and molten → demons and elementals.

## 5. Ranks, and composing creatures and items by WFC

### 5.1 Rank ladder

Ranks are data: an id, a name, a power budget, the share of the loot pool it takes,
and its visual signals (built in R1: `packages/compose`).

**Your rule for shares:** the number of ranks sets them. 100% starts divided evenly
(100/N each), then is tweaked until the highest rank has the lowest share and the
lowest rank the highest, always summing to 100%. The tweak is a linear tilt about the
even share; by default the top rank ends at half of it. Names are inferred from the
count. Five ranks:

| Rank | Budget | Loot share | Signals |
|---|---|---|---|
| common | 1 | 30% | none |
| uncommon | 2 | 25% | tinted palette |
| rare | 4 | 20% | particles |
| epic | 7 | 15% | aura, carved runes |
| legendary | 11 | 10% | aura, runes, a unique ability, proportion and animation transforms |

Three ranks give 50 / 33.33 / 16.67; seven give 21.43 down to 7.14. The shares can be
tuned from there, and the ladder's checks keep them strictly falling and summing to 100.

### 5.2 The component tree

Creatures and items are a tree of **component slots**:

- a base (species or item type)
- a weapon or material
- affix slots
- abilities
- signals: aura, runes, particles, a colour transform, a proportion or animation
  transform

Each slot's domain is the options that fit, and each option carries a cost against
the rank's budget and compatibility tags. WFC collapses the tree, starting with the
lowest-entropy slot, until the entity is complete:

- a higher rank has a larger budget and unlocks more slots
- tags keep it coherent (no frost aura on a fire-bound demon)
- global constraints keep a pool balanced (§6)

Since the same solver builds creatures and items, a legendary sword and a legendary
troll are generated the same way.

**The output** is an ECS component bundle with a `prefab` field:

- **Server:** the bundle is ECS data. Its stats feed the rules hooks (M0 `computeDamage`
  and friends), and its buffs, debuffs and abilities feed combat.
- **Client:** the prefab builds an `Object3D`, with the shaders, animations, particle
  effects and post-processing hooks named by its signals attached. This reuses the FX
  work: bloom, nebula particles, and the underwater and injury effects.

There's no runtime cost beyond spawning, because the compositions are baked.

## 6. The loot pool

Loot is **pre-baked**: a large pool of composed items, balanced by rank.

- **Pool size:** the pool has N items. Each rank's share is exact, and the WFC's
  global count constraints enforce it: with legendary at 10%, a pool of 10,000 holds
  exactly 1,000 legendaries.
- **Sources:** each item is assigned to a source: a mob rank, a chest by dungeon rank,
  a boss's table, a crafting outcome. Drops draw from the pool, so the economy's supply
  is known and tunable.
- **Uniqueness:** a legendary is a named, one-of-a-kind composition. A pool rebake
  keeps items already in players' hands (they are recorded by the world server).
- **Balance report:** the bake writes the expected time to obtain each rank, per
  source, and a rank × source × material table to tune from.

## 7. Materials and crafting: working backwards

The order you described:

1. **Top gear first.** Define what top-rank gear needs: materials, components and
   skill (mastery, from `MASTERY-AND-COMBAT.md`).
2. **Materials.** For each material: its tier, where it is found (open-world nodes vs
   dungeons), how hard it is to get, whether it is **tradable** (a commodity) or bound.
   Dungeons are rich in the high tiers: elemental crystal veins, enchanted metals,
   gold, exotic precious ores, magical enchantment runes.
3. **Sources.** Which dungeon ranks carry which veins, and which mobs drop which
   components.
4. **Dungeons and mobs.** Build dungeon ranks and their populations to supply that
   chain.
5. **Bake.** A WFC + scatter pass places the nodes and mobs. The balance report (§6)
   says whether the chain adds up. Tune the data and re-bake.

Materials, recipes and ranks are data (`content/items/`, `content/materials/`,
`content/recipes/`), validated like the rules.

## 8. Data layout (proposed)

    content/
      rules/            M0 (built)
      ecology/          scenery plans (built); gains creature and camp layers
      wfc/              option sets and constraint tables per adapter
      species/          kinds, habitats, sustenance, bodies, abilities
      ranks.json        the ladder: budgets, shares, signals
      items/            item types, affixes, signals
      materials/        tiers, sources, tradability
      recipes/          what makes what
      dungeons/         themes (D1's built-ins can move here), archetypes, rank tables

## 9. Build order

Each item is its own PR.

1. **D1: dungeon layouts + `dungeon:bake`.** Built.
2. **W1: `packages/wfc`.** The graph solver (entropy, propagation, budgets, pins,
   backtracking, seeded) plus the grid and points adapters, with golden-vector tests.
3. **W2: WFC in the terrain bake.** The point-graph pass after scatter, with seams on
   the checkerboard (§2.2).
4. **D2: dungeon dressing.** Room archetypes, room interiors, scatter, resource veins.
5. **S1: species + spawn tables**, for the open world (ecology) and dungeons (theme and
   depth).
6. **R1: ranks + the entity composer.** Component-tree WFC producing an ECS bundle and
   prefab; the client builds the `Object3D` from it.
7. **L1: loot pool bake**, with exact rank shares and the balance report.
8. **C1: materials, recipes, tradability**, backwards from top gear.
9. **D3: editor dungeon view.** Pool browser, 3D view, edits as patches.
10. **D4: instances.** Start from the pool, migrate in, report results to the region.
11. **P1: progression graphs.** Quests and dialog on the WFC and the editor's graph view.

## 10. Open questions

1. **Rank ladder:** answered. The count sets the shares (even, then tilted so each
   higher rank takes less, summing to 100%), and names are inferred (§5.1).
2. **Instances:**
   - party size, time limit, re-entry
   - whether a crash loses the run (proposed: nothing is committed until the instance
     reports)
3. **Demons and dread:** is a dungeon-wide dread meter the right mechanic for "feeding
   on emotion and lifeforce"?
4. **Tradability:** which ranks and materials are bound, and which are commodities?
5. **Raymarching:** for rendering (auras, runes, volumetrics), for generation (SDF
   fields as constraints), or both? Which first?
6. **Dungeon entrances:** does the terrain bake place them (scatter + WFC), each tied
   to a rank and theme and drawing layouts from the pool?
