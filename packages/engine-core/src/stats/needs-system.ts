/**
 * NeedsSystem — hunger and thirst meters (U3).
 *
 * Both meters start full and drain at the rules' `drainPerMinute`, faster
 * (`exertionFactor`) while the entity is running or swimming. A meter at
 * zero hurts: Health drops by `damagePerSecond` per second per empty meter.
 * Food and drink items refill through `restore()` once they exist. The
 * rules' `max` is authoritative: a meter whose max changed keeps its
 * fraction. Runs after DeathSystem, so a starved entity dies next tick.
 * Not persisted and not on the wire yet (no HUD until there is a meter to
 * show).
 */

import { defineQuery, hasComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import type { NeedsRules } from "@mmo-engine/rules";
import { God, Health, Locomotion, Needs, PlayerIntent } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

export type NeedKind = "hunger" | "thirst";

export class NeedsSystem implements SimSystem {
  readonly name = "needs";
  private readonly query = defineQuery([Needs, Health]);

  constructor(private readonly rules: NeedsRules) {}

  /** Refill a meter (clamped to its max). */
  restore(eid: number, kind: NeedKind, amount: number): void {
    if (kind === "hunger") Needs.hunger[eid] = Math.min(Needs.hungerMax[eid], Needs.hunger[eid] + amount);
    else Needs.thirst[eid] = Math.min(Needs.thirstMax[eid], Needs.thirst[eid] + amount);
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    const { hunger, thirst, exertionFactor } = this.rules;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      if (Health.current[e] <= 0) continue;
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
      let dmg = 0;
      if (Needs.hunger[e] === 0) dmg += hunger.damagePerSecond;
      if (Needs.thirst[e] === 0) dmg += thirst.damagePerSecond;
      if (dmg > 0 && !hasComponent(sim.ecs, God, e)) Health.current[e] = Math.max(0, Health.current[e] - dmg * dtSeconds);
    }
  }
}
