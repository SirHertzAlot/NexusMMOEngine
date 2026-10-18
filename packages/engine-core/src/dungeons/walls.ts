/**
 * Dungeon walls for an instance (roadmap D4): bodies stay on the layout's
 * walkable cells and out of its solid props. Runs after IntegrateSystem.
 *
 * The move is taken one axis at a time (x, then z), and an axis is allowed
 * only if every cell it sweeps is walkable, so a fast step cannot skip a
 * thin wall and a diagonal cannot slip between two wall cells at a corner.
 * A blocked axis keeps its old value, which slides a body along a wall.
 * A jump of more than `teleportStepM` metres in a tick is a teleport (respawn,
 * admin): accepted where it lands if that is floor.
 *
 * Props are round colliders baked with the layout (pillars, statues, chests;
 * not torches or banners): a body is pushed out of them, unless that would
 * push it into rock. The layout grid is the collider here, so an instance
 * needs no physics world; the prebaked shell is what clients draw.
 */

import { defineQuery, hasComponent } from "bitecs";
import * as C from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { CELL_M, walkableAt, type InstanceLayout } from "./pool.js";

/** A body's footprint and the teleport threshold (instances.json, EG12). */
export interface WallOptions {
  /** A body's footprint radius against props, metres (the character capsule's). Default 0.4. */
  bodyRadiusM?: number;
  /** Longest per-tick move that is walked rather than a teleport, metres (fly speed is 0.4 m a tick). Default 8. */
  teleportStepM?: number;
}

/** Is the row of cells z lies in walkable from x0 to x1 (or the column, swapped)? */
function clear(l: InstanceLayout, a0: number, a1: number, b: number, alongX: boolean): boolean {
  const lo = Math.floor(Math.min(a0, a1) / CELL_M);
  const hi = Math.floor(Math.max(a0, a1) / CELL_M);
  for (let c = lo; c <= hi; c++) {
    const a = (c + 0.5) * CELL_M;
    if (!(alongX ? walkableAt(l, a, b) : walkableAt(l, b, a))) return false;
  }
  return true;
}

export class DungeonWallSystem implements SimSystem {
  readonly name = "dungeon-walls";
  private readonly movers = defineQuery([C.Transform, C.Velocity]);
  private readonly last = new Map<number, [number, number]>();

  private readonly bodyRadius: number;
  private readonly maxStep: number;

  constructor(
    private readonly layout: InstanceLayout,
    opts: WallOptions = {},
  ) {
    this.bodyRadius = opts.bodyRadiusM ?? 0.4;
    this.maxStep = opts.teleportStepM ?? 8;
  }

  step(sim: SimWorld): void {
    const ids = this.movers(sim.ecs);
    const seen = new Set<number>();
    const l = this.layout;
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i];
      // No-clip passes through walls: neither corrected nor remembered,
      // so switching it off inside rock simply accepts the spot.
      if (hasComponent(sim.ecs, C.Noclip, e)) {
        this.last.delete(e);
        continue;
      }
      seen.add(e);
      const x = C.Transform.px[e];
      const z = C.Transform.pz[e];
      const prev = this.last.get(e);
      if (!prev) {
        if (walkableAt(l, x, z)) this.last.set(e, [x, z]);
        continue;
      }
      let nx = prev[0];
      let nz = prev[1];
      if (Math.hypot(x - nx, z - nz) > this.maxStep) {
        if (walkableAt(l, x, z)) [nx, nz] = [x, z];
      } else {
        if (clear(l, nx, x, nz, true)) nx = x;
        if (clear(l, nz, z, nx, false)) nz = z;
      }
      // Props: pushed out of each round collider, kept only where that is still floor.
      const px = nx, pz = nz;
      const c = l.colliders;
      for (let k = 0; k < c.length; k += 3) {
        const dx = nx - c[k], dz = nz - c[k + 1];
        const want = c[k + 2] + this.bodyRadius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= want * want) continue;
        const d = Math.sqrt(d2);
        // Dead centre: leave along +x.
        nx = c[k] + (d > 0 ? (dx / d) * want : want);
        nz = c[k + 1] + (d > 0 ? (dz / d) * want : 0);
      }
      if (!walkableAt(l, nx, nz)) [nx, nz] = [px, pz];
      C.Transform.px[e] = nx;
      C.Transform.pz[e] = nz;
      prev[0] = nx;
      prev[1] = nz;
    }
    if (this.last.size > seen.size) for (const e of this.last.keys()) if (!seen.has(e)) this.last.delete(e);
  }
}
