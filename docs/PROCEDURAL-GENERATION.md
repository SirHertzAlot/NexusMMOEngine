# Procedural generation

The engine generates most of what a player sees, and it does nearly all of it
**offline, before the server starts**. Nothing on this page runs on the tick,
with one exception that is called out where it happens.

There are two separate systems with confusingly similar names, so start here:

| | Decides **where things go** | Decides **what things are** |
|---|---|---|
| System | **Scatter** (`packages/scatter`, `packages/addons/scatter`) | **PICG** (`packages/picg`, `packages/addons/picg`) |
| Authoring format | `.pcg.json` placement graphs | `.pcg` asset graphs with `.pcgsubgraph` parts |
| Produces | Spawn records: which asset, at which transform | Geometry: an actual mesh |
| Where it runs | Cooked offline; the C++ addon executes the plan at chunk load | Cooked offline on the thread pool |
| Content | `packages/scatter/examples/` | `content/pcg/` |

Together: PICG makes the tree, scatter decides there is a tree *there*.

Terrain itself is a third thing again — a climate model, not a graph. See
[World building](WORLD-BUILDING.md).

---

## Scatter: placement graphs

A scatter graph is a linear chain from one sampler, through filters and
modifiers, to one spawner. Points flow along the edges.

```jsonc
{
  "name": "forest",
  "version": 1,
  "params": [{ "name": "density", "type": "number", "default": 0.35 }],
  "nodes": [
    { "id": "sample", "type": "gridSampler",
      "settings": { "spacing": 4, "jitter": 0.7, "seed": 1337 } },
    { "id": "thin", "type": "densityFilter",
      "settings": { "density": { "$param": "density" }, "seed": 11 } },
    { "id": "spawn", "type": "meshSpawner",
      "settings": { "entries": [{ "asset": "oak", "weight": 5 }], "seed": 99 } }
  ],
  "edges": [{ "from": "sample", "to": "thin" }, { "from": "thin", "to": "spawn" }]
}
```

Settings take a literal or `{ "$param": "name" }`, on settings the node type
marks as parameterisable. A graph plus a set of parameter overrides is an
**instance**, so one forest graph gives you a dense forest and a sparse one
without duplicating it.

### Node vocabulary

| Type | Category | Purpose |
|---|---|---|
| `gridSampler` | sampler | Jittered lattice over the 16 × 16 chunk footprint, snapped to terrain height |
| `densityFilter` | filter | Keep points with probability `density`, from the point's own seed |
| `slopeFilter` | filter | Drop points steeper than `maxSlope` |
| `attributeFilter` | filter | Keep points whose attribute falls in `[min, max]` |
| `setAttribute` | modifier | Write a constant dynamic attribute |
| `transformPoints` | modifier | Randomise yaw and uniform scale from a seed |
| `meshSpawner` | spawner | Terminal: weighted asset pick per point, producing spawn records |

The cooker enforces exactly one sampler and one spawner, every node on the
path between them, no dead branches and no cycles. Anything invalid throws
with a message naming the node and setting.

### Cooking a graph

```ts
import { parseGraphJSON, cook } from "@mmo-engine/scatter";

const plan = cook(parseGraphJSON(json), { graph: "forest", params: { density: 0.5 } });
// plan.hash  — sha256 of the canonical plan; the runtime versions and caches by it
// plan.order — node ids in execution order
// plan.nodes — resolved settings
```

Cooking validates structure, node types, settings before and after parameter
substitution, parameter types, edge endpoints, pin rules and reachability.

### Points

A `PointList` is structure-of-arrays: position, Euler rotation, scale,
density (existence probability 0–1), a per-point `u32` seed, and a table of
named float attribute columns. Canonical ordering is by seed ascending before
any stochastic branch.

### The determinism contract

This is the part to understand before you write a node.

All randomness is **per-point integer hashing**, never a sequential PRNG
stream:

- `hashU32(x)` is a splitmix32-style finalizer; `hash01(x) = hashU32(x) / 2³²`.
- `deriveChunkSeed(worldSeed, cx, cz)` derives a chunk's seed.
- Every per-point decision hashes `(pointSeed ^ salt)`.

The reason is compaction. A filter removes points from the middle of a list;
with a sequential stream every downstream decision would shift, and the same
world would generate differently depending on which points happened to
survive. Per-point hashing makes a point's outcome depend only on the point.
Scatter output is a pure function of `(worldSeed, cx, cz, plan, table)`.

