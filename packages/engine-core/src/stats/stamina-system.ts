/**
 * StaminaSystem — the exertion pool behind U2's stamina bar (U2).
 *
 * Drains (user's rules): dodges and attacks cost a flat amount, jumps
 * cost on the press, swimming and running drain per second. Climbing has
 * no locomotion system yet, so nothing drains for it. Recovery: a
 * cooldown after the last spend, then `staminaRegen`/s (a stat, so game
 * objects and abilities buff it through StatBook modifiers when those
 * systems land). The pool floors at zero.
 *
 * Authority split with CombatSystem (EDA, no shared mutable state):
 * combat moves spend through `spend()` at move start — denied starts
 * never fire — while this system owns only ambient drains and regen.
 * Runs after CombatSystem so a denied move spends nothing this tick.
 */

import { defineQuery, hasComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import { Action, Locomotion, PlayerIntent, Stamina } from "../components.js";
import { Injury } from "../body.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

/** Flat costs (stamina points). */
export const DODGE_COST = 20;
export const ATTACK_COST = 10;
export const JUMP_COST = 8;
/** Drains (points/second) while the intent drives them. */
export const SWIM_DRAIN = 10;
export const RUN_DRAIN = 6;
/** Ticks after the last spend before regen starts (30 = 1 s). */
export const REGEN_DELAY_TICKS = 30;
/** Regen when the rules define no `staminaRegen` stat. */
export const BUILTIN_REGEN = 12;

export class StaminaSystem implements SimSystem {
  readonly name = "stamina";
  private readonly query = defineQuery([Stamina, PlayerIntent, Action]);
  /** Eids with jump held last tick — jump costs on the rising edge. */
  private readonly jumpHeld = new Set<number>();
  /** Eid -> tick of the last spend (flat cost or drain). */
  private readonly drained = new Map<number, number>();

  /**
   * Spend a flat cost now. Returns whether the pool covered it (and only
   * then deducts and restarts the regen cooldown). CombatSystem gates
   * move starts on this.
   */
  spend(sim: SimWorld, eid: number, cost: number): boolean {
    if (Stamina.current[eid] < cost) return false;
    Stamina.current[eid] -= cost;
    this.drained.set(eid, sim.currentTick);
    return true;
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    if (this.jumpHeld.size + this.drained.size > eids.length * 2) {
      const live = new Set<number>(eids as unknown as number[]);
      for (const e of this.jumpHeld) if (!live.has(e)) this.jumpHeld.delete(e);
      for (const e of this.drained.keys()) if (!live.has(e)) this.drained.delete(e);
    }
    const tick = sim.currentTick;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      const grounded = !hasComponent(sim.ecs, Locomotion, e) || Locomotion.mode[e] === LocomotionMode.Ground;
      const wantJump = PlayerIntent.jump[e] !== 0;
      if (wantJump && !this.jumpHeld.has(e) && grounded) {
        this.drain(sim, e, tick, JUMP_COST);
      }
      if (wantJump) this.jumpHeld.add(e);
      else this.jumpHeld.delete(e);

      const mx = PlayerIntent.mx[e];
      const my = PlayerIntent.my[e];
      const mz = PlayerIntent.mz[e];
      if (hasComponent(sim.ecs, Locomotion, e) && Locomotion.mode[e] === LocomotionMode.Swim) {
        if (mx !== 0 || my !== 0 || mz !== 0) this.drain(sim, e, tick, SWIM_DRAIN * dtSeconds);
      } else if (mx !== 0 || mz !== 0) {
        this.drain(sim, e, tick, RUN_DRAIN * dtSeconds);
      }

      const since = tick - (this.drained.get(e) ?? -REGEN_DELAY_TICKS - 1);
      if (since > REGEN_DELAY_TICKS && Stamina.current[e] < Stamina.max[e]) {
        // A weakened torso (M2) recovers more slowly.
        const rate = (sim.stats.get(e, "staminaRegen") ?? BUILTIN_REGEN) * (hasComponent(sim.ecs, Injury, e) ? Injury.stamina[e] : 1);
        Stamina.current[e] = Math.min(Stamina.max[e], Stamina.current[e] + rate * dtSeconds);
      }
    }
  }

  private drain(sim: SimWorld, eid: number, tick: number, amount: number): void {
    Stamina.current[eid] = Math.max(0, Stamina.current[eid] - amount);
    this.drained.set(eid, tick);
  }
}
