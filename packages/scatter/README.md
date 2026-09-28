# `@mmo-engine/scatter` — PCG authoring & cooking

UE-style procedural content generation for the engine, phases 1–2
(see `docs/PCG-SPEC.md`): the `.pcg.json` node-graph authoring format,
the point data model, the cooker that compiles graphs into versioned
hashed scatter plans, the spawn-table schema, and an authoring-time
reference evaluator.

**Authority boundary.** This package is cooking/tooling only. Nothing
here runs in the region process or on the tick path. The runtime
authority is the C++ scatter addon (PCG slice 3), which executes cooked
plans. The reference evaluator exists to validate plans and to produce
the golden vectors the C++ implementation must reproduce bit-for-bit.

## Format

A `.pcg.json` graph: nodes with typed settings, edges carrying point
lists, graph-level parameters, and instances (graph + parameter
overrides — the Material-Instance equivalent).

```jsonc
{
  "name": "forest",
  "version": 1,
  "params": [
    { "name": "density", "type": "number", "default": 0.35 }
  ],
  "nodes": [
    { "id": "sample", "type": "gridSampler",
      "settings": { "spacing": 4, "jitter": 0.7, "seed": 1337 } },
    { "id": "thin", "type": "densityFilter",
      "settings": { "density": { "$param": "density" }, "seed": 11 } },
    { "id": "spawn", "type": "meshSpawner",
      "settings": { "entries": [{ "asset": "oak", "weight": 5 }], "seed": 99 } }
  ],
  "edges": [
    { "from": "sample", "to": "thin" },
    { "from": "thin", "to": "spawn" }
  ]
}
```

Settings accept literals or `{ "$param": "name" }` references (only on
settings each node type marks `paramable`). See `examples/forest.pcg.json`
for a complete biome graph.

## Node vocabulary (v1)

| Type | Category | Purpose |
|---|---|---|
| `gridSampler` | sampler | jittered lattice over the 16×16 chunk footprint, snapped to terrain height (needs heightfield) |
| `densityFilter` | filter | keep points with probability `density` (point-seed hash) |
| `slopeFilter` | filter | drop points steeper than `maxSlope` (needs heightfield) |
| `attributeFilter` | filter | keep points whose attribute is in `[min, max]` |
| `setAttribute` | modifier | write a constant dynamic attribute |
| `transformPoints` | modifier | randomize yaw / uniform scale from a seed |
| `meshSpawner` | spawner | terminal: weighted asset pick per point → spawn records |

v1 graphs are linear sampler→…→spawner chains; the cooker enforces one
sampler, one spawner, and that every node lies on the sampler→spawner
path (no dead branches, no cycles).

## Cooking

```ts
import { parseGraphJSON, cook } from "@mmo-engine/scatter";

const plan = cook(parseGraphJSON(json), { graph: "forest", params: { density: 0.5 } });
// plan.hash — sha256 of the canonical plan; the runtime versions/caches by it
// plan.order — node ids in execution order; plan.nodes — resolved settings
```

The cooker validates: structural shape, node types, settings (pre/post
param substitution, strict keys), param types, edge endpoints, pin
rules, reachability. Anything invalid throws with a message naming the
node/setting.

## Points

SoA `PointList`: position, euler rotation, scale, density (existence
probability 0–1), per-point u32 seed, and a dynamic attribute table
(named float columns). Canonical ordering is by seed ascending before
any stochastic branch.

## Determinism contract

All randomness is per-point integer hashing (portable to C++ — every op
is u32):

- `hashU32(x)` — splitmix32-style finalizer; `hash01(x) = hashU32(x) / 2^32`
- `deriveChunkSeed(worldSeed, cx, cz)` — chunk seed derivation
- per-point decisions hash `(pointSeed ^ salt)` — never sequential PRNG
  streams, so filter compaction can't change downstream randomness

## Spawn tables

`examples/forest.spawn-table.json` maps asset ids to archetypes
(collision → BodyConfig, health → Health). `resolveSpawns` turns spawn
records into `EntitySpawn` descriptors — the exact handoff region
integration (slice 4) consumes. Asset ids resolve to `fnv1a32(assetId)`
u32 hashes, matching the ECS `AssetRef` component (id 8).

## Reference evaluator

```ts
import { evaluatePlan } from "@mmo-engine/scatter";
const records = evaluatePlan(plan, { worldSeed: 1234, cx: 0, cz: 0, heightAt: (x, z) => h });
```

Authoring-time only. `heightAt` stands in for the C++ `generateChunk`
heightfield (slopeFilter needs it). Golden vectors in `test/` lock the
semantics the native addon must match.