Every operation is `u32` so the TypeScript reference evaluator and the C++
addon produce identical results, which is what the golden vectors in
`packages/scatter/test/` lock down. The addon builds with strict
floating-point flags (`-ffp-contract=off`, `/fp:precise`) for the same
reason: a world baked on one machine must match one baked on another.

### Spawn tables

A spawn table maps asset ids to archetypes — collision shape, health, and so
on. `resolveSpawns` turns spawn records into entity descriptors. Asset ids
resolve to `fnv1a32(assetId)`, matching the ECS `AssetRef` component.

### The one runtime piece

`packages/engine-core/src/procgen/scatter-spawn.ts` runs a cooked plan **at
chunk spawn** and emits ECS entities: a transform, an `AssetRef`, health for
breakable archetypes, and static bodies for colliders. It runs once per chunk,
the first time a player comes near, and the result persists in snapshots —
it does **not** re-run on restore.

That has a consequence worth knowing: areas a player has already visited keep
the scenery they grew. If you change a scatter plan and want it everywhere,
bake a fresh world into a separate data folder rather than expecting old
chunks to update.

### Authoring-time evaluator

```ts
import { evaluatePlan } from "@mmo-engine/scatter";
const records = evaluatePlan(plan, { worldSeed: 1234, cx: 0, cz: 0, heightAt: (x, z) => h });
```

Authoring only. `heightAt` stands in for the native heightfield, which
`slopeFilter` needs. Use it to check a plan before baking, and to generate
golden vectors the native addon must reproduce.

---

## PICG: procedural assets

PICG authors an asset as a node graph — primitives, splines, Booleans,
bevels, UVs, materials and subgraphs — and its vendored C++17 core cooks a
graph plus a seed into geometry.

```js
const picg = require("@mmo-engine/addon-picg");
picg.version();            // the cooker version
picg.validate(graph);      // null, or the error message
const r = await picg.cook(graph, 1234);
// r.kind === "mesh": r.mesh is a PCGM ArrayBuffer (positions, indices, and
//   optional normals, colours, UVs and material slots), plus counts
// r.kind === "json": points, splines or heightfield diagnostics
```

Four properties to design around:

- **Off the tick thread.** Cooks run on the libuv thread pool. A small asset
  takes milliseconds; a whole procedural city takes around ten seconds.
- **One at a time.** The core keeps process-global state, so `cook` queues
  calls and resolves them in order. Do not expect parallelism.
- **Deterministic.** The same graph and seed give the same bytes.
- **Flattened graphs only.** A graph linking `.pcgsubgraph` assets must be
  resolved by the host first (`@mmo-engine/picg`). Embedded subgraphs cook as
  they are.

Mesh file import is compiled out: `ImportMesh` fails the cook with a clear
message. PICG makes geometry, it does not load it.

`content/pcg/` holds the shipped library: an `index.json` listing reusable
subgraph parts (trunk, round crown, conifer crown) and assets built from
them (oak, birch and the rest), each with a variant count. This is why the
engine has scenery with no art pack installed at all — and why it is worth
keeping your own game runnable that way.

The editor has a hierarchical graph editor for these, in the Dungeons & PCG
workspace. See [The editor](EDITOR.md).

---

## The rest of the generation chain

| Produces | Package | Guide |
|---|---|---|
| Terrain, climate, biomes | `packages/addons/procgen`, `packages/addons/terrain-kernel` | [World building](WORLD-BUILDING.md) |
| Formations (what goes together) | `packages/wfc` | Wave Function Collapse over an arbitrary graph |
| Formation placement (where it goes) | `packages/placement` | |
| Towns, roads, wayside places | `packages/settlement`, `packages/fortify` | [Settlements](SETTLEMENTS.md) |
| Dungeons and their geometry | `packages/dungeon`, `packages/addons/geometry` | [Dungeons, creatures and loot](DUNGEONS-AND-LOOT.md) |
| Creature ecologies and spawns | `packages/species` | [Wildlife](WILDLIFE.md) |
| Ranks, prefabs, loot pools | `packages/compose`, `packages/crafting` | [Dungeons, creatures and loot](DUNGEONS-AND-LOOT.md) |
| Building and interior synthesis | `packages/synthesis` | |

`npm run bake:all` runs the whole chain in dependency order and skips steps
whose output already exists. [Command reference](CLI.md#bake-content) has every
individual command.
