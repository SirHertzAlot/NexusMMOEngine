/**
 * Prop collision — kinematic movers are blocked by static prop bodies.
 *
 * Why this exists (roadmap §5: Jolt CharacterVirtual is still planned):
 * characters are *kinematic* capsules moved by IntentSystem +
 * IntegrateSystem, and PhysicsSystem only copies results back for
 * *dynamic* bodies. Jolt moves kinematic bodies exactly where the game
 * puts them (MoveKinematic) and never pushes them back, so a walker
 * integrated into a tree's static box stays there: players walk straight
 * through scatter-spawned props. Static bodies already cut the navmesh
 * (NavObstacleSystem — crowds path round props); only characters ignore
 * them.
 *
 * This system resolves the move on the JS side, in the same tick the
 * move happened: it runs after IntegrateSystem (and CharacterSystem's Y
 * correction) and before PhysicsSystem syncs kinematics into Jolt, so
 * the native world sees the corrected transform. The posture matches
 * DungeonWallSystem (single-pass, axis-aware push-out, slide along the
 * surface) but against BodyConfig boxes/spheres instead of a grid.
 *
 * Shapes (same conventions as the Jolt addon, physics_world.cpp):
 * - a capsule stands on its base: the entity's position is the feet.
 * - a box or sphere is centred on the entity's position.
 * A mover is its XZ footprint circle plus its Y interval; a static box
 * is yaw-rotated (yaw extracted exactly like NavObstacleSystem). Movers
 * that do not overlap an obstacle vertically (flying over it, wading
 * past its base) are unaffected, and Noclip carriers pass through —
 * same as dungeon walls. Shape "none" props have no BodyConfig, so
 * there is nothing to resolve against (grass stays walk-through).
 *
 * Cost: movers × statics with a Y-interval + bounding-circle broadphase
 * before any trigonometry. Characters are few; props are many but each
 * pair is a handful of flops. A deliberate perf check on Linux
 * (`npm run valgrind:perf`) still owes this system a baseline look.
 */

import { defineQuery, hasComponent } from "bitecs";
import {
  BodyConfig,
  MotionType,
  Noclip,
  ShapeKind,
  Transform,
  Velocity,
} from "./components.js";
import type { SimWorld } from "./world.js";
import type { SimSystem } from "./systems.js";

/** XZ footprint circle + Y interval of one body. */
interface Footprint {
  radius: number;
  y0: number;
  y1: number;
}

function moverFootprint(e: number, out: Footprint): boolean {
  const kind = BodyConfig.shapeKind[e];
  if (kind === ShapeKind.Capsule) {
    const r = BodyConfig.radius[e];
    if (!(r > 0)) return false;
    out.radius = r;
    out.y0 = Transform.py[e];
    out.y1 = Transform.py[e] + 2 * (BodyConfig.halfY[e] + r);
    return true;
  }
  if (kind === ShapeKind.Sphere) {
    const r = BodyConfig.radius[e];
    if (!(r > 0)) return false;
    out.radius = r;
    out.y0 = Transform.py[e] - r;
    out.y1 = Transform.py[e] + r;
    return true;
  }
  // Box (kinematic movers sized from their scale): centred, footprint
  // is the XZ circumcircle so no orientation can tunnel a corner.
  const hx = BodyConfig.halfX[e];
  const hz = BodyConfig.halfZ[e];
  const r = Math.max(hx, hz);
  if (!(r > 0)) return false;
  out.radius = r;
  out.y0 = Transform.py[e] - BodyConfig.halfY[e];
  out.y1 = Transform.py[e] + BodyConfig.halfY[e];
  return true;
}

/** Yaw about +Y from a (yaw-only, in practice) quaternion. */
function yawOf(e: number): number {
  const qx = Transform.qx[e];
  const qy = Transform.qy[e];
  const qz = Transform.qz[e];
  const qw = Transform.qw[e];
  return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qx * qx + qy * qy));
}

/** Side of a grid cell, metres. A static is binned into every cell its XZ bounding circle touches. */
const CELL_M = 32;
const CELL_OFFSET = 32768;

/**
 * XZ grid of the static obstacles that can push a mover at all (boxes with
 * a size, discs with a radius). Built once per tick from the obstacle list,
 * in its order, so `near` returns them in the same order the full scan
 * visited them. Without it each mover scanned every body in the world.
 */
class StaticGrid {
  private readonly cells = new Map<number, number[]>();
  /** Body entity of each indexed static, in obstacle order. */
  private readonly bodies: number[] = [];
  /** Per-query dedupe: a static in several cells is reported once. */
  private stamp = new Uint32Array(0);
  private generation = 0;
  private readonly out: number[] = [];

