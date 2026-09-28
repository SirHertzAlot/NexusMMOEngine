// @mmo-engine/addon-navigation — JS boundary for the Recast/Detour addon.
//
// Thin wrapper: navmesh storage (dtNavMesh), per-profile queries
// (dtNavMeshQuery) and the bake pipeline live natively. All bulk,
// structure-of-arrays; no per-entity N-API in the hot loop.
//
// Contracts:
// - bakeTile() is synchronous and runs the full canonical bake. It is a
//   chunk-gen/load-time operation, never per tick. Production should move
//   it to a worker thread or bake ahead of time; the boundary is already
//   shaped for it (pure function: config + geometry in, blob out).
// - Tile identity on this side is the dtTileRef (u64). Native dtPolyRefs
//   never cross to JS.
// - findPaths() writes into caller-allocated arenas: one N-API call per
//   batch, zero allocation on the hot path.
// - All native ops run on the JS thread; the addon never spawns its own
//   JS-visible threads.
// - destroy() is explicit; the C++ finalizer tears the service down as a
//   backstop if the caller forgets.

'use strict';

const path = require('node:path');

const { NavService } = require(path.join(
  __dirname,
  'build',
  'Release',
  'navigation.node',
));

/** Pathfinding result status codes (mirror the native PathStatus). */
const PathStatus = Object.freeze({
  Ok: 0,
  NoStartPoly: 1,
  NoEndPoly: 2,
  NoPath: 3,
  UnknownProfile: 4,
});

/**
 * Create a navigation service.
 *
 * config = {
 *   originX, originZ,      // world coords of tile (0,0) corner
 *   tileWorldSize,         // world units per square tile
 *   maxTiles = 128,
 *   maxPolys = 2048,
 *   profiles = [{ id, agentHeight, agentRadius, agentMaxClimb }],
 * }
 */
function createService(config) {
  return new NavService(config);
}

module.exports = {
  NavService,
  createService,
  PathStatus,
};
