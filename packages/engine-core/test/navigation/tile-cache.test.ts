/**
 * Tile-cache navmesh against the real addon: ChunkNavmesh bakes chunk
 * layers (inline and on the worker) that join without gaps at chunk
 * edges, and NavObstacleSystem turns static bodies into obstacles that
 * paths go round, turned boxes turned the right way, applied to tiles
 * that load after them too, and gone again when the body despawns.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  ChunkNavmesh,
  createNavigationBackend,
  MotionType,
  NAV_PATH_STATUS,
  NavmeshTileRegistry,
  NavObstacleSystem,
  ShapeKind,
  SimWorld,
  TILE_CACHE_SETTINGS,
  Transform,
  Velocity,
  type NavigationBackend,
} from "../../src/index.js";
import type { ChunkDataSource } from "../../src/procgen/chunk-source.js";

const CHUNK = 16;
const flat: ChunkDataSource = { chunkSamples: 256, generateChunk: (_s, _x, _z, _l, out) => out.fill(0) };

function setup(worker = false): { backend: NavigationBackend; navmesh: ChunkNavmesh; obstacles: NavObstacleSystem; registry: NavmeshTileRegistry } {
  const backend = createNavigationBackend({
    originX: 0, originZ: 0, tileWorldSize: CHUNK, maxTiles: 64, maxPolys: 512,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
    tileCache: TILE_CACHE_SETTINGS,
  });
  const dir = mkdtempSync(join(tmpdir(), "navmesh-tc-"));
  const registry = new NavmeshTileRegistry({ dir });
  const obstacles = new NavObstacleSystem(backend.tileCache!, { chunkWorldSize: CHUNK, agentRadius: 0.6 });
  const navmesh = new ChunkNavmesh({
    backend, registry, registryDir: dir, source: flat, seed: 1n, chunkWorldSize: CHUNK, worker,
    onLoaded: (cx, cz) => obstacles.tileLoaded(cx, cz),
  });
  return { backend, navmesh, obstacles, registry };
}

function path(backend: NavigationBackend, from: number[], to: number[]): { status: number; length: number; pts: number[][] } {
  const out = { status: new Int32Array(1), waypointCount: new Uint32Array(1), polyCount: new Uint32Array(1), waypoints: new Float32Array(3 * 32) };
  backend.findPaths({ count: 1, entityIds: new BigUint64Array([1n]), start: Float32Array.from(from), end: Float32Array.from(to), profile: new Uint8Array([0]), maxWaypoints: 32 }, out);
  const pts: number[][] = [];
  for (let i = 0; i < out.waypointCount[0]; i++) pts.push([out.waypoints[i * 3], out.waypoints[i * 3 + 2]]);
  const length = pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  return { status: out.status[0], length, pts };
}

/** A static box body: centre, half extents, turned `yaw` about +Y. */
function wall(sim: SimWorld, x: number, z: number, hx: number, hz: number, yaw = 0): number {
  const e = sim.spawn();
  for (const c of [Transform, Velocity, BodyConfig]) addComponent(sim.ecs, c, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qy[e] = Math.sin(yaw / 2);
  Transform.qw[e] = Math.cos(yaw / 2);
  BodyConfig.shapeKind[e] = ShapeKind.Box;
  BodyConfig.halfX[e] = hx;
  BodyConfig.halfY[e] = 1.5;
  BodyConfig.halfZ[e] = hz;
  BodyConfig.motionType[e] = MotionType.Static;
  return e;
}

/** Tick the obstacles until every change is in (a body spawned since the last tick isn't known before a step). */
function settle(sim: SimWorld, obstacles: NavObstacleSystem): void {
  let i = 0;
  do obstacles.step(sim);
  while (!obstacles.upToDate && ++i < 200);
  assert.ok(obstacles.upToDate, "obstacles settled");
}

describe("tile-cache navmesh", () => {
  const cleanups: Array<() => void> = [];
  after(() => cleanups.forEach((f) => f()));

  it("bakes chunk layers that join at chunk edges, and reuses them from the registry", () => {
    const { backend, navmesh, registry } = setup();
    cleanups.push(() => { navmesh.close(); registry.close(); backend.destroy(); });
    assert.equal(navmesh.load(0, 0), "baked");
    assert.equal(navmesh.load(1, 0), "baked");
    const across = path(backend, [2, 0, 8], [30, 0, 8]);
    assert.equal(across.status, NAV_PATH_STATUS.Ok);
    assert.ok(Math.abs(across.length - 28) < 0.5, `straight over the seam (${across.length.toFixed(2)} m)`);
    navmesh.unload(1, 0);
    assert.equal(navmesh.load(1, 0), "cached");
    assert.equal(backend.tileCount(), 2);
  });

  it("static bodies cut the navmesh: paths go round, and straight again when they go", () => {
    const { backend, navmesh, obstacles, registry } = setup();
    cleanups.push(() => { navmesh.close(); registry.close(); backend.destroy(); });
    const sim = new SimWorld();
    navmesh.load(0, 0);
    obstacles.step(sim);
    // A wall across the chunk at x = 8 with a gap at the top (z > 13).
    const w = wall(sim, 8, 6, 0.3, 6.5);
    settle(sim, obstacles);
    const round = path(backend, [3, 0, 3], [13, 0, 3]);
    assert.equal(round.status, NAV_PATH_STATUS.Ok);
    assert.ok(round.length > 18, `round the wall (${round.length.toFixed(2)} m)`);
    sim.despawn(w);
    settle(sim, obstacles);
    assert.ok(Math.abs(path(backend, [3, 0, 3], [13, 0, 3]).length - 10) < 0.5, "straight again");
  });

  it("turns boxes the way the body is turned", () => {
    const { backend, navmesh, obstacles, registry } = setup();
    cleanups.push(() => { navmesh.close(); registry.close(); backend.destroy(); });
    const sim = new SimWorld();
    navmesh.load(0, 0);
    // A long thin wall turned +45 degrees about +Y: the body's local +x
    // maps to (cos, -sin) in (x, z), so its long side runs along (1, -1).
    wall(sim, 8, 8, 5, 0.2, Math.PI / 4);
    settle(sim, obstacles);
    // The wall lies along (1, -1)/sqrt2 through (8, 8): it blocks the diagonal (3, 3) -> (13, 13),
    // and leaves the other diagonal (3, 13) -> (13, 3), which runs along it, clear.
    const blocked = path(backend, [3, 0, 3], [13, 0, 13]);
    const along = path(backend, [5, 0, 11], [11, 0, 5]);
    assert.ok(blocked.length > Math.hypot(10, 10) + 1, `the wall is across (3,3)->(13,13): ${blocked.length.toFixed(2)} m`);
    assert.ok(Math.abs(along.length - Math.hypot(6, 6)) < 1.5, `and along (5,11)->(11,5): ${along.length.toFixed(2)} m`);
  });

  it("applies obstacles to a tile that loads after them (a worker bake)", async () => {
    const { backend, navmesh, obstacles, registry } = setup(true);
    cleanups.push(() => { navmesh.close(); registry.close(); backend.destroy(); });
    const sim = new SimWorld();
    wall(sim, 8, 6, 0.3, 6.5);
    obstacles.step(sim); // added while no tile is there: it reaches nothing yet
    assert.equal(navmesh.load(0, 0), "pending");
    // The bake worker never holds the process open (unref); a server's tick timer does. So does this.
    const alive = setInterval(() => {}, 20);
    await navmesh.whenIdle();
    clearInterval(alive);
    assert.equal(backend.tileCount(), 1);
    settle(sim, obstacles);
    const round = path(backend, [3, 0, 3], [13, 0, 3]);
    assert.ok(round.length > 18, `round the wall on the late tile (${round.length.toFixed(2)} m)`);
  });
});
