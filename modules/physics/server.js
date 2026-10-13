/**
 * Physics module server entry (complete-modularity slice 8).
 *
 * Exports createSystems(ctx) per the module contract. Builds the physics
 * domain: Jolt physics backend, navigation mesh, obstacle cutting,
 * integration, prop collision, and collider. The nav backend is shared
 * with the creatures module (crowd steering) via ctx.config.
 *
 * Dependencies (via ctx.config.physics): chunk size, tile cache settings,
 * nav backend config. The Jolt backend is created here (native module).
 */
import {
  createJoltBackend,
  createNavigationBackend,
  NavigationSystem,
  PhysicsSystem,
} from "../../packages/engine-core/dist/src/index.js";
import { NavObstacleSystem } from "../../packages/engine-core/dist/src/navigation/obstacle-system.js";
import { ChunkNavmesh } from "../../packages/engine-core/dist/src/navigation/chunk-navmesh.js";
import { IntegrateSystem } from "../../packages/engine-core/dist/src/index.js";
import { PropCollisionSystem } from "../../packages/engine-core/dist/src/index.js";
import { ColliderSystem } from "../../packages/engine-core/dist/src/index.js";

export function createSystems(ctx) {
  const config = ctx.config?.physics ?? {};

  const physics = new PhysicsSystem(createJoltBackend());

  const navBackend = createNavigationBackend({
    originX: 0,
    originZ: 0,
    tileWorldSize: config.chunkSize,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
    maxTiles: 8192,
    maxPolys: 512,
    tileCache: config.tileCacheSettings,
  });

  const obstacles = new NavObstacleSystem(navBackend.tileCache, {
    chunkWorldSize: config.chunkSize,
    agentRadius: config.tileCacheSettings.agentRadius,
  });

  const navigation = new NavigationSystem({ backend: navBackend });
  const integrate = new IntegrateSystem();
  const propCollision = new PropCollisionSystem();
  const collider = new ColliderSystem();

  // Chunk navmesh for terrain streaming (needs navBackend, registry, procgen).
  // Created here because navBackend lives in this module.
  const chunkNavmesh = config.createChunkNavmesh
    ? config.createChunkNavmesh(navBackend, obstacles)
    : null;

  // Expose the nav backend for the creatures module (crowd steering)
  // via the shared ctx object (creatures depends on physics).
  ctx.shared = ctx.shared ?? {};
  ctx.shared.navBackend = navBackend;
  if (chunkNavmesh) ctx.shared.chunkNavmesh = chunkNavmesh;
  // Also notify the host (server.ts) via callback for post-assembly setup.
  if (config.onNavBackend) config.onNavBackend(navBackend, obstacles, chunkNavmesh);

  return {
    physics,
    navigation,
    obstacles,
    integrate,
    "prop-collision": propCollision,
    collider,
  };
}
