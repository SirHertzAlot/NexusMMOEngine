/**
 * NavObstacleSystem — static bodies cut the navmesh (DetourTileCache).
 *
 * Every static physics body (BodyConfig with MotionType.Static: trees,
 * rocks, walls, anything ColliderSystem or a spawn archetype gave a still
 * collider) becomes a tile-cache obstacle, grown by the agent's radius so
 * paths keep a walker's body clear of it, not just its centre. A box is a
 * box turned by the body's yaw; a sphere or capsule an upright cylinder.
 * Despawned bodies' obstacles are removed.
 *
 * The cache applies an obstacle to the tiles loaded when it's added, so
 * when a chunk's tile arrives later (streaming, a worker bake), the
 * obstacles on and around it are added again (`tileLoaded`, wired to
 * ChunkNavmesh's onLoaded).
 *
 * Budgets keep ticks smooth when a ring of chunks streams in at once: at
 * most `addsPerTick` obstacles go in per tick (within the cache's request
 * queue, so it never has to drain), and the cache rebuilds at most
 * `tilesPerTick` touched tiles per tick; the rest follow over the next
 * ticks.
 */

import { defineQuery, enterQuery, exitQuery } from "bitecs";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import { BodyConfig, MotionType, ShapeKind, Transform } from "../components.js";
import type { TileCacheBackend } from "./backend.js";

const bodies = defineQuery([Transform, BodyConfig]);
const entered = enterQuery(bodies);
const exited = exitQuery(bodies);

export interface NavObstacleOptions {
  /** World units per chunk (= navmesh tile). */
  chunkWorldSize: number;
  /** Grow every obstacle by this much (the walkers' radius), metres. */
  agentRadius: number;
  /** Obstacles added per tick at most. Default 48 (the cache queues 64 requests). */
  addsPerTick?: number;
  /** Touched tiles rebuilt per tick at most. Default 4. */
  tilesPerTick?: number;
}

interface Obstacle {
  /** Cache ref, 0 while waiting to go in. */
  ref: number;
  kind: 0 | 1;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  cx: number;
  cz: number;
}

export class NavObstacleSystem implements SimSystem {
  readonly name = "nav-obstacles";
  /** By entity id (bitECS eid): the obstacle its body makes. */
  private readonly byEid = new Map<number, Obstacle>();
  private readonly waiting: Obstacle[] = [];
  private readonly reloaded: Array<[number, number]> = [];
  private readonly addsPerTick: number;
  private readonly tilesPerTick: number;
  private settled = true;

  constructor(
    private readonly cache: TileCacheBackend,
    private readonly opts: NavObstacleOptions,
  ) {
    this.addsPerTick = opts.addsPerTick ?? 48;
    this.tilesPerTick = opts.tilesPerTick ?? 4;
  }

  /** A chunk's tile went into the navmesh: its obstacles (and its neighbours' near its edge) go in again. */
  tileLoaded(cx: number, cz: number): void {
    this.reloaded.push([cx, cz]);
  }

  /** Obstacles in the cache, and waiting to go in. */
  get counts(): { placed: number; waiting: number } {
    return { placed: this.byEid.size - this.waiting.length, waiting: this.waiting.length };
  }

  /** True when every obstacle is in and every touched tile rebuilt. */
  get upToDate(): boolean {
    return this.waiting.length === 0 && this.settled;
  }

  step(sim: SimWorld): void {
    const removed: number[] = [];
    for (const e of exited(sim.ecs) as number[]) {
      const ob = this.byEid.get(e);
      if (!ob) continue;
      this.byEid.delete(e);
      if (ob.ref) removed.push(ob.ref);
      else this.waiting.splice(this.waiting.indexOf(ob), 1);
    }
    for (const e of entered(sim.ecs) as number[]) {
      if (BodyConfig.motionType[e] !== MotionType.Static) continue;
      const ob = this.shape(e);
      this.byEid.set(e, ob);
      this.waiting.push(ob);
    }
    // Tiles that just arrived: add their obstacles again so they reach them.
    if (this.reloaded.length > 0) {
      const s = this.opts.chunkWorldSize;
      for (const [cx, cz] of this.reloaded.splice(0)) {
        const x0 = cx * s - 2;
        const z0 = cz * s - 2;
        const x1 = (cx + 1) * s + 2;
        const z1 = (cz + 1) * s + 2;
        for (const ob of this.byEid.values()) {
          if (!ob.ref || ob.x < x0 || ob.x > x1 || ob.z < z0 || ob.z > z1) continue;
          removed.push(ob.ref);
          ob.ref = 0;
          this.waiting.push(ob);
        }
      }
    }
    if (removed.length > 0) this.cache.removeObstacles(Uint32Array.from(removed));

    const n = Math.min(this.waiting.length, this.addsPerTick);
    if (n > 0) {
      const batch = this.waiting.splice(0, n);
      const refs = this.cache.addObstacles({
        count: n,
        kind: Uint8Array.from(batch, (o) => o.kind),
        pos: Float32Array.from(batch.flatMap((o) => [o.x, o.y, o.z])),
        radius: Float32Array.from(batch, (o) => o.radius),
        height: Float32Array.from(batch, (o) => o.height),
        halfExtents: Float32Array.from(batch.flatMap((o) => [o.hx, o.hy, o.hz])),
        yaw: Float32Array.from(batch, (o) => o.yaw),
      });
      batch.forEach((o, i) => (o.ref = refs[i]));
    }
    this.settled = this.cache.update(this.tilesPerTick);
  }

  /** The obstacle a static body makes, grown by the agent radius. */
  private shape(e: number): Obstacle {
    const r = this.opts.agentRadius;
    const x = Transform.px[e];
    const y = Transform.py[e];
    const z = Transform.pz[e];
    const s = this.opts.chunkWorldSize;
    const base = { ref: 0, x, y, z, cx: Math.floor(x / s), cz: Math.floor(z / s), radius: 0, height: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
    const kind = BodyConfig.shapeKind[e];
    if (kind === ShapeKind.Box) {
      // The body's turn about +Y, which is what addBoxObstacle takes (it
      // builds the inverse rotation itself).
      const qx = Transform.qx[e];
      const qy = Transform.qy[e];
      const qz = Transform.qz[e];
      const qw = Transform.qw[e];
      const yaw = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qx * qx + qy * qy));
      return { ...base, kind: 1, hx: BodyConfig.halfX[e] + r, hy: Math.max(BodyConfig.halfY[e], 1), hz: BodyConfig.halfZ[e] + r, yaw };
    }
    // Sphere or capsule: an upright cylinder round it, standing on its bottom.
    const radius = BodyConfig.radius[e];
    const tall = kind === ShapeKind.Capsule ? 2 * (BodyConfig.halfY[e] + radius) : 2 * radius;
    const bottom = kind === ShapeKind.Capsule ? y : y - radius;
    return { ...base, kind: 0, y: bottom, radius: radius + r, height: Math.max(tall, 1) };
  }
}
