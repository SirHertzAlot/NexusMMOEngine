/**
 * Dungeon walls for an instance (roadmap D4): bodies stay on the layout's
 * walkable cells. Runs after IntegrateSystem: a body whose move this tick
 * would leave the floor keeps the part of the move that stays on it
 * (sliding along a wall) or, failing that, stays where it was.
 *
 * The layout grid is the collider here, so an instance needs no physics
 * world; the prebaked shell is what clients draw.
 */

import { defineQuery } from "bitecs";
import * as C from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { walkableAt, type InstanceLayout } from "./pool.js";

export class DungeonWallSystem implements SimSystem {
  readonly name = "dungeon-walls";
  private readonly movers = defineQuery([C.Transform, C.Velocity]);
  private readonly last = new Map<number, [number, number]>();

  constructor(private readonly layout: InstanceLayout) {}

  step(sim: SimWorld): void {
    const ids = this.movers(sim.ecs);
    const seen = new Set<number>();
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i];
      seen.add(e);
      const x = C.Transform.px[e];
      const z = C.Transform.pz[e];
      const prev = this.last.get(e);
      if (walkableAt(this.layout, x, z) || !prev) {
        if (walkableAt(this.layout, x, z)) this.last.set(e, [x, z]);
        continue;
      }
      const [px, pz] = prev;
      if (walkableAt(this.layout, x, pz)) C.Transform.pz[e] = pz;
      else if (walkableAt(this.layout, px, z)) C.Transform.px[e] = px;
      else {
        C.Transform.px[e] = px;
        C.Transform.pz[e] = pz;
      }
      this.last.set(e, [C.Transform.px[e], C.Transform.pz[e]]);
    }
    if (this.last.size > seen.size) for (const e of this.last.keys()) if (!seen.has(e)) this.last.delete(e);
  }
}
