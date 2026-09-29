# @mmo-engine/wfc

Wave Function Collapse over **any graph**, for every generation step that
needs things placed consistently with what's around them: terrain and
scatter, dungeon dressing, creature and item composition, quests and dialog.

A problem is **slots** (graph nodes), **options** (weighted, tagged), and constraints:

| Constraint | Meaning | Example |
|---|---|---|
| domains, weights | what each slot may be, and how likely | only empty ground in a marsh; pines favoured on cold heights |
| edges + rules | which option pairs may sit across an edge | sea never beside land; tile sockets must match |
| needs | an option needs N neighbours of a kind | a tent needs a fire within 7 m |
| counts | min/max of a group overall | exactly 10% legendary; one shrine |
| budgets | a cost per option, a total to stay within | a rank's power budget |
| pins | slots already decided | a neighbouring chunk's border; an editor override |

```ts
import { solve, gridProblem, pointsProblem } from "@mmo-engine/wfc";

const r = solve(problem, { seed: 42 });   // r.assignment (option per slot), r.ids, r.stats
```

How it solves:

1. Collapse the undecided slot of lowest entropy, drawing an option by weight.
   An option with needs is decided **together with** the neighbours that meet
   them, so a tent comes with its fire.
2. Propagate: edge rules to arc consistency, needs (including forcing the last
   possible supporters), counts and budgets to their bounds.
3. On a contradiction, undo the last decision (a trail of removals) and ban it.
   After too many backtracks, restart from a derived seed.

Deterministic: the same problem and seed always give the same answer. A
golden vector in the tests guards that, since every bake depends on it.

**Adapters** turn a problem into a graph:

- `gridProblem`: 2D/3D tiles, with sockets and/or an `allow` rule per axis.
- `pointsProblem`: scatter candidates linked within distances, with `avoid`,
  `needs`, `counts` by tag, and a per-point `weight` (biome, slope, depth).

Room graphs, component trees and progression graphs use `solve` directly (see
the tests). More adapters arrive with the slices that need them
(docs/DUNGEONS-AND-LOOT.md).

**Why our own solver:** the WFC libraries on npm (lite-wfc, three-wfc,
blazinwfc, schrodinger, …) are grid-only, and none has global counts or
budgets. We need both for room graphs, component trees and exact loot shares.
If we later want WFC to learn patterns from an example map, that can be a
separate adapter.

Performance: a 128 × 128 grid solves in well under a second (a lazy entropy
heap, flat typed arrays). This is bake-time code and never runs on the tick path.
