/**
 * DeathSystem — what happens when Health reaches 0 (M2b).
 *
 * A body at 0 health is dead: its move ends, its walk stops, and the death
 * is queued for the gateway (`drainEvents`, the 0x17 `life` message) with
 * the rules' onDeath outcome deciding the respawn delay. When that delay is
 * up the body is brought back at full health (`place` puts players at the
 * spawn point; anything else rises where it fell) and onRespawn is told.
 * Runs right after CombatSystem, so a blow's death shows the same tick.
 */

import { defineQuery, hasComponent } from "bitecs";
import type { DeathOutcome, RuleHooks } from "@mmo-engine/rules";
import { Action, Health, PlayerIntent, Transform, Velocity } from "./components.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** A death or a respawn, for the gateway to tell clients. */
export interface LifeEvent {
  tick: number;
  target: number;
  state: "dead" | "alive";
  killer?: number;
  /** Tick the body respawns (dead events). */
  respawnAt?: number;
  outcome?: DeathOutcome;
  /** Where it fell (dead events). */
  x?: number;
  z?: number;
}

interface Corpse {
  respawnAt: number;
  outcome: DeathOutcome;
}

export class DeathSystem implements SimSystem {
  readonly name = "death";
  private readonly bodies = defineQuery([Transform, Health]);
  private readonly dead = new Map<number, Corpse>();
  private events: LifeEvent[] = [];

  constructor(
    private readonly hooks: RuleHooks,
    private readonly tickHz = 30,
    /** The last entity to damage `e`, if known. */
    private readonly lastAttacker?: (e: number) => number | undefined,
    /** Put a respawning body down; return false to let it rise where it fell. */
    private readonly place?: (sim: SimWorld, e: number) => boolean,
    /** Respawn delay in seconds for `e` where it differs from the rules' (creatures); undefined keeps the rules'. */
    private readonly delayOf?: (e: number) => number | undefined,
    /** Called as each death is recorded (loot drops); the event is also queued for `drainEvents`. */
    private readonly onDeath?: (sim: SimWorld, ev: LifeEvent) => void,
  ) {}

  isDead(e: number): boolean {
    return this.dead.has(e);
  }

  /** The deaths and respawns since the last call. */
  drainEvents(): LifeEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }

  step(sim: SimWorld): void {
    const tick = sim.currentTick;
    const ids = this.bodies(sim.ecs);
    if (this.dead.size > 0) {
      const live = new Set<number>(ids as unknown as number[]);
      for (const e of this.dead.keys()) if (!live.has(e)) this.dead.delete(e);
    }
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] as number;
      const corpse = this.dead.get(e);
      if (corpse) {
        Velocity.lx[e] = 0;
        Velocity.lz[e] = 0;
        if (tick >= corpse.respawnAt) this.respawn(sim, e, tick, corpse);
        continue;
      }
      if (Health.current[e] > 0) continue;
      const outcome = this.hooks.onDeath({ cause: "part", part: "torso" });
      const delay = this.delayOf?.(e) ?? outcome.respawnInSeconds;
      const respawnAt = tick + Math.round(delay * this.tickHz);
      this.dead.set(e, { respawnAt, outcome });
      if (hasComponent(sim.ecs, Action, e)) Action.move[e] = 0;
      Velocity.lx[e] = 0;
      Velocity.lz[e] = 0;
      const ev: LifeEvent = {
        tick,
        target: e,
        state: "dead",
        killer: this.lastAttacker?.(e),
        respawnAt,
        outcome,
        x: Transform.px[e],
        z: Transform.pz[e],
      };
      this.events.push(ev);
      this.onDeath?.(sim, ev);
    }
  }

  private respawn(sim: SimWorld, e: number, tick: number, corpse: Corpse): void {
    this.dead.delete(e);
    this.hooks.onRespawn({ outcome: corpse.outcome });
    Health.current[e] = Health.max[e];
    if (hasComponent(sim.ecs, PlayerIntent, e)) PlayerIntent.buttons[e] = 0;
    this.place?.(sim, e);
    this.events.push({ tick, target: e, state: "alive" });
  }
}
