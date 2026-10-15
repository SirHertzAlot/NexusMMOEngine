/**
 * Movers against baked static bodies (settlement buildings): crowd agents
 * path round them and never end inside; creatures, spawns, respawns and
 * teleports never leave a character inside one; ground items don't block.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, hasComponent } from "bitecs";
import {
  AssetRef,
  attachDefaultCollider,
  BodyConfig,
  CHARACTER_CAPSULE,
  ChunkNavmesh,
  clearOfStatics,
  ColliderSystem,
  CrowdSystem,
  createNavigationBackend,
  IntegrateSystem,
  IntentSystem,
  Locomotion,
  MotionType,
  NavAgent,
  NavAgentState,
  NavmeshTileRegistry,
  NavObstacleSystem,
  PlayerIntent,
  PropCollisionSystem,
  ShapeKind,
  SimWorld,
  STEP_MS,
  TILE_CACHE_SETTINGS,
  Transform,
  Velocity,
} from "../src/index.js";
import { applyTeleport } from "../src/admin/player.js";
import { CreatureSystem } from "../src/creatures.js";
import { WorldItem } from "../src/components.js";
import { loadGameRules } from "../src/rules/boot.js";
import type { ChunkDataSource } from "../src/procgen/chunk-source.js";

const dt = STEP_MS / 1000;
const R = CHARACTER_CAPSULE.radius;

/** A static box centred at ground level (a Structure): half extents, turned `yaw` about +Y. */
function building(sim: SimWorld, x: number, z: number, hx: number, hy: number, hz: number, yaw = 0): number {
  const e = sim.spawn();
  for (const c of [Transform, Velocity, BodyConfig]) addComponent(sim.ecs, c, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qy[e] = Math.sin(yaw / 2);
  Transform.qw[e] = Math.cos(yaw / 2);
  BodyConfig.shapeKind[e] = ShapeKind.Box;
  BodyConfig.halfX[e] = hx;
  BodyConfig.halfY[e] = hy;
  BodyConfig.halfZ[e] = hz;
  BodyConfig.motionType[e] = MotionType.Static;
  return e;
}

/** Is a circle of radius `r` at (x, z) overlapping box `o`'s footprint (1 mm tolerance)? */
function inside(o: number, x: number, z: number, r = 0): boolean {
  const yaw = 2 * Math.atan2(Transform.qy[o], Transform.qw[o]);
  const dx = x - Transform.px[o];
  const dz = z - Transform.pz[o];
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const ex = lx - Math.max(-BodyConfig.halfX[o], Math.min(BodyConfig.halfX[o], lx));
  const ez = lz - Math.max(-BodyConfig.halfZ[o], Math.min(BodyConfig.halfZ[o], lz));
  return Math.hypot(ex, ez) < r - 1e-3;
}

function walker(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent, Locomotion, NavAgent]) addComponent(sim.ecs, c, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  NavAgent.speed[e] = 3;
  NavAgent.tx[e] = NaN;
  attachDefaultCollider(sim, e);
  return e;
}

const flat: ChunkDataSource = { chunkSamples: 256, generateChunk: (_s, _x, _z, _l, out) => out.fill(0) };