  build(obstacles: ArrayLike<number>): void {
    this.cells.clear();
    this.bodies.length = 0;
    for (let k = 0; k < obstacles.length; k++) {
      const o = obstacles[k] as number;
      if (BodyConfig.motionType[o] !== MotionType.Static) continue;
      let reach: number;
      if (BodyConfig.shapeKind[o] === ShapeKind.Box) {
        // Same guard as boxPush: a box with no size never pushes.
        const hx = BodyConfig.halfX[o];
        const hz = BodyConfig.halfZ[o];
        if (!(hx > 0) || !(hz > 0)) continue;
        reach = Math.sqrt(hx * hx + hz * hz);
      } else {
        // Same guard as discPush.
        reach = BodyConfig.radius[o];
        if (!(reach > 0)) continue;
      }
      const index = this.bodies.length;
      this.bodies.push(o);
      const ox = Transform.px[o];
      const oz = Transform.pz[o];
      const x0 = Math.floor((ox - reach) / CELL_M);
      const x1 = Math.floor((ox + reach) / CELL_M);
      const z0 = Math.floor((oz - reach) / CELL_M);
      const z1 = Math.floor((oz + reach) / CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = cellKey(cx, cz);
          let cell = this.cells.get(key);
          if (cell === undefined) {
            cell = [];
            this.cells.set(key, cell);
          }
          cell.push(index);
        }
      }
    }
    if (this.stamp.length < this.bodies.length) this.stamp = new Uint32Array(Math.max(this.bodies.length, 2 * this.stamp.length));
  }

  /** The statics whose cells lie within `reach` of (x, z), in obstacle order. The returned array is reused. */
  near(x: number, z: number, reach: number): number[] {
    const out = this.out;
    out.length = 0;
    const gen = ++this.generation;
    const x0 = Math.floor((x - reach) / CELL_M);
    const x1 = Math.floor((x + reach) / CELL_M);
    const z0 = Math.floor((z - reach) / CELL_M);
    const z1 = Math.floor((z + reach) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (cell === undefined) continue;
        for (let i = 0; i < cell.length; i++) {
          const index = cell[i] as number;
          if (this.stamp[index] === gen) continue;
          this.stamp[index] = gen;
          out.push(index);
        }
      }
    }
    if (out.length > 1) out.sort(ascending);
    for (let i = 0; i < out.length; i++) out[i] = this.bodies[out[i] as number] as number;
    return out;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + CELL_OFFSET) * 65536 + (cz + CELL_OFFSET);
}

function ascending(a: number, b: number): number {
  return a - b;
}

export class PropCollisionSystem implements SimSystem {
  readonly name = "prop-collision";
  private readonly movers = defineQuery([Transform, Velocity, BodyConfig]);
  private readonly obstacles = defineQuery([Transform, BodyConfig]);
  private readonly foot: Footprint = { radius: 0, y0: 0, y1: 0 };
  /** Static obstacles binned by XZ cell, rebuilt each tick (statics do not move; the set can change). */
  private readonly grid = new StaticGrid();

  step(sim: SimWorld): void {
    const movers = this.movers(sim.ecs);
    if (movers.length === 0) return;
    const obstacles = this.obstacles(sim.ecs);
    this.grid.build(obstacles);
    const foot = this.foot;
    for (let i = 0; i < movers.length; i++) {
      const e = movers[i] as number;
      if (BodyConfig.motionType[e] !== MotionType.Kinematic) continue;
      if (hasComponent(sim.ecs, Noclip, e)) continue;
      const px = Transform.px[e];
      const pz = Transform.pz[e];
      if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(Transform.py[e])) continue;
      if (!moverFootprint(e, foot)) continue;
      const rm = foot.radius;
      const my0 = foot.y0;
      const my1 = foot.y1;
      // Only statics near the mover, in their original order (pushes are order-sensitive).
      const near = this.grid.near(px, pz, rm + CELL_M);
      for (let n = 0; n < near.length; n++) {
        const o = near[n] as number;
        const kind = BodyConfig.shapeKind[o];
        const ox = Transform.px[o];
        const oz = Transform.pz[o];
        const oy = Transform.py[o];
        // Vertical broadphase first: the cheapest reject (flyers, waders).
        let sy0: number;
        let sy1: number;
        if (kind === ShapeKind.Capsule) {
          const r = BodyConfig.radius[o];
          if (!(r > 0)) continue;
          sy0 = oy;
          sy1 = oy + 2 * (BodyConfig.halfY[o] + r);
        } else if (kind === ShapeKind.Sphere) {
          const r = BodyConfig.radius[o];
          if (!(r > 0)) continue;
          sy0 = oy - r;
          sy1 = oy + r;
        } else {
          const hy = BodyConfig.halfY[o];
          if (!(hy > 0)) continue;
          sy0 = oy - hy;
          sy1 = oy + hy;
        }
        if (my1 <= sy0 || sy1 <= my0) continue;
        const hit = kind === ShapeKind.Box ? boxPush(o, Transform.px[e], Transform.pz[e], rm, PUSH) : discPush(o, Transform.px[e], Transform.pz[e], rm, PUSH);
        if (hit) {
          Transform.px[e] += PUSH.x;
          Transform.pz[e] += PUSH.z;
        }
      }
    }
  }
}

