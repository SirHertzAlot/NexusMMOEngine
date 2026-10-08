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

export class PropCollisionSystem implements SimSystem {
  readonly name = "prop-collision";
  private readonly movers = defineQuery([Transform, Velocity, BodyConfig]);
  private readonly obstacles = defineQuery([Transform, BodyConfig]);
  private readonly foot: Footprint = { radius: 0, y0: 0, y1: 0 };

  step(sim: SimWorld): void {
    const movers = this.movers(sim.ecs);
    if (movers.length === 0) return;
    const obstacles = this.obstacles(sim.ecs);
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
      for (let k = 0; k < obstacles.length; k++) {
        const o = obstacles[k] as number;
        if (o === e || BodyConfig.motionType[o] !== MotionType.Static) continue;
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
        if (kind === ShapeKind.Box) this.resolveBox(e, o, rm);
        else this.resolveDisc(e, o, rm, BodyConfig.radius[o]);
      }
    }
  }

  /** Push a mover's XZ circle out of a yaw-rotated static box. */
  private resolveBox(e: number, o: number, rm: number): void {
    const hx = BodyConfig.halfX[o];
    const hz = BodyConfig.halfZ[o];
    if (!(hx > 0) || !(hz > 0)) return;
    const dx = Transform.px[e] - Transform.px[o];
    const dz = Transform.pz[e] - Transform.pz[o];
    // Bounding-circle reject before any trigonometry.
    const bound = Math.sqrt(hx * hx + hz * hz) + rm;
    if (dx > bound || dx < -bound || dz > bound || dz < -bound) return;
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
      if (penX <= 0 || penZ <= 0) return;
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
      if (dist >= rm || dist === 0) return;
      const push = (rm - dist) / dist;
      pushLx = ex * push;
      pushLz = ez * push;
    }
    // Box-local -> world.
    Transform.px[e] += pushLx * c + pushLz * s;
    Transform.pz[e] += -pushLx * s + pushLz * c;
  }

  /** Push a mover's XZ circle out of a static sphere/capsule disc. */
  private resolveDisc(e: number, o: number, rm: number, r: number): void {
    if (!(r > 0)) return;
    const dx = Transform.px[e] - Transform.px[o];
    const dz = Transform.pz[e] - Transform.pz[o];
    const want = r + rm;
    if (dx > want || dx < -want || dz > want || dz < -want) return;
    const distSq = dx * dx + dz * dz;
    if (distSq >= want * want) return;
    if (distSq === 0) {
      Transform.px[e] += want;
      return;
    }
    const dist = Math.sqrt(distSq);
    const push = (want - dist) / dist;
    Transform.px[e] += dx * push;
    Transform.pz[e] += dz * push;
  }
}