describe("movers vs baked static bodies", () => {
  const cleanups: Array<() => void> = [];
  after(() => cleanups.forEach((f) => f()));

  for (const yaw of [0, 0.6]) {
    it(`a crowd agent paths round a Structure box (yaw ${yaw}) and never ends inside it`, () => {
      const backend = createNavigationBackend({
        originX: 0, originZ: 0, tileWorldSize: 16, maxTiles: 64, maxPolys: 512,
        profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
        tileCache: TILE_CACHE_SETTINGS,
      });
      const dir = mkdtempSync(join(tmpdir(), "movers-nav-"));
      const registry = new NavmeshTileRegistry({ dir });
      const obstacles = new NavObstacleSystem(backend.tileCache!, { chunkWorldSize: 16, agentRadius: 0.6 });
      const navmesh = new ChunkNavmesh({
        backend, registry, registryDir: dir, source: flat, seed: 1n, chunkWorldSize: 16, worker: false,
        onLoaded: (cx, cz) => obstacles.tileLoaded(cx, cz),
      });
      cleanups.push(() => { navmesh.close(); registry.close(); backend.destroy(); });
      const sim = new SimWorld();
      navmesh.load(0, 0);
      const box = building(sim, 8, 8, 2.5, 4, 1.5, yaw);
      for (let i = 0; i < 200; i++) {
        obstacles.step(sim);
        if (obstacles.upToDate) break;
      }
      assert.ok(obstacles.upToDate);

      const crowd = new CrowdSystem(backend.crowd!);
      const e = walker(sim, 2, 8);
      const systems = [crowd, new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
      for (const s of systems) s.step(sim, dt);
      NavAgent.tx[e] = 14; NavAgent.ty[e] = 0; NavAgent.tz[e] = 8; NavAgent.seq[e]++;
      let maxDz = 0;
      for (let i = 0; i < 30 * 25 && NavAgent.state[e] !== NavAgentState.Arrived; i++) {
        for (const s of systems) s.step(sim, dt);
        assert.ok(!inside(box, Transform.px[e], Transform.pz[e], R), `inside the box at (${Transform.px[e]}, ${Transform.pz[e]})`);
        maxDz = Math.max(maxDz, Math.abs(Transform.pz[e] - 8));
      }
      assert.equal(NavAgent.state[e], NavAgentState.Arrived);
      assert.ok(Math.hypot(Transform.px[e] - 14, Transform.pz[e] - 8) < 1, "reached the far side");
      assert.ok(maxDz > 1.5, `went round, not through (max z detour ${maxDz.toFixed(2)})`);
    });
  }

  it("a creature (Locomotion capsule) is blocked by a building like a player", () => {
    const game = loadGameRules();
    const sim = new SimWorld();
    const box = building(sim, 0, 0, 5, 6, 9, 0.4);
    const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    const [g] = creatures.spawnPack(sim, "goblin", -20, 0);
    const collider = new ColliderSystem();
    const rest = [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
    for (let i = 0; i < 300; i++) {
      sim.beginTick(i + 1);
      collider.step(sim);
      PlayerIntent.mx[g] = 1;
      PlayerIntent.mz[g] = 0.1;
      for (const s of rest) s.step(sim, dt);
      sim.endTick();
      assert.ok(!inside(box, Transform.px[g], Transform.pz[g], R), `creature inside the building at (${Transform.px[g]}, ${Transform.pz[g]})`);
    }
    assert.equal(BodyConfig.motionType[g], MotionType.Kinematic);
    assert.ok(Transform.px[g] > -20, "and it did walk");
  });

  it("clearOfStatics pushes a point out of a yawed box, and out of the next one too", () => {
    const sim = new SimWorld();
    const a = building(sim, 0, 0, 5, 6, 9, 0.5);
    // 14 m apart: the alley between the yawed faces is wider than a capsule.
    const b = building(sim, 14, 0, 5, 6, 9, 0.5);
    for (const [x, z] of [[0, 0], [1, 2], [4, -3], [6, 0]]) {
      const p = clearOfStatics(sim, x, z, R);
      assert.ok(!inside(a, p.x, p.z, R) && !inside(b, p.x, p.z, R), `(${x}, ${z}) -> (${p.x}, ${p.z})`);
    }
    assert.deepEqual(clearOfStatics(sim, 100, 100, R), { x: 100, z: 100 });
  });

  it("a character spawned inside a building is ejected by the first tick (not frozen)", () => {
    const sim = new SimWorld();
    const box = building(sim, 0, 0, 5, 6, 9);
    const p = walker(sim, 1, 1);
    new PropCollisionSystem().step(sim);
    assert.ok(!inside(box, Transform.px[p], Transform.pz[p], R));
  });

  it("creature spawns land outside buildings", () => {
    const game = loadGameRules();
    const sim = new SimWorld();
    const box = building(sim, 0, 0, 5, 6, 9, 0.3);
    const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    for (const e of creatures.spawnPack(sim, "goblin", 0, 0)) {
      assert.ok(!inside(box, Transform.px[e], Transform.pz[e], R), "spawned inside");
    }
  });

  it("teleport (and so respawn) never lands a character inside a building", () => {
    const sim = new SimWorld();
    const box = building(sim, 504, 616, 5, 6, 9);
    const p = walker(sim, 0, 0);
    const r = applyTeleport(sim, sim.wireId(p), 504, 616, () => 3);
    assert.ok(r.ok);
    assert.ok(!inside(box, Transform.px[p], Transform.pz[p], R));
    assert.equal(Transform.py[p], 3);
  });

  it("ground items and fixtures without a body do not block movement", () => {
    const sim = new SimWorld();
    const item = sim.spawn();
    for (const c of [Transform, AssetRef, WorldItem]) addComponent(sim.ecs, c, item);
    Transform.qw[item] = 1;
    Transform.sx[item] = Transform.sy[item] = Transform.sz[item] = 1;
    const p = walker(sim, -3, 0);
    new ColliderSystem().step(sim);
    assert.ok(!hasComponent(sim.ecs, BodyConfig, item), "a ground item got a collider");
    const systems = [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
    for (let i = 0; i < 90; i++) {
      PlayerIntent.mx[p] = 1;
      for (const s of systems) s.step(sim, dt);
    }
    assert.ok(Transform.px[p] > 0.5, `walked through the item (x=${Transform.px[p]})`);
  });
});