/** Scratch for the push helpers (no allocation per pair). */
const PUSH = { x: 0, z: 0 };
const statics = defineQuery([Transform, BodyConfig]);

/** The XZ push that frees a circle of radius `rm` at (px, pz) from yaw-rotated static box `o`, into `out`. False if clear. */
function boxPush(o: number, px: number, pz: number, rm: number, out: { x: number; z: number }): boolean {
  const hx = BodyConfig.halfX[o];
  const hz = BodyConfig.halfZ[o];
  if (!(hx > 0) || !(hz > 0)) return false;
  const dx = px - Transform.px[o];
  const dz = pz - Transform.pz[o];
  // Bounding-circle reject before any trigonometry.
  const bound = Math.sqrt(hx * hx + hz * hz) + rm;
  if (dx > bound || dx < -bound || dz > bound || dz < -bound) return false;
  const yaw = yawOf(o);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // World -> box-local (inverse of the +Y rotation the body carries).
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = Math.max(-hx, Math.min(hx, lx));
  const qz = Math.max(-hz, Math.min(hz, lz));
  let pushLx: number;
  let pushLz: number;
  if (qx === lx && qz === lz) {
    // Centre inside (or on) the box: leave along the least-penetrating axis.
    const penX = hx + rm - Math.abs(lx);
    const penZ = hz + rm - Math.abs(lz);
    if (penX <= 0 || penZ <= 0) return false;
    if (penX <= penZ) {
      pushLx = lx >= 0 ? penX : -penX;
      pushLz = 0;
    } else {
      pushLx = 0;
      pushLz = lz >= 0 ? penZ : -penZ;
    }
  } else {
    const ex = lx - qx;
    const ez = lz - qz;
    const dist = Math.sqrt(ex * ex + ez * ez);
    if (dist >= rm || dist === 0) return false;
    const push = (rm - dist) / dist;
    pushLx = ex * push;
    pushLz = ez * push;
  }
  // Box-local -> world.
  out.x = pushLx * c + pushLz * s;
  out.z = -pushLx * s + pushLz * c;
  return true;
}

/** Same for a static sphere/capsule disc. */
function discPush(o: number, px: number, pz: number, rm: number, out: { x: number; z: number }): boolean {
  const r = BodyConfig.radius[o];
  if (!(r > 0)) return false;
  const dx = px - Transform.px[o];
  const dz = pz - Transform.pz[o];
  const want = r + rm;
  if (dx > want || dx < -want || dz > want || dz < -want) return false;
  const distSq = dx * dx + dz * dz;
  if (distSq >= want * want) return false;
  if (distSq === 0) {
    out.x = want;
    out.z = 0;
    return true;
  }
  const dist = Math.sqrt(distSq);
  const push = (want - dist) / dist;
  out.x = dx * push;
  out.z = dz * push;
  return true;
}

/**
 * Where a character of `radius` placed at (x, z) ends up clear of every
 * static body: pushed out of boxes (yaw-aware) and discs, up to a few
 * passes so leaving one box does not land in the next. For spawn, respawn,
 * teleport and creature placement, so nothing starts inside a building.
 * Ignores height (conservative: any static, however high, pushes).
 * Not for the tick loop. ponytail: linear scan over statics, fine for
 * spawn-rate calls; add a grid if it ever runs per tick.
 */
export function clearOfStatics(sim: SimWorld, x: number, z: number, radius: number): { x: number; z: number } {
  const all = statics(sim.ecs);
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let k = 0; k < all.length; k++) {
      const o = all[k] as number;
      if (BodyConfig.motionType[o] !== MotionType.Static) continue;
      const kind = BodyConfig.shapeKind[o];
      const hit = kind === ShapeKind.Box ? boxPush(o, x, z, radius, PUSH) : kind === ShapeKind.Sphere || kind === ShapeKind.Capsule ? discPush(o, x, z, radius, PUSH) : false;
      if (hit) {
        x += PUSH.x;
        z += PUSH.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, z };
}
