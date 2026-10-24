/**
 * NeedsSystem — hunger and thirst meters (U3).
 *
 * Both meters start full and drain at the rules' `drainPerMinute`, faster
 * (`exertionFactor`) while the entity is running or swimming. A meter at
 * zero hurts: Health drops by `damagePerSecond` per second per empty meter.
 * Food and drink items refill through `restore()` once they exist. The
 * rules' `max` is authoritative: a meter whose max changed keeps its
 * fraction. Runs after DeathSystem, so a starved entity dies next tick.
 * A body that comes back from 0 Health (a respawn) gets both meters full,
 * so a starved player doesn't respawn into the same death. Standing in or
 * at water (feet within the rules' `drink.reachM` of the surface) refills
 * thirst at `drink.perSecond`.
 * Not persisted and not on the wire yet (no HUD until there is a meter to
 * show).
 */

import { defineQuery, entityExists, hasComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import type { NeedsRules } from "@mmo-engine/rules";
import { God, Health, Locomotion, Needs, PlayerIntent, Transform } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

export type NeedKind = "hunger" | "thirst";

export class NeedsSystem implements SimSystem {
  readonly name = "needs";
  private readonly query = defineQuery([Needs, Health]);

  /** Entities seen at 0 Health: refilled when they rise. */
  private readonly dead = new Set<number>();

  constructor(
    private readonly rules: NeedsRules,
    /** The water surface height at (x, z), null where there is none. Absent: nowhere to drink. */
    private readonly waterSurfaceAt?: (x: number, z: number) => number | null,
  ) {}

  /** Refill a meter (clamped to its max). */
  restore(eid: number, kind: NeedKind, amount: number): void {
    if (kind === "hunger") Needs.hunger[eid] = Math.min(Needs.hungerMax[eid], Needs.hunger[eid] + amount);
    else Needs.thirst[eid] = Math.min(Needs.thirstMax[eid], Needs.thirst[eid] + amount);
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    for (const d of this.dead) if (!entityExists(sim.ecs, d)) this.dead.delete(d); // a body despawned while dead
    const { hunger, thirst, exertionFactor } = this.rules;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      if (Health.current[e] <= 0) {
        this.dead.add(e);
        continue;
      }
      if (this.dead.delete(e)) {
        Needs.hunger[e] = Needs.hungerMax[e];
        Needs.thirst[e] = Needs.thirstMax[e];
      }
      if (Needs.hungerMax[e] !== hunger.max) {
        Needs.hunger[e] = Needs.hungerMax[e] > 0 ? (Needs.hunger[e] / Needs.hungerMax[e]) * hunger.max : hunger.max;
        Needs.hungerMax[e] = hunger.max;
      }
      if (Needs.thirstMax[e] !== thirst.max) {
        Needs.thirst[e] = Needs.thirstMax[e] > 0 ? (Needs.thirst[e] / Needs.thirstMax[e]) * thirst.max : thirst.max;
        Needs.thirstMax[e] = thirst.max;
      }
      const exerting =
        hasComponent(sim.ecs, PlayerIntent, e) &&
        (hasComponent(sim.ecs, Locomotion, e) && Locomotion.mode[e] === LocomotionMode.Swim
          ? PlayerIntent.mx[e] !== 0 || PlayerIntent.my[e] !== 0 || PlayerIntent.mz[e] !== 0
          : PlayerIntent.mx[e] !== 0 || PlayerIntent.mz[e] !== 0);
      const k = (exerting ? exertionFactor : 1) * dtSeconds / 60;
      Needs.hunger[e] = Math.max(0, Needs.hunger[e] - hunger.drainPerMinute * k);
      Needs.thirst[e] = Math.max(0, Needs.thirst[e] - thirst.drainPerMinute * k);
      if (this.waterSurfaceAt && hasComponent(sim.ecs, Transform, e)) {
        const surface = this.waterSurfaceAt(Transform.px[e], Transform.pz[e]);
        if (surface !== null && Transform.py[e] <= surface + this.rules.drink.reachM) this.restore(e, "thirst", this.rules.drink.perSecond * dtSeconds);
      }
      let dmg = 0;
      if (Needs.hunger[e] === 0) dmg += hunger.damagePerSecond;
      if (Needs.thirst[e] === 0) dmg += thirst.damagePerSecond;
      if (dmg > 0 && !hasComponent(sim.ecs, God, e)) Health.current[e] = Math.max(0, Health.current[e] - dmg * dtSeconds);
    }
  }
}
