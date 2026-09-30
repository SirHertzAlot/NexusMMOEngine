# @mmo-engine/addon-navigation

Recast/Detour navigation native addon for the MMO engine (Phase 2):
server-side navmesh baking + bulk structure-of-arrays pathfinding behind
an N-API boundary.

## What lives where

| Side | Owns |
|---|---|
| JS (engine-core) | `Transform`, `PathRequest`, `PathState` components — the authoritative config; tile blob cache + SQLite registry |
| Native (`NavService`) | `dtNavMesh`, one `dtNavMeshQuery` per agent profile, tile blob store |

Native `dtPolyRef`s **never cross to JS**. Tile identity is the
`dtTileRef` (u64); entity identity is the engine's u64 wire id.

## API (`index.js`)

```js
const { createService, PathStatus } = require('@mmo-engine/addon-navigation');

const svc = createService({
  originX: 0, originZ: 0,   // world coords of tile (0,0) corner
  tileWorldSize: 16,        // world units per square tile
  maxTiles: 128,
  maxPolys: 2048,
  profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
});

// 1. Bake (chunk-gen/load time, NEVER per tick — synchronous, seconds-scale)
const { blob, stats } = svc.bakeTile(bakeConfig, vertices, indices);
//    bakeConfig: { tileX, tileZ, cellSize, cellHeight, agentHeight,
//      agentRadius, agentMaxClimb, walkableSlopeAngle, regionMinSize,
//      regionMergeSize, edgeMaxLen, edgeMaxError, vertsPerPoly,
//      detailSampleDist, detailSampleMaxError }
//    vertices: Float32Array (3N, world coords), indices: Uint32Array (3M)
//    stats: { spanCount, contourCount, polyCount, detailTriCount, blobBytes }

// 2. Load tiles into the navmesh (zero-copy: Buffers stay alive natively)
const refs = svc.loadTiles([blob]);   // -> BigUint64Array of tile refs
svc.unloadTiles(refs);

// 3. Query: one N-API call moves N requests; results land in arenas
svc.findPaths(
  { count, entityIds, start, end, profile, maxWaypoints },  // SoA in
  { status, waypointCount, polyCount, waypoints },           // SoA out
);
// status[i]: PathStatus.Ok | NoStartPoly | NoEndPoly | NoPath | UnknownProfile

svc.tileCount();
svc.destroy();  // explicit; the finalizer is a backstop
```

`PathStatus.NoPath` also covers the case where Detour reports
`DT_PARTIAL_RESULT` (the end poly was unreachable): a corridor that
leads somewhere else is not a valid answer to the request.

## Crowd steering (DetourCrowd)

One `dtCrowd` per service (`config.crowd = { maxAgents: 1024,
maxAgentRadius: 1 }`), agents keyed by the engine's u64 entity id:

```js
svc.crowdAdd({ count, entityIds, pos, radius, height, maxSpeed, maxAcceleration });
//   -> Int32Array of CrowdAddStatus: Added | Updated (already an agent) | Full
svc.crowdTarget({ count, entityIds, target });   // NaN x clears a target
//   -> Int32Array of CrowdTargetStatus: Ok | UnknownAgent | NoPoly | Cleared
svc.crowdStep(dt, { count, entityIds, pos }, { vel, pos, state });
svc.crowdRemove(entityIds);
svc.crowdCount();
```

The crowd **steers; the simulation decides where things are.** Each
`crowdStep` first snaps the listed agents to the positions the game gives
(sliding each corridor along the mesh, or re-placing an agent that moved
further than steering could: teleports, knockback), then runs
`dtCrowd::update` (path following, corridor optimisation, separation,
velocity-obstacle avoidance at the highest-quality preset) and writes each
agent's move for the tick over `dt` into `out.vel`. That includes the push
that separates agents that got too close, which dtCrowd applies to
positions rather than velocities. The game acts on it as intent. `state`
is a `CrowdAgentState`: Invalid (off the mesh: no tile under it,
swimming), Idle, Moving, Arrived (within its radius of the target) or
NoPath. Stuck agents are left to the caller (a brain picks another target).

## Tile cache: obstacles (DetourTileCache)

Created with `config.tileCache = { cellSize, cellHeight, agentHeight,
agentRadius, agentMaxClimb, edgeMaxError, maxObstacles, maxLayers }`, the
service builds navmesh tiles from **heightfield layers plus obstacles**
instead of loading finished tiles:

```js
const blob = svc.bakeTileLayers(bakeConfig, vertices, indices); // throws "0 layers" where nothing is walkable
const refs = svc.loadLayers(tileX, tileZ, blob);   // builds the tile's navmesh tiles
svc.unloadLayers(refs);
const obs = svc.addObstacles({ count, kind, pos, radius, height, halfExtents, yaw });
//   kind 0: upright cylinder standing on pos; 1: box centred on pos, turned by yaw about +Y
svc.removeObstacles(obs);
svc.updateObstacles(maxTiles);  // rebuild up to maxTiles touched tiles; true when all changes are in
svc.obstacleCount();
```

- `cellSize` must divide `tileWorldSize` exactly (8-200 cells), and every
  layer bake must use the cache's cell and agent sizes.
- Give `bakeTileLayers` geometry past the tile's edge (the neighbours'),
  so the border it rasterises isn't eroded where the ground carries on.
- The navmesh gets `maxTiles * maxLayers` tile slots: keep tile bits plus
  poly bits within 22 (32-bit poly refs).
- Obstacles are exact footprints: grow them by the agent radius yourself
  if paths must keep a body clear of them. An obstacle applies to the
  tiles loaded when it is added; add it again after its tile loads.
- The cache queues 64 obstacle requests; `addObstacles` drains it (tile
  rebuilds) when a batch overflows, so steady callers should add in
  smaller batches. Layers are stored uncompressed (a copy "compressor").

## Bake ownership

The **server** bakes, from the same geometry its procgen/chunk pipeline
generates — at chunk-gen/load time, never per tick. `bakeTile` is
synchronous; production should move it onto a worker thread or bake
ahead of time (the boundary is already shaped for it: pure function,
config + geometry in, blob out). Dynamic obstacles are the tile cache above
(not rebakes, see EVALUATION.md §2); local avoidance is the crowd.

Geometry contract: triangles must use **counter-clockwise winding when
viewed from above (+Y)** and overlap the tile bounds. Violations fail
loudly — the bake asserts span/contour/poly counts and throws
descriptive errors instead of producing an empty tile.

## Determinism posture

Detour queries are synchronous with no internal randomness; the only
randomness in the Recast/Detour pipeline is the caller-supplied
random-float callback, which this addon never uses (the test suite
asserts the shim contains no such reference). Treat baked tiles as
**versioned deterministic build artifacts**: the tile cache key is
`(worldSeed, chunkX, chunkZ, terrainVersion, agentProfile,
bakeConfigHash)`. Same inputs → byte-identical blob (asserted
in-process and across 3 fresh processes in the test suite).

Caveat (from EVALUATION.md §2): upstream makes no explicit
bit-identical guarantee across compilers/platforms. Same binary +
same inputs is asserted; heterogeneous server builds are an open
Phase-2 question, same as Jolt's `CROSS_PLATFORM_DETERMINISTIC`.

## Build

Vendored RecastNavigation at the evaluated commit builds offline —
`Recast/Source/*.cpp` + `Detour/Source/*.cpp` compile directly as
node-gyp sources, no CMake (see `VENDORING.md`). Requirements: a C++17
compiler and `node-gyp`. A plain `npm install` builds everything.
